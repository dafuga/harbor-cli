// @harness-uid u_fwgya7wrna
import {localModel} from '../../lib/local-model.js'
import type {ServiceHost} from '../../lib/host-policy.js'
import type {ResourceLimits} from '../../lib/resource-limits.js'
import type {Eligibility, ServiceCapacity} from './serviceEligibility.types.js'

const GiB = 2 ** 30
const MiB = 2 ** 20
export const RELAY_MEMORY_FLOOR = 128 * MiB

const CAPACITY: Readonly<Record<string, ServiceCapacity>> = {
  storage: {cpuCores: 0.5, memoryBytes: 512 * MiB, diskBytes: 8 * GiB, bandwidthMbps: 5, alwaysOn: true, units: 'GiB-hours', unitsPerHour: 8, scalable: true},
  p2pseed: {cpuCores: 0.5, memoryBytes: 512 * MiB, diskBytes: 2 * GiB, bandwidthMbps: 5, alwaysOn: true, units: 'seed minutes', unitsPerHour: 60},
  aiinfer: {cpuCores: 1, memoryBytes: Math.ceil(localModel().working_memory_gib * GiB), diskBytes: 6 * GiB, bandwidthMbps: 1, units: 'requests', unitsPerHour: 60, scalable: true},
  aitrain: {cpuCores: 2, memoryBytes: 12 * GiB, diskBytes: 12 * GiB, bandwidthMbps: 1, gpuBytes: 10 * GiB, units: 'adapter jobs', unitsPerHour: 1},
  sealedcompute: {cpuCores: 0.5, memoryBytes: GiB, diskBytes: 2 * GiB, bandwidthMbps: 1, alwaysOn: true, units: 'attested minutes', unitsPerHour: 60, scalable: true},
  relay: {cpuCores: 0.125, memoryBytes: RELAY_MEMORY_FLOOR, diskBytes: 256 * MiB, bandwidthMbps: 1, alwaysOn: true, units: 'MiB delivered', unitsPerHour: 1},
}

function hostAvailability(name: string, host: ServiceHost, need: ServiceCapacity): string | undefined {
  if (host.state?.on_battery) return 'Host is on battery.'
  if (host.state?.hot) return 'Host is thermally constrained.'
  if (need.alwaysOn && !host.alwaysOn) return 'Requires an always-on host. Set --always-on when the host can stay available.'
  if (name === 'sealedcompute' && !host.confidentialVm) return 'Requires SEV-SNP or TDX host support.'
  return modelAvailability(name, host)
}

function modelAvailability(name: string, host: ServiceHost): string | undefined {
  if (name === 'aiinfer' && host.memoryBytes < 16 * GiB) return 'Qwen3 8B 4-bit requires at least 16 GiB installed RAM.'
  if (name === 'aitrain' && host.state && host.state.active !== false) return 'Expert training requires confirmed user inactivity.'
  return undefined
}

function resourceBudget(host: ServiceHost, limits: ResourceLimits) {
  return {
    cpu: host.cpuCores * limits.cpu_percent / 100 * (host.state?.active ? 0.5 : 1),
    ram: Math.min(host.memoryBytes * limits.memory_percent / 100, host.availableMemoryBytes),
    gpu: host.gpuBytes * limits.gpu_percent / 100,
    disk: host.freeDiskBytes / 2,
    bandwidth: host.bandwidthMbps / 2,
  }
}

function capacityShortfall(need: ServiceCapacity, budget: ReturnType<typeof resourceBudget>): string | undefined {
  const {cpu, ram, gpu, disk, bandwidth} = budget
  if (cpu < need.cpuCores) return `Requires ${need.cpuCores} vCPU within the cap.`
  if (ram < need.memoryBytes) return `Requires ${(need.memoryBytes / GiB).toFixed(2)} GiB available RAM within the cap.`
  if (need.gpuBytes && gpu < need.gpuBytes) return `Requires ${need.gpuBytes / GiB} GiB GPU or unified memory within the cap.`
  if (disk < need.diskBytes) return `Requires ${need.diskBytes / MiB} MiB within the disk budget.`
  if (bandwidth < need.bandwidthMbps) return `Requires ${need.bandwidthMbps} Mbps within the bandwidth budget. Set --bandwidth-mbps to measured uplink speed.`
  return undefined
}

/** Example: relay on a qualified 20 Mbps uplink can carry 4291 MiB per hour. */
export function serviceEligibility(name: string, host: ServiceHost, limits: ResourceLimits): Eligibility {
  const need = Object.hasOwn(CAPACITY, name) ? CAPACITY[name] : undefined
  if (!need) return {units: 0, blocked: 'This service requires manual setup or has no capacity profile.'}
  const budget = resourceBudget(host, limits)
  const blocked = hostAvailability(name, host, need) ?? capacityShortfall(need, budget)
  if (blocked) return {unit: need.units, units: 0, blocked}
  const {cpu, ram, disk, bandwidth, gpu} = budget
  const slots = Math.floor(Math.min(cpu / need.cpuCores, ram / need.memoryBytes, disk / need.diskBytes, bandwidth / need.bandwidthMbps))
  const inferenceScale = name === 'aiinfer' && gpu < need.memoryBytes ? 0.25 : 1
  const units = name === 'relay'
    ? Math.floor(bandwidth * 1e6 * 3600 / (8 * MiB))
    : need.unitsPerHour * (need.scalable ? slots : 1) * inferenceScale
  return {unit: need.units, units}
}
