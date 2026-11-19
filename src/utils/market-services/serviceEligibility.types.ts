// @harness-uid u_fwgya7wrna
export interface ServiceCapacity {
  cpuCores: number
  memoryBytes: number
  diskBytes: number
  bandwidthMbps: number
  gpuBytes?: number
  alwaysOn?: boolean
  units: string
  unitsPerHour: number
  scalable?: boolean
}

export interface Eligibility {
  unit?: string
  units: number
  blocked?: string
}
