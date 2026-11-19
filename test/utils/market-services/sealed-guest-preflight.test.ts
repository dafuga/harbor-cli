import {appendFile, mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {expect, test, vi} from 'vitest'
import {sealedGuestPreflight} from '../../../src/utils/market-services/sealedGuestPreflight.js'

async function capturePreflight(device: string) {
  const directory = process.env.HARNESS_EVIDENCE_DIR
  if (!directory || process.env.TAKE_SCREENSHOT !== '1') return

  const timings = []
  let peakRss = 0
  const options = {
    platform: 'linux' as const, arch: 'x64', hasConfig: true,
    canAccess: async (target: string) => target === device,
  }
  for (let sample = 0; sample < 25; sample += 1) {
    const start = performance.now()
    await sealedGuestPreflight(options)
    timings.push(performance.now() - start)
    peakRss = Math.max(peakRss, process.memoryUsage.rss())
  }
  timings.sort((left, right) => left - right)
  const boundary = {
    unit: 'function.market-services-sealed-guest-preflight', callable: 'sealedGuestPreflight',
    workload: 'tdx-guest-interface-fixture', target: 'module', samples: timings.length,
  }
  const measurements = [
    {...boundary, metric: 'latency-warm-ms', unitOfMeasure: 'ms', value: timings[12], method: 'Median elapsed time across the checked fixture call'},
    {...boundary, metric: 'memory-bytes', unitOfMeasure: 'bytes', value: peakRss, method: 'Peak sampled whole Vitest worker RSS after each fixture call'},
  ]
  const file = 'sealed-guest-preflight.json'
  await mkdir(directory, {recursive: true})
  await writeFile(path.join(directory, file), JSON.stringify({measurements}))
  const capture = {evidence: 'guest-preflight-workload', kind: 'benchmark', state: 'ready', file, mediaType: 'application/json'}
  await appendFile(path.join(directory, 'captures.ndjson'), `${JSON.stringify(capture)}\n`)
}

test.each(['/dev/sev-guest', '/sys/kernel/config/tsm/report'])(
  'accepts a guest exposing %s without a host hypervisor',
  async (device) => {
    const canAccess = vi.fn(async (target: string) => target === device)
    await expect(sealedGuestPreflight({platform: 'linux', arch: 'x64', hasConfig: true, canAccess})).resolves.toBeUndefined()
    expect(canAccess).not.toHaveBeenCalledWith('/dev/kvm')
    if (device === '/sys/kernel/config/tsm/report') await capturePreflight(device)
  },
)

test('a host-only KVM device cannot start the sealed provider', async () => {
  const canAccess = vi.fn(async (target: string) => target === '/dev/kvm')
  await expect(sealedGuestPreflight({platform: 'linux', arch: 'x64', hasConfig: true, canAccess}))
    .rejects.toThrow(/guest interfaces are unavailable/)
})

test('rejects an unsupported OS or missing config before probing devices', async () => {
  const canAccess = vi.fn(async () => true)
  await expect(sealedGuestPreflight({platform: 'darwin', arch: 'arm64', hasConfig: true, canAccess}))
    .rejects.toThrow(/requires a Linux x64 SEV-SNP or TDX guest/)
  await expect(sealedGuestPreflight({platform: 'linux', arch: 'x64', hasConfig: false, canAccess}))
    .rejects.toThrow(/requires an existing provider config/)
  expect(canAccess).not.toHaveBeenCalled()
})
