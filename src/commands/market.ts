import {Command} from 'commander'
import {
  HarborService,
  MarketOptions as OpportunityMarketOptions,
  buildOpportunityReport,
  loadMarket,
  recommendation,
  getTableRows,
  isActive,
} from '@harbor/opportunities/market'

export interface MarketOptions extends OpportunityMarketOptions {
  url: string
  contract: string
  json?: boolean
  best?: boolean
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
