import { Command } from 'commander';
import { assetSymbol, getTableRows, isActive, parseAssetAmount, } from '../lib/chain.js';
async function loadMarket(options) {
    const [types, services, state] = await Promise.all([
        getTableRows(options.url, options.contract, 'svctypes'),
        getTableRows(options.url, options.contract, 'services'),
        getTableRows(options.url, options.contract, 'state'),
    ]);
    return {
        types: types.rows,
        services: services.rows,
        state: state.rows[0],
    };
}
function estimateReward(serviceType, services) {
    const activeCount = services.filter((service) => isActive(service.active) && service.service_type === Number(serviceType.id)).length;
    const participants = Math.max(activeCount, 1);
    const epochBudget = parseAssetAmount(serviceType.epoch_budget);
    const baseReward = parseAssetAmount(serviceType.base_provider_reward);
    const symbol = assetSymbol(serviceType.epoch_budget || serviceType.base_provider_reward);
    const amount = Math.min(baseReward, epochBudget / participants);
    return `${amount.toFixed(4)} ${symbol}`;
}
function buildOpportunities(types, services) {
    return types.map((type) => {
        const activeProviders = services.filter((service) => isActive(service.active) && service.service_type === Number(type.id)).length;
        return {
            id: Number(type.id),
            name: type.name,
            activeProviders,
            epochBudget: type.epoch_budget,
            estimatedProviderReward: estimateReward(type, services),
            baseProviderReward: type.base_provider_reward,
            status: isActive(type.enabled) ? 'open' : 'disabled',
        };
    });
}
export function createMarketCommand() {
    const market = new Command('market');
    market.description('Inspect Harbor service-market opportunities');
    market
        .command('opportunities')
        .description('Show token opportunities for agents')
        .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
        .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
        .option('--json', 'print JSON')
        .action(async (options) => {
        const { types, services, state } = await loadMarket(options);
        const opportunities = buildOpportunities(types, services);
        if (options.json) {
            console.log(JSON.stringify({ rewardPool: state?.reward_pool, opportunities }, null, 2));
            return;
        }
        console.log(`Reward pool: ${state?.reward_pool ?? 'unknown'}`);
        console.table(opportunities);
    });
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
    return market;
}
