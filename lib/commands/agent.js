import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDefaultConfig, defaultConfigPath, ensureHarborDirs, harborHome, loadConfig, saveConfig } from '../lib/config.js';
import { renderLaunchdPlist } from '../lib/launchd.js';
import { canConnect } from '../lib/ports.js';
async function loadOptionalConfig(configPath) {
    try {
        return await loadConfig(configPath);
    }
    catch {
        return null;
    }
}
function configuredCommand(name, service) {
    if (!service.command) {
        throw new Error(`${name} command is not configured`);
    }
    return service.command;
}
function hasPort(check) {
    return Number.isFinite(check.port);
}
export function createAgentCommand() {
    const agent = new Command('agent');
    agent.description('Inspect and run Harbor service agents');
    agent
        .command('init')
        .description('Create a Harbor agent config')
        .requiredOption('-a, --account <account>', 'provider account')
        .option('-u, --api-url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
        .option('-c, --contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
        .option('--storage-dir <path>', 'storage root')
        .option('--config <path>', 'config path', defaultConfigPath())
        .option('--force', 'overwrite existing config', false)
        .action(async (options) => {
        try {
            if (!options.force) {
                await fs.access(options.config ?? defaultConfigPath());
                throw new Error(`config already exists: ${options.config ?? defaultConfigPath()}`);
            }
        }
        catch (error) {
            if (error instanceof Error && !error.message.startsWith('config already exists')) {
                // Missing config is expected.
            }
            else {
                throw error;
            }
        }
        const config = createDefaultConfig(options.account);
        config.apiUrl = options.apiUrl;
        config.marketContract = options.contract;
        if (options.storageDir) {
            config.storageDir = path.resolve(options.storageDir);
        }
        await saveConfig(config, options.config);
        console.log(`Created Harbor agent config: ${options.config ?? defaultConfigPath()}`);
    });
    agent
        .command('config')
        .description('Print Harbor agent config')
        .option('--config <path>', 'config path', defaultConfigPath())
        .action(async (options) => {
        console.log(JSON.stringify(await loadConfig(options.config), null, 2));
    });
    agent
        .command('status')
        .description('Check local Harbor service ports')
        .option('--bp-port <port>', 'block producer p2p port', '9876')
        .option('--api-port <port>', 'Harbor chain API port', '8888')
        .option('--trace-port <port>', 'Harbor trace API port', '8889')
        .option('--robo-core-port <port>', 'Roborovski core/indexing status port')
        .option('--robo-actions-port <port>', 'Roborovski actions API port', '8081')
        .option('--robo-tx-port <port>', 'Roborovski tx lookup API port', '8082')
        .option('--robo-api-port <port>', 'Roborovski API router port', '8080')
        .option('--robo-stream-port <port>', 'Roborovski stream API port', '8083')
        .option('--storage-port <port>', 'Harbor storage manifest port', '9090')
        .option('--config <path>', 'config path', defaultConfigPath())
        .action(async (options) => {
        const config = await loadOptionalConfig(options.config);
        const checks = [
            { service: 'bp', port: config?.services.blockProducer.port ?? Number(options.bpPort) },
            { service: 'chain-api', port: config?.services.chainApi.port ?? Number(options.apiPort) },
            { service: 'trace-api', port: config?.services.traceApi.port ?? Number(options.tracePort) },
            { service: 'robo-core', port: config?.services.roboCore.port ?? (options.roboCorePort ? Number(options.roboCorePort) : undefined) },
            { service: 'robo-actions', port: config?.services.roboActions.port ?? Number(options.roboActionsPort) },
            { service: 'robo-tx', port: config?.services.roboTx.port ?? Number(options.roboTxPort) },
            { service: 'robo-api', port: config?.services.roboApi.port ?? Number(options.roboApiPort) },
            { service: 'robo-stream', port: config?.services.roboStream.port ?? Number(options.roboStreamPort) },
            { service: 'storage-manifest', port: config?.services.storageManifest.port ?? Number(options.storagePort) },
        ].filter(hasPort);
        const results = await Promise.all(checks.map(async (check) => ({
            ...check,
            reachable: await canConnect(check.port),
        })));
        console.table(results);
    });
    agent
        .command('doctor')
        .description('Check local config, directories, and service ports')
        .option('--config <path>', 'config path', defaultConfigPath())
        .action(async (options) => {
        const config = await loadConfig(options.config);
        await ensureHarborDirs(config);
        const checks = [
            { check: 'config', value: options.config, ok: true },
            { check: 'storage-dir', value: config.storageDir, ok: true },
            { check: 'bp-port', value: String(config.services.blockProducer.port ?? 'unconfigured'), ok: config.services.blockProducer.port ? await canConnect(config.services.blockProducer.port) : false },
            { check: 'chain-api-port', value: String(config.services.chainApi.port), ok: await canConnect(config.services.chainApi.port ?? 8888) },
            { check: 'trace-api-port', value: String(config.services.traceApi.port), ok: await canConnect(config.services.traceApi.port ?? 8889) },
            { check: 'robo-core-port', value: String(config.services.roboCore.port ?? 'unconfigured'), ok: config.services.roboCore.port ? await canConnect(config.services.roboCore.port) : false },
            { check: 'robo-actions-port', value: String(config.services.roboActions.port), ok: await canConnect(config.services.roboActions.port ?? 8081) },
            { check: 'robo-tx-port', value: String(config.services.roboTx.port), ok: await canConnect(config.services.roboTx.port ?? 8082) },
            { check: 'robo-api-port', value: String(config.services.roboApi.port), ok: await canConnect(config.services.roboApi.port ?? 8080) },
            { check: 'robo-stream-port', value: String(config.services.roboStream.port), ok: await canConnect(config.services.roboStream.port ?? 8083) },
            { check: 'storage-manifest-port', value: String(config.services.storageManifest.port), ok: await canConnect(config.services.storageManifest.port ?? 9090) },
        ];
        console.table(checks);
    });
    agent
        .command('launchd')
        .description('Write a launchd plist for a Harbor service')
        .requiredOption('-s, --service <service>', 'bp, chain-api, trace-api, storage, robo-core, robo-actions, robo-tx, robo-api, or robo-stream')
        .option('--config <path>', 'config path', defaultConfigPath())
        .option('-o, --output <path>', 'output plist path')
        .action(async (options) => {
        const config = await loadConfig(options.config);
        const harborBin = process.argv[1];
        let plist;
        let filename;
        if (options.service === 'storage') {
            const port = config.services.storageManifest.port ?? 9090;
            plist = renderLaunchdPlist({
                label: 'io.harbor.storage',
                command: process.execPath,
                args: [harborBin, 'storage', 'serve', '--root', config.storageDir, '--port', String(port)],
                workingDirectory: harborHome(),
            });
            filename = 'io.harbor.storage.plist';
        }
        else if (options.service === 'bp') {
            const service = config.services.blockProducer;
            plist = renderLaunchdPlist({
                label: 'io.harbor.bp',
                command: service.command ?? 'nodeos',
                args: service.args ?? [],
                workingDirectory: service.workingDirectory,
            });
            filename = 'io.harbor.bp.plist';
        }
        else if (options.service === 'chain-api') {
            const service = config.services.chainApi;
            plist = renderLaunchdPlist({
                label: 'io.harbor.chain-api',
                command: service.command ?? 'nodeos',
                args: service.args ?? [],
                workingDirectory: service.workingDirectory,
            });
            filename = 'io.harbor.chain-api.plist';
        }
        else if (options.service === 'trace-api') {
            const service = config.services.traceApi;
            plist = renderLaunchdPlist({
                label: 'io.harbor.trace-api',
                command: service.command ?? 'nodeos',
                args: service.args ?? [],
                workingDirectory: service.workingDirectory,
            });
            filename = 'io.harbor.trace-api.plist';
        }
        else if (options.service === 'robo-core') {
            const service = config.services.roboCore;
            const command = configuredCommand('robo-core', service);
            plist = renderLaunchdPlist({
                label: 'io.harbor.robo-core',
                command,
                args: service.args ?? [],
                workingDirectory: service.workingDirectory,
            });
            filename = 'io.harbor.robo-core.plist';
        }
        else if (options.service === 'robo-actions') {
            const service = config.services.roboActions;
            const command = configuredCommand('robo-actions', service);
            plist = renderLaunchdPlist({
                label: 'io.harbor.robo-actions',
                command,
                args: service.args ?? [],
                workingDirectory: service.workingDirectory,
            });
            filename = 'io.harbor.robo-actions.plist';
        }
        else if (options.service === 'robo-tx') {
            const service = config.services.roboTx;
            const command = configuredCommand('robo-tx', service);
            plist = renderLaunchdPlist({
                label: 'io.harbor.robo-tx',
                command,
                args: service.args ?? [],
                workingDirectory: service.workingDirectory,
            });
            filename = 'io.harbor.robo-tx.plist';
        }
        else if (options.service === 'robo-api') {
            const service = config.services.roboApi;
            const command = configuredCommand('robo-api', service);
            plist = renderLaunchdPlist({
                label: 'io.harbor.robo-api',
                command,
                args: service.args ?? [],
                workingDirectory: service.workingDirectory,
            });
            filename = 'io.harbor.robo-api.plist';
        }
        else if (options.service === 'robo-stream') {
            const service = config.services.roboStream;
            const command = configuredCommand('robo-stream', service);
            plist = renderLaunchdPlist({
                label: 'io.harbor.robo-stream',
                command,
                args: service.args ?? [],
                workingDirectory: service.workingDirectory,
            });
            filename = 'io.harbor.robo-stream.plist';
        }
        else {
            throw new Error(`unknown service: ${options.service}`);
        }
        const output = options.output ?? path.join(harborHome(), 'launchd', filename);
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, plist);
        console.log(output);
    });
    return agent;
}
