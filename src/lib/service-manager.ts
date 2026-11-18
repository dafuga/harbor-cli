import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {promisify} from 'node:util'
import {normalizeServiceName, ServiceRuntime} from './artifacts.js'
import {harborHome} from './config.js'
import {renderLaunchdPlist} from './launchd.js'
import {canConnect} from './ports.js'
import {buildRunPlan, HarborRunOptions, HarborRunPlan, serviceHealthy, superviseRuntime, waitForHealth} from './run.js'
import {runtimeTarget} from './runtime-host.js'

const exec = promisify(execFile)
type Manager = 'launchd' | 'systemd'
type ServiceState = 'running' | 'starting' | 'stopping' | 'stopped' | 'failed'

export interface ServiceRegistration {
  manager: Manager
  id: string
  record: string
  definition: string
}

export function serviceManager(): Manager {
  runtimeTarget()
  return process.platform === 'darwin' ? 'launchd' : 'systemd'
}

export function registration(service: ServiceRuntime): ServiceRegistration {
  const manager = serviceManager()
  const home = path.resolve(harborHome())
  const namespace = createHash('sha256').update(home).digest('hex').slice(0, 12)
  const id = `io.harbor.runtime.${namespace}.${service.name}`
  const dir = path.join(home, 'services', service.name)
  return {
    manager,
    id,
    record: path.join(dir, 'registration.json'),
    definition: manager === 'launchd'
      ? path.join(dir, `${id}.plist`)
      : path.resolve(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'systemd', 'user', `${id}.service`),
  }
}

function domain(): string {
  return `gui/${process.getuid!()}`
}

async function managerCommand(manager: Manager, args: string[]): Promise<string> {
  const command = manager === 'launchd' ? '/bin/launchctl' : 'systemctl'
  const argv = manager === 'systemd' ? ['--user', ...args] : args
  const env: NodeJS.ProcessEnv = {...process.env, LC_ALL: 'C'}
  if (manager === 'systemd') env.XDG_RUNTIME_DIR ??= `/run/user/${process.getuid!()}`
  const {stdout} = await exec(command, argv, {timeout: 15_000, env})
  return stdout
}

export async function verifyServiceManager(): Promise<void> {
  const manager = serviceManager()
  try {
    await managerCommand(manager, manager === 'launchd' ? ['print', domain()] : ['show', '--property=Version'])
  } catch (error) {
    const instruction = manager === 'launchd' ? 'Use a logged-in macOS desktop session.' : 'Start a systemd user session. On WSL2 enable systemd first.'
    throw new Error(`${manager} user manager is unavailable. ${instruction}`, {cause: error})
  }
}

function systemdQuote(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('systemd service paths cannot contain control characters')
  return JSON.stringify(value.replaceAll('%', '%%'))
}

