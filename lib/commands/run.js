import { Command } from 'commander';
import { normalizeServiceName } from '../lib/artifacts.js';
import { buildRunPlan, runServiceForeground } from '../lib/run.js';
export function createRunCommand() {
    return new Command('run')
        .description('Install and run a Harbor opportunity service in the foreground')
        .argument('<service_name>', 'service to run')
        .option('--source <source>', 'auto, local, harbor-storage, github, or url', 'auto')
        .option('--version <version>', 'artifact version', 'dev')
        .option('--binary-url <url>', 'direct binary download URL for --source url')
        .option('--artifact-hash <hash>', 'Harbor storage artifact manifest content hash')
        .option('--sha256 <hash>', 'required binary SHA-256 for downloaded direct URLs')
        .option('--config <path>', 'runtime config path')
        .option('--data-dir <path>', 'runtime data directory')
        .option('--port <port>', 'service listen port')
        .option('--force-install', 'reinstall or rebuild the service binary', false)
        .option('--json', 'print JSON output', false)
        .option('--dry-run', 'print the install/run plan without changing files or starting processes', false)
        .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
        .option('--market-contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
        .option('--storage-contract <account>', 'storage registry contract account', process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore')
        .action(async (serviceName, options) => {
        const service = normalizeServiceName(serviceName);
        const source = options.source;
        if (!['auto', 'local', 'harbor-storage', 'github', 'url'].includes(source)) {
            throw new Error(`invalid --source: ${options.source}`);
        }
        const planOptions = { ...options, source };
        if (options.dryRun) {
            console.log(JSON.stringify(await buildRunPlan(service, planOptions), null, 2));
            return;
        }
        const plan = await runServiceForeground(service, planOptions);
        if (options.json) {
            console.log(JSON.stringify(plan, null, 2));
        }
    });
}
