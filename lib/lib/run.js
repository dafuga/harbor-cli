import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { sealedGuestPreflight } from '../utils/market-services/sealedGuestPreflight.js';
import { artifactBinary, defaultRuntimeConfigPath, defaultRuntimeDataDir, isNodeRuntime, resolveArtifact } from './artifacts.js';
import { harborHome } from './config.js';
import { verifyQwenGguf } from './gguf.js';
import { checkDiskFloor, hostMemoryBytes, hostPolicy, hostState } from './host-policy.js';
import { createKvGateway } from './kv-cache.js';
import { isLocalHttp, llamaCacheDirectory, LOCAL_BACKEND_KEY_ENV, localModel, planManagedBackend } from './local-model.js';
import { canConnect } from './ports.js';
import { RELAY_MEMORY_FLOOR } from './opportunities.js';
import { configuredLimits, signalGroup, watchProcessGroups } from './resource-limits.js';
import { releaseAsset, runtimeTarget } from './runtime-host.js';
function nodeConfig(options) {
    if (!options.config)
        throw new Error('nodeos needs --config <config.ini> for the intended Harbor network');
    const config = path.resolve(options.config);
    const dataDir = path.resolve(options.dataDir ?? path.join(harborHome(), 'node'));
    const port = Number(options.port ?? 8888);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('--port must be an integer from 1 to 65535');
    const args = [
        '--config-dir', path.dirname(config), '--config', path.basename(config), '--data-dir', dataDir,
        '--http-server-address', `127.0.0.1:${port}`,
        ...(options.genesisJson ? ['--genesis-json', path.resolve(options.genesisJson)] : []),
    ];
    return { config, dataDir, port, args };
}
function q(value) {
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\t', '\\t')}"`;
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
        ['sealedcompute', 22],
        ['relay', 23],
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
http_endpoint = ${q(input.url ?? process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')}
p2p_endpoint = "127.0.0.1:9876"
chain_id = ${q(input.expectChainId ?? '')}
svcmarket_contract = ${q(input.marketContract ?? process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')}
storage_contract = ${q(input.storageContract ?? process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore')}
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
backend_endpoint = ${q(input.backendEndpoint ?? process.env.HARBOR_AI_BACKEND_ENDPOINT ?? '')}
backend_protocol = ${q(input.backendProtocol ?? process.env.HARBOR_AI_BACKEND_PROTOCOL ?? 'raw')}
backend_model = ${q(input.backendModel ?? process.env.HARBOR_AI_BACKEND_MODEL ?? '')}
backend_api_key_env = ${q(input.backendApiKeyEnv ?? process.env.HARBOR_AI_BACKEND_API_KEY_ENV ?? '')}
trusted_checker_endpoint = ${q(process.env.HARBOR_AI_TRUSTED_CHECKER_ENDPOINT ?? '')}
trusted_checker_command = ${q(process.env.HARBOR_AI_TRUSTED_CHECKER_COMMAND ?? '')}
trusted_checker_min_score_bps = ${Number(process.env.HARBOR_AI_TRUSTED_CHECKER_MIN_SCORE_BPS ?? 8500)}
${serviceProviders(input.basePort)}
`;
}
function parseConfig(source) {
    const values = new Map();
    let section = '';
    for (const raw of source.split('\n')) {
        const line = raw.match(/^(?:"(?:[^"\\]|\\.)*"|[^"#])*/)?.[0].trim() ?? '';
        const header = line.match(/^\[(.+)]$/);
        if (header)
            section = header[1];
        const assignment = line.match(/^(\w+)\s*=\s*(.*)$/);
        if (assignment) {
            const value = assignment[2].replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, (_, char) => char === 'n' ? '\n' : char === 't' ? '\t' : char);
            values.set(`${section}.${assignment[1]}`, value);
        }
    }
    return values;
}
const BACKEND_FIELDS = {
    backendEndpoint: ['ai.backend_endpoint', 'HARBOR_AI_BACKEND_ENDPOINT', ''],
    backendProtocol: ['ai.backend_protocol', 'HARBOR_AI_BACKEND_PROTOCOL', 'raw'],
    backendModel: ['ai.backend_model', 'HARBOR_AI_BACKEND_MODEL', ''],
    backendApiKeyEnv: ['ai.backend_api_key_env', 'HARBOR_AI_BACKEND_API_KEY_ENV', ''],
};
async function runtimeConfig(config, service, options, limits) {
    let existing;
    try {
        existing = parseConfig(await fs.readFile(config, 'utf8'));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    if (service.name === 'sealedcompute' && !options.dryRun) {
        await sealedGuestPreflight({
            platform: process.platform, arch: process.arch, hasConfig: existing !== undefined,
            canAccess: (device) => fs.access(device).then(() => true, () => false),
        });
    }
    if (existing && options.expectChainId) {
        const endpoint = existing.get('chain.http_endpoint');
        if (endpoint !== options.url || existing.get('chain.chain_id') !== options.expectChainId ||
            existing.get('chain.svcmarket_contract') !== options.marketContract) {
            throw new Error('runtime config must use the same chain ID, endpoint, and market contract as automatic selection');
        }
    }
    const basePort = Number(existing?.get('services.base_port') ?? (existing || options.port === undefined ? 9100 : Number(options.port) - service.portOffset));
    const port = basePort + service.portOffset;
    if (!Number.isInteger(basePort) || basePort < 1 || basePort > 65535 - service.portOffset) {
        throw new Error('service port and runtime base port must be integers from 1 to 65535');
    }
    const dataDir = path.resolve(existing?.get('services.data_dir') ?? (existing ? '/tmp/harbor-opportunities' : options.dataDir ?? defaultRuntimeDataDir()));
    if (existing && ((options.port !== undefined && port !== Number(options.port)) ||
        (options.dataDir !== undefined && dataDir !== path.resolve(options.dataDir)))) {
        throw new Error(`--port or --data-dir conflicts with ${config}. Choose a new --config path or update the existing file.`);
    }
    const configuredBackend = Object.keys(BACKEND_FIELDS)
        .some((key) => options[key] !== undefined || process.env[BACKEND_FIELDS[key][1]] !== undefined);
    const profileName = options.modelProfile ?? (!existing && service.name === 'aiinfer' && (!configuredBackend || options.ollama || options.llamaServer) ? 'auto' : undefined);
    const modelProfile = profileName ? localModel(profileName, hostMemoryBytes(), limits.memory_bytes) : undefined;
    const profileDefaults = modelProfile ? {
        backendEndpoint: modelProfile.backend_endpoint,
        backendProtocol: 'openai',
        backendModel: modelProfile.model,
    } : {};
    const backend = {};
    for (const key of Object.keys(BACKEND_FIELDS)) {
        const [name, env, fallback] = BACKEND_FIELDS[key];
        const selected = options[key] ?? profileDefaults[key];
        const value = existing ? existing.get(name) ?? fallback : options[key] ?? process.env[env] ?? profileDefaults[key] ?? fallback;
        if (existing && selected !== undefined && value !== selected) {
            throw new Error(`${name} conflicts with ${config}. Choose a new --config path or update the existing file.`);
        }
        backend[key] = value;
    }
    const loopback = isLocalHttp(backend.backendEndpoint ?? '');
    if (modelProfile && !existing && !backend.backendApiKeyEnv && loopback)
        backend.backendApiKeyEnv = LOCAL_BACKEND_KEY_ENV;
    if (backend.backendEndpoint) {
        const { protocol, username, password } = new URL(backend.backendEndpoint);
        if (!['http:', 'https:'].includes(protocol) || username || password)
            throw new Error('inference backend endpoint must be an HTTP(S) URL without credentials');
    }
    if (backend.backendProtocol !== 'raw' && backend.backendProtocol !== 'openai')
        throw new Error('backend protocol must be raw or openai');
    if (backend.backendApiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(backend.backendApiKeyEnv)) {
        throw new Error('backend API key environment variable name is invalid');
    }
    if (backend.backendApiKeyEnv === LOCAL_BACKEND_KEY_ENV && !loopback) {
        throw new Error(`${LOCAL_BACKEND_KEY_ENV} is reserved for a loopback inference backend`);
    }
    if (backend.backendProtocol === 'openai' && (!backend.backendEndpoint || !backend.backendModel || !backend.backendApiKeyEnv)) {
        throw new Error('the OpenAI-compatible backend requires an endpoint, model, and API key environment variable name');
    }
    const { url, marketContract, storageContract, expectChainId } = options;
    return { port, dataDir, backend, modelProfile, generated: existing ? undefined : renderRuntimeConfig({ dataDir, basePort, url, marketContract, storageContract, expectChainId, ...backend }) };
}
export async function buildRunPlan(service, options) {
    const target = runtimeTarget();
    const version = options.version ?? 'dev';
    const prospectiveBinary = artifactBinary(service, version);
    const limits = await configuredLimits(options);
    const node = isNodeRuntime(service) ? nodeConfig(options) : undefined;
    if (node) {
        if (!options.dryRun) {
            await fs.access(node.config);
            if (options.genesisJson)
                await fs.access(options.genesisJson);
        }
        const artifact = options.dryRun ? undefined : await resolveArtifact({ ...options, service, version });
        const binary = artifact?.binary ?? prospectiveBinary;
        return {
            service: service.name, daemon: service.daemon, version, source: options.source ?? 'auto',
            binary, target, release_asset: releaseAsset(service.daemon, target), config: node.config,
            data_dir: node.dataDir, port: node.port, command: [binary, ...node.args],
            log: path.resolve(harborHome(), 'logs', 'nodeos.log'), limits, cwd: process.cwd(),
            usage_file: path.resolve(harborHome(), 'logs', 'nodeos.usage.json'),
            idle_only: options.idleOnly,
            artifact, dry_run: Boolean(options.dryRun),
        };
    }
    const config = path.resolve(options.config ?? defaultRuntimeConfigPath());
    let runtime = await runtimeConfig(config, service, options, limits);
    const resolveBackend = () => planManagedBackend(options, runtime.backend.backendEndpoint, runtime.backend.backendModel, runtime.backend.backendProtocol, limits, runtime.modelProfile, Boolean(options.dryRun));
    let managedBackend = await resolveBackend();
    if (managedBackend && !runtime.backend.backendApiKeyEnv)
        throw new Error('a managed backend requires a local model profile or --backend-api-key-env');
    const artifact = options.dryRun
        ? undefined
        : await resolveArtifact({ ...options, service, version });
    if (!options.dryRun && runtime.generated !== undefined) {
        await fs.mkdir(path.dirname(config), { recursive: true });
        const temporary = `${config}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, runtime.generated, { flag: 'wx', mode: 0o600 });
            await fs.link(temporary, config);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            runtime = await runtimeConfig(config, service, options, limits);
            managedBackend = await resolveBackend();
        }
        finally {
            await fs.rm(temporary, { force: true });
        }
    }
    const binary = artifact?.binary ?? prospectiveBinary;
    const command = [binary, '--config', config];
    if (service.name === 'relay' && options.relayConfig) {
        if (!options.expectChainId)
            throw new Error('--relay-config requires --expect-chain-id');
        command.push('--relay-config', path.resolve(options.relayConfig), '--port', String(runtime.port), '--chain-id', options.expectChainId);
    }
    return {
        service: service.name,
        daemon: service.daemon,
        version,
        source: options.source ?? 'auto',
        binary,
        target,
        release_asset: releaseAsset(service.daemon, target),
        config,
        data_dir: runtime.dataDir,
        port: runtime.port,
        command,
        log: path.resolve(harborHome(), 'logs', `${service.name}.log`),
        usage_file: path.resolve(harborHome(), 'logs', `${service.name}.usage.json`),
        limits,
        cwd: process.cwd(),
        backend_key_env: runtime.backend.backendApiKeyEnv || undefined,
        backend_local: runtime.backend.backendApiKeyEnv === LOCAL_BACKEND_KEY_ENV || undefined,
        model_profile: runtime.modelProfile,
        managed_backend: managedBackend,
        idle_only: options.idleOnly,
        artifact,
        dry_run: Boolean(options.dryRun),
    };
}
export async function serviceHealthy(port, service) {
    try {
        const node = service === 'nodeos';
        const endpoint = node ? '/v1/chain/get_info' : '/health';
        const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: AbortSignal.timeout(1000) });
        if (!response.ok)
            return false;
        const health = await response.json();
        if (node)
            return /^[a-f0-9]{64}$/.test(health.chain_id ?? '') && Number.isSafeInteger(health.head_block_num);
        return health.ok === true && health.role === service;
    }
    catch {
        return false;
    }
}
export async function waitForHealth(plan, childExited = () => false, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    const url = `http://127.0.0.1:${plan.port}${plan.service === 'nodeos' ? '/v1/chain/get_info' : '/health'}`;
    while (Date.now() < deadline) {
        if (childExited()) {
            throw new Error(`service exited before readiness: ${url}`);
        }
        if (await serviceHealthy(plan.port, plan.service) && !childExited())
            return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`service did not become healthy: ${url}`);
}
export async function runServiceForeground(service, options) {
    const plan = await buildRunPlan(service, options);
    if (!options.dryRun)
        await superviseRuntime(plan, { mirror: options.json ? 'stderr' : 'both', kernelLimits: false });
    return plan;
}
async function backendEngine(backend) {
    if (!backend.cacheDirectory)
        return backend;
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const address = socket.address();
    await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
    const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    const command = [...backend.command];
    command[command.indexOf('--host') + 1] = '127.0.0.1';
    command[command.indexOf('--port') + 1] = String(address.port);
    const base = command[command.indexOf('--model') + 1];
    const expertIndex = command.indexOf('--lora');
    const files = [command[0], base, ...(expertIndex >= 0 ? [command[expertIndex + 1]] : [])];
    await verifyQwenGguf(base);
    const cacheDirectory = await llamaCacheDirectory(path.dirname(backend.cacheDirectory), files, backend.model, backend.parallel);
    command[command.indexOf('--slot-save-path') + 1] = cacheDirectory;
    await checkDiskFloor(cacheDirectory);
    await fs.mkdir(cacheDirectory, { mode: 0o700, recursive: true });
    const info = await fs.lstat(cacheDirectory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
        throw new Error('the KV cache directory must be private and owned by the service user');
    }
    const key = randomBytes(32).toString('hex');
    const keyFile = path.join(cacheDirectory, `engine-${randomUUID()}.key`);
    await fs.writeFile(keyFile, `${key}\n`, { mode: 0o600, flag: 'wx' });
    command.push('--api-key-file', keyFile);
    return { ...backend, command, endpoint, readiness: new URL('/v1/models', endpoint).href, cacheDirectory, key, keyFile };
}
async function waitForBackend(backend, stopped) {
    const deadline = Date.now() + 75_000;
    const expected = backend.model.toLowerCase();
    while (Date.now() < deadline && !stopped()) {
        const headers = backend.key ? { Authorization: `Bearer ${backend.key}` } : undefined;
        const response = await fetch(backend.readiness, { headers, signal: AbortSignal.timeout(1000) }).catch(() => undefined);
        if (response?.ok) {
            const body = await response.json();
            const names = backend.engine === 'ollama'
                ? body.models?.filter(({ details }) => /^Q4_/i.test(details?.quantization_level ?? '')).map(({ name }) => name)
                : body.data?.map(({ id }) => id);
            if (names?.some((name) => name?.toLowerCase() === expected))
                return;
            throw new Error(`${backend.engine} does not list the required model ${backend.model}${backend.engine === 'ollama' ? ' at Q4 quantization' : ''}`);
        }
        await response?.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`${backend.engine} did not become ready at ${backend.readiness}`);
}
export async function superviseRuntime(plan, options) {
    if (options.signal?.aborted)
        return;
    const memoryFloor = plan.service === 'relay' ? RELAY_MEMORY_FLOOR : undefined;
    let policy = hostPolicy(await hostState(), Boolean(plan.idle_only), memoryFloor);
    if (policy.blocked)
        throw new Error(`cannot start ${plan.service}: ${policy.blocked}`);
    await Promise.all([checkDiskFloor(plan.data_dir), checkDiskFloor(path.dirname(plan.log))]);
    // This header satisfies the daemon's OpenAI client for a local backend that requires no key.
    const env = plan.backend_local ? { ...process.env, [LOCAL_BACKEND_KEY_ENV]: 'harbor-local' } : process.env;
    if (plan.backend_key_env && !env[plan.backend_key_env])
        throw new Error(`set ${plan.backend_key_env} in the service environment before starting ${plan.service}`);
    if (await canConnect(plan.port))
        throw new Error(`port ${plan.port} is already in use`);
    const backend = plan.managed_backend;
    if (backend) {
        const url = new URL(backend.endpoint);
        const port = Number(url.port);
        if (port === plan.port || await canConnect(port, url.hostname.replace(/^\[|\]$/g, ''))) {
            throw new Error(`managed backend port ${port} is already in use`);
        }
    }
    await fs.mkdir(plan.data_dir, { recursive: true });
    await fs.mkdir(path.dirname(plan.log), { recursive: true });
    const file = await fs.open(plan.log, 'a', 0o600);
    const log = file.createWriteStream();
    const workloads = [];
    const groups = () => workloads.flatMap(({ child, result }) => child.pid && !result ? [child.pid] : []);
    let problem;
    let stopping = false;
    let killTimer;
    let gateway;
    let engine;
    let engineWorkload;
    let engineReady = false;
    let pressurePaused = false;
    const stop = () => {
        if (stopping)
            return;
        stopping = true;
        for (const pid of groups()) {
            signalGroup(pid, 'SIGTERM');
            signalGroup(pid, 'SIGCONT');
        }
        killTimer = setTimeout(() => {
            for (const pid of groups())
                signalGroup(pid, 'SIGKILL');
        }, 4000);
    };
    const fail = (error) => {
        problem ??= error;
        stop();
    };
    function launch(command, environment) {
        const argv = process.platform === 'darwin' ? ['/usr/sbin/taskpolicy', '-b', '/usr/bin/nice', '-n', '10', ...command] : command;
        const child = spawn(argv[0], argv.slice(1), {
            cwd: plan.cwd,
            env: { ...env, ...environment },
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const closed = new Promise((resolve) => {
            child.once('error', (error) => { workload.result = { code: null, signal: null, error }; });
            child.once('exit', (code, signal) => {
                workload.result = { code, signal };
                if (child.pid)
                    signalGroup(child.pid, 'SIGKILL');
            });
            child.once('close', (code, signal) => resolve(workload.result ?? { code, signal }));
        });
        const workload = { child, closed };
        workloads.push(workload);
        child.stdout.pipe(log, { end: false });
        child.stderr.pipe(log, { end: false });
        child.stdout.pipe(options.mirror === 'both' ? process.stdout : process.stderr, { end: false });
        child.stderr.pipe(process.stderr, { end: false });
        return workload;
    }
    async function startBackend(enginePlan) {
        const workload = launch(enginePlan.command, enginePlan.environment);
        engineWorkload = workload;
        void workload.closed.then(({ code, signal, error }) => {
            if (!stopping && engineWorkload === workload)
                fail(error ?? new Error(`${enginePlan.engine} exited with status ${code ?? signal}`));
        });
        await waitForBackend(enginePlan, () => stopping);
        if (!stopping) {
            engineReady = true;
            gateway?.resume();
        }
    }
    async function pauseForPressure() {
        if (!gateway || !engineWorkload || !engineReady || pressurePaused)
            return;
        pressurePaused = true;
        await gateway.pause();
        const workload = engineWorkload;
        engineWorkload = undefined;
        engineReady = false;
        const pid = workload.child.pid;
        if (pid && !workload.result) {
            signalGroup(pid, 'SIGTERM');
            signalGroup(pid, 'SIGCONT');
            const deadline = setTimeout(() => {
                if (!workload.result)
                    signalGroup(pid, 'SIGKILL');
            }, 4000);
            try {
                await workload.closed;
            }
            finally {
                clearTimeout(deadline);
            }
        }
    }
    log.on('error', fail);
    let checking = false;
    const policyTimer = setInterval(async () => {
        if (checking || stopping)
            return;
        checking = true;
        try {
            const current = await hostState();
            const next = hostPolicy(current, Boolean(plan.idle_only), memoryFloor);
            if (stopping)
                return;
            if (current.available_memory_bytes < 2 ** 30)
                await pauseForPressure();
            if (pressurePaused && !next.blocked && current.available_memory_bytes < (localModel().working_memory_gib + 1) * 2 ** 30) {
                next.blocked = 'waiting for memory pressure to clear';
            }
            if (!stopping && next.blocked !== policy.blocked)
                log.write(next.blocked ? `Paused: ${next.blocked}\n` : 'Resumed after host conditions recovered\n');
            policy = next;
            if (pressurePaused && !stopping && !next.blocked && engine) {
                await startBackend(engine);
                pressurePaused = false;
            }
        }
        catch (error) {
            if (!stopping)
                fail(error);
        }
        finally {
            checking = false;
        }
    }, 10_000);
    let lastUsage = 0;
    let pendingUsage;
    const usageFile = plan.usage_file ?? plan.log.replace(/\.log$/, '.usage.json');
    const temporaryUsage = `${usageFile}.${process.pid}.tmp`;
    const stopWatching = watchProcessGroups(groups, plan.limits, fail, () => ({ paused: Boolean(policy.blocked), cpuScale: policy.cpuScale }), options.kernelLimits, (usage) => {
        const now = Date.now();
        if (pendingUsage || now - lastUsage < 2000)
            return;
        lastUsage = now;
        const sample = { ...usage, gpu_bytes: null, paused_reason: policy.blocked, kv_cache: gateway?.stats(), measured_at: now };
        pendingUsage = fs.writeFile(temporaryUsage, `${JSON.stringify(sample)}\n`, { mode: 0o600 })
            .then(() => fs.rename(temporaryUsage, usageFile)).catch(() => { })
            .finally(() => { pendingUsage = undefined; });
    });
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted)
        stop();
    try {
        if (backend) {
            engine = await backendEngine(backend);
            if (engine.cacheDirectory) {
                gateway = await createKvGateway(new URL(backend.endpoint), new URL(engine.endpoint), {
                    directory: engine.cacheDirectory,
                    parallel: backend.parallel,
                    engineKey: engine.key,
                });
            }
            if (!stopping)
                await startBackend(engine);
        }
        if (!stopping) {
            const workload = launch(plan.command);
            await waitForHealth(plan, () => Boolean(workload.result) || stopping, plan.service === 'nodeos' ? 75_000 : 10_000).catch((error) => {
                if (!stopping)
                    fail(workload.result?.error ?? error);
            });
            if (!stopping && !workload.result)
                options.onReady?.();
            const exit = await workload.closed;
            if (!stopping && (exit.error || exit.code !== 0)) {
                fail(exit.error ?? new Error(`${plan.service} exited with status ${exit.code ?? exit.signal}`));
            }
        }
        stop();
        await Promise.all(workloads.map(({ closed }) => closed));
        if (problem)
            throw problem;
    }
    finally {
        stop();
        await gateway?.close();
        await Promise.all(workloads.map(({ closed }) => closed));
        if (engine?.keyFile)
            await fs.rm(engine.keyFile, { force: true });
        stopWatching();
        await pendingUsage;
        await fs.rm(temporaryUsage, { force: true });
        clearInterval(policyTimer);
        clearTimeout(killTimer);
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        options.signal?.removeEventListener('abort', stop);
        const logClosed = log.closed ? undefined : once(log, 'close');
        log.end();
        await logClosed;
    }
}
