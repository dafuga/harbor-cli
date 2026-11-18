import {ChildProcess, spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {once} from 'node:events'
import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'
import {artifactBinary, defaultRuntimeConfigPath, defaultRuntimeDataDir, ResolveArtifactOptions, resolveArtifact, ResolvedArtifact, ServiceRuntime} from './artifacts.js'
import {harborHome} from './config.js'
import {isLocalHttp, LOCAL_BACKEND_KEY_ENV, localModel, ManagedBackend, ManagedBackendOptions, planManagedBackend} from './local-model.js'
import {canConnect} from './ports.js'
import {LimitOptions, ResourceLimits, resourceLimits, signalGroup, watchProcessGroups} from './resource-limits.js'
import {releaseAsset, runtimeTarget} from './runtime-host.js'

interface BackendOptions {
  backendEndpoint?: string
  backendProtocol?: string
  backendModel?: string
  backendApiKeyEnv?: string
}

export interface HarborRunOptions extends Omit<ResolveArtifactOptions, 'service'>, LimitOptions, BackendOptions, ManagedBackendOptions {
  config?: string
  dataDir?: string
  port?: string | number
  json?: boolean
  dryRun?: boolean
  modelProfile?: string
}

export interface HarborRunPlan {
  service: string
  daemon: string
  version: string
  source: string
  binary: string
  target: string
  release_asset: string
  config: string
  data_dir: string
  port: number
  command: string[]
  log: string
  limits: ResourceLimits
  cwd: string
  backend_key_env?: string
  backend_local?: boolean
  model_profile?: ReturnType<typeof localModel>
  managed_backend?: ManagedBackend
  artifact?: ResolvedArtifact
  dry_run: boolean
}

function q(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\t', '\\t')}"`
}

function providerAccount(service: string): string {
  const cleaned = service.replace(/[^a-z0-9]/g, '').slice(0, 9)
  return `hb${cleaned}`.padEnd(11, '1').slice(0, 12)
}

function serviceProviders(basePort: number): string {
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
  ] as const
  return services.map(([service, offset]) => {
    const endpoint = service === 'p2pseed' ? '127.0.0.1:9876' : `http://127.0.0.1:${basePort + offset}`
    return `
[[providers]]
account = ${q(providerAccount(service))}
service_type = ${q(service)}
endpoint = ${q(endpoint)}
range_start = 0
range_end = 999999999999
capacity_bytes = ${service === 'storage' ? 1073741824 : 0}
metadata = ${q(JSON.stringify({source: 'harbor-run', service}))}
`
  }).join('\n')
}

