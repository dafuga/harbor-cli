import {Asset} from '@wharfkit/antelope'
import {getTableRows as readRows} from './tx.js'
import type {ServiceHost} from './host-policy.js'
import {localModel} from './local-model.js'
import type {ResourceLimits} from './resource-limits.js'

export interface TableRowsResponse<T> {
  rows: T[]
  more: boolean | string
  next_key?: string
}

export interface HarborServiceType {
  id: number
  service_name: string
  enabled: boolean | number
  reward_weight: number | string
  epoch_budget: string
  base_provider_reward: string
  provider_fail_penalty: string
  oracle_agree_reward: string
  oracle_disagree_penalty: string
  oracle_miss_penalty: string
  min_provider_stake: string
  min_oracle_stake: string
  min_oracle_reports: number
  min_check_window_sec: number
  metadata?: string
}

export interface HarborService {
  id: number
  provider: string
  service_type: number
  segment_kind: number
  range_start: number
  range_end: number
  capacity_bytes: number | string
  active: boolean | number
  last_heartbeat?: string
  last_status_hash?: string
  endpoint: string
  metadata: string
}

export interface HarborState {
  reward_pool: string
}

export interface MarketOptions {
  url: string
  contract: string
}

interface ServiceTtl {
  service_type: number | string
  ttl_sec: number
}

export interface MarketSnapshot {
  types: HarborServiceType[]
  services: HarborService[]
  ttls?: ServiceTtl[]
  state?: HarborState
}

export interface Opportunity {
  id: number
  name: string
  duties: string
  mustNot: string
  oracleChecks: string
  activeProviders: number
  epochBudget: string
  estimatedProviderReward: string
  estimatedProviderRewardAmount: number
  baseProviderReward: string
  status: string
  reason?: string
  demandUnitsPerHour?: number
  unitPrice?: string
  unit?: string
  capacityUnitsPerHour?: number
  estimatedHourlyReward?: string
  hourlyRewardAmount?: number
}

export interface OpportunityReport {
  rewardPool?: string
  best: PrintableOpportunity | null
  opportunities: PrintableOpportunity[]
}

export type PrintableOpportunity = Omit<Opportunity, 'estimatedProviderRewardAmount' | 'hourlyRewardAmount'>

interface ServiceGuidance {
  duties: string
  mustNot: string
  oracleChecks: string
}

