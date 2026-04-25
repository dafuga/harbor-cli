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
        .option('--api-port <port>', 'Spring chain API port', '8888')
        .option('--robo-port <port>', 'Roborovski API port', '8080')
        .option('--storage-port <port>', 'Harbor storage manifest port', '9090')
        .option('--config <path>', 'config path', defaultConfigPath())
        .action(async (options) => {
        const config = await loadOptionalConfig(options.config);
        const checks = [
            { service: 'chain-api', port: config?.services.chainApi.port ?? Number(options.apiPort) },
            { service: 'robo-history', port: config?.services.roboHistory.port ?? Number(options.roboPort) },
            { service: 'storage-manifest', port: config?.services.storageManifest.port ?? Number(options.storagePort) },
        ];
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
            { check: 'chain-api-port', value: String(config.services.chainApi.port), ok: await canConnect(config.services.chainApi.port ?? 8888) },
            { check: 'robo-history-port', value: String(config.services.roboHistory.port), ok: await canConnect(config.services.roboHistory.port ?? 8080) },
            { check: 'storage-manifest-port', value: String(config.services.storageManifest.port), ok: await canConnect(config.services.storageManifest.port ?? 9090) },
        ];
        console.table(checks);
    });
    agent
        .command('launchd')
        .description('Write a launchd plist for a Harbor service')
        .requiredOption('-s, --service <service>', 'storage, chain-api, or robo-history')
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
        else if (options.service === 'robo-history') {
            const service = config.services.roboHistory;
            if (!service.command) {
                throw new Error('robo-history command is not configured');
            }
            plist = renderLaunchdPlist({
                label: 'io.harbor.robo-history',
                command: service.command,
                args: service.args ?? [],
                workingDirectory: service.workingDirectory,
            });
            filename = 'io.harbor.robo-history.plist';
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
