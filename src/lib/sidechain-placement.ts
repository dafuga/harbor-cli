import {getTableRows} from './tx.js'

export const CONTRACT_MANIFEST_KIND = 'harbor-contract-manifest'
export const CONTRACT_MANIFEST_VERSION = 1
export const DEFAULT_CONTRACT_RAM_OVERHEAD_BYTES = 65536

const CHAIN_ACTIVE = 2
const CHAIN_SATURATED = 3
const CHAIN_DISABLED = 4
const MAIN_CHAIN_UID = 'main'

export interface ContractDependency {
  contract: string
  chain_uid?: string
}

export interface ContractManifest {
  kind: typeof CONTRACT_MANIFEST_KIND
  version: typeof CONTRACT_MANIFEST_VERSION
  account: string
  owner: string
  title: string
  wasm_object_hash: string
  abi_object_hash: string
  wasm_sha256: string
  abi_sha256: string
  wasm_bytes: number
  abi_bytes: number
  metadata: Record<string, unknown>
  dependencies: ContractDependency[]
}

export interface ChainRow {
  chain_uid: string
  status: number | string
  endpoint?: string
  last_free_bytes?: number | string
  last_used_bytes?: number | string
  last_size_bytes?: number | string
  [key: string]: unknown
}

export interface RamMarketRow {
  base?: string | {balance?: string}
  quote?: string | {balance?: string}
  [key: string]: unknown
}

export interface RamQuote {
  sys_per_kib: number
  base_ram_bytes: number
  quote_sys: number
}

export interface PlacementCandidate {
  chain_uid: string
  endpoint: string
  status: number
  last_free_bytes: number
  last_used_bytes: number
  last_size_bytes: number
  ram_quote: RamQuote
}

export interface SelectPlacementInput {
  url?: string
  marketContract: string
  manifest: ContractManifest
  ramBytes: number
  targetChain?: string
  chains?: ChainRow[]
  ramMarketLoader?: (chain: ChainRow) => Promise<RamQuote>
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`contract manifest field ${field} is required`)
  }
  return value
}

function numberField(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`contract manifest field ${field} must be a nonnegative number`)
  }
  return parsed
}

export function parseContractDependencies(value: unknown): ContractDependency[] {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new Error('contract dependencies must be a JSON array')
  }
  return value.map((entry, index) => {
    const dependency = assertObject(entry, `contract dependency ${index}`)
    const contract = stringField(dependency.contract, `dependencies[${index}].contract`)
    const chainUid = dependency.chain_uid
    if (chainUid !== undefined && (typeof chainUid !== 'string' || chainUid.trim() === '')) {
      throw new Error(`contract manifest field dependencies[${index}].chain_uid must be a nonempty string`)
    }
    return {contract, chain_uid: chainUid}
  })
}

export function parseContractMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {}
  }
  return assertObject(value, 'contract metadata')
}

export function parseContractManifest(value: Buffer | string | unknown): ContractManifest {
  const raw = Buffer.isBuffer(value)
    ? JSON.parse(value.toString('utf8')) as unknown
    : typeof value === 'string'
      ? JSON.parse(value) as unknown
      : value
  const manifest = assertObject(raw, 'contract manifest')
  if (manifest.kind !== CONTRACT_MANIFEST_KIND) {
    throw new Error(`contract manifest kind must be ${CONTRACT_MANIFEST_KIND}`)
  }
  if (Number(manifest.version) !== CONTRACT_MANIFEST_VERSION) {
    throw new Error(`contract manifest version must be ${CONTRACT_MANIFEST_VERSION}`)
  }

  return {
    kind: CONTRACT_MANIFEST_KIND,
    version: CONTRACT_MANIFEST_VERSION,
    account: stringField(manifest.account, 'account'),
    owner: stringField(manifest.owner, 'owner'),
    title: stringField(manifest.title, 'title'),
    wasm_object_hash: stringField(manifest.wasm_object_hash, 'wasm_object_hash'),
    abi_object_hash: stringField(manifest.abi_object_hash, 'abi_object_hash'),
    wasm_sha256: stringField(manifest.wasm_sha256, 'wasm_sha256'),
    abi_sha256: stringField(manifest.abi_sha256, 'abi_sha256'),
    wasm_bytes: numberField(manifest.wasm_bytes, 'wasm_bytes'),
    abi_bytes: numberField(manifest.abi_bytes, 'abi_bytes'),
    metadata: parseContractMetadata(manifest.metadata),
    dependencies: parseContractDependencies(manifest.dependencies),
  }
}

export function buildContractManifest(input: Omit<ContractManifest, 'kind' | 'version'>): ContractManifest {
  return parseContractManifest({
    kind: CONTRACT_MANIFEST_KIND,
    version: CONTRACT_MANIFEST_VERSION,
    ...input,
  })
}

export function defaultContractRamBytes(manifest: Pick<ContractManifest, 'wasm_bytes' | 'abi_bytes'>): number {
  return manifest.wasm_bytes + manifest.abi_bytes + DEFAULT_CONTRACT_RAM_OVERHEAD_BYTES
}

export function dependencyPinnedChain(manifest: Pick<ContractManifest, 'dependencies'>): string | undefined {
  const pinned = new Set(
    manifest.dependencies
      .map((dependency) => dependency.chain_uid)
      .filter((chainUid): chainUid is string => Boolean(chainUid))
  )
  if (pinned.size > 1) {
    throw new Error(`contract dependencies require conflicting chains: ${[...pinned].sort().join(', ')}`)
  }
  return [...pinned][0]
}

