import { Command } from 'commander';
import { assetSymbol, getTableRows, isActive, parseAssetAmount, } from '../lib/chain.js';
export async function loadMarket(options) {
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
function activeProviderCount(serviceType, services) {
    return services.filter((service) => isActive(service.active) && service.service_type === Number(serviceType.id)).length;
}
function estimateRewardAmount(serviceType, activeCount) {
    const participants = Math.max(activeCount, 1);
    const epochBudget = parseAssetAmount(serviceType.epoch_budget);
    const baseReward = parseAssetAmount(serviceType.base_provider_reward);
    return Math.min(baseReward, epochBudget / participants);
}
function formatReward(amount, serviceType) {
    const symbol = assetSymbol(serviceType.epoch_budget || serviceType.base_provider_reward);
    return `${amount.toFixed(4)} ${symbol}`;
}
export function buildOpportunities(types, services) {
    return types.map((type) => {
        const activeProviders = activeProviderCount(type, services);
        const estimatedProviderRewardAmount = estimateRewardAmount(type, activeProviders);
        return {
            id: Number(type.id),
            name: type.service_name,
            activeProviders,
            epochBudget: type.epoch_budget,
            estimatedProviderReward: formatReward(estimatedProviderRewardAmount, type),
            estimatedProviderRewardAmount,
            baseProviderReward: type.base_provider_reward,
            status: isActive(type.enabled) ? 'open' : 'disabled',
        };
    });
}
export function bestOpportunity(opportunities) {
    return opportunities
        .filter((opportunity) => opportunity.status === 'open')
        .sort((a, b) => {
        const rewardDiff = b.estimatedProviderRewardAmount - a.estimatedProviderRewardAmount;
        if (rewardDiff !== 0) {
            return rewardDiff;
        }
        const budgetDiff = parseAssetAmount(b.epochBudget) - parseAssetAmount(a.epochBudget);
        if (budgetDiff !== 0) {
            return budgetDiff;
        }
        const providerDiff = a.activeProviders - b.activeProviders;
        if (providerDiff !== 0) {
            return providerDiff;
        }
        return a.id - b.id;
    })[0];
}
function printableOpportunity(opportunity) {
    const { estimatedProviderRewardAmount: _estimatedProviderRewardAmount, ...printable } = opportunity;
    return printable;
}
function printableOpportunities(opportunities) {
    return opportunities.map(printableOpportunity);
}
function recommendation(opportunity) {
    return `Best opportunity: run ${opportunity.name} (service type ${opportunity.id}) for an estimated ${opportunity.estimatedProviderReward} per passing check.`;
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
        .option('--best', 'show the best current opportunity for one agent')
        .action(async (options) => {
        const { types, services, state } = await loadMarket(options);
        const opportunities = buildOpportunities(types, services);
        const best = bestOpportunity(opportunities);
        if (options.json) {
            console.log(JSON.stringify({
                rewardPool: state?.reward_pool,
                best: best ? printableOpportunity(best) : null,
                opportunities: printableOpportunities(opportunities),
            }, null, 2));
            return;
        }
        console.log(`Reward pool: ${state?.reward_pool ?? 'unknown'}`);
        if (options.best) {
            if (!best) {
                console.log('No open opportunities.');
                return;
            }
            console.log(recommendation(best));
            console.table([printableOpportunity(best)]);
            return;
        }
        console.table(printableOpportunities(opportunities));
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
