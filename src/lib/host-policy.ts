import {execFile} from 'node:child_process'
import {constants, readFileSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {promisify} from 'node:util'
import {isWsl} from './runtime-host.js'

const exec = promisify(execFile)
const GiB = 2 ** 30

async function read(file: string): Promise<string> {
  return fs.readFile(file, 'utf8').then((value) => value.trim()).catch(() => '')
}

async function command(file: string, args: string[]): Promise<string> {
  return exec(file, args, {timeout: 2000, maxBuffer: 1024 * 1024}).then(({stdout}) => stdout).catch(() => '')
}

export function hostCpuCores(): number {
  const logicalCores = os.availableParallelism()
  if (process.platform !== 'linux') return logicalCores
  try {
    const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/).map(Number)
    return quota > 0 && period > 0 ? Math.min(logicalCores, quota / period) : logicalCores
  } catch {
    return logicalCores
  }
}

export function hostMemoryBytes(): number {
  return Math.min(os.totalmem(), process.constrainedMemory() || Infinity)
}

export interface HostState {
  on_battery: boolean | null
  active: boolean | null
  hot: boolean | null
  available_memory_bytes: number
}

export async function hostState(): Promise<HostState> {
  if (process.platform === 'darwin') {
    const [battery, thermal, input, vm] = await Promise.all([
      command('/usr/bin/pmset', ['-g', 'batt']),
      command('/usr/bin/pmset', ['-g', 'therm']),
      command('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-r', '-d', '1']),
      command('/usr/bin/vm_stat', []),
    ])
    const idle = input.match(/"HIDIdleTime"\s*=\s*(\d+)/)?.[1]
    const speed = thermal.match(/CPU_Speed_Limit\s*=\s*(\d+)/)?.[1]
    const pageBytes = Number(vm.match(/page size of (\d+) bytes/)?.[1])
    const freeAndReclaimable = [...vm.matchAll(/^Pages (?:free|inactive|speculative):\s+(\d+)\./gm)]
      .reduce((total, match) => total + Number(match[1]), 0)
    return {
      on_battery: battery ? battery.includes("'Battery Power'") : null,
      active: idle ? Number(idle) < 5 * 60 * 1e9 : null,
      hot: thermal ? (Boolean(speed && Number(speed) < 80) || /thermal pressure.*(?:serious|critical)/i.test(thermal)) : null,
      available_memory_bytes: pageBytes > 0 ? Math.min(os.totalmem(), freeAndReclaimable * pageBytes) : os.freemem(),
    }
  }

  const supplies = await fs.readdir('/sys/class/power_supply').catch(() => [])
  const zones = await fs.readdir('/sys/class/thermal').catch(() => [])
  const [battery, temperatures, idle, memory, windowsPower] = await Promise.all([
    Promise.all(supplies.map((name) => read(`/sys/class/power_supply/${name}/status`))),
    Promise.all(zones.filter((zone) => zone.startsWith('thermal_zone')).map(async (zone) => {
      const type = await read(`/sys/class/thermal/${zone}/type`)
      return /cpu|pkg|soc|acpi|x86_pkg/i.test(type) ? read(`/sys/class/thermal/${zone}/temp`) : ''
    })),
    command('loginctl', ['show-user', String(process.getuid?.()), '--property=IdleHint', '--value']),
    read('/proc/meminfo'),
    isWsl()
      ? command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus'])
      : '',
  ])
  const available = memory.match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1]
  const hostAvailable = available ? Number(available) * 1024 : os.freemem()
  const constrainedAvailable = process.constrainedMemory() ? process.availableMemory() : Infinity
  return {
    on_battery: ['Online', 'Offline'].includes(windowsPower.trim()) ? windowsPower.trim() === 'Offline'
      : battery.some(Boolean) ? battery.some((value) => value === 'Discharging') : null,
    active: idle.trim() === 'yes' ? false : idle.trim() === 'no' ? true : null,
    hot: temperatures.some(Boolean) ? temperatures.some((value) => Number(value) >= 85_000) : null,
    available_memory_bytes: Math.min(hostAvailable, constrainedAvailable, hostMemoryBytes()),
  }
}

export function hostPolicy(state: HostState, idleOnly: boolean, memoryFloor = GiB): {blocked: string | undefined; cpuScale: number} {
  let blocked: string | undefined
  if (state.on_battery) blocked = 'host is on battery'
  else if (state.hot) blocked = 'host is thermally constrained'
  else if (state.available_memory_bytes < memoryFloor) blocked = `less than ${memoryFloor === GiB ? '1 GiB' : `${memoryFloor / 2 ** 20} MiB`} of host memory is available`
  else if (idleOnly && state.active !== false) blocked = 'training requires confirmed user inactivity'
  return {blocked, cpuScale: state.active ? 0.5 : 1}
}

export async function freeDiskBytes(directory: string): Promise<number> {
  let probe = path.resolve(directory)
  for (;;) {
    try {
      const info = await fs.statfs(probe, {bigint: true})
      return Number(info.bavail * info.bsize)
    } catch (error) {
      const parent = path.dirname(probe)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === probe) throw error
      probe = parent
    }
  }
}

