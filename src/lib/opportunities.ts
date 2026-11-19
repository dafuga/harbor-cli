import {getTableRows as readRows} from './tx.js'
import {demandRanking, liveProviderRows} from '../utils/market-services/demandRanking.js'
import type {OpportunitySelection} from '../utils/market-services/demandRanking.types.js'

export type {OpportunitySelection} from '../utils/market-services/demandRanking.types.js'
export {RELAY_MEMORY_FLOOR} from '../utils/market-services/serviceEligibility.js'

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

export function rankServiceDemand(snapshot: MarketSnapshot, selection: OpportunitySelection): Opportunity[] {
  const now = selection.now ?? Date.now()
  const services = liveProviderRows(snapshot, now)
  return demandRanking(buildOpportunities(snapshot.types, services), {...snapshot, services}, {...selection, now})
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
