import {Command} from 'commander'
import {
  HarborService,
  HarborServiceType,
  HarborState,
  assetSymbol,
  getTableRows,
  isActive,
  parseAssetAmount,
} from '../lib/chain.js'

export interface MarketOptions {
  url: string
  contract: string
  json?: boolean
  best?: boolean
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
  robocore: {
    duties: 'Ingest trace data and build Roborovski history slices for a declared block range.',
    mustNot: 'Do not claim public API routing or query service unless separately registered.',
    oracleChecks: 'Slice manifest integrity, sampled range coverage, freshness.',
  },
  roboactions: {
    duties: 'Serve account/action history queries for a declared block range.',
    mustNot: 'Do not claim txid lookup, API routing, or core slice storage unless separately registered.',
    oracleChecks: 'Sampled account/action responses, block-range boundaries, freshness.',
  },
  robotx: {
    duties: 'Serve transaction-id lookups for a declared block range.',
    mustNot: 'Do not claim account/action indexing or API routing unless separately registered.',
    oracleChecks: 'Sampled txid responses, block-range boundaries, freshness.',
  },
  roboapi: {
    duties: 'Serve the Roborovski-compatible API edge and route range queries to backing indexes.',
    mustNot: 'Do not claim storage or indexing work without a separate range registration.',
    oracleChecks: 'Endpoint availability, routing correctness, latency.',
  },
  robostream: {
    duties: 'Serve real-time Roborovski history/event streams.',
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
}

const DEFAULT_GUIDANCE: ServiceGuidance = {
  duties: 'Run the registered Harbor service described by on-chain metadata.',
  mustNot: 'Do not claim unrelated service duties under this registration.',
  oracleChecks: 'Availability, correctness, and freshness checks.',
}

function guidanceFor(serviceName: string): ServiceGuidance {
  return SERVICE_GUIDANCE[serviceName] ?? DEFAULT_GUIDANCE
}

export async function loadMarket(options: MarketOptions) {
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

function printableOpportunity(opportunity: Opportunity) {
  const {estimatedProviderRewardAmount: _estimatedProviderRewardAmount, ...printable} = opportunity
  return printable
}

function printableOpportunities(opportunities: Opportunity[]) {
  return opportunities.map(printableOpportunity)
}

function recommendation(opportunity: Opportunity): string {
  return [
    `Best opportunity: run ${opportunity.name} (service type ${opportunity.id}) for an estimated ${opportunity.estimatedProviderReward} per passing check.`,
    `Duty: ${opportunity.duties}`,
    `Do not: ${opportunity.mustNot}`,
    `Oracle checks: ${opportunity.oracleChecks}`,
  ].join('\n')
}

export function createMarketCommand(): Command {
  const market = new Command('market')
  market.description('Inspect Harbor service-market opportunities')

  market
    .command('opportunities')
    .description('Show token opportunities for agents')
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
    .option('--json', 'print JSON')
    .option('--best', 'show the best current opportunity for one agent')
    .action(async (options: MarketOptions) => {
      const {types, services, state} = await loadMarket(options)
      const opportunities = buildOpportunities(types, services)
      const best = bestOpportunity(opportunities)

      if (options.json) {
        console.log(JSON.stringify({
          rewardPool: state?.reward_pool,
          best: best ? printableOpportunity(best) : null,
          opportunities: printableOpportunities(opportunities),
        }, null, 2))
        return
      }

      console.log(`Reward pool: ${state?.reward_pool ?? 'unknown'}`)
      if (options.best) {
        if (!best) {
          console.log('No open opportunities.')
          return
        }

        console.log(recommendation(best))
        console.table([printableOpportunity(best)])
        return
      }

      console.table(printableOpportunities(opportunities))
    })

  market
    .command('services')
    .description('List registered services')
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
    .option('--json', 'print JSON')
    .action(async (options: MarketOptions) => {
      const services = await getTableRows<HarborService>(options.url, options.contract, 'services')
      if (options.json) {
        console.log(JSON.stringify(services.rows, null, 2))
        return
      }

      console.table(
        services.rows.map((service) => ({
          id: service.id,
          provider: service.provider,
          type: service.service_type,
          active: isActive(service.active),
          capacity: service.capacity_bytes,
          endpoint: service.endpoint,
        }))
      )
    })

  return market
}
