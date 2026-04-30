import {Command} from 'commander'
import {defaultConfigPath, ensureHarborDirs, HarborAgentConfig, loadConfig} from '../lib/config.js'
import {canConnect} from '../lib/ports.js'

interface AgentStatusOptions {
  bpPort: string
  apiPort: string
  tracePort: string
  historyCorePort?: string
  historyActionsPort: string
  historyTxPort: string
  historyApiPort: string
  historyStreamPort: string
  storagePort: string
  config?: string
}

type ServiceKey = keyof HarborAgentConfig['services']

interface PortSpec {
  service: string
  configKey: ServiceKey
  optionKey: keyof AgentStatusOptions
  fallback?: number
}

const STATUS_PORTS: PortSpec[] = [
  {service: 'bp', configKey: 'blockProducer', optionKey: 'bpPort'},
  {service: 'chain-api', configKey: 'chainApi', optionKey: 'apiPort'},
  {service: 'trace-api', configKey: 'traceApi', optionKey: 'tracePort'},
  {service: 'history-core', configKey: 'historyCore', optionKey: 'historyCorePort'},
  {service: 'history-actions', configKey: 'historyActions', optionKey: 'historyActionsPort'},
  {service: 'history-tx', configKey: 'historyTx', optionKey: 'historyTxPort'},
  {service: 'history-api', configKey: 'historyApi', optionKey: 'historyApiPort'},
  {service: 'history-stream', configKey: 'historyStream', optionKey: 'historyStreamPort'},
  {service: 'storage-manifest', configKey: 'storageManifest', optionKey: 'storagePort'},
]

const DOCTOR_FALLBACKS: Partial<Record<ServiceKey, number>> = {
  chainApi: 8888,
  traceApi: 8889,
  historyActions: 8081,
  historyTx: 8082,
  historyApi: 8080,
  historyStream: 8083,
  storageManifest: 9090,
}

async function loadOptionalConfig(configPath?: string) {
  try {
    return await loadConfig(configPath)
  } catch {
    return null
  }
}

function optionPort(options: AgentStatusOptions, key: keyof AgentStatusOptions): number | undefined {
  const value = options[key]
  return value ? Number(value) : undefined
}

function configuredPort(config: HarborAgentConfig | null, options: AgentStatusOptions, spec: PortSpec): number | undefined {
  return config?.services[spec.configKey].port ?? optionPort(options, spec.optionKey)
}

async function statusRows(config: HarborAgentConfig | null, options: AgentStatusOptions) {
  const checks = STATUS_PORTS
    .map((spec) => ({service: spec.service, port: configuredPort(config, options, spec)}))
    .filter((check): check is {service: string; port: number} => Number.isFinite(check.port))

  return Promise.all(checks.map(async (check) => ({...check, reachable: await canConnect(check.port)})))
}

async function doctorPortRow(name: string, port?: number, fallback?: number) {
  const value = port ?? fallback
  return {
    check: `${name}-port`,
    value: String(value ?? 'unconfigured'),
    ok: value ? await canConnect(value) : false,
  }
}

async function doctorRows(config: HarborAgentConfig, configPath: string) {
  const portRows = await Promise.all(
    STATUS_PORTS.map((spec) => doctorPortRow(spec.service, config.services[spec.configKey].port, DOCTOR_FALLBACKS[spec.configKey]))
  )
  return [
    {check: 'config', value: configPath, ok: true},
    {check: 'storage-dir', value: config.storageDir, ok: true},
    ...portRows,
  ]
}

function addStatusCommand(agent: Command): void {
  agent
    .command('status')
    .description('Check local Harbor service ports')
    .option('--bp-port <port>', 'block producer p2p port', '9876')
    .option('--api-port <port>', 'Harbor chain API port', '8888')
    .option('--trace-port <port>', 'Harbor trace API port', '8889')
    .option('--history-core-port <port>', 'Harbor History core/indexing status port')
    .option('--history-actions-port <port>', 'Harbor History actions API port', '8081')
    .option('--history-tx-port <port>', 'Harbor History tx lookup API port', '8082')
    .option('--history-api-port <port>', 'Harbor History API router port', '8080')
    .option('--history-stream-port <port>', 'Harbor History stream API port', '8083')
    .option('--storage-port <port>', 'Harbor storage manifest port', '9090')
    .option('--config <path>', 'config path', defaultConfigPath())
    .action(async (options: AgentStatusOptions) => {
      console.table(await statusRows(await loadOptionalConfig(options.config), options))
    })
}

function addDoctorCommand(agent: Command): void {
  agent
    .command('doctor')
    .description('Check local config, directories, and service ports')
    .option('--config <path>', 'config path', defaultConfigPath())
    .action(async (options: {config: string}) => {
      const config = await loadConfig(options.config)
      await ensureHarborDirs(config)
      console.table(await doctorRows(config, options.config))
    })
}

export function addAgentStatusCommands(agent: Command): void {
  addStatusCommand(agent)
  addDoctorCommand(agent)
}
