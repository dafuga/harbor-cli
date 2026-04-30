import {Command} from 'commander'
import {
  HarborService,
  MarketOptions as OpportunityMarketOptions,
  buildOpportunityReport,
  getTableRows,
  isActive,
  loadMarket,
  recommendation,
} from '@harbor/opportunities/market'
import {buildActionData} from './action-fields.js'
import type {Field} from './action-fields.js'
import {addMarketActionCommands} from './market-actions.js'

export interface MarketOptions extends OpportunityMarketOptions {
  url: string
  contract: string
  json?: boolean
  best?: boolean
}

export type {Field} from './action-fields.js'

export interface ReferralConfig {
  id: number
  enabled: boolean | number
  first_level_bps: number
  decay_bps: number
  max_total_bps: number
}

export interface ReferralLink {
  account: string
  referrer: string
  created_at: string
}

export interface ReferralStats {
  account: string
  direct_invites: number
  total_rewards: string
}

export interface ReferralReport {
  config: ReferralConfig | null
  referrals: ReferralLink[]
  stats: ReferralStats[]
}

export function buildMarketActionData(fields: Field[], values: string[]): Record<string, unknown> {
  return buildActionData(fields, values)
}

async function loadReferralReport(options: MarketOptions): Promise<ReferralReport> {
  const [config, referrals, stats] = await Promise.all([
    getTableRows<ReferralConfig>(options.url, options.contract, 'refcfg'),
    getTableRows<ReferralLink>(options.url, options.contract, 'referrals'),
    getTableRows<ReferralStats>(options.url, options.contract, 'refstats'),
  ])

  return {
    config: config.rows[0] ?? null,
    referrals: referrals.rows,
    stats: stats.rows,
  }
}

function addOpportunitiesCommand(market: Command): void {
  market
    .command('opportunities')
    .description('Show token opportunities for agents')
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
    .option('--json', 'print JSON')
    .option('--best', 'show the best current opportunity for one agent')
    .action(async (options: MarketOptions) => {
      const report = buildOpportunityReport(await loadMarket(options))

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
    .description('Inspect Harbor agent referral tree state')
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
    .option('--json', 'print JSON')
    .action(async (options: MarketOptions) => {
      const report = await loadReferralReport(options)
      if (options.json) {
        console.log(JSON.stringify(report, null, 2))
        return
      }

      console.log(`Referral rewards: ${report.config && isActive(report.config.enabled) ? 'enabled' : 'disabled'}`)
      console.table(report.referrals)
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