const SERVICE_GUIDANCE: Record<string, ServiceGuidance> = {
  bp: {
    duties: 'Produce and validate blocks only.',
    mustNot: 'Do not serve chain API, trace API, storage, or history under this service.',
    oracleChecks: 'Schedule presence, produced-block sampling, missed-block rate.',
  },
  chainapi: {
    duties: 'Serve chain API RPC requests.',
    mustNot: 'Do not claim trace-history coverage under this service.',
    oracleChecks: 'RPC availability, latency, head freshness, sampled chain responses.',
  },
  traceapi: {
    duties: 'Store and serve transaction/action traces only.',
    mustNot: 'Do not serve chain API RPC requests under this service.',
    oracleChecks: 'Trace lookup availability, sampled trace correctness, range freshness.',
  },
  storage: {
    duties: 'Store declared Harbor artifacts for assigned ranges and serve manifest/file reads.',
    mustNot: 'Do not claim chain API, trace API, or BP duties under this service.',
    oracleChecks: 'Manifest integrity, sampled object hashes, range coverage, freshness.',
  },
  histcore: {
    duties: 'Ingest trace data and build Harbor History slices for a declared block range.',
    mustNot: 'Do not claim public API routing or query service unless separately registered.',
    oracleChecks: 'Slice manifest integrity, sampled range coverage, freshness.',
  },
  histactions: {
    duties: 'Serve account/action history queries for a declared block range.',
    mustNot: 'Do not claim txid lookup, API routing, or core slice storage unless separately registered.',
    oracleChecks: 'Sampled account/action responses, block-range boundaries, freshness.',
  },
  histtx: {
    duties: 'Serve transaction-id lookups for a declared block range.',
    mustNot: 'Do not claim account/action indexing or API routing unless separately registered.',
    oracleChecks: 'Sampled txid responses, block-range boundaries, freshness.',
  },
  histapi: {
    duties: 'Serve the Harbor History-compatible API edge and route range queries to backing indexes.',
    mustNot: 'Do not claim storage or indexing work without a separate range registration.',
    oracleChecks: 'Endpoint availability, routing correctness, latency.',
  },
  histstream: {
    duties: 'Serve real-time Harbor History event streams.',
    mustNot: 'Do not claim archive range coverage from stream availability alone.',
    oracleChecks: 'Stream liveness, head freshness, sampled event delivery.',
  },
  snapshot: {
    duties: 'Publish recent restorable chain snapshots.',
    mustNot: 'Do not use snapshot service to claim live API availability.',
    oracleChecks: 'Snapshot manifest, download sample, block-height freshness.',
  },
  p2pseed: {
    duties: 'Maintain reachable p2p seed connectivity and relay blocks/transactions.',
    mustNot: 'Do not claim BP rewards without producing blocks or API rewards for p2p connectivity.',
    oracleChecks: 'P2P dial, handshake, head freshness, propagation sampling.',
  },
  ibcrelayer: {
    duties: 'Relay configured IBC packets.',
    mustNot: 'Do not claim relayer rewards without configured route liveness.',
    oracleChecks: 'Relay liveness, packet proof sampling, route freshness.',
  },
  aiinfer: {
    duties: 'Serve Qwen3 8B at 4-bit quantization with at least 16 GiB installed RAM.',
    mustNot: 'Do not claim training or routing as inference work.',
    oracleChecks: 'Existing Harbor AI model, token accounting and settlement checks.',
  },
  aitrain: {
    duties: 'Train QLoRA expert adapters on a frozen Qwen3 8B 4-bit base.',
    mustNot: 'Do not modify the base weights.',
    oracleChecks: 'Existing Harbor AI training submission and evaluation checks.',
  },
  sealedcompute: {
    duties: 'Host sealed per-user containers on attestation-capable confidential VMs.',
    mustNot: 'Do not claim unaudited or duplicate lease minutes.',
    oracleChecks: 'Attestation-bound, lease-fenced minute heartbeats and watcher quorum.',
  },
  relay: {
    duties: 'Forward encrypted fallback traffic and hold sealed mail for offline peers.',
    mustNot: 'Do not claim direct traffic as relay deliveries.',
    oracleChecks: 'Recipient-signed delivery ID, ciphertext commitment and delivered bytes.',
  },
  verifier: {
    duties: 'Verify that registered Harbor agents perform their declared duties.',
    mustNot: 'Do not act as a price oracle or claim provider work being verified under this service.',
    oracleChecks: 'Endpoint probes, storage replica audits, service-boundary checks, signed reports.',
  },
}

const DEFAULT_GUIDANCE: ServiceGuidance = {
  duties: 'Run the registered Harbor service described by on-chain metadata.',
  mustNot: 'Do not claim unrelated service duties under this registration.',
  oracleChecks: 'Availability, correctness, and freshness checks.',
}

function guidanceFor(serviceName: string): ServiceGuidance {
  return SERVICE_GUIDANCE[serviceName] ?? DEFAULT_GUIDANCE
}

export function normalizeUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

export async function getTableRows<T>(
  url: string,
  contract: string,
  table: string,
  options: {scope?: string; limit?: number} = {}
): Promise<TableRowsResponse<T>> {
  const page = await readRows<T>(contract, table, {url, ...options, keyType: 'i64'})
  return {...page, next_key: page.next_key ? String(page.next_key) : undefined}
}

export function parseAssetAmount(asset: string): number {
  const [amount] = asset.split(' ')
  return Number(amount)
}

export function assetSymbol(asset: string): string {
  const [, symbol] = asset.split(' ')
  return symbol ?? ''
}

export function isActive(value: boolean | number): boolean {
  return value === true || value === 1
}

export async function allMarketRows<T>(options: MarketOptions, table: string, scope?: string): Promise<T[]> {
  const rows: T[] = []
  const cursors = new Set<string>()
  let lowerBound: string | undefined
  do {
    const page = await readRows<T>(options.contract, table, {
      url: options.url, scope, lowerBound, keyType: 'i64', limit: 500,
    })
    rows.push(...page.rows)
    if (!page.more) return rows
    const next = page.next_key ? String(page.next_key) : ''
    if (!next || cursors.has(next)) throw new Error(`market table ${table} did not advance its pagination cursor`)
    cursors.add(next)
    lowerBound = next
  } while (true)
}

