import { Command } from 'commander';
import { bestOpportunity, buildOpportunities, getTableRows, isActive, loadMarket, recommendation, } from '@harbor/opportunities/market';
import { addTxOptions, pushJsonAction } from './action.js';
import { buildActionData } from './action-fields.js';
import { addMarketActionCommands } from './market-actions.js';
export function buildMarketActionData(fields, values) {
    return buildActionData(fields, values);
}
function printableOpportunityWithUnable(opportunity) {
    const { estimatedProviderRewardAmount: _estimatedProviderRewardAmount, ...printable } = opportunity;
    return printable;
}
export function buildAgentOpportunityReportFromSnapshot(snapshot, unableRows = [], agent) {
    const unableByServiceType = new Map(unableRows.map((row) => [Number(row.service_type), row]));
    const opportunities = buildOpportunities(snapshot.types, snapshot.services).map((opportunity) => {
        const unable = unableByServiceType.get(opportunity.id);
        if (!unable) {
            return opportunity;
        }
        return {
            ...opportunity,
            status: 'unable',
            unableReason: unable.reason,
            unableMetadata: unable.metadata,
            unableUpdatedAt: unable.updated_at,
        };
    });
    const best = bestOpportunity(opportunities);
    return {
        rewardPool: snapshot.state?.reward_pool,
        agent,
        unable: unableRows,
        best: best ? printableOpportunityWithUnable(best) : null,
        opportunities: opportunities.map(printableOpportunityWithUnable),
    };
}
async function loadUnableOpportunities(options) {
    if (!options.agent) {
        return [];
    }
    const unable = await getTableRows(options.url, options.contract, 'unables', { scope: options.agent });
    return unable.rows;
}
async function buildAgentOpportunityReport(options) {
    const [snapshot, unableRows] = await Promise.all([
        loadMarket(options),
        loadUnableOpportunities(options),
    ]);
    return buildAgentOpportunityReportFromSnapshot(snapshot, unableRows, options.agent);
}
function serviceTypeMatches(serviceType, service) {
    const id = Number(service);
    if (Number.isInteger(id) && Number(serviceType.id) === id) {
        return true;
    }
    return serviceType.service_name === service;
}
async function resolveServiceType(options, service) {
    const serviceTypes = await getTableRows(options.url, options.contract, 'svctypes');
    const serviceType = serviceTypes.rows.find((row) => serviceTypeMatches(row, service));
    if (!serviceType) {
        throw new Error(`unknown service opportunity: ${service}`);
    }
    return serviceType;
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
    const opportunities = new Command('opportunities');
    opportunities
        .description('Show token opportunities for agents')
        .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
        .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
        .option('-a, --agent <account>', 'agent account used to filter unable opportunities')
        .option('--json', 'print JSON')
        .option('--best', 'show the best current opportunity for one agent')
        .action(async (options) => {
        const report = await buildAgentOpportunityReport(options);
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
    addTxOptions(opportunities
        .command('unable <agent> <service> <reason>')
        .description('Tell Harbor this agent cannot do an opportunity')
        .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
        .option('-m, --metadata <json>', 'operator metadata', '{}')).action(async (agent, service, reason, options) => {
        const serviceType = await resolveServiceType(options, service);
        await pushJsonAction(String(options.contract), 'unable', {
            agent,
            service_type: Number(serviceType.id),
            reason,
            metadata: options.metadata ?? '{}',
        }, { ...options, actor: options.actor ?? agent });
    });
    addTxOptions(opportunities
        .command('able <agent> <service>')
        .description('Clear an unable opportunity marker for an agent')
        .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')).action(async (agent, service, options) => {
        const serviceType = await resolveServiceType(options, service);
        await pushJsonAction(String(options.contract), 'able', {
            agent,
            service_type: Number(serviceType.id),
        }, { ...options, actor: options.actor ?? agent });
    });
    market.addCommand(opportunities);
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
