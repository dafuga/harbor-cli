import {setTimeout as delay} from 'node:timers/promises'
import {Command} from 'commander'
import {ArtifactSource, normalizeServiceName} from '../lib/artifacts.js'
import {buildRunPlan, HarborRunOptions, HarborRunPlan, runServiceForeground, superviseRuntime} from '../lib/run.js'
import type {ServiceHostOptions} from '../lib/host-policy.js'
import {marketLimits} from '../lib/resource-limits.js'
import {clientFor} from '../lib/tx.js'
import {marketSupervision} from '../utils/market-services/marketSupervision.js'
import {addMarketSelectionOptions, buildAgentOpportunityReport, type AgentOpportunityReport} from './market.js'

export function addRuntimeOptions(command: Command): Command {
  return command
    .option('--source <source>', 'auto, local, harbor-storage, github, or url', 'auto')
    .option('--version <version>', 'artifact version', 'dev')
    .option('--binary-url <url>', 'direct binary download URL for --source url')
    .option('--artifact-hash <hash>', 'Harbor storage artifact manifest content hash')
    .option('--sha256 <hash>', 'required binary SHA-256 for downloaded direct URLs')
    .option('--config <path>', 'runtime config path')
    .option('--genesis-json <path>', 'nodeos genesis file for a new chain data directory')
    .option('--data-dir <path>', 'runtime data directory')
    .option('--port <port>', 'service listen port')
    .option('--relay-config <path>', 'private relay daemon JSON configuration')
    .option('--force-install', 'reinstall or rebuild the service binary', false)
    .option('--cpu-percent <percent>', 'maximum share of available logical CPUs per service (default 40)')
    .option('--memory-percent <percent>', 'maximum share of visible physical memory per service (default 40)')
    .option('--gpu-percent <percent>', 'GPU offload budget for managed inference (default 40)')
    .option('--backend-endpoint <url>', 'HTTP endpoint for local or hosted inference')
    .option('--backend-protocol <protocol>', 'inference backend protocol, raw or openai')
    .option('--backend-model <model>', 'model identifier for OpenAI-compatible inference')
    .option('--backend-api-key-env <name>', 'environment variable that supplies the inference API key')
    .option('--model-profile <profile>', 'Qwen3 8B 4-bit local inference profile: auto or flagship')
    .option('--ollama <path>', 'manage a local Ollama executable under the service resource limits')
    .option('--llama-server <path>', 'manage a local llama.cpp server under the service resource limits')
    .option('--base-gguf <path>', '4-bit base model file for --llama-server')
    .option('--expert-gguf <path>', 'matching QLoRA adapter file for --llama-server')
    .option('--idle-only', 'start and continue only while the host is confirmed idle')
    .option('--json', 'print JSON output', false)
    .option('--dry-run', 'print the install/run plan without changing files or starting processes', false)
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('--market-contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
    .option('--storage-contract <account>', 'storage registry contract account', process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore')
}

export function validateRuntimeSource(source: ArtifactSource | undefined): void {
  if (source && !['auto', 'local', 'harbor-storage', 'github', 'url'].includes(source)) {
    throw new Error(`invalid --source: ${source}`)
  }
}

interface AutoRunOptions extends HarborRunOptions, ServiceHostOptions {
  agent?: string
  exclude?: string[]
  interval: string
  expectChainId?: string
}

async function selectService(options: AutoRunOptions): Promise<AgentOpportunityReport> {
  return buildAgentOpportunityReport({
    ...options, best: true,
    contract: options.marketContract ?? 'svcmarket',
    url: options.url ?? 'http://127.0.0.1:8888',
  })
}

async function autoPlan(name: string, options: AutoRunOptions): Promise<HarborRunPlan> {
  const limits = await marketLimits(options)
  return buildRunPlan(normalizeServiceName(name), {
    ...options, source: 'local', localInstalledOnly: true,
    cpuPercent: limits.cpu_percent, memoryPercent: limits.memory_percent, gpuPercent: limits.gpu_percent,
    idleOnly: name === 'aitrain' || options.idleOnly,
  })
}

async function runAuto(options: AutoRunOptions): Promise<void> {
  const seconds = Number(options.interval)
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error('--interval must be an integer from 1 to 3600 seconds')
  }
  if (options.dryRun) {
    const report = await selectService(options)
    console.log(JSON.stringify({...report, plan: report.best && await autoPlan(report.best.name, options)}, null, 2))
    return
  }
  if (options.hardwareProfile) throw new Error('a simulated hardware profile requires --dry-run')
  if (!options.expectChainId || !/^[a-f0-9]{64}$/.test(options.expectChainId)) {
    throw new Error('harbor run auto requires --expect-chain-id with the intended 64-digit chain ID')
  }
  if (options.source && options.source !== 'local') throw new Error('harbor run auto uses locally installed runtime artifacts')
  if (options.port || options.forceInstall) throw new Error('use a runtime config for service ports and install artifacts before starting auto selection')

  const expected = options.expectChainId
  const shutdown = new AbortController()
  const stop = () => shutdown.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    await marketSupervision({
      async inspect() {
        const chain = await clientFor(options.url).v1.chain.get_info()
        if (String(chain.chain_id) !== expected) throw new Error('RPC endpoint does not match --expect-chain-id')
        return (await selectService(options)).opportunities
      },
      prepare: (name) => autoPlan(name, options),
      start: (plan, lifecycle) => superviseRuntime(plan, {mirror: 'stderr', kernelLimits: false, ...lifecycle}),
      wait: (signal) => delay(seconds * 1000, undefined, {signal}),
      report: (message) => console[options.json ? 'log' : 'error'](JSON.stringify(message)),
    }, {signal: shutdown.signal, cooldownMs: Math.max(seconds * 2000, 15_000)})
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

export function createRunCommand(): Command {
  const command = addRuntimeOptions(new Command('run')
    .description('Install and run a Harbor service, or supervise the best eligible service')
    .argument('<service_name>', 'service to run, or auto'))
  return addMarketSelectionOptions(command)
    .option('--agent <account>', 'apply this provider account’s on-chain opt-outs to automatic selection')
    .option('--interval <seconds>', 'poll interval for automatic selection', '60')
    .option('--expect-chain-id <id>', 'required chain ID for live automatic selection')
    .action(async (serviceName: string, options: AutoRunOptions) => {
      validateRuntimeSource(options.source)
      if (serviceName === 'auto') {
        if (command.getOptionValueSource('source') === 'default') options.source = 'local'
        await runAuto(options)
        return
      }
      const service = normalizeServiceName(serviceName)
      if (options.hardwareProfile) throw new Error('--hardware-profile is only supported by run auto --dry-run')
      if (!options.dryRun && options.relayConfig && service.name === 'relay') {
        if (!options.expectChainId || String((await clientFor(options.url).v1.chain.get_info()).chain_id) !== options.expectChainId) {
          throw new Error('relay runtime RPC endpoint does not match --expect-chain-id')
        }
      }
      if (service.name === 'aitrain') options.idleOnly = true
      const plan = await runServiceForeground(service, options)
      if (options.json || options.dryRun) console.log(JSON.stringify(plan, null, 2))
    })
}
