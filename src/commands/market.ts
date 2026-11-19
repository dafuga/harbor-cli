import fs from 'node:fs/promises'
import {Command} from 'commander'
import {
  HarborService,
  HarborServiceType,
  MarketOptions as OpportunityMarketOptions,
  MarketSnapshot,
  Opportunity,
  allMarketRows,
  bestOpportunity,
  buildOpportunities,
  getTableRows,
  isActive,
  loadMarket,
  type OpportunitySelection,
  printableOpportunity,
  rankServiceDemand,
  recommendation,
} from '../lib/opportunities.js'
import {addTxOptions, pushJsonAction} from './action.js'
import type {SignedRelayReceipt} from '../lib/relay-receipt.js'
import {printResult} from '../lib/tx.js'
import {relayPayment} from '../utils/market-services/relayPayment.js'
import type {RelayPaymentOptions} from '../utils/market-services/relayPayment.types.js'
import {buildActionData} from './action-fields.js'
import type {Field} from './action-fields.js'
import {addMarketActionCommands} from './market-actions.js'
import {defaultRuntimeDataDir, normalizeServiceName} from '../lib/artifacts.js'
import {serviceHost, type ServiceHostOptions} from '../lib/host-policy.js'
import {marketLimits, type LimitOptions} from '../lib/resource-limits.js'

export interface MarketOptions extends OpportunityMarketOptions, ServiceHostOptions, LimitOptions {
  url: string
  contract: string
  json?: boolean
  best?: boolean
  agent?: string
  exclude?: string[]
  dataDir?: string
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

export type PrintableOpportunityWithUnable = Omit<OpportunityWithUnable, 'estimatedProviderRewardAmount' | 'hourlyRewardAmount'>

export interface AgentOpportunityReport {
  rewardPool?: string
  agent?: string
  unable: UnableOpportunity[]
  best: PrintableOpportunityWithUnable | null
  opportunities: PrintableOpportunityWithUnable[]
  hardwareSource?: 'detected' | 'simulated'
  hardware?: {
    cpuCores: number
    memoryBytes: number
    gpuKind: string
    confidentialVm: string | null
  }
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

export function buildAgentOpportunityReportFromSnapshot(
  snapshot: MarketSnapshot,
  unableRows: UnableOpportunity[] = [],
  agent?: string,
  selection?: OpportunitySelection
): AgentOpportunityReport {
  const unableByServiceType = new Map(unableRows.map((row) => [Number(row.service_type), row]))
  const candidates = selection
    ? rankServiceDemand(snapshot, {...selection, agent})
    : buildOpportunities(snapshot.types, snapshot.services)
  const opportunities: OpportunityWithUnable[] = candidates.map((opportunity) => {
    const unable = unableByServiceType.get(opportunity.id)
    if (!unable) {
      return opportunity
    }

    return {
      ...opportunity,
      status: 'unable',
      reason: unable.reason,
      hourlyRewardAmount: undefined,
      estimatedHourlyReward: undefined,
      unableReason: unable.reason,
      unableMetadata: unable.metadata,
      unableUpdatedAt: unable.updated_at,
    }
  })
  const best = selection
    ? opportunities.find((opportunity) => opportunity.status === 'open' && (opportunity.hourlyRewardAmount ?? 0) > 0)
    : bestOpportunity(opportunities)

  return {
    rewardPool: snapshot.state?.reward_pool,
    agent,
    unable: unableRows,
    best: best ? printableOpportunity(best) : null,
    opportunities: opportunities.map(printableOpportunity),
  }
}

async function loadUnableOpportunities(options: MarketOptions): Promise<UnableOpportunity[]> {
  if (!options.agent) {
    return []
  }

  return allMarketRows<UnableOpportunity>(options, 'unables', options.agent)
}

export function addMarketSelectionOptions(command: Command): Command {
  return command
    .option('--hardware-profile <path>', 'diagnostic JSON profile for a simulated host')
    .option('--always-on', 'this host can stay online for background services')
    .option('--bandwidth-mbps <mbps>', 'measured available uplink before applying the 50% budget')
    .option('--exclude <service...>', 'omit these services from demand-based selection')
}

export async function buildAgentOpportunityReport(options: MarketOptions): Promise<AgentOpportunityReport> {
  const [snapshot, unableRows, selection] = await Promise.all([
    loadMarket(options, Boolean(options.best)),
    loadUnableOpportunities(options),
    options.best && Promise.all([
      serviceHost(options.dataDir ?? defaultRuntimeDataDir(), options),
      marketLimits(options),
    ]).then(([host, limits]) => ({
      host, limits, exclude: new Set(options.exclude?.map((name) => normalizeServiceName(name).name)),
    })),
  ])
  const report = buildAgentOpportunityReportFromSnapshot(snapshot, unableRows, options.agent, selection || undefined)
  if (selection) {
    const {cpuCores, memoryBytes, gpuKind, confidentialVm} = selection.host
    report.hardwareSource = options.hardwareProfile ? 'simulated' : 'detected'
    report.hardware = {cpuCores, memoryBytes, gpuKind, confidentialVm}
  }
  return report
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
  addMarketSelectionOptions(opportunities)
    .description('Show token opportunities for agents')
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
    .option('-a, --agent <account>', 'agent account used to filter unable opportunities')
    .option('--json', 'print JSON')
    .option('--cpu-percent <percent>', 'CPU share, capped at 50%')
    .option('--memory-percent <percent>', 'RAM share, capped at 50%')
    .option('--gpu-percent <percent>', 'GPU share, capped at 50%')
    .option('--data-dir <path>', 'runtime directory whose available disk space is checked')
    .option('--best', 'rank by estimated hourly earnings for this host')
    .action(async (options: MarketOptions) => {
      const report = await buildAgentOpportunityReport(options)

      if (options.json) {
        console.log(JSON.stringify(report, null, 2))
        return
      }

      console.log(`Reward pool: ${report.rewardPool ?? 'unknown'}`)
      if (options.best) {
        console.log(report.best ? recommendation(report.best) : 'No eligible opportunity with current priced demand.')
        console.table(report.opportunities.map(({name, status, estimatedHourlyReward, reason}) => ({
          name, status, estimatedHourlyReward, reason,
        })))
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

function addRelayPaymentCommand(market: Command): void {
  addTxOptions(market.command('pay-relay <receipt-file>'))
    .description('Pay a recipient-signed Harbor relay delivery once')
    .requiredOption('--recipient-key <public-key>', 'previously authorized one-time recipient receipt key')
    .option('--relay-contract <account>', 'delivery settlement contract account', 'harborrelay')
    .option('--yes', 'approve the exact payment without an interactive prompt')
    .action(async (file: string, options: RelayPaymentOptions) => {
      const receipt = JSON.parse(await fs.readFile(file, 'utf8')) as SignedRelayReceipt
      const result = await relayPayment(receipt, options)
      printResult(result, options.json)
    })
}

export function createMarketCommand(): Command {
  const market = new Command('market')
  market.description('Inspect Harbor service-market opportunities')
  addOpportunitiesCommand(market)
  addRelayPaymentCommand(market)
  addServicesCommand(market)
  addReferralsCommand(market)
  addMarketActionCommands(market)

  return market
}
