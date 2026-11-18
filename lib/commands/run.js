import { Command } from 'commander';
import { normalizeServiceName } from '../lib/artifacts.js';
import { runServiceForeground } from '../lib/run.js';
export function addRuntimeOptions(command) {
    return command
        .option('--source <source>', 'auto, local, harbor-storage, github, or url', 'auto')
        .option('--version <version>', 'artifact version', 'dev')
        .option('--binary-url <url>', 'direct binary download URL for --source url')
        .option('--artifact-hash <hash>', 'Harbor storage artifact manifest content hash')
        .option('--sha256 <hash>', 'required binary SHA-256 for downloaded direct URLs')
        .option('--config <path>', 'runtime config path')
        .option('--data-dir <path>', 'runtime data directory')
        .option('--port <port>', 'service listen port')
        .option('--force-install', 'reinstall or rebuild the service binary', false)
        .option('--cpu-percent <percent>', 'maximum share of available logical CPUs per service (default 40)')
        .option('--memory-percent <percent>', 'maximum share of visible physical memory per service (default 40)')
        .option('--backend-endpoint <url>', 'HTTP endpoint for local or hosted inference')
        .option('--backend-protocol <protocol>', 'inference backend protocol, raw or openai')
        .option('--backend-model <model>', 'model identifier for OpenAI-compatible inference')
        .option('--backend-api-key-env <name>', 'environment variable that supplies the inference API key')
        .option('--model-profile <profile>', 'Qwen 4-bit local inference profile: auto, flagship, compact, or large')
        .option('--ollama <path>', 'manage a local Ollama executable under the service resource limits')
        .option('--llama-server <path>', 'manage a local llama.cpp server under the service resource limits')
        .option('--base-gguf <path>', '4-bit base model file for --llama-server')
        .option('--expert-gguf <path>', 'matching QLoRA adapter file for --llama-server')
        .option('--json', 'print JSON output', false)
        .option('--dry-run', 'print the install/run plan without changing files or starting processes', false)
        .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
        .option('--market-contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
        .option('--storage-contract <account>', 'storage registry contract account', process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore');
}
export function validateRuntimeSource(source) {
    if (source && !['auto', 'local', 'harbor-storage', 'github', 'url'].includes(source)) {
        throw new Error(`invalid --source: ${source}`);
    }
}
export function createRunCommand() {
    return addRuntimeOptions(new Command('run')
        .description('Install and run a Harbor opportunity service in the foreground')
        .argument('<service_name>', 'service to run'))
        .action(async (serviceName, options) => {
        validateRuntimeSource(options.source);
        const plan = await runServiceForeground(normalizeServiceName(serviceName), options);
        if (options.json || options.dryRun)
            console.log(JSON.stringify(plan, null, 2));
    });
}