export async function loadMarket(options: MarketOptions, withDemand = false): Promise<MarketSnapshot> {
  const [types, services, state, ttls] = await Promise.all([
    allMarketRows<HarborServiceType>(options, 'svctypes'),
    allMarketRows<HarborService>(options, 'services'),
    getTableRows<HarborState>(options.url, options.contract, 'state'),
    withDemand ? allMarketRows<ServiceTtl>(options, 'svcttls') : undefined,
  ])

  return {types, services, ttls, state: state.rows[0]}
}

function activeProviderCount(serviceType: HarborServiceType, services: HarborService[]): number {
  return services.filter(
    (service) => isActive(service.active) && Number(service.service_type) === Number(serviceType.id)
  ).length
}

function estimateRewardAmount(serviceType: HarborServiceType, activeCount: number): number {
  const participants = Math.max(activeCount, 1)
  const epochBudget = parseAssetAmount(serviceType.epoch_budget)
  const baseReward = parseAssetAmount(serviceType.base_provider_reward)
  return Math.min(baseReward, epochBudget / participants)
}

function formatReward(amount: number, serviceType: HarborServiceType): string {
  const symbol = assetSymbol(serviceType.epoch_budget || serviceType.base_provider_reward)
  return `${amount.toFixed(4)} ${symbol}`
}

export function buildOpportunities(types: HarborServiceType[], services: HarborService[]): Opportunity[] {
  return types.map((type) => {
    const activeProviders = activeProviderCount(type, services)
    const estimatedProviderRewardAmount = estimateRewardAmount(type, activeProviders)
    const guidance = guidanceFor(type.service_name)
    return {
      id: Number(type.id),
      name: type.service_name,
      duties: guidance.duties,
      mustNot: guidance.mustNot,
      oracleChecks: guidance.oracleChecks,
      activeProviders,
      epochBudget: type.epoch_budget,
      estimatedProviderReward: formatReward(estimatedProviderRewardAmount, type),
      estimatedProviderRewardAmount,
      baseProviderReward: type.base_provider_reward,
      status: isActive(type.enabled) ? 'open' : 'disabled',
    }
  })
}

const GiB = 2 ** 30
const MiB = 2 ** 20
export const RELAY_MEMORY_FLOOR = 128 * MiB

interface ServiceCapacity {
  cpuCores: number
  memoryBytes: number
  diskBytes: number
  bandwidthMbps: number
  gpuBytes?: number
  alwaysOn?: boolean
  units: string
  unitsPerHour: number
  scalable?: boolean
}

const CAPACITY: Readonly<Record<string, ServiceCapacity>> = {
  storage: {cpuCores: 0.5, memoryBytes: 512 * MiB, diskBytes: 8 * GiB, bandwidthMbps: 5, alwaysOn: true, units: 'GiB-hours', unitsPerHour: 8, scalable: true},
  p2pseed: {cpuCores: 0.5, memoryBytes: 512 * MiB, diskBytes: 2 * GiB, bandwidthMbps: 5, alwaysOn: true, units: 'seed minutes', unitsPerHour: 60},
  aiinfer: {cpuCores: 1, memoryBytes: Math.ceil(localModel().working_memory_gib * GiB), diskBytes: 6 * GiB, bandwidthMbps: 1, units: 'requests', unitsPerHour: 60, scalable: true},
  aitrain: {cpuCores: 2, memoryBytes: 12 * GiB, diskBytes: 12 * GiB, bandwidthMbps: 1, gpuBytes: 10 * GiB, units: 'adapter jobs', unitsPerHour: 1},
  sealedcompute: {cpuCores: 0.5, memoryBytes: GiB, diskBytes: 2 * GiB, bandwidthMbps: 1, alwaysOn: true, units: 'attested minutes', unitsPerHour: 60, scalable: true},
  relay: {cpuCores: 0.125, memoryBytes: RELAY_MEMORY_FLOOR, diskBytes: 256 * MiB, bandwidthMbps: 1, alwaysOn: true, units: 'MiB delivered', unitsPerHour: 1},
}

export interface OpportunitySelection {
  host: ServiceHost
  limits: ResourceLimits
  exclude?: Set<string>
  now?: number
  agent?: string
}

