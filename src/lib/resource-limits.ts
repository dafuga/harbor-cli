import {execFile} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {promisify} from 'node:util'
import {harborHome} from './config.js'

const exec = promisify(execFile)
const SAMPLE_MS = 500
export const DEFAULT_RESOURCE_PERCENT = 50

export interface LimitOptions {
  cpuPercent?: string | number
  memoryPercent?: string | number
  gpuPercent?: string | number
}

export interface ResourceLimits {
  cpu_percent: number
  memory_percent: number
  gpu_percent: number
  cpu_cores: number
  memory_bytes: number
}

function percent(value: string | number | undefined, name: string, minimum = 1): number {
  const number = value === undefined ? DEFAULT_RESOURCE_PERCENT : Number(value)
  if (!Number.isInteger(number) || number < minimum || number > 100) {
    throw new Error(`${name} must be an integer from ${minimum} to 100`)
  }
  return number
}

export function resourceLimits(options: LimitOptions = {}): ResourceLimits {
  const cpu_percent = percent(options.cpuPercent, '--cpu-percent')
  const memory_percent = percent(options.memoryPercent, '--memory-percent')
  return {
    cpu_percent,
    memory_percent,
    gpu_percent: percent(options.gpuPercent, '--gpu-percent', 0),
    cpu_cores: os.availableParallelism() * cpu_percent / 100,
    memory_bytes: Math.floor(os.totalmem() * memory_percent / 100),
  }
}

function limitsPath(): string {
  return path.resolve(harborHome(), 'limits.json')
}

export async function configuredLimits(overrides: LimitOptions = {}): Promise<ResourceLimits> {
  let defaults: LimitOptions = {}
  try {
    defaults = JSON.parse(await fs.readFile(limitsPath(), 'utf8')) as LimitOptions
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return resourceLimits({
    cpuPercent: overrides.cpuPercent ?? defaults.cpuPercent,
    gpuPercent: overrides.gpuPercent ?? defaults.gpuPercent,
    memoryPercent: overrides.memoryPercent ?? defaults.memoryPercent,
  })
}

export async function saveLimits(overrides: LimitOptions): Promise<ResourceLimits> {
  const limits = await configuredLimits(overrides)
  const file = limitsPath()
  const temporary = `${file}.${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700})
  try {
    await fs.writeFile(temporary, `${JSON.stringify({
      cpuPercent: limits.cpu_percent,
      gpuPercent: limits.gpu_percent,
      memoryPercent: limits.memory_percent,
    }, null, 2)}\n`, {mode: 0o600, flag: 'wx'})
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, {force: true})
  }
  return limits
}

function cpuSeconds(time: string): number {
  // BSD uses minutes:seconds.hundredths, while procps can include hours or days.
  const [clock, days = '0'] = time.split('-').reverse()
  return Number(days) * 86400 + clock.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0)
}

export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

export function watchProcessGroups(
  groups: () => readonly number[],
  limits: ResourceLimits,
  onError: (error: Error) => void,
  policy = () => ({paused: false, cpuScale: 1}),
  kernelLimits = false,
  onUsage?: (usage: {cpu_cores: number; memory_bytes: number; throttled: boolean}) => void,
): () => void {
  let stopped = false
  let cancelled = false
  let timer: NodeJS.Timeout
  let previous = new Map<number, number>()
  let sampledAt = performance.now()
  let credit = 0

  async function sample(): Promise<void> {
    try {
      const {stdout} = await exec('/bin/ps', ['-A', '-o', 'pid=,pgid=,rss=,time='], {timeout: 2000, maxBuffer: 4 * 1024 * 1024})
      if (cancelled) return
      const pids = groups()
      let rss = 0
      let used = 0
      const next = new Map<number, number>()
      for (const line of stdout.trim().split('\n')) {
        const [id, group, kib, time] = line.trim().split(/\s+/)
        if (!pids.includes(Number(group))) continue
        const member = Number(id)
        const cpu = cpuSeconds(time)
        next.set(member, cpu)
        used += Math.max(0, cpu - (previous.get(member) ?? 0))
        rss += Number(kib) * 1024
      }
      if (rss > limits.memory_bytes) {
        throw new Error(`Harbor service exceeded its memory limit (${rss} / ${limits.memory_bytes} bytes RSS)`)
      }
      const now = performance.now()
      const elapsedSeconds = (now - sampledAt) / 1000
      const {paused, cpuScale} = policy()
      const intervalBudget = elapsedSeconds * limits.cpu_cores * cpuScale
      credit = Math.min(intervalBudget, credit + intervalBudget - used)
      sampledAt = now
      previous = next
      const shouldStop = paused || (credit < 0 && (!kernelLimits || cpuScale < 1))
      if (shouldStop !== stopped) {
        stopped = shouldStop
        for (const pid of pids) signalGroup(pid, stopped ? 'SIGSTOP' : 'SIGCONT')
      }
      onUsage?.({cpu_cores: used / elapsedSeconds, memory_bytes: rss, throttled: stopped})
      timer = setTimeout(sample, SAMPLE_MS)
    } catch (error) {
      if (!cancelled) onError(error as Error)
    }
  }

  timer = setTimeout(sample, SAMPLE_MS)
  return () => {
    cancelled = true
    clearTimeout(timer)
    if (stopped) for (const pid of groups()) signalGroup(pid, 'SIGCONT')
  }
}
