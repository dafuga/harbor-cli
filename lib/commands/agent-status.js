import { defaultConfigPath, ensureHarborDirs, loadConfig } from '../lib/config.js';
import { canConnect } from '../lib/ports.js';
import { hostPlatform } from '../lib/runtime-host.js';
import { serviceManager, verifyServiceManager } from '../lib/service-manager.js';
const STATUS_PORTS = [
    { service: 'bp', configKey: 'blockProducer', optionKey: 'bpPort' },
    { service: 'chain-api', configKey: 'chainApi', optionKey: 'apiPort' },
    { service: 'trace-api', configKey: 'traceApi', optionKey: 'tracePort' },
    { service: 'history-core', configKey: 'historyCore', optionKey: 'historyCorePort' },
    { service: 'history-actions', configKey: 'historyActions', optionKey: 'historyActionsPort' },
    { service: 'history-tx', configKey: 'historyTx', optionKey: 'historyTxPort' },
    { service: 'history-api', configKey: 'historyApi', optionKey: 'historyApiPort' },
    { service: 'history-stream', configKey: 'historyStream', optionKey: 'historyStreamPort' },
    { service: 'storage-manifest', configKey: 'storageManifest', optionKey: 'storagePort' },
];
const DOCTOR_FALLBACKS = {
    chainApi: 8888,
    traceApi: 8889,
    historyActions: 8081,
    historyTx: 8082,
    historyApi: 8080,
    historyStream: 8083,
    storageManifest: 9090,
};
async function loadOptionalConfig(configPath) {
    try {
        return await loadConfig(configPath);
    }
    catch {
        return null;
    }
}
function optionPort(options, key) {
    const value = options[key];
    return value ? Number(value) : undefined;
}
function configuredPort(config, options, spec) {
    return config?.services[spec.configKey].port ?? optionPort(options, spec.optionKey);
}
async function statusRows(config, options) {
    const checks = STATUS_PORTS
        .map((spec) => ({ service: spec.service, port: configuredPort(config, options, spec) }))
        .filter((check) => Number.isFinite(check.port));
    return Promise.all(checks.map(async (check) => ({ ...check, reachable: await canConnect(check.port) })));
}
async function doctorPortRow(name, port, fallback) {
    const value = port ?? fallback;
    return {
        check: `${name}-port`,
        value: String(value ?? 'unconfigured'),
        ok: value ? await canConnect(value) : false,
    };
}
async function doctorRows(config, configPath) {
    const portRows = await Promise.all(STATUS_PORTS.map((spec) => doctorPortRow(spec.service, config.services[spec.configKey].port, DOCTOR_FALLBACKS[spec.configKey])));
    return [
        { check: 'config', value: configPath, ok: true },
        { check: 'storage-dir', value: config.storageDir, ok: true },
        ...portRows,
    ];
}
function addStatusCommand(agent) {
    agent
        .command('status')
        .description('Check local Harbor service ports')
        .option('--bp-port <port>', 'block producer p2p port', '9876')
        .option('--api-port <port>', 'Harbor chain API port', '8888')
        .option('--trace-port <port>', 'Harbor trace API port', '8889')
        .option('--history-core-port <port>', 'Harbor History core/indexing status port')
        .option('--history-actions-port <port>', 'Harbor History actions API port', '8081')
        .option('--history-tx-port <port>', 'Harbor History tx lookup API port', '8082')
        .option('--history-api-port <port>', 'Harbor History API router port', '8080')
        .option('--history-stream-port <port>', 'Harbor History stream API port', '8083')
        .option('--storage-port <port>', 'Harbor storage manifest port', '9090')
        .option('--config <path>', 'config path', defaultConfigPath())
        .action(async (options) => {
        console.table(await statusRows(await loadOptionalConfig(options.config), options));
    });
}
function addDoctorCommand(agent) {
    agent
        .command('doctor')
        .description('Check local config, directories, and service ports')
        .option('--config <path>', 'config path', defaultConfigPath())
        .option('--json', 'print JSON output')
        .action(async (options) => {
        const checks = await loadConfig(options.config).then(async (config) => {
            await ensureHarborDirs(config);
            return doctorRows(config, options.config);
        }).catch((error) => [{ check: 'config', value: error.message, ok: false }]);
        checks.unshift(await verifyServiceManager()
            .then(() => ({ check: 'service-manager', value: serviceManager(), ok: true }))
            .catch((error) => ({ check: 'service-manager', value: error.message, ok: false })));
        if (options.json)
            console.log(JSON.stringify({ platform: hostPlatform(), checks }, null, 2));
        else
            console.table(checks);
    });
}
export function addAgentStatusCommands(agent) {
    addStatusCommand(agent);
    addDoctorCommand(agent);
}
