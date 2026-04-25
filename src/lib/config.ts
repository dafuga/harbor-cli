import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface HarborAgentServiceConfig {
  enabled: boolean
  port?: number
  command?: string
  args?: string[]
  workingDirectory?: string
}

export interface HarborAgentConfig {
  account: string
  apiUrl: string
  marketContract: string
  storageDir: string
  services: {
    chainApi: HarborAgentServiceConfig
    roboHistory: HarborAgentServiceConfig
    storageManifest: HarborAgentServiceConfig
  }
}

export function harborHome(): string {
  return process.env.HARBOR_HOME ?? path.join(os.homedir(), '.harbor')
}

export function defaultConfigPath(): string {
  return path.join(harborHome(), 'config.json')
}

export function defaultStorageDir(): string {
  return path.join(harborHome(), 'storage')
}

export function createDefaultConfig(account: string): HarborAgentConfig {
  return {
    account,
    apiUrl: process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888',
    marketContract: process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket',
    storageDir: defaultStorageDir(),
    services: {
      chainApi: {enabled: true, port: 8888, command: 'nodeos'},
      roboHistory: {enabled: false, port: 8080},
      storageManifest: {enabled: true, port: 9090},
    },
  }
}

export async function ensureHarborDirs(config: HarborAgentConfig): Promise<void> {
  await fs.mkdir(harborHome(), {recursive: true})
  await fs.mkdir(config.storageDir, {recursive: true})
  await fs.mkdir(path.join(harborHome(), 'logs'), {recursive: true})
  await fs.mkdir(path.join(harborHome(), 'launchd'), {recursive: true})
}

export async function loadConfig(configPath = defaultConfigPath()): Promise<HarborAgentConfig> {
  const raw = await fs.readFile(configPath, 'utf8')
  return JSON.parse(raw) as HarborAgentConfig
}

export async function saveConfig(config: HarborAgentConfig, configPath = defaultConfigPath()): Promise<void> {
  await ensureHarborDirs(config)
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
}
