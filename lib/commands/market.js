import { Command } from 'commander';
import { buildOpportunityReport, loadMarket, recommendation, getTableRows, isActive, } from '@harbor/opportunities/market';
import { addTxOptions, pushJsonAction } from './action.js';
function fieldName(field) {
    return Array.isArray(field) ? field[0] : field;
}
function fieldType(field) {
    return Array.isArray(field) ? field[1] : 'string';
}
function parseField(value, type) {
    if (type === 'number') {
        return Number(value);
    }
    if (type === 'boolean') {
        return value === 'true' || value === '1';
    }
    if (type === 'json') {
        return JSON.parse(value);
    }
    return value;
}
function actionOptions(args) {
    const last = args.at(-1);
    if (last && typeof last.optsWithGlobals === 'function') {
        return last.optsWithGlobals();
    }
    if (last && typeof last.opts === 'function') {
        return last.opts();
    }
    return last;
}
function addMarketAction(root, commandName, action, fields, signerField) {
    let cmd = root.command(commandName);
    cmd.description(`Push ${action}`);
    for (const field of fields) {
        cmd = cmd.argument(`<${fieldName(field)}>`);
    }
    cmd.option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket');
    addTxOptions(cmd).action(async (...args) => {
        const options = actionOptions(args);
        const values = args.slice(0, -1);
        const data = Object.fromEntries(fields.map((field, index) => [fieldName(field), parseField(values[index], fieldType(field))]));
        const signer = signerField ? String(data[signerField]) : undefined;
        await pushJsonAction(String(options.contract), action, data, { ...options, actor: String(options.actor ?? signer) });
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
    addMarketAction(market, 'configure', 'setparams', [
        'token_symbol',
        'provider_pass_reward',
        'provider_fail_penalty',
        'oracle_agree_reward',
        'oracle_disagree_penalty',
        'oracle_miss_penalty',
        ['min_oracle_reports', 'number'],
        ['min_check_window_sec', 'number'],
        ['max_endpoint_size', 'number'],
        ['max_metadata_size', 'number'],
    ]);
    addMarketAction(market, 'set-service-type', 'setsvctype', [
        ['service_type', 'number'],
        'service_name',
        ['enabled', 'boolean'],
        ['reward_weight', 'number'],
        'epoch_budget',
        'base_provider_reward',
        'provider_fail_penalty',
        'oracle_agree_reward',
        'oracle_disagree_penalty',
        'oracle_miss_penalty',
        'min_provider_stake',
        'min_oracle_stake',
        ['min_oracle_reports', 'number'],
        ['min_check_window_sec', 'number'],
        'metadata',
    ]);
    addMarketAction(market, 'register-provider', 'regprovider', ['provider', 'metadata'], 'provider');
    addMarketAction(market, 'unregister-provider', 'unregprov', ['provider'], 'provider');
    addMarketAction(market, 'register-oracle', 'regoracle', ['oracle', ['supported_service_mask', 'number'], 'metadata'], 'oracle');
    addMarketAction(market, 'unregister-oracle', 'unregoracle', ['oracle'], 'oracle');
    addMarketAction(market, 'stake-provider', 'stakeprov', ['provider', 'quantity'], 'provider');
    addMarketAction(market, 'stake-oracle', 'stakeoracle', ['oracle', 'quantity'], 'oracle');
    addMarketAction(market, 'unstake-provider', 'unstakeprov', ['provider', 'quantity'], 'provider');
    addMarketAction(market, 'unstake-oracle', 'unstakeorcl', ['oracle', 'quantity'], 'oracle');
    addMarketAction(market, 'fund-reward', 'fundreward', ['from', 'quantity'], 'from');
    addMarketAction(market, 'add-service', 'addservice', [
        'provider',
        ['service_type', 'number'],
        ['segment_kind', 'number'],
        'range_start',
        'range_end',
        ['capacity_bytes', 'number'],
        'endpoint',
        'metadata',
    ], 'provider');
    addMarketAction(market, 'disable-service', 'disablesvc', ['provider', ['service_id', 'number']], 'provider');
    addMarketAction(market, 'heartbeat', 'heartbeat', ['provider', ['service_id', 'number'], 'status_hash', 'metadata'], 'provider');
    addMarketAction(market, 'create-check', 'createcheck', [
        ['service_id', 'number'],
        ['oracles', 'json'],
        'sample_start',
        'sample_end',
        'payload_hash',
        ['commit_window_sec', 'number'],
        ['reveal_window_sec', 'number'],
    ]);
    addMarketAction(market, 'commit-check', 'commit', ['oracle', ['check_id', 'number'], 'commitment'], 'oracle');
    addMarketAction(market, 'reveal-check', 'reveal', ['oracle', ['check_id', 'number'], ['passed', 'boolean'], 'result_hash', 'salt'], 'oracle');
    addMarketAction(market, 'settle-check', 'settle', [['check_id', 'number']]);
    addMarketAction(market, 'claim', 'claim', ['owner', 'quantity'], 'owner');
    addMarketAction(market, 'set-inflation', 'setinfl', ['daily_inflation', 'token_issuer', ['min_epoch_sec', 'number']]);
    addMarketAction(market, 'set-project-inflation', 'setprojinf', ['project_contract', ['project_bps', 'number']]);
    addMarketAction(market, 'vote-project', 'voteproj', ['voter', ['project_id', 'number'], 'quantity'], 'voter');
    addMarketAction(market, 'unvote-project', 'unvoteproj', ['voter'], 'voter');
    addMarketAction(market, 'close-inflation', 'closeinfl', []);
    return market;
}
