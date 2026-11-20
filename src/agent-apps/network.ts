import {createHmac, randomBytes} from 'node:crypto'
import {Name, PublicKey} from '@wharfkit/antelope'
import {consumeGrantUseOnChain, readVaultPrivateKeyFile, verifyAccessEnvelopeObjectOnChain} from '../commands/vault.js'
import {walletPluginForSigner} from '../lib/private-key-wallet.js'
import {downloadStoredObjectBytes, resolveStorageObjectByHash} from '../lib/storage.js'
import {canonicalUint64, pushAction} from '../lib/tx.js'
import {decryptVaultBytes, parseVaultPrivateKey, vaultEnvelopeFromBytes} from '../lib/vault-crypto.js'
import type {AntelopeSigner} from '../lib/wallet.js'
import {positiveId} from './config.js'
import {postJson, responseBytes, sha256} from './http.js'
import {AgentError, amount, hash, record, text} from './validation.js'
import {MAX_PROMPT_BYTES} from './worker.js'
import type {HarborConfig, HarborModel} from './network.types.js'
import type {Agent, Network, Price, Run, ToolCall} from './types.js'

const AI = 'harborai'
const VAULT = 'harborvault'
const STORAGE = 'harborstore'
const RESULT_TIMEOUT = 5 * 60_000
const MAX_FILE = 8192
const WORKER_ACTIONS = ['reqroute', 'commitseed', 'ackinfer', 'canceljob']

function authPart(value: string) {
  const bytes = Buffer.from(value)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(bytes.length)
  return Buffer.concat([size, bytes])
}

export function routerSignature(secret: string, audience: string, subject: string, route: string, at: number, nonce: string, body: string) {
  const timestamp = Buffer.alloc(8)
  timestamp.writeBigUInt64BE(BigInt(at))
  const prefix = [Buffer.from('HRA3'), ...[audience, subject, 'POST', route].map(authPart)]
  return createHmac('sha256', secret)
    .update(Buffer.concat([...prefix, timestamp, authPart(nonce), authPart(sha256(body))])).digest('hex')
}

function seedCommitment(inferId: string, account: string, seed: Buffer) {
  const values = ['aicseedv1', AI, account].map(name => BigInt(Name.from(name).value.toString()))
  const bytes = Buffer.alloc(32)
  for (const [index, value] of [values[0], values[1], BigInt(inferId), values[2]].entries()) {
    bytes.writeBigUInt64LE(value, index * 8)
  }
  return sha256(Buffer.concat([bytes, seed]))
}

function optionalJson(value: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(value))
  } catch {
    return undefined
  }
}

function decodeResult(result: unknown) {
  const raw = text(result, 'Provider output', 32_000)
  const backend = optionalJson(raw)
  const content = typeof backend?.response === 'string' ? backend.response : raw
  const output = optionalJson(content)
  const calls: ToolCall[] = []
  if (output && 'calls' in output) {
    if (!Array.isArray(output.calls) || output.calls.length > 4) throw new AgentError('Invalid tool proposals.', 502)
    for (const proposal of output.calls) {
      const item = record(proposal)
      const resource = text(item.resource, 'Tool resource', 64)
      if (item.name === 'read_file' && hash(resource)) calls.push({name: item.name, resource})
      else if (item.name === 'use_secret' && /^[a-z][a-z0-9_-]{0,31}$/.test(resource)) {
        calls.push({name: item.name, resource, message: text(item.message, 'Message to sign', 512)})
      } else {
        throw new AgentError('Unknown or invalid tool proposal.', 502)
      }
    }
  }
  return {text: text(output?.text ?? content, 'Agent response', 16_000), calls}
}

export class HarborNetwork implements Network {
  readonly models
  readonly currency
  readonly identity
  readonly baseModel
  private readonly acceptedSpecialties = new Map<string, string>()

  constructor(private readonly config: HarborConfig, private readonly signer: AntelopeSigner, private readonly transact = pushAction) {
    this.models = config.models.filter(model => !model.specialty).map(({id, label, revision}) => ({id, label, revision}))
    this.baseModel = config.models.find(model => model.kind === 'flagship')!.id
    this.currency = config.currency
    this.identity = `${config.chainId}/${config.account}`
  }

  private async chain(route: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const {data} = await postJson(new URL(`/v1/chain/${route}`, this.config.rpc), JSON.stringify(body), {signal})
    return data
  }

