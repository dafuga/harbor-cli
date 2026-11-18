import fs from 'node:fs/promises'
import {Command} from 'commander'
import {executableExists, normalizeServiceName} from '../lib/artifacts.js'
import {resourceLimits} from '../lib/resource-limits.js'
import {buildRunPlan, serviceHealthy} from '../lib/run.js'
import {hostPlatform, isWsl, releaseAsset, runtimeTarget} from '../lib/runtime-host.js'
import {serviceManager, verifyServiceManager} from '../lib/service-manager.js'
import {selectWslDistribution, wslDistributions} from '../lib/wsl.js'

interface Check {
  check: string
  ok: boolean
  value: string
}

async function check(name: string, inspect: () => Promise<string> | string): Promise<Check> {
  try {
    return {check: name, ok: true, value: await inspect()}
  } catch (error) {
    return {check: name, ok: false, value: (error as Error).message}
  }
}

async function windowsChecks(): Promise<Check[]> {
  return [await check('wsl2', async () => {
    const distros = await wslDistributions().catch(() => [])
    const distro = selectWslDistribution(distros)
    if (!distro) {
      throw new Error('Install a WSL2 distribution with wsl --install, then run wsl --list --verbose. HARBOR_WSL_DISTRO selects a distribution.')
    }
    return distro.name
  })]
}

async function unixChecks(options: {service?: string; config?: string}): Promise<Check[]> {
  const checks = await Promise.all([
    check('runtime-target', runtimeTarget),
    check('service-manager', async () => {
      await verifyServiceManager()
      return serviceManager()
    }),
    check('foreground-resource-monitor', async () => {
      if (!await executableExists('/bin/ps')) throw new Error('/bin/ps is required for foreground resource limits')
      return '/bin/ps'
    }),
  ])
  if (!options.service) return checks
  const service = normalizeServiceName(options.service)
  checks.push(await check('service-health', async () => {
    const plan = await buildRunPlan(service, {dryRun: true, config: options.config})
    if (!await serviceHealthy(plan.port, service.name)) throw new Error(`${service.name} is not healthy on port ${plan.port}`)
    return `http://127.0.0.1:${plan.port}/health`
  }))
  if (options.config) {
    checks.push(await check('runtime-config', async () => {
      await fs.access(options.config!)
      return options.config!
    }))
  }
  checks.push(await check('release-asset', () => releaseAsset(service.daemon)))
  return checks
}

export function createDoctorCommand(): Command {
  return new Command('doctor')
    .description('Diagnose Harbor runtime support and local service health')
    .option('--service <name>', 'probe an opportunity service on this Linux or macOS runtime')
    .option('--config <path>', 'runtime TOML config used for the health check')
    .option('--json', 'print JSON output')
    .option('--strict', 'exit with status 1 if a check fails')
    .action(async (options: {service?: string; config?: string; json?: boolean; strict?: boolean}) => {
      const windows = process.platform === 'win32'
      const checks = windows ? await windowsChecks() : await unixChecks(options)
      checks.unshift({check: 'node', ok: Number(process.versions.node.split('.')[0]) >= 20, value: process.version})
      const result = {
        platform: hostPlatform(),
        runtime: windows || isWsl() ? 'wsl2' : process.platform,
        limits: windows ? undefined : resourceLimits(),
        ok: checks.every((item) => item.ok),
        checks,
      }
      if (options.json) console.log(JSON.stringify(result, null, 2))
      else {
        console.log(`Harbor runtime on ${result.platform} (${result.runtime})`)
        console.table(checks)
      }
      if (options.strict && !result.ok) process.exitCode = 1
    })
}