export async function gpuCapacity(): Promise<{kind: string; bytes: number | null}> {
  if (process.platform === 'darwin' && process.arch === 'arm64') return {kind: 'apple-unified', bytes: os.totalmem()}
  const result = await command('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'])
  const sizes = result.trim().split(/\s+/).map(Number).filter((value) => value > 0)
  return sizes.length ? {kind: 'nvidia', bytes: Math.max(...sizes) * 2 ** 20} : {kind: 'cpu-or-undetected', bytes: null}
}


export async function checkDiskFloor(directory: string): Promise<void> {
  if (await freeDiskBytes(directory) < 2 * GiB) {
    throw new Error(`less than 2 GiB of disk space is available at ${directory}`)
  }
}

export type ConfidentialVm = 'sev-snp' | 'tdx'

export interface ServiceHost {
  cpuCores: number
  memoryBytes: number
  availableMemoryBytes: number
  gpuKind: 'apple-unified' | 'nvidia' | 'none'
  gpuBytes: number
  freeDiskBytes: number
  bandwidthMbps: number
  alwaysOn: boolean
  confidentialVm: ConfidentialVm | null
  state?: HostState
}

async function confidentialVm(): Promise<ConfidentialVm | null> {
  if (process.platform !== 'linux' || process.arch !== 'x64') return null
  const writable = async (device: string) => fs.access(device, constants.R_OK | constants.W_OK).then(() => true, () => false)
  if (!await writable('/dev/kvm')) return null
  const [snp, tdx] = await Promise.all([
    read('/sys/module/kvm_amd/parameters/sev_snp'),
    read('/sys/module/kvm_intel/parameters/tdx'),
  ])
  if (/^[Y1]$/i.test(snp) && await writable('/dev/sev')) return 'sev-snp'
  if (/^[Y1]$/i.test(tdx)) return 'tdx'
  return null
}

export interface ServiceHostOptions {
  hardwareProfile?: string
  alwaysOn?: boolean
  bandwidthMbps?: string | number
}

async function uplinkMbps(): Promise<number> {
  if (process.platform === 'linux') {
    const route = await read('/proc/net/route')
    const iface = route.split('\n').slice(1).map((line) => line.trim().split(/\s+/))
      .filter(([, destination, , flags]) => destination === '00000000' && (Number.parseInt(flags, 16) & 1))
      .sort((a, b) => Number(a[6]) - Number(b[6]))[0]?.[0]
    if (!iface || !/^[\w.-]+$/.test(iface)) return 0
    return Math.max(0, Number(await read(`/sys/class/net/${iface}/speed`)) || 0)
  }
  if (process.platform === 'darwin') {
    const route = await command('/sbin/route', ['-n', 'get', 'default'])
    const iface = route.match(/^\s*interface:\s+([\w.-]+)$/m)?.[1]
    if (!iface) return 0
    const media = await command('/sbin/ifconfig', [iface])
    return Number(media.match(/media:.*?(\d+)base[\w-]*/i)?.[1] ?? 0)
  }
  return 0
}

export async function serviceHost(directory: string, options: ServiceHostOptions): Promise<ServiceHost> {
  if (options.hardwareProfile) {
    const profile = JSON.parse(await fs.readFile(options.hardwareProfile, 'utf8')) as ServiceHost
    const numbers = [profile.cpuCores, profile.memoryBytes, profile.availableMemoryBytes,
      profile.gpuBytes, profile.freeDiskBytes, profile.bandwidthMbps]
    if (numbers.some((value) => !Number.isFinite(value) || value < 0) ||
        profile.cpuCores <= 0 || profile.memoryBytes < 1 || profile.availableMemoryBytes > profile.memoryBytes ||
        !['apple-unified', 'nvidia', 'none'].includes(profile.gpuKind) ||
        typeof profile.alwaysOn !== 'boolean' ||
        ![null, 'sev-snp', 'tdx'].includes(profile.confidentialVm)) {
      throw new Error('invalid simulated service host profile')
    }
    const {state: _state, ...hardware} = profile
    return hardware
  }
  const bandwidthMbps = options.bandwidthMbps === undefined ? await uplinkMbps() : Number(options.bandwidthMbps)
  if (!Number.isFinite(bandwidthMbps) || bandwidthMbps < 0) {
    throw new Error('--bandwidth-mbps must be a nonnegative number')
  }
  const [state, gpu, disk, vm] = await Promise.all([hostState(), gpuCapacity(), freeDiskBytes(directory), confidentialVm()])
  return {
    cpuCores: hostCpuCores(),
    memoryBytes: hostMemoryBytes(),
    availableMemoryBytes: state.available_memory_bytes,
    gpuKind: gpu.kind === 'apple-unified' || gpu.kind === 'nvidia' ? gpu.kind : 'none',
    gpuBytes: gpu.bytes ?? 0,
    freeDiskBytes: disk,
    bandwidthMbps,
    alwaysOn: Boolean(options.alwaysOn),
    confidentialVm: vm,
    state,
  }
}