  private async assertChain(signal?: AbortSignal) {
    const info = await this.chain('get_info', {}, signal)
    if (info.chain_id !== this.config.chainId) throw new AgentError('Harbor RPC is on a different chain.', 409)
  }

  async ready() {
    await this.assertChain()
    const response = await this.chain('get_account', {account_name: this.config.account})
    const permissions = Array.isArray(response.permissions) ? response.permissions.map(record) : []
    const permission = permissions.find(item => item.perm_name === this.config.permission)
    if (!permission) throw new AgentError('Worker permission was not found on the Harbor account.', 409)
    const authorization = record(permission.required_auth)
    if (!Array.isArray(authorization.keys) || authorization.threshold !== 1 || authorization.keys.length !== 1 ||
        Number(record(authorization.keys[0]).weight) !== 1 ||
        !PublicKey.from(String(record(authorization.keys[0]).key)).equals(this.signer.publicKey) ||
        [authorization.accounts, authorization.waits].some(values => Array.isArray(values) && values.length) ||
        permissions.some(item => item !== permission && this.permissionUsesWorkerKey(item))) {
      throw new AgentError('Use a dedicated worker key with no broader Harbor account permission.', 409)
    }
    const links = Array.isArray(permission.linked_actions) ? permission.linked_actions.map(record) : []
    const required = WORKER_ACTIONS.map(action => `${AI}::${action}`)
    if (this.config.vault.size) required.push(`${VAULT}::usegrant`)
    const linked = links.map(link => `${link.account}::${link.action}`)
    if (linked.length !== required.length || required.some(action => !linked.includes(action))) {
      throw new AgentError('Worker permission is missing or exceeds the exact HarborAI and Vault action links.', 409)
    }
    this.acceptedSpecialties.clear()
    const ordinary = this.models.filter(({id}) => !this.config.models.find(model => model.id === id)?.specialty)
    this.models.splice(0, this.models.length, ...ordinary)
    const flagship = this.config.models.find(model => model.kind === 'flagship')!
    for (const model of this.config.models) {
      const [entry, manifest] = await Promise.all([
        this.row('models', model.modelId), this.row('modelmanifs', model.modelId),
      ])
      const expectedType = model.kind === 'flagship' ? 1 : 2
      const expectedParent = model.kind === 'flagship' ? '0' : flagship.modelId
      if (!entry || Number(entry.status) !== 1 || Number(entry.model_type) !== expectedType ||
          String(entry.parent_model_id) !== expectedParent ||
          !manifest || Number(manifest.source_type) !== 1 || !(Number(manifest.capabilities) & 1) ||
          manifest.revision_hash !== model.revision) {
        if (model.specialty) continue
        throw new AgentError('A configured model lacks the exact active Harbor model and manifest lineage.', 409)
      }
      const specialty = model.specialty
      if (!specialty || manifest.runtime_profile_hash !== specialty.runtime) continue
      const weightsId = String(entry.weights_artifact_id ?? '0')
      const evaluationId = String(entry.eval_artifact_id ?? '0')
      const [current, weights, evaluation] = await Promise.all([
        this.isCurrentSpecialty(model), this.row('artifacts', weightsId), this.row('artifacts', evaluationId),
      ])
      if (!current || weights?.content_hash !== specialty.adapter || evaluation?.content_hash !== specialty.receipt ||
          weightsId === '0' || evaluationId === '0') continue
      this.acceptedSpecialties.set(specialty.id + ':' + specialty.version, model.id)
      this.models.push({id: model.id, label: model.label, revision: model.revision})
    }
  }

  specialtyModel(id: string, version: number) {
    return this.acceptedSpecialties.get(id + ':' + version)
  }

  private async isCurrentSpecialty(model: HarborModel, signal?: AbortSignal) {
    const program = await this.row('programs', model.programId, signal)
    return (program?.active === true || program?.active === 1) && String(program.current_model_id) === model.modelId
  }

  private permissionUsesWorkerKey(permission: Record<string, unknown>) {
    const authorization = record(permission.required_auth)
    return Array.isArray(authorization.keys) && authorization.keys.some(entry => {
      return PublicKey.from(String(record(entry).key)).equals(this.signer.publicKey)
    })
  }

  private push(contract: string, action: string, data: Record<string, unknown>, assertActive: () => void) {
    assertActive()
    const wallet = walletPluginForSigner(this.signer, this.config.rpc.href, async request => {
      assertActive()
      if (String(request.chainId) !== this.config.chainId) throw new AgentError('Signing chain ID changed.', 409)
    })
    return this.transact({
      url: this.config.rpc.href, actor: this.config.account, permission: this.config.permission,
      expectChainId: this.config.chainId, contract, action, data, expiration: '60',
    }, undefined, wallet)
  }

