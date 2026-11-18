import {Command} from 'commander'
import {
  HarborService,
  HarborServiceType,
  MarketOptions as OpportunityMarketOptions,
  MarketSnapshot,
  Opportunity,
  bestOpportunity,
  buildOpportunities,
  getTableRows,
  isActive,
  loadMarket,
  recommendation,
} from '../lib/opportunities.js'
import {addTxOptions, pushJsonAction} from './action.js'
import {buildActionData} from './action-fields.js'
import type {Field} from './action-fields.js'
import {addMarketActionCommands} from './market-actions.js'

export interface MarketOptions extends OpportunityMarketOptions {
  url: string
  contract: string
  json?: boolean
  best?: boolean
  agent?: string
}

export type {Field} from './action-fields.js'

export interface UnableOpportunity {
  service_type: number
  service_name: string
  reason: string
  metadata: string
  updated_at: string
}

export type OpportunityWithUnable = Opportunity & {
  unableReason?: string
  unableMetadata?: string
  unableUpdatedAt?: string
}

export type PrintableOpportunityWithUnable = Omit<OpportunityWithUnable, 'estimatedProviderRewardAmount'>

export interface AgentOpportunityReport {
  rewardPool?: string
  agent?: string
  unable: UnableOpportunity[]
  best: PrintableOpportunityWithUnable | null
  opportunities: PrintableOpportunityWithUnable[]
}

export interface ReferralStats {
  account: string
  direct_invites: number
  total_rewards: string
}

export interface ReferralReport {
  note: string
  stats: ReferralStats[]
}

export function buildMarketActionData(fields: Field[], values: string[]): Record<string, unknown> {
  return buildActionData(fields, values)
}

function printableOpportunityWithUnable(opportunity: OpportunityWithUnable): PrintableOpportunityWithUnable {
  const {estimatedProviderRewardAmount: _estimatedProviderRewardAmount, ...printable} = opportunity
  return printable
}

export function buildAgentOpportunityReportFromSnapshot(
  snapshot: MarketSnapshot,
  unableRows: UnableOpportunity[] = [],
  agent?: string
): AgentOpportunityReport {
  const unableByServiceType = new Map(unableRows.map((row) => [Number(row.service_type), row]))
  const opportunities: OpportunityWithUnable[] = buildOpportunities(snapshot.types, snapshot.services).map((opportunity) => {
    const unable = unableByServiceType.get(opportunity.id)
    if (!unable) {
      return opportunity
    }

    return {
      ...opportunity,
      status: 'unable',
      unableReason: unable.reason,
      unableMetadata: unable.metadata,
      unableUpdatedAt: unable.updated_at,
    }
  })
  const best = bestOpportunity(opportunities)

  return {
    rewardPool: snapshot.state?.reward_pool,
    agent,
    unable: unableRows,
    best: best ? printableOpportunityWithUnable(best as OpportunityWithUnable) : null,
    opportunities: opportunities.map(printableOpportunityWithUnable),
  }
}

async function loadUnableOpportunities(options: MarketOptions): Promise<UnableOpportunity[]> {
  if (!options.agent) {
    return []
  }

  const unable = await getTableRows<UnableOpportunity>(options.url, options.contract, 'unables', {scope: options.agent})
  return unable.rows
}

async function buildAgentOpportunityReport(options: MarketOptions): Promise<AgentOpportunityReport> {
  const [snapshot, unableRows] = await Promise.all([
    loadMarket(options),
    loadUnableOpportunities(options),
  ])
  return buildAgentOpportunityReportFromSnapshot(snapshot, unableRows, options.agent)
}

function serviceTypeMatches(serviceType: HarborServiceType, service: string): boolean {
  const id = Number(service)
  if (Number.isInteger(id) && Number(serviceType.id) === id) {
    return true
  }
  return serviceType.service_name === service
}

async function resolveServiceType(options: Pick<MarketOptions, 'url' | 'contract'>, service: string): Promise<HarborServiceType> {
  const serviceTypes = await getTableRows<HarborServiceType>(options.url, options.contract, 'svctypes')
  const serviceType = serviceTypes.rows.find((row) => serviceTypeMatches(row, service))
  if (!serviceType) {
    throw new Error(`unknown service opportunity: ${service}`)
  }
  return serviceType
}

async function loadReferralReport(options: MarketOptions): Promise<ReferralReport> {
  const stats = await getTableRows<ReferralStats>(
    options.url,
    options.contract,
    'refstats',
  )

  return {
    note: 'Invite configuration and links live in eosio native state; SvcMarket exposes reward stats only.',
    stats: stats.rows,
  }
}

function addOpportunitiesCommand(market: Command): void {
  const opportunities = new Command('opportunities')
  opportunities
    .description('Show token opportunities for agents')
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
    .option('-a, --agent <account>', 'agent account used to filter unable opportunities')
    .option('--json', 'print JSON')
    .option('--best', 'show the best current opportunity for one agent')
    .action(async (options: MarketOptions) => {
      const report = await buildAgentOpportunityReport(options)

      if (options.json) {
        console.log(JSON.stringify(report, null, 2))
        return
      }

      console.log(`Reward pool: ${report.rewardPool ?? 'unknown'}`)
      if (options.best) {
        if (!report.best) {
          console.log('No open opportunities.')
          return
        }

        console.log(recommendation(report.best))
        console.table([report.best])
        return
      }

      console.table(report.opportunities)
    })

  addTxOptions(
    opportunities
      .command('unable <agent> <service> <reason>')
      .description('Tell Harbor this agent cannot do an opportunity')
      .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
      .option('-m, --metadata <json>', 'operator metadata', '{}')
  ).action(async (agent: string, service: string, reason: string, options: MarketOptions & {actor?: string; metadata?: string}) => {
    const serviceType = await resolveServiceType(options, service)
    await pushJsonAction(
      String(options.contract),
      'unable',
      {
        agent,
        service_type: Number(serviceType.id),
        reason,
        metadata: options.metadata ?? '{}',
      },
      {...options, actor: options.actor ?? agent}
    )
  })

  addTxOptions(
    opportunities
      .command('able <agent> <service>')
      .description('Clear an unable opportunity marker for an agent')
      .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
  ).action(async (agent: string, service: string, options: MarketOptions & {actor?: string}) => {
    const serviceType = await resolveServiceType(options, service)
    await pushJsonAction(
      String(options.contract),
      'able',
      {
        agent,
        service_type: Number(serviceType.id),
      },
      {...options, actor: options.actor ?? agent}
    )
  })

  market.addCommand(opportunities)
}

function addServicesCommand(market: Command): void {
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
}

function addReferralsCommand(market: Command): void {
  market
    .command('referrals')
    .description('Inspect SvcMarket native-invite reward stats')
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
    .option('--json', 'print JSON')
    .action(async (options: MarketOptions) => {
      const report = await loadReferralReport(options)
      if (options.json) {
        console.log(JSON.stringify(report, null, 2))
        return
      }

      console.log(report.note)
      console.table(report.stats)
    })
}

export function createMarketCommand(): Command {
  const market = new Command('market')
  market.description('Inspect Harbor service-market opportunities')
  addOpportunitiesCommand(market)
  addServicesCommand(market)
  addReferralsCommand(market)
  addMarketActionCommands(market)

  return market
}
