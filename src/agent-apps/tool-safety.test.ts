import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {once} from 'node:events'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {workerServer} from './server.js'
import {AgentWorker} from './worker.js'
import type {Network} from './types.js'

test('owner must review the exact model-proposed Vault action before the real worker dispatches it', async t => {
  const home = await mkdtemp(join(tmpdir(), 'harbor-tool-safety-'))
  const events: string[] = []
  const text = 'Approve this fixture message only'
  let proposals: unknown[] = [{name: 'use_secret', resource: 'fixture-key', message: text}]
  const network: Network = {
    identity: 'fixture/owner',
    currency: {symbol: 'TEST', precision: 4},
    models: [{id: 'fixture', label: 'Unfiltered tool stub'}],
    async quote() { return {maxCost: 10, deployment: '1'} },
    async execute({starting, submitted}) {
      starting()
      submitted('8')
      return {
        text: 'Fixture answer', paid: 0,
        calls: proposals,
      }
    },
    async reconcile() { return 0 },
    async verify(call) {
      assert.equal(call.message, text)
      events.push('verified')
      return 'a'.repeat(64)
    },
    async readFile() { throw new Error('Unexpected read') },
    async useSecret(_alias, message) {
      assert.equal(message, text)
      events.push('signed')
      return 'fixture-signature'
    },
  }
  const file = join(home, 'worker.sqlite')
  const token = randomBytes(32).toString('base64url')
  const worker = new AgentWorker(file, 'Fixture host', network)
  const server = workerServer(worker, token).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}/v1`
  const request = (path: string, method = 'GET', credential = token) => fetch(base + path, {
    method, headers: {authorization: 'Bearer ' + credential},
  })
  let running: Promise<void> | undefined
  t.after(async () => {
    worker.stop()
    await running
    await new Promise<void>(resolve => server.close(() => resolve()))
    worker.close()
    await rm(home, {recursive: true, force: true})
  })

  const agent = worker.createAgent({
    name: 'Reviewer', instructions: 'Review the fixture', model: 'fixture',
    perRun: 10, total: 100, files: [], secrets: ['fixture-key'],
  })
  const reviewPath = `/tool-reviews/${agent.id}`
  const run = worker.confirm((await worker.quote(agent.id, 'Check the fixture')).id)
  running = worker.tick()
  assert.equal((await request(reviewPath, 'GET', '')).status, 401)
  const [review] = await waitForReviews(() => request(reviewPath))
  assert.deepEqual(events, [])
  assert.equal(review.action, 'credential-use')
  assert.equal(review.summary, 'Sign this text with HarborVault grant fixture-key')
  assert.equal(review.content, text)
  const approve = `/tool-reviews/${review.id}/approve`
  assert.equal((await request(approve, 'POST', '')).status, 401)
  const approved = await Promise.all([request(approve, 'POST'), request(approve, 'POST')])
  assert.deepEqual(approved.map(response => response.status).sort(), [202, 404])
  await running
  assert.deepEqual(events, ['verified', 'signed'])

  const declined = worker.confirm((await worker.quote(agent.id, 'Review another fixture')).id)
  running = worker.tick()
  const [secondReview] = await waitForReviews(() => request(reviewPath))
  assert.equal((await request(`/tool-reviews/${secondReview.id}/decline`, 'POST')).status, 202)
  await running
  assert.deepEqual(events, ['verified', 'signed'])
  assert.equal(worker.snapshot(agent.id).runs.find(item => item.id === declined.id)?.status, 'blocked')

  proposals = [{name: 'publish', resource: 'unknown-destination'}]
  const unknown = worker.confirm((await worker.quote(agent.id, 'Check an unregistered tool')).id)
  await worker.tick()
  const refused = worker.snapshot(agent.id)
  assert.equal(refused.runs.find(item => item.id === unknown.id)?.status, 'blocked')
  assert.ok(refused.audit.some(item => item.runId === unknown.id &&
    item.event === 'tool_policy_denied' && item.detail === 'unknown-tool'))
  assert.deepEqual(events, ['verified', 'signed'])

  worker.close()
  const reopened = new AgentWorker(file, 'Restarted fixture', network)
  try {
    const {runs, audit} = reopened.snapshot(agent.id)
    assert.equal(runs.find(item => item.id === run.id)?.status, 'completed')
    const policy = audit.filter(item => item.runId === run.id && item.event.startsWith('tool_policy_')).reverse()
    assert.deepEqual(policy.map(item => item.event), [
      'tool_policy_requested', 'tool_policy_held', 'tool_policy_requested',
      'tool_policy_reserved', 'tool_policy_completed',
    ])
    assert.ok(policy.every(item => item.runId === run.id))
    assert.equal(JSON.stringify(policy).includes(text), false)
    assert.equal(JSON.stringify(policy).includes('fixture-key'), false)
  } finally {
    reopened.close()
  }
})

async function waitForReviews(read: () => Promise<Response>) {
  for (let i = 0; i < 30; i++) {
    const response = await read()
    assert.equal(response.status, 200)
    const {reviews} = await response.json()
    if (reviews.length) return reviews
    await delay(10)
  }
  throw new Error('Expected a held worker tool review.')
}
