import {expect, test} from 'vitest'
import {serviceEligibility} from '../../../src/utils/market-services/serviceEligibility.js'

const GiB = 2 ** 30
const host = {
  cpuCores: 2, memoryBytes: GiB, availableMemoryBytes: GiB, gpuKind: 'none' as const,
  gpuBytes: 0, freeDiskBytes: 8 * GiB, bandwidthMbps: 20, alwaysOn: true, confidentialVm: null,
}
const limits = {cpu_percent: 50, memory_percent: 50, gpu_percent: 50, cpu_cores: 1, memory_bytes: GiB / 2}

test('relay on a small system has capacity within its bandwidth budget', () => {
  expect(serviceEligibility('relay', host, limits)).toEqual({unit: 'MiB delivered', units: 4291})
})

test('sealed compute requires confirmed confidential capability and memory', () => {
  expect(serviceEligibility('sealedcompute', host, limits).blocked).toMatch(/SEV-SNP or TDX/)
  const confidential = {...host, confidentialVm: 'tdx' as const}
  expect(serviceEligibility('sealedcompute', confidential, limits).blocked).toMatch(/available RAM/)
  expect(serviceEligibility('sealedcompute', {
    ...confidential, memoryBytes: 4 * GiB, availableMemoryBytes: 4 * GiB,
  }, limits).units).toBe(120)
})

test('Qwen3 8B inference requires the installed RAM floor', () => {
  expect(serviceEligibility('aiinfer', host, limits).blocked).toMatch(/16 GiB installed RAM/)
})

test('relay admission reports the uplink floor', () => {
  expect(serviceEligibility('relay', {...host, bandwidthMbps: 1}, limits).blocked).toMatch(/bandwidth budget/)
})
