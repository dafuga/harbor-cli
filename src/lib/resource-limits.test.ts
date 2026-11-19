import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {configuredLimits, resourceLimits, saveLimits, signalGroup, watchProcessGroups} from './resource-limits.js'

test('persists CPU, GPU, and memory defaults and applies per-run overrides', async (t) => {
  const old = process.env.HARBOR_HOME
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-limits-'))
  process.env.HARBOR_HOME = home
  t.after(async () => {
    if (old === undefined) delete process.env.HARBOR_HOME
    else process.env.HARBOR_HOME = old
    await fs.rm(home, {recursive: true, force: true})
  })
  await saveLimits({cpuPercent: 38, gpuPercent: 0, memoryPercent: 42})
  const cap = await configuredLimits({cpuPercent: 55})
  assert.deepEqual([cap.cpu_percent, cap.gpu_percent, cap.memory_percent], [55, 0, 42])
  assert.equal((await configuredLimits()).cpu_percent, 38)
})

test('limits use the visible container memory quota instead of VM physical memory', (t) => {
  t.mock.method(process, 'constrainedMemory', () => 2 ** 30)
  assert.equal(resourceLimits({memoryPercent: 50}).memory_bytes, 512 * 2 ** 20)
})

test('foreground process group triggers its configured memory limit', {
  skip: process.platform === 'win32',
  timeout: 5000,
}, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: 'ignore'})
  await once(child, 'spawn')
  const closed = once(child, 'exit')
  const pid = child.pid!
  let problem: Error | undefined
  const stop = watchProcessGroups(() => [pid], {...resourceLimits(), memory_bytes: 1}, (error) => {
    problem = error
    signalGroup(pid, 'SIGTERM')
  })
  try {
    const [, signal] = await closed
    assert.equal(signal, 'SIGTERM')
    assert.match(problem?.message ?? '', /exceeded its memory limit/)
  } finally {
    stop()
    if (child.exitCode === null && child.signalCode === null) signalGroup(pid, 'SIGKILL')
  }
})