function demandEstimate(type: HarborServiceType, now: number) {
  try {
    const demand = JSON.parse(type.metadata ?? '{}')?.demand
    if (!demand || !Number.isFinite(demand.unitsPerHour) || demand.unitsPerHour < 0 ||
        typeof demand.unitPrice !== 'string' || typeof demand.expiresAt !== 'string') return undefined
    const expires = Date.parse(demand.expiresAt)
    if (!Number.isFinite(expires) || expires <= now) return undefined
    const price = Asset.from(demand.unitPrice)
    if (!price.symbol.equals(Asset.from(type.epoch_budget).symbol) || price.value < 0) return undefined
    return {unitsPerHour: demand.unitsPerHour as number, price}
  } catch {
    return undefined
  }
}

function hostCapacity(name: string, selection: OpportunitySelection): {units: number; blocked?: string} {
  const need = CAPACITY[name]
  const {host, limits} = selection
  if (!need) return {units: 0, blocked: 'This service requires manual setup or has no capacity profile.'}
  if (host.state?.on_battery) return {units: 0, blocked: 'Host is on battery.'}
  if (host.state?.hot) return {units: 0, blocked: 'Host is thermally constrained.'}
  if (need.alwaysOn && !host.alwaysOn) return {units: 0, blocked: 'Requires an always-on host. Set --always-on when the host can stay available.'}
  if (name === 'sealedcompute' && !host.confidentialVm) return {units: 0, blocked: 'Requires SEV-SNP or TDX host support.'}
  if (name === 'aiinfer' && host.memoryBytes < 16 * GiB) return {units: 0, blocked: 'Qwen3 8B 4-bit requires at least 16 GiB installed RAM.'}
  if (name === 'aitrain' && host.state && host.state.active !== false) return {units: 0, blocked: 'Expert training requires confirmed user inactivity.'}

  const cpu = host.cpuCores * limits.cpu_percent / 100 * (host.state?.active ? 0.5 : 1)
  const ram = Math.min(host.memoryBytes * limits.memory_percent / 100, host.availableMemoryBytes)
  const gpu = host.gpuBytes * limits.gpu_percent / 100
  const disk = host.freeDiskBytes / 2
  const bandwidth = host.bandwidthMbps / 2
  if (cpu < need.cpuCores) return {units: 0, blocked: `Requires ${need.cpuCores} vCPU within the cap.`}
  if (ram < need.memoryBytes) return {units: 0, blocked: `Requires ${(need.memoryBytes / GiB).toFixed(2)} GiB available RAM within the cap.`}
  if (need.gpuBytes && gpu < need.gpuBytes) return {units: 0, blocked: `Requires ${need.gpuBytes / GiB} GiB GPU or unified memory within the cap.`}
  if (disk < need.diskBytes) return {units: 0, blocked: `Requires ${need.diskBytes / MiB} MiB within the disk budget.`}
  if (bandwidth < need.bandwidthMbps) return {units: 0, blocked: `Requires ${need.bandwidthMbps} Mbps within the bandwidth budget. Set --bandwidth-mbps to measured uplink speed.`}

  const slots = Math.floor(Math.min(cpu / need.cpuCores, ram / need.memoryBytes, disk / need.diskBytes, bandwidth / need.bandwidthMbps))
  const inferenceScale = name === 'aiinfer' && gpu < need.memoryBytes ? 0.25 : 1
  const relayUnits = Math.floor(bandwidth * 1e6 * 3600 / (8 * MiB))
  return {units: name === 'relay' ? relayUnits : need.unitsPerHour * (need.scalable ? slots : 1) * inferenceScale}
}

