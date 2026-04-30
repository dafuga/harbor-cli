import { Command } from 'commander';
import { buildOpportunityReport, getTableRows, isActive, loadMarket, recommendation, } from '@harbor/opportunities/market';
import { buildActionData } from './action-fields.js';
import { addMarketActionCommands } from './market-actions.js';
export function buildMarketActionData(fields, values) {
    return buildActionData(fields, values);
}
async function loadReferralReport(options) {
    const [config, referrals, stats] = await Promise.all([
        getTableRows(options.url, options.contract, 'refcfg'),
        getTableRows(options.url, options.contract, 'referrals'),
        getTableRows(options.url, options.contract, 'refstats'),
    ]);
    return {
        config: config.rows[0] ?? null,
        referrals: referrals.rows,
        stats: stats.rows,
    };
}
function addOpportunitiesCommand(market) {
    market
        .command('opportunities')
        .description('Show token opportunities for agents')
        .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
        .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
        .option('--json', 'print JSON')
        .option('--best', 'show the best current opportunity for one agent')
        .action(async (options) => {
        const report = buildOpportunityReport(await loadMarket(options));
        if (options.json) {
            console.log(JSON.stringify(report, null, 2));
            return;
        }
        console.log(`Reward pool: ${report.rewardPool ?? 'unknown'}`);
        if (options.best) {
            if (!report.best) {
                console.log('No open opportunities.');
                return;
            }
            console.log(recommendation(report.best));
            console.table([report.best]);
            return;
        }
        console.table(report.opportunities);
    });
}
function addServicesCommand(market) {
    market
        .command('services')
        .description('List registered services')
        .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
        .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
        .option('--json', 'print JSON')
        .action(async (options) => {
        const services = await getTableRows(options.url, options.contract, 'services');
        if (options.json) {
            console.log(JSON.stringify(services.rows, null, 2));
            return;
        }
        console.table(services.rows.map((service) => ({
            id: service.id,
            provider: service.provider,
            type: service.service_type,
            active: isActive(service.active),
            capacity: service.capacity_bytes,
            endpoint: service.endpoint,
        })));
    });
}
function addReferralsCommand(market) {
    market
        .command('referrals')
        .description('Inspect Harbor agent referral tree state')
        .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
        .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
        .option('--json', 'print JSON')
        .action(async (options) => {
        const report = await loadReferralReport(options);
        if (options.json) {
            console.log(JSON.stringify(report, null, 2));
            return;
        }
        console.log(`Referral rewards: ${report.config && isActive(report.config.enabled) ? 'enabled' : 'disabled'}`);
        console.table(report.referrals);
        console.table(report.stats);
    });
}
export function createMarketCommand() {
    const market = new Command('market');
    market.description('Inspect Harbor service-market opportunities');
    addOpportunitiesCommand(market);
    addServicesCommand(market);
    addReferralsCommand(market);
    addMarketActionCommands(market);
    return market;
}
