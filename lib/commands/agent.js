import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { addLaunchdCommand } from './agent-launchd.js';
import { addAgentLimitsCommands } from './agent-limits.js';
import { addAgentStatusCommands } from './agent-status.js';
import { createServiceCommand } from './service.js';
import { createDefaultConfig, defaultConfigPath, loadConfig, saveConfig } from '../lib/config.js';
async function ensureConfigCanBeWritten(configPath, force) {
    if (force) {
        return;
    }
    try {
        await fs.access(configPath);
    }
    catch {
        return;
    }
    throw new Error(`config already exists: ${configPath}`);
}
async function initAgentConfig(options) {
    const configPath = options.config ?? defaultConfigPath();
    await ensureConfigCanBeWritten(configPath, options.force);
    const config = createDefaultConfig(options.account);
    config.apiUrl = options.apiUrl;
    config.marketContract = options.contract;
    if (options.storageDir) {
        config.storageDir = path.resolve(options.storageDir);
    }
    await saveConfig(config, configPath);
    return configPath;
}
function addInitCommand(agent) {
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
        console.log(`Created Harbor agent config: ${await initAgentConfig(options)}`);
    });
}
function addConfigCommand(agent) {
    agent
        .command('config')
        .description('Print Harbor agent config')
        .option('--config <path>', 'config path', defaultConfigPath())
        .action(async (options) => {
        console.log(JSON.stringify(await loadConfig(options.config), null, 2));
    });
}
export function createAgentCommand() {
    const agent = new Command('agent');
    agent.description('Inspect and run Harbor service agents');
    addInitCommand(agent);
    addConfigCommand(agent);
    addAgentStatusCommands(agent);
    addAgentLimitsCommands(agent);
    addLaunchdCommand(agent);
    agent.addCommand(createServiceCommand());
    return agent;
}