  private harborModel(agent: Agent) {
    const model = this.config.models.find(item => item.id === agent.model)
    if (!model) throw new AgentError('Agent model is no longer pinned by the runner.', 409)
    return model
  }

  private asset(cost: number) {
    const digits = String(cost).padStart(this.currency.precision + 1, '0')
    const precision = this.currency.precision
    return `${precision ? digits.slice(0, -precision) + '.' + digits.slice(-precision) : digits} ${this.currency.symbol}`
  }

  private fee(value: unknown) {
    const [digits, symbol, extra] = String(value).split(' ')
    const precision = this.currency.precision
    const pattern = precision ? new RegExp(`^\\d+\\.\\d{${precision}}$`) : /^\d+$/
    if (extra || symbol !== this.currency.symbol || !pattern.test(digits)) {
      throw new AgentError('Harbor fee has a different currency or precision.', 502)
    }
    return amount(Number(digits.replace('.', '')), 'Harbor fee')
  }

  private body(model: HarborModel, prompt: string, ceiling: number) {
    const bytes = Buffer.byteLength(prompt)
    if (bytes > MAX_PROMPT_BYTES) throw new AgentError('Agent instructions and conversation exceed the input budget.')
    return {
      user: this.config.account, model_id: model.modelId, policy_id: model.policyId, program_id: model.programId,
      min_compute_class: model.computeClass, max_compute_class: model.computeClass,
      max_latency_ms: 120_000, allow_escalation: false, max_input_tokens: bytes + 128, max_output_tokens: 512,
      request_hash: sha256(prompt), max_fee: this.asset(ceiling), task: 'agent_apps',
    }
  }

  private router(route: string, input: ReturnType<HarborNetwork['body']> & {infer_id?: string; prompt?: string}, signal?: AbortSignal) {
    const body = JSON.stringify(input)
    const headers: Record<string, string> = {}
    const auth = this.config.routerAuth
    if (auth) {
      const at = Math.floor(Date.now() / 1000)
      const nonce = randomBytes(16).toString('hex')
      Object.assign(headers, {
        'x-harbor-auth-audience': auth.audience, 'x-harbor-auth-key-id': auth.keyId,
        'x-harbor-auth-subject': input.user, 'x-harbor-auth-timestamp': String(at),
        'x-harbor-auth-nonce': nonce,
        'x-harbor-auth-signature': routerSignature(auth.secret, auth.audience, input.user, route, at, nonce, body),
      })
    }
    return postJson(new URL(route, this.config.router), body, {headers, signal, timeout: input.infer_id ? RESULT_TIMEOUT : undefined})
  }

  private assertRoute(data: Record<string, unknown>, model: HarborModel, promptHash: string) {
    if (data.ok !== true || data.request_hash !== promptHash ||
        canonicalUint64(data.selected_model_id) !== model.modelId || data.model_revision !== model.revision) {
      throw new AgentError('Router did not return the pinned Harbor model revision.', 502)
    }
    return positiveId(data.deployment_id, 'Harbor deployment ID')
  }

  async quote(agent: Agent, prompt: string, ceiling: number, signal?: AbortSignal): Promise<Price> {
    await this.assertChain(signal)
    const model = this.harborModel(agent)
    if (model.specialty && !await this.isCurrentSpecialty(model, signal)) {
      this.acceptedSpecialties.delete(model.specialty.id + ':' + model.specialty.version)
      const index = this.models.findIndex(item => item.id === model.id)
      if (index !== -1) this.models.splice(index, 1)
      throw new AgentError('The approved specialty model changed. Request a new quote.', 409)
    }
    const {data} = await this.router('/ai/route', this.body(model, prompt, ceiling), signal)
    const deployment = this.assertRoute(data, model, sha256(prompt))
    const maxCost = this.fee(data.gross_inference_fee_ceiling)
    if (maxCost > ceiling) throw new AgentError('Harbor quote exceeds the approved budget.', 409)
    return {maxCost, deployment}
  }