export function rankServiceDemand(snapshot: MarketSnapshot, selection: OpportunitySelection): Opportunity[] {
  const types = new Map(snapshot.types.map((type) => [Number(type.id), type]))
  const now = selection.now ?? Date.now()
  const ttls = new Map(snapshot.ttls?.map((row) => [Number(row.service_type), row.ttl_sec]))
  const activeByType = new Map<number, Set<string>>()
  const liveServices = snapshot.services.filter((service) => {
    const type = Number(service.service_type)
    const time = service.last_heartbeat
    const at = time ? Date.parse(time.endsWith('Z') ? time : `${time}Z`) : NaN
    const ttl = ttls.get(type) ?? ttls.get(0) ?? 300
    if (!isActive(service.active) || !Number.isFinite(at) || at + ttl * 1000 <= now) return false
    let providers = activeByType.get(type)
    if (!providers) {
      providers = new Set()
      activeByType.set(type, providers)
    }
    providers.add(service.provider)
    return true
  })
  return buildOpportunities(snapshot.types, liveServices).map((opportunity) => {
    const type = types.get(opportunity.id)!
    const name = opportunity.name
    const demand = demandEstimate(type, now)
    const capacity = hostCapacity(name, selection)
    const unit = CAPACITY[name]?.units
    const demandFields = {
      unit, demandUnitsPerHour: demand?.unitsPerHour, unitPrice: demand?.price.toString(),
      capacityUnitsPerHour: capacity.blocked ? undefined : capacity.units,
    }

    if (opportunity.status !== 'open') return {...opportunity, ...demandFields, reason: 'Service type disabled on chain.'}
    if (selection.exclude?.has(name)) return {...opportunity, ...demandFields, status: 'excluded', reason: 'Disabled by the operator.'}
    if (capacity.blocked) return {...opportunity, ...demandFields, status: 'ineligible', reason: capacity.blocked}
    if (!demand || !demand.unitsPerHour || !demand.price.value) {
      return {...opportunity, ...demandFields, status: 'no-demand', reason: 'No current priced demand estimate on chain.'}
    }

    const active = activeByType.get(opportunity.id)
    const activeProviders = active?.size ?? 0
    const alreadyActive = selection.agent !== undefined && active?.has(selection.agent)
    const providers = activeProviders + (alreadyActive ? 0 : 1)
    const expectedUnits = Math.min(demand.unitsPerHour / providers, capacity.units)
    const amount = expectedUnits * demand.price.value
    if (!Number.isFinite(amount)) return {...opportunity, ...demandFields, status: 'no-demand', reason: 'Invalid hourly demand estimate.'}
    const reward = `${amount.toFixed(demand.price.symbol.precision)} ${demand.price.symbol.name}`
    const reason = `${expectedUnits.toFixed(2)} ${unit}/hour at ${demand.price} with ${providers} potential provider(s).`
    return {...opportunity, ...demandFields, activeProviders, hourlyRewardAmount: amount, estimatedHourlyReward: reward, reason}
  }).sort((a, b) => (b.hourlyRewardAmount ?? 0) - (a.hourlyRewardAmount ?? 0) || a.id - b.id)
}

export function bestOpportunity(opportunities: Opportunity[]): Opportunity | undefined {
  return opportunities
    .filter((opportunity) => opportunity.status === 'open')
    .sort((a, b) => {
      const rewardDiff = b.estimatedProviderRewardAmount - a.estimatedProviderRewardAmount
      if (rewardDiff !== 0) {
        return rewardDiff
      }

      const budgetDiff = parseAssetAmount(b.epochBudget) - parseAssetAmount(a.epochBudget)
      if (budgetDiff !== 0) {
        return budgetDiff
      }

      const providerDiff = a.activeProviders - b.activeProviders
      if (providerDiff !== 0) {
        return providerDiff
      }

      return a.id - b.id
    })[0]
}

export function printableOpportunity(opportunity: Opportunity): PrintableOpportunity {
  const {estimatedProviderRewardAmount: _estimatedProviderRewardAmount, hourlyRewardAmount: _hourlyRewardAmount, ...printable} = opportunity
  return printable
}

export function printableOpportunities(opportunities: Opportunity[]): PrintableOpportunity[] {
  return opportunities.map(printableOpportunity)
}

export function buildOpportunityReport(snapshot: MarketSnapshot): OpportunityReport {
  const opportunities = buildOpportunities(snapshot.types, snapshot.services)
  const best = bestOpportunity(opportunities)
  return {
    rewardPool: snapshot.state?.reward_pool,
    best: best ? printableOpportunity(best) : null,
    opportunities: printableOpportunities(opportunities),
  }
}

export function recommendation(opportunity: PrintableOpportunity): string {
  return [
    opportunity.estimatedHourlyReward
      ? `Best opportunity: run ${opportunity.name} (service type ${opportunity.id}) for an estimated ${opportunity.estimatedHourlyReward} per hour.
${opportunity.reason}`
      : `Best opportunity: run ${opportunity.name} (service type ${opportunity.id}) for an estimated ${opportunity.estimatedProviderReward} per passing check.`,
    `Duty: ${opportunity.duties}`,
    `Do not: ${opportunity.mustNot}`,
    `Oracle checks: ${opportunity.oracleChecks}`,
  ].join('\n')
}