export function resolveRequestedChain(manifest: ContractManifest, targetChain?: string): string | undefined {
  const pinned = dependencyPinnedChain(manifest)
  if (pinned && targetChain && pinned !== targetChain) {
    throw new Error(`target chain ${targetChain} conflicts with dependency-pinned chain ${pinned}`)
  }
  return targetChain ?? pinned
}

function connectorBalance(connector: string | {balance?: string} | undefined, label: string): string {
  if (typeof connector === 'string') {
    return connector
  }
  if (typeof connector?.balance === 'string') {
    return connector.balance
  }
  throw new Error(`rammarket ${label} balance is missing`)
}

function parseAssetAmount(asset: string, label: string): number {
  const [amount] = asset.trim().split(/\s+/, 1)
  const parsed = Number(amount)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`rammarket ${label} balance is invalid`)
  }
  return parsed
}

export function estimateRamQuote(row: RamMarketRow): RamQuote {
  const base = parseAssetAmount(connectorBalance(row.base, 'base'), 'base')
  const quote = parseAssetAmount(connectorBalance(row.quote, 'quote'), 'quote')
  return {
    sys_per_kib: (quote / base) * 1024,
    base_ram_bytes: base,
    quote_sys: quote,
  }
}

async function loadRamMarketQuote(chain: ChainRow): Promise<RamQuote> {
  const endpoint = String(chain.endpoint ?? '')
  const rows = await getTableRows<RamMarketRow>('eosio', 'rammarket', {
    url: endpoint,
    scope: 'eosio',
    limit: 1,
  })
  const row = rows.rows[0]
  if (!row) {
    throw new Error('rammarket row is missing')
  }
  return estimateRamQuote(row)
}

function normalizedChain(row: ChainRow): Omit<PlacementCandidate, 'ram_quote'> {
  return {
    chain_uid: String(row.chain_uid),
    endpoint: String(row.endpoint ?? ''),
    status: Number(row.status),
    last_free_bytes: Number(row.last_free_bytes ?? 0),
    last_used_bytes: Number(row.last_used_bytes ?? 0),
    last_size_bytes: Number(row.last_size_bytes ?? 0),
  }
}

function chainFailure(row: ChainRow, ramBytes: number): string | undefined {
  const chain = normalizedChain(row)
  if (!chain.endpoint) {
    return 'chain endpoint is missing'
  }
  if (chain.status === CHAIN_DISABLED) {
    return 'chain is disabled'
  }
  if (chain.status === CHAIN_SATURATED) {
    return 'chain is saturated'
  }
  if (chain.status !== CHAIN_ACTIVE) {
    return 'chain is not active'
  }
  if (chain.last_free_bytes < ramBytes) {
    return `chain has insufficient recorded RAM: ${chain.last_free_bytes} < ${ramBytes}`
  }
  return undefined
}

function compareCandidates(left: PlacementCandidate, right: PlacementCandidate): number {
  return left.ram_quote.sys_per_kib - right.ram_quote.sys_per_kib ||
    right.last_free_bytes - left.last_free_bytes ||
    left.chain_uid.localeCompare(right.chain_uid)
}

export async function selectPlacementChainFromRows(input: Omit<SelectPlacementInput, 'url' | 'marketContract' | 'chains'> & {chains: ChainRow[]}): Promise<PlacementCandidate> {
  const requestedChain = resolveRequestedChain(input.manifest, input.targetChain)
  const loader = input.ramMarketLoader ?? loadRamMarketQuote
  const rows = requestedChain
    ? input.chains.filter((chain) => String(chain.chain_uid) === requestedChain)
    : input.chains.filter((chain) => String(chain.chain_uid) !== MAIN_CHAIN_UID)

  if (requestedChain && rows.length === 0) {
    throw new Error(`target chain ${requestedChain} is not registered`)
  }

  const eligible: ChainRow[] = []
  for (const row of rows) {
    const failure = chainFailure(row, input.ramBytes)
    if (failure) {
      if (requestedChain) {
        throw new Error(`target chain ${requestedChain} cannot host contract: ${failure}`)
      }
      continue
    }
    eligible.push(row)
  }

  if (eligible.length === 0) {
    throw new Error(`no active sidechain has enough recorded RAM for ${input.ramBytes} bytes`)
  }

  const quoted: PlacementCandidate[] = []
  const quoteFailures: string[] = []
  for (const row of eligible) {
    try {
      quoted.push({...normalizedChain(row), ram_quote: await loader(row)})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (requestedChain) {
        throw new Error(`target chain ${requestedChain} RAM quote failed: ${message}`)
      }
      quoteFailures.push(`${row.chain_uid}: ${message}`)
    }
  }

  if (quoted.length === 0) {
    throw new Error(`unable to quote RAM market for placement candidates: ${quoteFailures.join('; ')}`)
  }

  return quoted.sort(compareCandidates)[0]
}

export async function selectPlacementChain(input: SelectPlacementInput): Promise<PlacementCandidate> {
  const chains = input.chains ?? (await getTableRows<ChainRow>(input.marketContract, 'chains', {
    url: input.url,
    scope: input.marketContract,
    limit: 1000,
  })).rows
  return selectPlacementChainFromRows({...input, chains})
}
