import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import type {AgentInput, Network} from './types.js'

const source: AgentInput = {
  name: 'Project review', instructions: 'Identify open decisions.', model: 'flagship',
  perRun: 100, total: 150, files: ['a'.repeat(64)], secrets: [],
}

test('the worker persists scheduled and triggered runs, reserves spend, and verifies tools first', async () => {
  const {AgentWorker} = await import('./worker.js')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'harbor-agent-test-'))
  const file = path.join(dir, 'agent.sqlite')
  const actions: string[] = []
  let now = Date.UTC(2026, 10, 18)
  let request = 0
  const network: Network = {
    models: [{id: 'flagship', label: 'Qwen3 8B 4-bit'}],
    currency: {symbol: 'TEST', precision: 4},
    async quote() { return {maxCost: 100, deployment: '1'} },
    async execute({starting, submitted}) {
      starting()
      actions.push('inference')
      submitted(String(++request))
      return {text: 'Result', calls: [{name: 'read_file', resource: 'a'.repeat(64)}], paid: 30}
    },
    async reconcile() { return 30 },
    async verify() { actions.push('verified'); return 'b'.repeat(64) },
    async readFile() { actions.push('read'); return 'Project files' },
    async useSecret() { throw new Error('Unexpected secret tool') },
  }
  const workers: InstanceType<typeof AgentWorker>[] = []
  const open = () => {
    const worker = new AgentWorker(file, 'Test worker', network, () => now)
    workers.push(worker)
    return worker
  }
  try {
    const first = open()
    const agent = first.createAgent(source)
    const quote = await first.quote(agent.id, 'Review the daily notes')
    assert.equal(quote.maxCost, 100)
    assert.deepEqual(actions, [])
    const chat = first.confirm(quote.id)
    assert.equal(first.confirm(quote.id).id, chat.id)
    const scheduled = first.createRoutine(agent.id, {
      kind: 'interval', name: 'Daily review', prompt: 'Review today', intervalMinutes: 1, maxCost: 100,
    })
    const triggered = first.createRoutine(agent.id, {
      kind: 'trigger', name: 'Review on request', prompt: 'Review now', maxCost: 100,
    })
    assert.ok(triggered.token)
    assert.throws(() => first.trigger(triggered.routine.id, 'invalid', 'event-1'), /invalid trigger/i)
    const hook = first.trigger(triggered.routine.id, triggered.token, 'event-1')
    assert.equal(first.trigger(triggered.routine.id, triggered.token, 'event-1').id, hook.id)
    first.close()

    now += 60_000
    const restarted = open()
    await restarted.tick()
    await restarted.tick()
    await restarted.tick()
    const {runs, audit} = restarted.snapshot(agent.id)
    assert.equal(runs.filter(run => run.routineId === scheduled.routine.id).length, 1)
    assert.equal(runs.find(run => run.id === chat.id)?.status, 'completed')
    assert.equal(runs.find(run => run.id === hook.id)?.status, 'completed')
    assert.equal(runs.find(run => run.routineId === scheduled.routine.id)?.status, 'blocked')
    assert.deepEqual(actions, ['inference', 'verified', 'read', 'inference', 'verified', 'read'])
    assert.ok(audit.some(entry => entry.event === 'tool_executed'))
    restarted.setStatus(agent.id, 'paused')
    assert.throws(() => restarted.trigger(triggered.routine.id, triggered.token!, 'event-2'), /paused/i)
    restarted.setStatus(agent.id, 'killed')
    assert.throws(() => restarted.setStatus(agent.id, 'active'), /killed/i)
  } finally {
    for (const worker of workers) worker.close()
    await rm(dir, {recursive: true, force: true})
  }
})
