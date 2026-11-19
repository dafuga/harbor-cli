import {expect, test} from 'vitest'
import {demandRanking, liveProviderRows} from '../../../src/utils/market-services/demandRanking.js'
import {buildOpportunities} from '../../../src/lib/opportunities.js'
import type {HarborService, HarborServiceType} from '../../../src/lib/opportunities.js'

const now = Date.parse('2026-11-19T10:00:00Z')
const GiB = 2 ** 30
const relay = {
  id: 24, service_name: 'relay', enabled: true, epoch_budget: '1.0000 HRBR', base_provider_reward: '1.0000 HRBR',
  metadata: JSON.stringify({demand: {unitsPerHour: 12, unitPrice: '1.2500 HRBR', expiresAt: '2026-11-19T10:01:00Z'}}),
} as HarborServiceType
const row = (provider: string, at: string) => ({
  provider, active: true, service_type: 24, last_heartbeat: at,
} as HarborService)
const snapshot = {
  types: [relay],
  services: [row('worker', '2026-11-19T09:59:55'), row('worker', '2026-11-19T09:59:56'), row('expired', '2026-11-19T09:59:39')],
  ttls: [{service_type: 24, ttl_sec: 20}],
}
const selection = {
  now,
  host: {
    cpuCores: 2, memoryBytes: GiB, availableMemoryBytes: GiB, gpuKind: 'none' as const,
    gpuBytes: 0, freeDiskBytes: 8 * GiB, bandwidthMbps: 20, alwaysOn: true, confidentialVm: null,
  },
  limits: {cpu_percent: 50, memory_percent: 50, gpu_percent: 50, cpu_cores: 1, memory_bytes: GiB / 2},
}

test('only live distinct providers compete for fresh demand', () => {
  const services = liveProviderRows(snapshot, now)
  expect(services.map(({provider}) => provider)).toEqual(['worker', 'worker'])
  const ranking = demandRanking(buildOpportunities(snapshot.types, services), {...snapshot, services}, selection)
  expect(ranking[0]).toMatchObject({status: 'open', activeProviders: 1, estimatedHourlyReward: '7.5000 HRBR'})
})

test('expired demand and a local opt-out are reported explicitly', () => {
  const offers = buildOpportunities(snapshot.types, [])
  expect(demandRanking(offers, snapshot, {...selection, now: now + 60_000})[0].status).toBe('no-demand')
  expect(demandRanking(offers, snapshot, {...selection, exclude: new Set(['relay'])})[0].status).toBe('excluded')
})
