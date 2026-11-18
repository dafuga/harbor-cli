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

export interface MarketSnapshot {
  types: HarborServiceType[]
  services: HarborService[]
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
}

export interface OpportunityReport {
  rewardPool?: string
  best: PrintableOpportunity | null
  opportunities: PrintableOpportunity[]
}

export type PrintableOpportunity = Omit<Opportunity, 'estimatedProviderRewardAmount'>

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
  const response = await fetch(`${normalizeUrl(url)}/v1/chain/get_table_rows`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      json: true,
      code: contract,
      scope: options.scope ?? contract,
      table,
      limit: options.limit ?? 100,
    }),
  })

  if (!response.ok) {
    throw new Error(`get_table_rows ${contract}::${table} failed: ${response.status}`)
  }

  return (await response.json()) as TableRowsResponse<T>
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

export async function loadMarket(options: MarketOptions): Promise<MarketSnapshot> {
  const [types, services, state] = await Promise.all([
    getTableRows<HarborServiceType>(options.url, options.contract, 'svctypes'),
    getTableRows<HarborService>(options.url, options.contract, 'services'),
    getTableRows<HarborState>(options.url, options.contract, 'state'),
  ])

  return {
    types: types.rows,
    services: services.rows,
    state: state.rows[0],
  }
}

function activeProviderCount(serviceType: HarborServiceType, services: HarborService[]): number {
  return services.filter(
    (service) => isActive(service.active) && service.service_type === Number(serviceType.id)
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
  const {estimatedProviderRewardAmount: _estimatedProviderRewardAmount, ...printable} = opportunity
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
    `Best opportunity: run ${opportunity.name} (service type ${opportunity.id}) for an estimated ${opportunity.estimatedProviderReward} per passing check.`,
    `Duty: ${opportunity.duties}`,
    `Do not: ${opportunity.mustNot}`,
    `Oracle checks: ${opportunity.oracleChecks}`,
  ].join('\n')
}
