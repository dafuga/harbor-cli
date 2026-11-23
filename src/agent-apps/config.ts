import {isAbsolute} from 'node:path'
import {canonicalUint64} from '../lib/tx.js'
import {serviceUrl} from './http.js'
import {AgentError, alias, amount, hash, record, text} from './validation.js'
import type {HarborConfig, HarborModel} from './network.types.js'

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

function model(value: unknown): HarborModel {
  const data = record(value)
  if (data.family !== 'Qwen3-8B' || data.bits !== 4 || (data.weights !== 'AWQ' && data.weights !== 'MLX')) {
    throw new AgentError('Use Qwen3 8B 4-bit AWQ or MLX for the flagship and every expert.')
  }
  if (data.kind !== 'flagship' && data.kind !== 'lora') throw new AgentError('Select the flagship or a LoRA expert.')
  const computeClass = amount(data.computeClass, 'Compute class')
  if (computeClass < 1 || computeClass > 255) throw new AgentError('Invalid model compute class.')
  return {
    id: text(data.id, 'Model key', 80), label: text(data.label, 'Model label', 120), computeClass,
    modelId: positiveId(data.modelId, 'Model ID'), programId: positiveId(data.programId, 'Program ID'),
    policyId: positiveId(data.policyId, 'Policy ID'), revision: commitment(data.revision, 'Model revision'),
    weights: data.weights, kind: data.kind,
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
