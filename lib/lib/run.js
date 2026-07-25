import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { defaultRuntimeConfigPath, defaultRuntimeDataDir, resolveArtifact } from './artifacts.js';
import { harborHome } from './config.js';
function q(value) {
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
function providerAccount(service) {
    const cleaned = service.replace(/[^a-z0-9]/g, '').slice(0, 9);
    return `hb${cleaned}`.padEnd(11, '1').slice(0, 12);
}
function serviceProviders(basePort) {
    const services = [
        ['chainapi', 0],
        ['traceapi', 1],
        ['storage', 2],
        ['histcore', 3],
        ['snapshot', 4],
        ['p2pseed', 5],
        ['ibcrelayer', 6],
        ['bp', 7],
        ['histactions', 8],
        ['histtx', 9],
        ['histapi', 10],
        ['histstream', 11],
        ['verifier', 12],
        ['router', 13],
        ['sitegw', 14],
        ['appealcmte', 15],
        ['pricefeed', 16],
        ['aiinfer', 17],
        ['aitrain', 18],
        ['airouter', 19],
        ['keycustody', 20],
    ];
    return services.map(([service, offset]) => {
        const endpoint = service === 'p2pseed' ? '127.0.0.1:9876' : `http://127.0.0.1:${basePort + offset}`;
        return `
[[providers]]
account = ${q(providerAccount(service))}
service_type = ${q(service)}
endpoint = ${q(endpoint)}
range_start = 0
range_end = 999999999999
capacity_bytes = ${service === 'storage' ? 1073741824 : 0}
metadata = ${q(JSON.stringify({ source: 'harbor-run', service }))}
`;
    }).join('\n');
}
export function renderRuntimeConfig(input) {
    const historyRepo = input.historyRepo ?? path.resolve(process.cwd(), '..', 'harbor-history');
    return `[chain]
http_endpoint = ${q(process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')}
p2p_endpoint = "127.0.0.1:9876"
chain_id = ""
svcmarket_contract = ${q(process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')}
storage_contract = ${q(process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore')}
ai_contract = ${q(process.env.HARBOR_AI_CONTRACT ?? 'harborai')}
sites_contract = "harborsites"
ibc_contract = "ibc"
harbor_cli = "harbor"
harbor_cli_node = "node"
signing_key = ""
push_transactions = false

[services]
data_dir = ${q(input.dataDir)}
base_port = ${input.basePort}
heartbeat_interval_sec = 30
required_replicas = 1
corrupt_router_reads = false

[history]
repo = ${q(historyRepo)}
config_dir = ${q(path.join(historyRepo, 'configs', 'harbor'))}
binary_dir = ${q(path.join(historyRepo, 'bin'))}
origin = "https://github.com/dafuga/harbor-history.git"

[verifier]
account_a = "hboraclea11"
account_b = "hboracleb11"
commit_window_sec = 60
reveal_window_sec = 60

[ai]
default_model_id = 1
default_policy_id = 1
classifier_model_id = 0
token_window = 128
confidence_bps = 9000
max_fee = "1.0000 SYS"
provider_fee = "1.0000 SYS"
backend_endpoint = ${q(process.env.HARBOR_AI_BACKEND_ENDPOINT ?? '')}
trusted_checker_endpoint = ${q(process.env.HARBOR_AI_TRUSTED_CHECKER_ENDPOINT ?? '')}
trusted_checker_command = ${q(process.env.HARBOR_AI_TRUSTED_CHECKER_COMMAND ?? '')}
trusted_checker_min_score_bps = ${Number(process.env.HARBOR_AI_TRUSTED_CHECKER_MIN_SCORE_BPS ?? 8500)}
${serviceProviders(input.basePort)}
`;
}
export async function ensureRuntimeConfig(options) {
    const basePort = options.port - options.service.portOffset;
    try {
        if (!options.force) {
            await fs.access(options.config);
            return { config: options.config, basePort };
        }
    }
    catch {
        // Create the config below.
    }
    await fs.mkdir(path.dirname(options.config), { recursive: true });
    await fs.mkdir(options.dataDir, { recursive: true });
    await fs.writeFile(options.config, renderRuntimeConfig({ dataDir: options.dataDir, basePort }));
    return { config: options.config, basePort };
}
export async function buildRunPlan(service, options) {
    const version = options.version ?? 'dev';
    const port = Number(options.port ?? 9100 + service.portOffset);
    const config = path.resolve(options.config ?? defaultRuntimeConfigPath());
    const dataDir = path.resolve(options.dataDir ?? defaultRuntimeDataDir());
    const artifact = options.dryRun
        ? undefined
        : await resolveArtifact({ ...options, service, version });
    const binary = artifact?.binary ?? path.join(harborHome(), 'bin', service.name, version, service.daemon);
    return {
        service: service.name,
        daemon: service.daemon,
        version,
        source: options.source ?? 'auto',
        binary,
        config,
        data_dir: dataDir,
        port,
        command: [binary, '--config', config],
        artifact,
        dry_run: Boolean(options.dryRun),
    };
}
async function waitForHealth(port, childExited) {
    const deadline = Date.now() + 10_000;
    const url = `http://127.0.0.1:${port}/health`;
    while (Date.now() < deadline) {
        if (childExited()) {
            throw new Error(`service exited before readiness: ${url}`);
        }
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
            if (response.ok) {
                return;
            }
        }
        catch {
            // Retry until the readiness deadline.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`service did not become healthy: ${url}`);
}
export async function runServiceForeground(service, options) {
    const plan = await buildRunPlan(service, options);
    if (options.dryRun) {
        return plan;
    }
    await ensureRuntimeConfig({
        config: plan.config,
        dataDir: plan.data_dir,
        service,
        port: plan.port,
        force: Boolean(options.forceInstall),
    });
    await fs.mkdir(path.join(harborHome(), 'logs'), { recursive: true });
    const logPath = path.join(harborHome(), 'logs', `${service.name}.log`);
    const log = fssync.createWriteStream(logPath, { flags: 'a' });
    const child = spawn(plan.command[0], plan.command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let exited = false;
    let exitCode = null;
    child.stdout?.on('data', (chunk) => {
        process.stdout.write(chunk);
        log.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
        process.stderr.write(chunk);
        log.write(chunk);
    });
    child.once('exit', (code) => {
        exited = true;
        exitCode = code;
    });
    const stop = () => {
        if (!exited) {
            child.kill('SIGTERM');
        }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await waitForHealth(plan.port, () => exited);
    await new Promise((resolve, reject) => {
        child.once('exit', (code) => {
            log.end();
            if (code === 0 || code === null) {
                resolve();
            }
            else {
                reject(new Error(`${service.name} exited with status ${code}`));
            }
        });
    });
    if (exitCode && exitCode !== 0) {
        throw new Error(`${service.name} exited with status ${exitCode}`);
    }
    return plan;
}