  private async findRequest(promptHash: string, signal?: AbortSignal) {
    const requester = String(Name.from(this.config.account).value)
    let upper: string | undefined = requester
    for (let page = 0; page < 4; page++) {
      const response = await this.chain('get_table_rows', {
        code: AI, scope: AI, table: 'inferjobs', json: true, index_position: '3',
        key_type: 'i64', lower_bound: requester, upper_bound: upper,
        reverse: true, limit: 250,
      }, signal)
      const rows = Array.isArray(response.rows) ? response.rows.map(record) : []
      const matches = rows.filter(row => row.requester === this.config.account && row.prompt_hash === promptHash)
      if (matches.length > 1) throw new AgentError('Multiple Harbor jobs match the request commitment.', 409)
      if (matches.length) return matches[0]
      // Equal secondary keys may share an RPC cursor. Stop rather than infer an absent charge.
      if (!response.more || typeof response.next_key !== 'string' || response.next_key === upper) break
      upper = response.next_key
    }
    return undefined
  }

  private async row(table: string, id: string, signal?: AbortSignal) {
    const response = await this.chain('get_table_rows', {
      code: AI, scope: AI, table, lower_bound: id, json: true, limit: 1,
    }, signal)
    const rows = Array.isArray(response.rows) ? response.rows.map(record) : []
    return rows.find(row => String(row.id ?? row.infer_id ?? row.model_id) === id)
  }