export function renderRuntimeConfig(input: {
  dataDir: string
  basePort: number
  historyRepo?: string
} & BackendOptions): string {
  const historyRepo = input.historyRepo ?? path.resolve(process.cwd(), '..', 'harbor-history')
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
backend_endpoint = ${q(input.backendEndpoint ?? process.env.HARBOR_AI_BACKEND_ENDPOINT ?? '')}
backend_protocol = ${q(input.backendProtocol ?? process.env.HARBOR_AI_BACKEND_PROTOCOL ?? 'raw')}
backend_model = ${q(input.backendModel ?? process.env.HARBOR_AI_BACKEND_MODEL ?? '')}
backend_api_key_env = ${q(input.backendApiKeyEnv ?? process.env.HARBOR_AI_BACKEND_API_KEY_ENV ?? '')}
trusted_checker_endpoint = ${q(process.env.HARBOR_AI_TRUSTED_CHECKER_ENDPOINT ?? '')}
trusted_checker_command = ${q(process.env.HARBOR_AI_TRUSTED_CHECKER_COMMAND ?? '')}
trusted_checker_min_score_bps = ${Number(process.env.HARBOR_AI_TRUSTED_CHECKER_MIN_SCORE_BPS ?? 8500)}
${serviceProviders(input.basePort)}
`
}

function parseConfig(source: string): Map<string, string> {
  const values = new Map<string, string>()
  let section = ''
  for (const raw of source.split('\n')) {
    const line = raw.match(/^(?:"(?:[^"\\]|\\.)*"|[^"#])*/)?.[0].trim() ?? ''
    const header = line.match(/^\[(.+)]$/)
    if (header) section = header[1]
    const assignment = line.match(/^(\w+)\s*=\s*(.*)$/)
    if (assignment) {
      const value = assignment[2].replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, (_, char) => char === 'n' ? '\n' : char === 't' ? '\t' : char)
      values.set(`${section}.${assignment[1]}`, value)
    }
  }
  return values
}

const BACKEND_FIELDS = {
  backendEndpoint: ['ai.backend_endpoint', 'HARBOR_AI_BACKEND_ENDPOINT', ''],
  backendProtocol: ['ai.backend_protocol', 'HARBOR_AI_BACKEND_PROTOCOL', 'raw'],
  backendModel: ['ai.backend_model', 'HARBOR_AI_BACKEND_MODEL', ''],
  backendApiKeyEnv: ['ai.backend_api_key_env', 'HARBOR_AI_BACKEND_API_KEY_ENV', ''],
} as const

async function runtimeConfig(config: string, service: ServiceRuntime, options: HarborRunOptions) {
  let existing: Map<string, string> | undefined
  try {
    existing = parseConfig(await fs.readFile(config, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const basePort = Number(existing?.get('services.base_port') ?? (existing || options.port === undefined ? 9100 : Number(options.port) - service.portOffset))
  const port = basePort + service.portOffset
  if (!Number.isInteger(basePort) || basePort < 1 || basePort > 65535 - service.portOffset) {
    throw new Error('service port and runtime base port must be integers from 1 to 65535')
  }
  const dataDir = path.resolve(existing?.get('services.data_dir') ?? (existing ? '/tmp/harbor-opportunities' : options.dataDir ?? defaultRuntimeDataDir()))
  if (existing && ((options.port !== undefined && port !== Number(options.port)) ||
      (options.dataDir !== undefined && dataDir !== path.resolve(options.dataDir)))) {
    throw new Error(`--port or --data-dir conflicts with ${config}. Choose a new --config path or update the existing file.`)
  }
  const configuredBackend = (Object.keys(BACKEND_FIELDS) as Array<keyof BackendOptions>)
    .some((key) => options[key] !== undefined || process.env[BACKEND_FIELDS[key][1]] !== undefined)
  const profileName = options.modelProfile ?? (!existing && service.name === 'aiinfer' && !configuredBackend ? 'auto' : undefined)
  const modelProfile = profileName ? localModel(profileName) : undefined
  const profileDefaults: BackendOptions = modelProfile ? {
    backendEndpoint: modelProfile.backend_endpoint,
    backendProtocol: 'openai',
    backendModel: modelProfile.model,
  } : {}
  const backend: BackendOptions = {}
  for (const key of Object.keys(BACKEND_FIELDS) as Array<keyof BackendOptions>) {
    const [name, env, fallback] = BACKEND_FIELDS[key]
    const selected = options[key] ?? profileDefaults[key]
    const value = existing ? existing.get(name) ?? fallback : options[key] ?? process.env[env] ?? profileDefaults[key] ?? fallback
    if (existing && selected !== undefined && value !== selected) {
      throw new Error(`${name} conflicts with ${config}. Choose a new --config path or update the existing file.`)
    }
    backend[key] = value
  }
  const loopback = isLocalHttp(backend.backendEndpoint ?? '')
  if (modelProfile && !existing && !backend.backendApiKeyEnv && loopback) backend.backendApiKeyEnv = LOCAL_BACKEND_KEY_ENV
  if (backend.backendEndpoint) {
    const {protocol, username, password} = new URL(backend.backendEndpoint)
    if (!['http:', 'https:'].includes(protocol) || username || password) throw new Error('inference backend endpoint must be an HTTP(S) URL without credentials')
  }
  if (backend.backendProtocol !== 'raw' && backend.backendProtocol !== 'openai') throw new Error('backend protocol must be raw or openai')
  if (backend.backendApiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(backend.backendApiKeyEnv)) {
    throw new Error('backend API key environment variable name is invalid')
  }
  if (backend.backendApiKeyEnv === LOCAL_BACKEND_KEY_ENV && !loopback) {
    throw new Error(`${LOCAL_BACKEND_KEY_ENV} is reserved for a loopback inference backend`)
  }
  if (backend.backendProtocol === 'openai' && (!backend.backendEndpoint || !backend.backendModel || !backend.backendApiKeyEnv)) {
    throw new Error('the OpenAI-compatible backend requires an endpoint, model, and API key environment variable name')
  }
  return {port, dataDir, backend, modelProfile, generated: existing ? undefined : renderRuntimeConfig({dataDir, basePort, ...backend})}
}

export async function buildRunPlan(service: ServiceRuntime, options: HarborRunOptions): Promise<HarborRunPlan> {
  const target = runtimeTarget()
  const version = options.version ?? 'dev'
  const prospectiveBinary = artifactBinary(service, version)
  const limits = resourceLimits(options)
  const config = path.resolve(options.config ?? defaultRuntimeConfigPath())
  let runtime = await runtimeConfig(config, service, options)
  const managedBackend = await planManagedBackend(options, runtime.backend.backendEndpoint!, runtime.backend.backendModel!,
    runtime.backend.backendProtocol!, limits.cpu_cores, Boolean(options.dryRun))
  if (managedBackend && !runtime.backend.backendApiKeyEnv) throw new Error('a managed backend requires a local model profile or --backend-api-key-env')
  const artifact = options.dryRun
    ? undefined
    : await resolveArtifact({...options, service, version})
  if (!options.dryRun && runtime.generated !== undefined) {
    await fs.mkdir(path.dirname(config), {recursive: true})
    const temporary = `${config}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, runtime.generated, {flag: 'wx', mode: 0o600})
      await fs.link(temporary, config)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      runtime = await runtimeConfig(config, service, options)
    } finally {
      await fs.rm(temporary, {force: true})
    }
  }
  const binary = artifact?.binary ?? prospectiveBinary
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
    command: [binary, '--config', config],
    log: path.resolve(harborHome(), 'logs', `${service.name}.log`),
    limits,
    cwd: process.cwd(),
    backend_key_env: runtime.backend.backendApiKeyEnv || undefined,
    backend_local: runtime.backend.backendApiKeyEnv === LOCAL_BACKEND_KEY_ENV || undefined,
    model_profile: runtime.modelProfile,
    managed_backend: managedBackend,
    artifact,
    dry_run: Boolean(options.dryRun),
  }
}