export function renderServiceDefinition(spec: ServiceRegistration, plan: HarborRunPlan, launcher: string[]): string {
  const [command, ...args] = [...launcher, 'service', 'supervise', spec.record]
  if (spec.manager === 'launchd') {
    return renderLaunchdPlist({
      label: spec.id,
      command,
      args,
      workingDirectory: plan.cwd,
      restartOnFailure: true,
      supervisorLog: `${plan.log}.supervisor`,
    })
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
`
}

interface RecordedService {
  schema: 1
  spec: ServiceRegistration
  plan: HarborRunPlan
}

async function readRegistration(file: string): Promise<RecordedService | undefined> {
  try {
    const record = JSON.parse(await fs.readFile(file, 'utf8')) as RecordedService
    if (record.schema !== 1 || record.spec.record !== file || record.plan.target !== runtimeTarget()) {
      throw new Error(`incompatible Harbor service registration: ${file}`)
    }
    return record
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function installService(service: ServiceRuntime, options: HarborRunOptions, launcher: string[]) {
  const spec = registration(service)
  if (!options.dryRun) {
    if (await readRegistration(spec.record)) throw new Error(`${service.name} is already installed. Uninstall it before changing its registration.`)
    await verifyServiceManager()
  }
  const plan = await buildRunPlan(service, options)
  const definition = renderServiceDefinition(spec, plan, launcher)
  if (options.dryRun) return {...spec, plan, preview: definition}

  await fs.mkdir(path.dirname(spec.record), {recursive: true, mode: 0o700})
  await fs.mkdir(path.dirname(spec.definition), {recursive: true})
  await fs.mkdir(path.dirname(plan.log), {recursive: true, mode: 0o700})
  const record: RecordedService = {schema: 1, spec, plan}
  await fs.writeFile(spec.record, `${JSON.stringify(record, null, 2)}\n`, {flag: 'wx', mode: 0o600})
  let wroteDefinition = false
  try {
    await fs.writeFile(spec.definition, definition, {flag: 'wx', mode: 0o600})
    wroteDefinition = true
    if (spec.manager === 'systemd') await managerCommand(spec.manager, ['daemon-reload'])
  } catch (error) {
    if (wroteDefinition) await fs.rm(spec.definition, {force: true})
    await fs.rm(spec.record, {force: true})
    throw error
  }
  return {...spec, plan}
}

async function state(spec: ServiceRegistration): Promise<ServiceState> {
  if (spec.manager === 'systemd') {
    const status = (await managerCommand(spec.manager, ['show', '--property=ActiveState', '--value', `${spec.id}.service`])).trim()
    if (status === 'active') return 'running'
    if (status === 'activating' || status === 'reloading') return 'starting'
    if (status === 'deactivating') return 'stopping'
    return status === 'failed' ? 'failed' : 'stopped'
  }
  try {
    const status = await managerCommand(spec.manager, ['print', `${domain()}/${spec.id}`])
    if (/^\s+state = running\s*$/m.test(status)) return 'running'
    if (/^\s+last exit code = [1-9]\d*\s*$/m.test(status)) return 'failed'
    return 'starting'
  } catch (error) {
    if ((error as {stderr?: string}).stderr?.includes('Could not find service')) return 'stopped'
    throw error
  }
}

async function managerState(record: RecordedService) {
  const current = await state(record.spec)
  return {
    service: record.plan.service,
    manager: record.spec.manager,
    target: record.plan.target,
    installed: true,
    state: current,
    healthy: current === 'running' && await serviceHealthy(record.plan.port, record.plan.service),
    port: record.plan.port,
    limits: record.plan.limits,
    log: record.plan.log,
    config: record.plan.config,
    backend: record.plan.managed_backend && {
      engine: record.plan.managed_backend.engine,
      model: record.plan.managed_backend.model,
    },
  }
}

export async function serviceStatus(service: ServiceRuntime) {
  const spec = registration(service)
  const record = await readRegistration(spec.record)
  if (record) return managerState(record)
  return {
    service: service.name,
    manager: spec.manager,
    target: runtimeTarget(),
    installed: false,
    state: 'uninstalled',
    healthy: false,
  }
}

export async function registeredService(service: ServiceRuntime): Promise<RecordedService> {
  const record = await readRegistration(registration(service).record)
  if (!record) throw new Error(`${service.name} is not installed. Run harbor service install ${service.name}.`)
  return record
}

async function stopService(spec: ServiceRegistration, plan: HarborRunPlan): Promise<void> {
  const previous = await state(spec)
  if (previous === 'stopped') return
  if (spec.manager === 'systemd') {
    await managerCommand(spec.manager, ['stop', `${spec.id}.service`])
  } else {
    await managerCommand(spec.manager, ['bootout', `${domain()}/${spec.id}`])
    const deadline = Date.now() + 8000
    const backend = plan.managed_backend && new URL(plan.managed_backend.endpoint)
    const hasBackend = () => backend && previous === 'running' && canConnect(Number(backend.port), backend.hostname.replace(/^\[|\]$/g, ''))
    while (await state(spec) !== 'stopped' || await canConnect(plan.port) || await hasBackend()) {
      if (Date.now() >= deadline) throw new Error(`${spec.id} did not unload and release its ports after stop`)
      await delay(100)
    }
  }
}

export async function controlService(service: ServiceRuntime, action: 'start' | 'stop' | 'restart' | 'uninstall') {
  const record = await registeredService(service)
  const {spec, plan} = record
  await verifyServiceManager()
  if (action !== 'start') await stopService(spec, plan)
  if (action === 'uninstall') {
    await fs.rm(spec.definition, {force: true})
    if (spec.manager === 'systemd') await managerCommand(spec.manager, ['daemon-reload'])
    await fs.rm(spec.record, {force: true})
    return serviceStatus(service)
  }
  if (action !== 'stop') {
    const current = await state(spec)
    if (current === 'failed') {
      await stopService(spec, plan)
      if (spec.manager === 'systemd') await managerCommand(spec.manager, ['reset-failed', `${spec.id}.service`])
    }
    if (action === 'restart' || current === 'stopped' || current === 'failed') {
      if (await canConnect(plan.port)) throw new Error(`port ${plan.port} is already in use`)
      if (spec.manager === 'launchd') await managerCommand(spec.manager, ['bootstrap', domain(), spec.definition])
      else await managerCommand(spec.manager, ['start', `${spec.id}.service`])
    }
    await waitForHealth(plan, undefined, plan.managed_backend ? 90_000 : 15_000).catch((error: Error) => {
      throw new Error(`${error.message}. Run harbor service logs ${service.name} --supervisor`, {cause: error})
    })
  }
  return managerState(record)
}

async function hasKernelLimits(plan: HarborRunPlan): Promise<boolean> {
  try {
    const scope = (await fs.readFile('/proc/self/cgroup', 'utf8')).match(/^0::(\/.*)$/m)?.[1]
    if (!scope) return false
    const cgroup = path.join('/sys/fs/cgroup', scope)
    const [cpu, memory] = await Promise.all([
      fs.readFile(path.join(cgroup, 'cpu.max'), 'utf8'),
      fs.readFile(path.join(cgroup, 'memory.max'), 'utf8'),
    ])
    const [quota, period] = cpu.trim().split(/\s+/).map(Number)
    return quota / period <= plan.limits.cpu_cores + 0.00001 && Number(memory.trim()) <= plan.limits.memory_bytes
  } catch {
    return false
  }
}

export async function superviseRegisteredService(file: string): Promise<void> {
  const record = await readRegistration(file)
  if (!record) throw new Error(`missing service registration: ${file}`)
  const {plan} = record
  process.chdir(plan.cwd)
  await fs.access(plan.config)
  const live = await buildRunPlan(normalizeServiceName(plan.service), {
    dryRun: true,
    config: plan.config,
    port: plan.port,
    dataDir: plan.data_dir,
    backendEndpoint: plan.managed_backend?.endpoint,
    backendModel: plan.managed_backend?.model,
    backendProtocol: plan.managed_backend ? 'openai' : undefined,
  })
  const kernelLimits = record.spec.manager === 'systemd' && await hasKernelLimits(plan)
  await superviseRuntime({...plan, backend_key_env: live.backend_key_env, backend_local: live.backend_local}, {mirror: 'stderr', kernelLimits})
}
