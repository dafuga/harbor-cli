import {readFileSync, statSync} from 'node:fs'
import {isAbsolute} from 'node:path'
import {canonicalUint64} from '../lib/tx.js'
import {specialtyManifest} from './specialties.js'
import {serviceUrl, sha256} from './http.js'
import {AgentError, alias, amount, hash, record, text} from './validation.js'
import type {HarborConfig, HarborModel, LocalAgentConfig} from './network.types.js'

export const HARBOR_TESTNET = 'd7e3ddbbf7e977f95d2f2d388926dd875e8a57c5a14259e8335b70b3b4bc498a'
const LOCAL_TESTNET = 'cf057bbfb72640471fd910bcb67639c22df9f92470936cddc1ade0e2f2e7dc4f'

function name(value: unknown, label: string) {
  const id = text(value, label, 12)
  if (!/^[a-z1-5](?:[a-z1-5.]{0,10}[a-z1-5])?$/.test(id)) throw new AgentError(`Invalid ${label}.`)
  return id
}

export function positiveId(value: unknown, label: string) {
  const id = canonicalUint64(value, label)
  if (id === '0') throw new AgentError(`${label} must be positive.`)
  return id
}

function commitment(value: unknown, label: string) {
  const id = text(value, label, 64)
  if (!hash(id)) throw new AgentError(`Invalid ${label}.`)
  return id
}

function specialtyPromotion(pathValue: unknown) {
  const path = text(pathValue, 'Specialty promotion receipt path', 1000)
  if (!isAbsolute(path)) throw new AgentError('Use an absolute path for the specialty promotion receipt.')
  try {
    const file = statSync(path)
    if (!file.isFile() || file.size > 8192) throw new Error('invalid receipt file')
    const bytes = readFileSync(path)
    if (bytes.length > 8192) throw new Error('receipt too large')
    const receipt = record(JSON.parse(bytes.toString('utf8')))
    const version = amount(receipt.version, 'Specialty version')
    const manifest = specialtyManifest(receipt.specialty, version)
    const counts = record(receipt.counts)
    const base = amount(counts.base, 'Base score')
    const incumbent = amount(counts.incumbent, 'Incumbent score')
    const candidate = amount(counts.candidate, 'Candidate score')
    if (receipt.format !== 'harbor.specialty-promotion.v1' || receipt.passed !== true ||
        receipt.suiteId !== manifest.evaluationSuite || !Array.isArray(receipt.hardFailures) ||
        receipt.hardFailures.length || !Array.isArray(receipt.regressions) || receipt.regressions.length ||
        candidate <= Math.max(base, incumbent) ||
        typeof receipt.suite !== 'string' || !hash(receipt.suite) ||
        typeof receipt.evaluation !== 'string' || !hash(receipt.evaluation)) throw new Error('promotion failed')
    return {id: manifest.id, version, receipt: sha256(bytes), adapter: commitment(receipt.candidate, 'Adapter'),
      runtime: commitment(receipt.runtime, 'Runtime hash'), registryBase: commitment(receipt.registryBase, 'Registry base revision')}
  } catch {
    throw new AgentError('A specialty expert requires a passing pinned promotion receipt.')
  }
}

function model(value: unknown): HarborModel {
  const data = record(value)
  if (data.family !== 'Qwen3-8B' || data.bits !== 4 || (data.weights !== 'AWQ' && data.weights !== 'MLX')) {
    throw new AgentError('Use Qwen3 8B 4-bit AWQ or MLX for the flagship and every expert.')
  }
  if (data.kind !== 'flagship' && data.kind !== 'lora') throw new AgentError('Select the flagship or a LoRA expert.')
  if (data.specialtyPromotion !== undefined && data.kind !== 'lora') {
    throw new AgentError('A specialty promotion receipt applies to a LoRA expert.')
  }
  const specialty = data.specialtyPromotion === undefined ? undefined : specialtyPromotion(data.specialtyPromotion)
  const computeClass = amount(data.computeClass, 'Compute class')
  if (computeClass < 1 || computeClass > 255) throw new AgentError('Invalid model compute class.')
  return {
    id: text(data.id, 'Model key', 80), label: text(data.label, 'Model label', 120), computeClass,
    modelId: positiveId(data.modelId, 'Model ID'), programId: positiveId(data.programId, 'Program ID'),
    policyId: positiveId(data.policyId, 'Policy ID'), revision: commitment(data.revision, 'Model revision'),
    weights: data.weights, kind: data.kind, specialty,
    baseRevision: data.kind === 'lora' ? commitment(data.baseRevision, 'Expert base revision') : undefined,
  }
}