export async function serviceHealthy(port: number, service: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(1000)})
    if (!response.ok) return false
    const health = await response.json() as {ok?: boolean; role?: string}
    return health.ok === true && health.role === service
  } catch {
    return false
  }
}

export async function waitForHealth(plan: Pick<HarborRunPlan, 'port' | 'service'>, childExited: () => boolean = () => false, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout
  const url = `http://127.0.0.1:${plan.port}/health`
  while (Date.now() < deadline) {
    if (childExited()) {
      throw new Error(`service exited before readiness: ${url}`)
    }
    if (await serviceHealthy(plan.port, plan.service) && !childExited()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`service did not become healthy: ${url}`)
}

export async function runServiceForeground(service: ServiceRuntime, options: HarborRunOptions): Promise<HarborRunPlan> {
  const plan = await buildRunPlan(service, options)
  if (!options.dryRun) await superviseRuntime(plan, {mirror: options.json ? 'stderr' : 'both', kernelLimits: false})
  return plan
}

type ChildResult = {code: number | null; signal: NodeJS.Signals | null; error?: Error}
interface Workload {
  child: ChildProcess
  closed: Promise<ChildResult>
  result?: ChildResult
}

async function waitForBackend(backend: ManagedBackend, stopped: () => boolean): Promise<void> {
  const deadline = Date.now() + 75_000
  const expected = backend.model.toLowerCase()
  while (Date.now() < deadline && !stopped()) {
    const response = await fetch(backend.readiness, {signal: AbortSignal.timeout(1000)}).catch(() => undefined)
    if (response?.ok) {
      const body = await response.json() as {models?: Array<{name?: string}>; data?: Array<{id?: string}>}
      const names = backend.engine === 'ollama' ? body.models?.map(({name}) => name) : body.data?.map(({id}) => id)
      if (names?.some((name) => name?.toLowerCase() === expected)) return
      throw new Error(`${backend.engine} does not list model ${backend.model}`)
    }
    await response?.body?.cancel()
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`${backend.engine} did not become ready at ${backend.readiness}`)
}

export async function superviseRuntime(plan: HarborRunPlan, options: {mirror: 'both' | 'stderr'; kernelLimits: boolean}): Promise<void> {
  // This header satisfies the daemon's OpenAI client for a local backend that requires no key.
  const env = plan.backend_local ? {...process.env, [LOCAL_BACKEND_KEY_ENV]: 'harbor-local'} : process.env
  if (plan.backend_key_env && !env[plan.backend_key_env]) throw new Error(`set ${plan.backend_key_env} in the service environment before starting ${plan.service}`)
  if (await canConnect(plan.port)) throw new Error(`port ${plan.port} is already in use`)
  const backend = plan.managed_backend
  if (backend) {
    const url = new URL(backend.endpoint)
    const port = Number(url.port)
    if (port === plan.port || await canConnect(port, url.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`managed backend port ${port} is already in use`)
    }
  }
  await fs.mkdir(plan.data_dir, {recursive: true})
  await fs.mkdir(path.dirname(plan.log), {recursive: true})
  const file = await fs.open(plan.log, 'a', 0o600)
  const log = file.createWriteStream()
  const workloads: Workload[] = []
  const groups = () => workloads.flatMap(({child, result}) => child.pid && !result ? [child.pid] : [])
  let problem: Error | undefined
  let stopping = false
  let killTimer: NodeJS.Timeout | undefined
  const stop = () => {
    if (stopping) return
    stopping = true
    for (const pid of groups()) {
      signalGroup(pid, 'SIGTERM')
      signalGroup(pid, 'SIGCONT')
    }
    killTimer = setTimeout(() => {
      for (const pid of groups()) signalGroup(pid, 'SIGKILL')
    }, 4000)
  }
  const fail = (error: Error) => {
    problem ??= error
    stop()
  }
  function launch(command: string[], environment?: Record<string, string>): Workload {
    const child = spawn(command[0], command.slice(1), {
      cwd: plan.cwd,
      env: {...env, ...environment},
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const closed = new Promise<ChildResult>((resolve) => {
      child.once('error', (error) => { workload.result = {code: null, signal: null, error} })
      child.once('exit', (code, signal) => {
        workload.result = {code, signal}
        if (child.pid) signalGroup(child.pid, 'SIGKILL')
      })
      child.once('close', (code, signal) => resolve(workload.result ?? {code, signal}))
    })
    const workload: Workload = {child, closed}
    workloads.push(workload)
    child.stdout.pipe(log, {end: false})
    child.stderr.pipe(log, {end: false})
    child.stdout.pipe(options.mirror === 'both' ? process.stdout : process.stderr, {end: false})
    child.stderr.pipe(process.stderr, {end: false})
    return workload
  }
  log.on('error', fail)
  const stopWatching = options.kernelLimits ? undefined : watchProcessGroups(groups, plan.limits, fail)
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    if (backend) {
      const workload = launch(backend.command, backend.environment)
      void workload.closed.then(({code, signal, error}) => {
        if (!stopping) fail(error ?? new Error(`${backend.engine} exited with status ${code ?? signal}`))
      })
      await waitForBackend(backend, () => stopping).catch((error: Error) => {
        if (!stopping) fail(workload.result?.error ?? error)
      })
    }
    if (!stopping) {
      const workload = launch(plan.command)
      await waitForHealth(plan, () => Boolean(workload.result) || stopping).catch((error: Error) => {
        if (!stopping) fail(workload.result?.error ?? error)
      })
      const exit = await workload.closed
      if (!stopping && (exit.error || exit.code !== 0)) {
        fail(exit.error ?? new Error(`${plan.service} exited with status ${exit.code ?? exit.signal}`))
      }
    }
    stop()
    await Promise.all(workloads.map(({closed}) => closed))
    if (problem) throw problem
  } finally {
    stop()
    await Promise.all(workloads.map(({closed}) => closed))
    stopWatching?.()
    clearTimeout(killTimer)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    const logClosed = log.closed ? undefined : once(log, 'close')
    log.end()
    await logClosed
  }
}
