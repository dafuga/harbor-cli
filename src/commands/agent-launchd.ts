import {Command} from 'commander'
import fs from 'node:fs/promises'
import path from 'node:path'
import {defaultConfigPath, harborHome, HarborAgentConfig, HarborAgentServiceConfig, loadConfig} from '../lib/config.js'
import {renderLaunchdPlist} from '../lib/launchd.js'

type LaunchService =
  | 'storage'
  | 'bp'
  | 'chain-api'
  | 'trace-api'
  | 'history-core'
  | 'history-actions'
  | 'history-tx'
  | 'history-api'
  | 'history-stream'

interface LaunchdOptions {
  config?: string
  service: LaunchService
  output?: string
}

interface LaunchSpec {
  label: string
  command: string
  args?: string[]
  workingDirectory?: string
  filename: string
}

type LaunchBuilder = (config: HarborAgentConfig, harborBin: string) => LaunchSpec

function configuredCommand(name: string, service: HarborAgentServiceConfig): string {
  if (!service.command) {
    throw new Error(`${name} command is not configured`)
  }
  return service.command
}

function nodeServiceSpec(label: string, filename: string, service: HarborAgentServiceConfig, fallback?: string): LaunchSpec {
  return {
    label,
    filename,
    command: service.command ?? fallback ?? configuredCommand(label, service),
    args: service.args ?? [],
    workingDirectory: service.workingDirectory,
  }
}

function storageSpec(config: HarborAgentConfig, harborBin: string): LaunchSpec {
  const port = config.services.storageManifest.port ?? 9090
  return {
    label: 'io.harbor.storage',
    filename: 'io.harbor.storage.plist',
    command: process.execPath,
    args: [harborBin, 'storage', 'serve', '--root', config.storageDir, '--port', String(port)],
    workingDirectory: harborHome(),
  }
}

const launchBuilders: Record<LaunchService, LaunchBuilder> = {
  storage: storageSpec,
  bp: (config) => nodeServiceSpec('io.harbor.bp', 'io.harbor.bp.plist', config.services.blockProducer, 'nodeos'),
  'chain-api': (config) => nodeServiceSpec('io.harbor.chain-api', 'io.harbor.chain-api.plist', config.services.chainApi, 'nodeos'),
  'trace-api': (config) => nodeServiceSpec('io.harbor.trace-api', 'io.harbor.trace-api.plist', config.services.traceApi, 'nodeos'),
  'history-core': (config) => nodeServiceSpec('io.harbor.history-core', 'io.harbor.history-core.plist', config.services.historyCore),
  'history-actions': (config) => nodeServiceSpec('io.harbor.history-actions', 'io.harbor.history-actions.plist', config.services.historyActions),
  'history-tx': (config) => nodeServiceSpec('io.harbor.history-tx', 'io.harbor.history-tx.plist', config.services.historyTx),
  'history-api': (config) => nodeServiceSpec('io.harbor.history-api', 'io.harbor.history-api.plist', config.services.historyApi),
  'history-stream': (config) => nodeServiceSpec('io.harbor.history-stream', 'io.harbor.history-stream.plist', config.services.historyStream),
}

async function writeLaunchdSpec(spec: LaunchSpec, output?: string): Promise<string> {
  const plistPath = output ?? path.join(harborHome(), 'launchd', spec.filename)
  await fs.mkdir(path.dirname(plistPath), {recursive: true})
  await fs.writeFile(plistPath, renderLaunchdPlist(spec))
  return plistPath
}

export function addLaunchdCommand(agent: Command): void {
  agent
    .command('launchd')
    .description('Write a launchd plist for a Harbor service')
    .requiredOption('-s, --service <service>', 'bp, chain-api, trace-api, storage, history-core, history-actions, history-tx, history-api, or history-stream')
    .option('--config <path>', 'config path', defaultConfigPath())
    .option('-o, --output <path>', 'output plist path')
    .action(async (options: LaunchdOptions) => {
      const config = await loadConfig(options.config)
      const spec = launchBuilders[options.service](config, process.argv[1])
      console.log(await writeLaunchdSpec(spec, options.output))
    })
}