  async execute(input: Parameters<Network['execute']>[0]) {
    const {agent, prompt, price, signal, assertActive, submitted, starting} = input
    const model = this.harborModel(agent)
    const current = await this.quote(agent, prompt, price.maxCost, signal)
    if (current.deployment !== price.deployment) throw new AgentError('Harbor deployment changed. Request a new quote.', 409)
    const body = this.body(model, prompt, price.maxCost)
    const requester = this.config.account
    starting()
    await this.push(AI, 'reqroute', {
      requester, program_id: body.program_id, min_compute_class: body.min_compute_class,
      max_compute_class: body.max_compute_class, routing_policy: 0, prompt_hash: body.request_hash,
      max_input_tokens: body.max_input_tokens, max_output_tokens: body.max_output_tokens,
      max_fee: body.max_fee, max_latency_ms: body.max_latency_ms, allow_escalation: false,
      metadata: '{"client":"harbor-agent-apps"}',
    }, assertActive)
    const job = await this.findRequest(body.request_hash, AbortSignal.timeout(15_000))
    if (!job) throw new AgentError('Harbor request was broadcast but is not visible yet.', 502)
    const inferId = positiveId(job.id, 'Inference ID')
    submitted(inferId)
    try {
      const seed = randomBytes(32)
      try {
        await this.push(AI, 'commitseed', {requester, infer_id: inferId, seed_commitment: seedCommitment(inferId, requester, seed)}, assertActive)
      } finally {
        seed.fill(0)
      }
      assertActive()
      const {raw, data} = await this.router('/ai/infer', {...body, infer_id: inferId, prompt}, signal)
      const deployment = this.assertRoute(data, model, body.request_hash)
      if (deployment !== price.deployment) throw new AgentError('Delivered Harbor deployment differs from the quote.', 409)
      const provider = record(data.selected_provider)
      const committed = await this.row('inferjobs', inferId, signal)
      // Airouter embeds the exact provider JSON as its last property and commits those bytes.
      const exactProvider = /"provider_result"\s*:\s*(\{[\s\S]*\})\s*\}\s*$/.exec(raw)?.[1]
      if (!exactProvider || !committed || committed.prompt_hash !== body.request_hash ||
          committed.requester !== requester || committed.provider !== provider.account ||
          committed.result_hash !== sha256(exactProvider) || ![1, 5].includes(Number(committed.status))) {
        throw new AgentError('Inference output has no matching on-chain result commitment.', 502)
      }
      const result = decodeResult(record(JSON.parse(exactProvider)).result)
      if (Number(committed.status) === 5) {
        await this.push(AI, 'ackinfer', {
          requester, infer_id: inferId, acceptance_hash: sha256(`harbor-agent-acceptance/v1/${committed.result_hash}`),
        }, assertActive)
      }
      const settled = await this.row('inferjobs', inferId, signal)
      return {...result, paid: settled && Number(settled.status) === 1 ? this.fee(settled.paid_fee) : null}
    } catch (error) {
      // Cancel only before provider acceptance. Harbor enforces the cutoff.
      await this.push(AI, 'canceljob', {requester, infer_id: inferId}, () => {}).catch(() => {})
      throw error
    }
  }

  async reconcile(run: Run, _agent: Agent, signal?: AbortSignal) {
    await this.assertChain(signal)
    const job = run.inferId ? await this.row('inferjobs', run.inferId, signal)
      : run.promptHash ? await this.findRequest(run.promptHash, signal) : undefined
    if (!job || job.requester !== this.config.account || job.prompt_hash !== run.promptHash) return null
    const status = Number(job.status)
    if (status === 1) return this.fee(job.paid_fee)
    if ([2, 3, 4].includes(status)) return 0
    return null
  }

  async verify(call: ToolCall, context: Parameters<Network['verify']>[1], signal: AbortSignal) {
    if (!this.config.checker) throw new AgentError('An independent tool checker is required.', 409)
    const callHash = sha256(JSON.stringify({runId: context.runId, inference: context.inferId, call}))
    const headers = this.config.checkerToken ? {authorization: `Bearer ${this.config.checkerToken}`} : undefined
    const {data} = await postJson(this.config.checker, JSON.stringify({
      kind: 'harbor.ai.route_verification', task: 'verify_agent_tool_call', infer_id: context.inferId,
      prompt: context.prompt, output: context.response, tool_call: call, call_hash: callHash,
    }), {headers, signal})
    if (data.approved !== true || data.call_hash !== callHash || data.needs_tune === true) {
      throw new AgentError('Independent checker rejected the tool call.', 403)
    }
    return callHash
  }

  private async storageBytes(contentHash: string, encrypted: boolean, signal: AbortSignal) {
    await this.assertChain(signal)
    const url = this.config.rpc.href
    const object = await resolveStorageObjectByHash({url, storageContract: STORAGE, contentHash})
    const isEncrypted = [true, 1, '1', 'true'].includes(object.encrypted)
    if (isEncrypted !== encrypted || Number(object.bytes) > MAX_FILE) {
      throw new AgentError('HarborStore object exceeds the grant or allowed size.', 403)
    }
    const {bytes} = await downloadStoredObjectBytes({
      url, storageContract: STORAGE, marketContract: 'svcmarket', contentHash,
      readReplica: async replica => {
        if (!this.config.storageOrigins.has(replica.origin) || replica.username || replica.password) {
          throw new AgentError('HarborStore replica origin is outside the worker allowlist.', 403)
        }
        const response = await fetch(replica, {redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])})
        return {status: response.status, bytes: await responseBytes(response, MAX_FILE)}
      },
    })
    return bytes
  }

  async readFile(contentHash: string, signal: AbortSignal) {
    return new TextDecoder('utf-8', {fatal: true}).decode(await this.storageBytes(contentHash, false, signal))
  }

  async useSecret(alias: string, message: string, context: Parameters<Network['useSecret']>[2], signal: AbortSignal) {
    const binding = this.config.vault.get(alias)
    if (!binding) throw new AgentError('HarborVault alias is not bound by the runner.', 403)
    const envelope = vaultEnvelopeFromBytes(await this.storageBytes(binding.contentHash, true, signal))
    const privateKey = await readVaultPrivateKeyFile(binding.recipientKey)
    try {
      const recipient = parseVaultPrivateKey(privateKey)
      try {
        if (envelope.recipient_key_id !== recipient.keyId || envelope.recipient_key_commitment !== recipient.publicKeyHash) {
          throw new AgentError('Vault recipient key does not match the granted envelope.', 403)
        }
        const url = this.config.rpc.href
        const processor = this.config.account
        const useHash = sha256(JSON.stringify({runId: context.runId, alias, message, grant: binding.grantId}))
        const now = Math.floor(Date.now() / 1000)
        context.assertActive()
        await consumeGrantUseOnChain({
          envelope, grantId: binding.grantId, processor, useHash, vaultContract: VAULT, url, now,
          pushUse: () => this.push(VAULT, 'usegrant', {processor, grant_id: binding.grantId, use_hash: useHash}, context.assertActive),
          verifyAuthorization: authorization => verifyAccessEnvelopeObjectOnChain({
            envelope, authorization, grantId: binding.grantId, processor, vaultContract: VAULT,
            storageContract: STORAGE, objectId: binding.objectId, url,
          }),
        })
        context.assertActive()
        const secret = decryptVaultBytes(envelope, recipient.publicKey, recipient.privateKey, now)
        try {
          return createHmac('sha256', secret).update(message).digest('hex')
        } finally {
          secret.fill(0)
        }
      } finally {
        recipient.privateKey.fill(0)
      }
    } finally {
      privateKey.fill(0)
    }
  }
}