export function harborConfig(value: unknown, env = process.env): HarborConfig {
  const data = record(value)
  const chainId = text(data.chainId, 'Chain ID', 64)
  const rpc = serviceUrl(data.rpc, 'Harbor RPC')
  if (chainId !== HARBOR_TESTNET && !(chainId === LOCAL_TESTNET &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(rpc.hostname))) {
    throw new AgentError('Agent workers require the Harbor testnet or local test genesis.')
  }
  const account = name(data.account, 'Harbor account')
  const permission = name(data.permission, 'Worker permission')
  if (['active', 'owner', 'eosio.code'].includes(permission)) throw new AgentError('Create a dedicated worker permission.')
  const router = serviceUrl(data.router, 'Harbor router')
  const checker = data.checker ? serviceUrl(data.checker, 'Tool checker') : undefined
  if (checker?.origin === router.origin) throw new AgentError('Use an independent tool checker origin.')
  const currency = record(data.currency)
  const precision = amount(currency.precision, 'Currency precision')
  const symbol = text(currency.symbol, 'Currency symbol', 7)
  if (precision > 8 || !/^[A-Z]{1,7}$/.test(symbol)) throw new AgentError('Invalid currency.')
  if (!Array.isArray(data.models) || data.models.length < 1 || data.models.length > 24) {
    throw new AgentError('Configure one to 24 pinned Harbor models.')
  }
  const models = data.models.map(model)
  if (new Set(models.map(item => item.id)).size !== models.length) throw new AgentError('Model keys must be unique.')
  const flagships = models.filter(item => item.kind === 'flagship')
  if (flagships.length !== 1 || models.some(item => item.kind === 'lora' &&
      (item.baseRevision !== flagships[0].revision || item.weights !== flagships[0].weights))) {
    throw new AgentError('Pin one Qwen3 8B 4-bit flagship and match every LoRA expert to its exact base revision and format.')
  }
  const specialties = models.flatMap(item => item.specialty ? [item.specialty.id + ':' + item.specialty.version] : [])
  if (new Set(specialties).size !== specialties.length ||
      models.some(item => item.specialty && item.specialty.registryBase !== flagships[0].revision)) {
    throw new AgentError('Pin one candidate per specialty on the approved base revision.')
  }
  const storage = data.storageOrigins ?? []
  if (!Array.isArray(storage) || storage.length > 16) throw new AgentError('Invalid HarborStore origins.')
  const vault = new Map(Object.entries(record(data.vault ?? {})).map(([key, entry]) => {
    if (!alias(key)) throw new AgentError('Invalid HarborVault alias.')
    const raw = record(entry)
    const recipientKey = text(raw.recipientKey, 'Recipient key path', 1000)
    if (!isAbsolute(recipientKey)) throw new AgentError('HarborVault recipient key paths must be absolute.')
    return [key, {
      grantId: positiveId(raw.grantId, 'Vault grant ID'), objectId: positiveId(raw.objectId, 'Vault access object ID'),
      contentHash: commitment(raw.contentHash, 'Vault access object hash'), recipientKey,
    }]
  }))
  let routerAuth: HarborConfig['routerAuth']
  if (data.routerAuth) {
    const config = record(data.routerAuth)
    routerAuth = {
      audience: text(config.audience, 'Router audience', 256),
      keyId: text(config.keyId, 'Router key ID', 256),
      secret: text(env.HARBOR_AGENT_ROUTER_KEY, 'Router authentication key', 1024),
    }
    if (router.pathname !== '/') throw new AgentError('Use the router root URL with Harbor request authentication.')
  }
  return {
    chainId, rpc, router, checker, routerAuth, checkerToken: env.HARBOR_AGENT_CHECKER_TOKEN,
    account, permission, key: text(data.key, 'Named worker key', 80), models, currency: {symbol, precision},
    storageOrigins: new Set(storage.map(origin => serviceUrl(origin, 'HarborStore replica').origin)), vault,
  }
}

export function localAgentConfig(value: unknown): LocalAgentConfig {
  const data = record(value)
  const chainId = data.chainId === undefined ? HARBOR_TESTNET : text(data.chainId, 'Chain ID', 64)
  if (chainId !== HARBOR_TESTNET && chainId !== LOCAL_TESTNET) throw new AgentError('Use a Harbor testnet identity.')
  const ollama = serviceUrl(data.ollama ?? 'http://127.0.0.1:11434', 'Local Ollama')
  if (!['127.0.0.1', '[::1]'].includes(ollama.hostname) || ollama.pathname !== '/') {
    throw new AgentError('Local Ollama must use a loopback origin.')
  }
  return {chainId, ollama, account: name(data.account, 'Profile account'),
    modelRevision: commitment(data.modelRevision, 'Local model revision')}
}
