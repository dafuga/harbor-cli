import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { normalizeServiceName } from './artifacts.js';
import { harborHome } from './config.js';
import { renderLaunchdPlist } from './launchd.js';
import { canConnect } from './ports.js';
import { buildRunPlan, serviceHealthy, superviseRuntime, waitForHealth } from './run.js';
import { runtimeTarget } from './runtime-host.js';
const exec = promisify(execFile);
export function serviceManager() {
    runtimeTarget();
    return process.platform === 'darwin' ? 'launchd' : 'systemd';
}
export function registration(service, system = false) {
    const manager = serviceManager();
    if (system && manager !== 'systemd')
        throw new Error('--system is supported with Linux systemd');
    const home = path.resolve(harborHome());
    const namespace = createHash('sha256').update(home).digest('hex').slice(0, 12);
    const id = `io.harbor.runtime.${namespace}.${service.name}`;
    const dir = path.join(home, system ? 'system-services' : 'services', service.name);
    return {
        manager,
        system,
        id,
        record: path.join(dir, 'registration.json'),
        definition: manager === 'launchd'
            ? path.join(dir, `${id}.plist`)
            : system
                ? path.join('/etc/systemd/system', `${id}.service`)
                : path.resolve(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'systemd', 'user', `${id}.service`),
    };
}
function domain() {
    return `gui/${process.getuid()}`;
}
async function managerCommand(manager, args, system = false) {
    const command = manager === 'launchd' ? '/bin/launchctl' : 'systemctl';
    const argv = manager === 'systemd' ? [system ? '--system' : '--user', ...args] : args;
    const env = { ...process.env, LC_ALL: 'C' };
    if (manager === 'systemd' && !system)
        env.XDG_RUNTIME_DIR ??= `/run/user/${process.getuid()}`;
    const { stdout } = await exec(command, argv, { timeout: 15_000, env });
    return stdout;
}
export async function verifyServiceManager(system = false) {
    const manager = serviceManager();
    try {
        await managerCommand(manager, manager === 'launchd' ? ['print', domain()] : ['show', '--property=Version'], system);
    }
    catch (error) {
        const instruction = manager === 'launchd' ? 'Use a logged-in macOS desktop session.' : 'Start a systemd user session. On WSL2 enable systemd first.';
        throw new Error(`${manager} ${system ? 'system' : 'user'} manager is unavailable. ${instruction}`, { cause: error });
    }
}
function systemdQuote(value) {
    if (/[\u0000-\u001f\u007f]/.test(value))
        throw new Error('systemd service paths cannot contain control characters');
    return JSON.stringify(value.replaceAll('%', '%%'));
}
export function renderServiceDefinition(spec, plan, launcher) {
    const [command, ...args] = [...launcher, 'service', 'supervise', spec.record];
    if (spec.manager === 'launchd') {
        return renderLaunchdPlist({
            label: spec.id,
            command,
            args,
            workingDirectory: plan.cwd,
            restartOnFailure: true,
            supervisorLog: `${plan.log}.supervisor`,
        });
    }
    return `[Unit]
Description=Harbor ${plan.service}
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=exec
ExecStart=:${[command, ...args].map(systemdQuote).join(' ')}
Restart=on-failure
RestartSec=3
TimeoutStopSec=8
CPUQuota=${plan.limits.cpu_cores * 100}%
MemoryMax=${plan.limits.memory_bytes}
UMask=0077
`;
}
async function readRegistration(file) {
    try {
        const record = JSON.parse(await fs.readFile(file, 'utf8'));
        if (record.schema !== 1 || record.spec.record !== file || record.plan.target !== runtimeTarget()) {
            throw new Error(`incompatible Harbor service registration: ${file}`);
        }
        return record;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
export async function installService(service, options, launcher, system = false) {
    const spec = registration(service, system);
    if (!options.dryRun) {
        if (system && process.getuid?.() !== 0)
            throw new Error('system-level Harbor service installation requires root');
        if (await readRegistration(spec.record))
            throw new Error(`${service.name} is already installed. Uninstall it before changing its registration.`);
        await verifyServiceManager(system);
    }
    const plan = await buildRunPlan(service, options);
    const definition = renderServiceDefinition(spec, plan, launcher);
    if (options.dryRun)
        return { ...spec, plan, preview: definition };
    await fs.mkdir(path.dirname(spec.record), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(spec.definition), { recursive: true });
    await fs.mkdir(path.dirname(plan.log), { recursive: true, mode: 0o700 });
    const record = { schema: 1, spec, plan };
    await fs.writeFile(spec.record, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    let wroteDefinition = false;
    try {
        await fs.writeFile(spec.definition, definition, { flag: 'wx', mode: 0o600 });
        wroteDefinition = true;
        if (spec.manager === 'systemd')
            await managerCommand(spec.manager, ['daemon-reload'], spec.system);
    }
    catch (error) {
        if (wroteDefinition)
            await fs.rm(spec.definition, { force: true });
        await fs.rm(spec.record, { force: true });
        throw error;
    }
    return { ...spec, plan };
}
async function state(spec) {
    if (spec.manager === 'systemd') {
        const status = (await managerCommand(spec.manager, ['show', '--property=ActiveState', '--value', `${spec.id}.service`], spec.system)).trim();
        if (status === 'active')
            return 'running';
        if (status === 'activating' || status === 'reloading')
            return 'starting';
        if (status === 'deactivating')
            return 'stopping';
        return status === 'failed' ? 'failed' : 'stopped';
    }
    try {
        const status = await managerCommand(spec.manager, ['print', `${domain()}/${spec.id}`]);
        if (/^\s+state = running\s*$/m.test(status))
            return 'running';
        if (/^\s+last exit code = [1-9]\d*\s*$/m.test(status))
            return 'failed';
        return 'starting';
    }
    catch (error) {
        if (error.stderr?.includes('Could not find service'))
            return 'stopped';
        throw error;
    }
}
async function managerState(record) {
    const current = await state(record.spec);
    const usage = current === 'running' && record.plan.usage_file
        ? await fs.readFile(record.plan.usage_file, 'utf8').then((raw) => JSON.parse(raw)).catch(() => undefined)
        : undefined;
    const liveUsage = usage && Date.now() - usage.measured_at < 10_000 ? usage : undefined;
    return {
        service: record.plan.service,
        manager: record.spec.manager,
        system: Boolean(record.spec.system),
        target: record.plan.target,
        installed: true,
        state: current,
        healthy: current === 'running' && await serviceHealthy(record.plan.port, record.plan.service),
        port: record.plan.port,
        limits: record.plan.limits,
        usage: liveUsage,
        log: record.plan.log,
        config: record.plan.config,
        backend: record.plan.managed_backend && {
            engine: record.plan.managed_backend.engine,
            model: record.plan.managed_backend.model,
            parallel: record.plan.managed_backend.parallel,
        },
    };
}
export async function serviceStatus(service, system = false) {
    const spec = registration(service, system);
    const record = await readRegistration(spec.record);
    if (record)
        return managerState(record);
    return {
        service: service.name,
        manager: spec.manager,
        system,
        target: runtimeTarget(),
        installed: false,
        state: 'uninstalled',
        healthy: false,
    };
}
export async function registeredService(service, system = false) {
    const record = await readRegistration(registration(service, system).record);
    if (!record)
        throw new Error(`${service.name} is not installed. Run harbor service install ${service.name}.`);
    return record;
}
async function stopService(spec, plan) {
    const previous = await state(spec);
    if (previous === 'stopped')
        return;
    if (spec.manager === 'systemd') {
        await managerCommand(spec.manager, ['stop', `${spec.id}.service`], spec.system);
    }
    else {
        await managerCommand(spec.manager, ['bootout', `${domain()}/${spec.id}`]);
        const deadline = Date.now() + 8000;
        const backend = plan.managed_backend && new URL(plan.managed_backend.endpoint);
        const hasBackend = () => backend && previous === 'running' && canConnect(Number(backend.port), backend.hostname.replace(/^\[|\]$/g, ''));
        while (await state(spec) !== 'stopped' || await canConnect(plan.port) || await hasBackend()) {
            if (Date.now() >= deadline)
                throw new Error(`${spec.id} did not unload and release its ports after stop`);
            await delay(100);
        }
    }
}
export async function controlService(service, action, system = false) {
    const record = await registeredService(service, system);
    const { spec, plan } = record;
    await verifyServiceManager(system);
    if (action !== 'start')
        await stopService(spec, plan);
    if (action === 'uninstall') {
        await fs.rm(spec.definition, { force: true });
        if (spec.manager === 'systemd')
            await managerCommand(spec.manager, ['daemon-reload'], spec.system);
        await fs.rm(spec.record, { force: true });
        return serviceStatus(service, system);
    }
    if (action !== 'stop') {
        const current = await state(spec);
        if (current === 'failed') {
            await stopService(spec, plan);
            if (spec.manager === 'systemd')
                await managerCommand(spec.manager, ['reset-failed', `${spec.id}.service`], spec.system);
        }
        if (action === 'restart' || current === 'stopped' || current === 'failed') {
            if (await canConnect(plan.port))
                throw new Error(`port ${plan.port} is already in use`);
            if (spec.manager === 'launchd')
                await managerCommand(spec.manager, ['bootstrap', domain(), spec.definition]);
            else
                await managerCommand(spec.manager, ['start', `${spec.id}.service`], spec.system);
        }
        await waitForHealth(plan, undefined, plan.managed_backend || plan.service === 'nodeos' ? 90_000 : 15_000).catch((error) => {
            throw new Error(`${error.message}. Run harbor service logs ${service.name} --supervisor`, { cause: error });
        });
    }
    return managerState(record);
}
async function hasKernelLimits(plan) {
    try {
        const scope = (await fs.readFile('/proc/self/cgroup', 'utf8')).match(/^0::(\/.*)$/m)?.[1];
        if (!scope)
            return false;
        const cgroup = path.join('/sys/fs/cgroup', scope);
        const [cpu, memory] = await Promise.all([
            fs.readFile(path.join(cgroup, 'cpu.max'), 'utf8'),
            fs.readFile(path.join(cgroup, 'memory.max'), 'utf8'),
        ]);
        const [quota, period] = cpu.trim().split(/\s+/).map(Number);
        return quota / period <= plan.limits.cpu_cores + 0.00001 && Number(memory.trim()) <= plan.limits.memory_bytes;
    }
    catch {
        return false;
    }
}
export async function superviseRegisteredService(file) {
    const record = await readRegistration(file);
    if (!record)
        throw new Error(`missing service registration: ${file}`);
    const { plan } = record;
    process.chdir(plan.cwd);
    await fs.access(plan.config);
    const live = await buildRunPlan(normalizeServiceName(plan.service), {
        dryRun: true,
        config: plan.config,
        port: plan.port,
        dataDir: plan.data_dir,
        backendEndpoint: plan.managed_backend?.endpoint,
        backendModel: plan.managed_backend?.model,
        backendProtocol: plan.managed_backend ? 'openai' : undefined,
    });
    const kernelLimits = record.spec.manager === 'systemd' && await hasKernelLimits(plan);
    await superviseRuntime({ ...plan, backend_key_env: live.backend_key_env, backend_local: live.backend_local }, { mirror: 'stderr', kernelLimits });
}
