import assert from 'node:assert/strict'
import {createHash, randomBytes} from 'node:crypto'
import {once} from 'node:events'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {localAgentConfig} from './config.js'
import {LocalAgentNetwork} from './local.js'
import {workerServer} from './server.js'
import {AgentWorker} from './worker.js'
import type {Network} from './types.js'

test('worker and trigger credentials are isolated, with no token in URLs or state', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'harbor-worker-http-'))
  const quotedPrompts: string[] = []
  let preferred: string | undefined
  const network: Network = {
    identity: 'test/agenttest', models: [{id: 'flagship', label: 'Qwen3 8B 4-bit'}, {id: 'expert', label: 'Qualified Harness Coder'}],
    baseModel: 'flagship', specialtyModel: id => id === 'harness-coder' ? preferred : undefined, currency: {symbol: 'TEST', precision: 4},
    async quote(_agent, prompt) { quotedPrompts.push(prompt); return {maxCost: 10, deployment: '1'} },
    async execute({starting, submitted}) {
      starting()
      submitted('1')
      return {text: 'Fixture response', calls: [], paid: 5}
    },
    async reconcile() { return null },
    async verify() { throw new Error('Unexpected verifier') },
    async readFile() { throw new Error('Unexpected file read') },
    async useSecret() { throw new Error('Unexpected secret operation') },
  }
  const worker = new AgentWorker(path.join(temp, 'worker.sqlite'), 'Fixture host', network)
  const token = randomBytes(32).toString('base64url')
  const server = workerServer(worker, token).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}/v1`
  const get = (resource: string, credential = token, identity = network.identity) =>
    fetch(base + resource, {headers: {authorization: 'Bearer ' + credential, 'x-harbor-agent-identity': identity!}})
  const post = (resource: string, data: object, credential = token) => fetch(base + resource, {
    method: 'POST', headers: {authorization: 'Bearer ' + credential, 'content-type': 'application/json'}, body: JSON.stringify(data),
  })
  try {
    assert.equal((await get('/state', '')).status, 401)
    assert.equal((await get('/state', token, 'another-network')).status, 409)
    assert.equal((await get('/state?auth=placeholder', '')).status, 404)
    const agent = await post('/agents', {name: 'Reporter', instructions: 'Write notes', model: 'flagship',
      perRun: 10, total: 100, files: [], secrets: []}).then(response => response.json())
    assert.match(agent.id, /^[a-f0-9-]{36}$/)
    const request = await post(`/agents/${agent.id}/routines`, {name: 'Run on request', prompt: 'Write notes',
      kind: 'trigger', maxCost: 10}).then(response => response.json())
    assert.ok(request.token)
    const state = await get('/state').then(response => response.text())
    assert.equal(state.includes(request.token), false)
    assert.equal(state.includes(token), false)
    assert.equal(state.includes('credential'), false)
    assert.equal((await get('/state', request.token)).status, 401)
    assert.equal((await post(`/triggers/${request.routine.id}`, {eventId: 'first'})).status, 401)
    const first = await post(`/triggers/${request.routine.id}`, {eventId: 'first'}, request.token).then(response => response.json())
    assert.deepEqual(Object.keys(first).sort(), ['id', 'status'])
    const replay = await post(`/triggers/${request.routine.id}`, {eventId: 'first'}, request.token).then(response => response.json())
    assert.equal(replay.id, first.id)
    const quote = await post(`/agents/${agent.id}/quote`, {message: 'Draft an update'}).then(response => response.json())
    assert.equal(quote.maxCost, 10)
    const replacement = await post(`/agents/${agent.id}/quote`, {message: 'Replacement', replaceOpen: true})
      .then(response => response.json())
    assert.equal((await post(`/confirm/${quote.id}`, {})).status, 409)
    const legacy = await post(`/agents/${agent.id}/quote`, {message: 'Independent legacy quote'})
      .then(response => response.json())
    const quoted = await get(`/state/${agent.id}`).then(response => response.json())
    assert.deepEqual(quoted.quotes, [legacy, replacement])
    assert.equal('input' in quoted.quotes[0], false)
    assert.equal((await post(`/cancel/${legacy.id}`, {})).status, 200)
    assert.equal((await post(`/cancel/${replacement.id}`, {})).status, 200)
    assert.equal((await post(`/confirm/${quote.id}`, {})).status, 409)
    const next = await post(`/agents/${agent.id}/quote`, {message: 'Another update'}).then(response => response.json())
    assert.equal((await post(`/confirm/${next.id}`, {})).status, 202)
    assert.equal((await post(`/cancel/${next.id}`, {})).status, 409)
    assert.deepEqual((await get(`/state/${agent.id}`).then(response => response.json())).quotes, [])
    const scheduled = await post(`/agents/${agent.id}/routines`, {
      name: 'Review schedule', prompt: 'Check status', kind: 'interval', intervalMinutes: 15, maxCost: 10, enabled: false,
    }).then(response => response.json())
    assert.equal(scheduled.routine.enabled, false)
    assert.equal(scheduled.routine.nextAt, null)
    const enabled = await post(`/routines/${scheduled.routine.id}`, {enabled: true}).then(response => response.json())
    assert.equal(enabled.enabled, true)
    assert.ok(enabled.nextAt > Date.now())
    const bytes = Buffer.from(JSON.stringify({
      name: 'Reviewed author', instructions: 'Write a verified report', model: 'flagship',
      perRun: 20, total: 100, files: ['a'.repeat(64)], secrets: ['mock-grant'],
    }))
    const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')
    const receipt = Buffer.from(JSON.stringify({
      schema: 1, runId: 'run-1', sourceCommit: 'b'.repeat(40), profile: 'harbor-agent',
      verification: {build: 'passed', test: 'passed'},
      artifact: {format: 'harbor-agent-definition', sha256: sha256(bytes), base64: bytes.toString('base64')},
    }))
    const importedBody = {receipt: receipt.toString('base64'), approvedSha256: sha256(receipt)}
    assert.equal((await post('/import', {...importedBody, approvedSha256: '0'.repeat(64)})).status, 409)
    const importedResponse = await post('/import', importedBody)
    assert.equal(importedResponse.status, 201)
    const imported = await importedResponse.json()
    assert.equal(imported.status, 'paused')
    assert.equal((await post(`/agents/${imported.id}/quote`, {message: 'No implicit approval'})).status, 409)
    assert.equal((await post('/import', importedBody).then(response => response.json())).id, imported.id)
    const reviewed = await get(`/state/${imported.id}`).then(response => response.json())
    assert.deepEqual(reviewed.agents[0].files, ['a'.repeat(64)])
    assert.deepEqual(reviewed.agents[0].secrets, ['mock-grant'])
    assert.equal(reviewed.audit.filter((entry: {event: string}) => entry.event === 'agent_imported').length, 1)
    assert.equal(reviewed.runs.length, 0)
    assert.equal((await post(`/agents/${imported.id}/status`, {status: 'active'})).status, 200)
    assert.equal((await post(`/agents/${imported.id}/quote`, {message: 'Quote only after activation'})).status, 200)
    const catalog = await get('/state').then(response => response.json())
    assert.deepEqual(catalog.specialties?.map((item: {id: string}) => item.id),
      ['researcher', 'chief-of-staff', 'coder', 'harness-coder'])
    const input = {requestId: 'a'.repeat(64), name: 'Build reviewer', specialty: 'harness-coder', perRun: 10, total: 100, files: [], secrets: []}
    assert.equal((await post('/agents', {...input, specialty: 'unknown'})).status, 400)
    assert.equal((await post('/agents', {...input, secrets: ['wallet-key']})).status, 403)
    const owner = {name: 'Ops desk', specialty: 'chief-of-staff', perRun: 10, total: 100, managedAgents: [agent.id]}
    assert.equal((await post('/agents', {...owner, specialty: 'coder'})).status, 403)
    const chief = await post('/agents', owner).then(response => response.json())
    assert.equal((await post('/agents/' + chief.id + '/quote', {message: 'Review agent status.'})).status, 200)
    const context = JSON.parse(quotedPrompts.at(-1)!)
    assert.deepEqual(context.managedAgentStatus, [{id: agent.id, name: 'Reporter', status: 'active'}])
    assert.equal(context.managedAgentStatus[0].instructions, undefined)

    const specialtyAgent = await post('/agents', input).then(response => response.json())
    assert.equal(specialtyAgent.specialty, 'harness-coder')
    assert.equal(specialtyAgent.specialtyVersion, 1)
    assert.equal(specialtyAgent.model, 'flagship')
    const replayAgent = await post('/agents', input).then(response => response.json())
    assert.equal(replayAgent.id, specialtyAgent.id)
    assert.equal((await post('/agents', {...input, name: 'Different'})).status, 409)
    const snapshot = await get(`/state/${specialtyAgent.id}`).then(response => response.json())
    assert.equal(snapshot.routines.length, 1)
    assert.equal(snapshot.routines[0].enabled, false)
    assert.equal(snapshot.routines[0].nextAt, null)
    assert.equal((await post(`/agents/${specialtyAgent.id}`, {...input, specialty: 'researcher'})).status, 409)
    preferred = 'expert'
    const promotedQuote = await post('/agents/' + specialtyAgent.id + '/quote', {message: 'Verify the version.'})
      .then(response => response.json())
    assert.equal(promotedQuote.model, 'expert')
    preferred = undefined
    assert.equal((await post('/confirm/' + promotedQuote.id, {})).status, 409)
    const specialtyQuote = await post(`/agents/${specialtyAgent.id}/quote`, {message: 'Verify the requested behavior.'})
      .then(response => response.json())
    assert.match(JSON.parse(quotedPrompts.at(-1)!).specialtyInstructions, /Harness/)
    const specialtyRun = await post(`/confirm/${specialtyQuote.id}`, {}).then(response => response.json())
    const feedbackPath = `/runs/${specialtyRun.id}/feedback`
    const vote = {kind: 'answer', rating: 'up', policy: 'harbor.agent-feedback.v1', correction: 'Check the contract.'}
    assert.equal(specialtyRun.specialty, 'harness-coder')
    assert.equal(specialtyRun.model, 'flagship')
    assert.equal((await post(feedbackPath, vote, request.token)).status, 401)
    assert.equal((await post(feedbackPath, vote)).status, 409)
    for (let i = 0; i < 3; i++) await worker.tick()
    assert.equal((await post(feedbackPath, {...vote, policy: undefined})).status, 400)
    assert.equal((await post(feedbackPath, vote)).status, 200)
    assert.equal((await post(feedbackPath, {...vote, rating: 'down'})).status, 200)
    assert.equal((await post(feedbackPath, {...vote, kind: 'task'})).status, 200)
    const feedback = await get(`/state/${specialtyAgent.id}`).then(response => response.json())
    assert.deepEqual(feedback.feedback.map((item: {kind: string; rating: string}) => [item.kind, item.rating]),
      [['answer', 'down'], ['task', 'up']])
    assert.equal((await post(feedbackPath, {kind: 'answer', rating: null})).status, 200)
    const updated = await get(`/state/${specialtyAgent.id}`).then(response => response.json())
    assert.deepEqual(updated.feedback.map((item: {kind: string}) => item.kind), ['task'])
    const clearPath = '/agents/' + specialtyAgent.id + '/clear-feedback'
    assert.equal((await post(clearPath, {}, request.token)).status, 401)
    assert.equal((await post(clearPath, {})).status, 200)
    const cleared = await get('/state/' + specialtyAgent.id).then(response => response.json())
    assert.deepEqual(cleared.feedback, [])

  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    worker.close()
    await rm(temp, {recursive: true, force: true})
  }
})

test('the local worker runs a confirmed specialty without chain credentials or paid inference', async t => {
  const {randomUUID} = await import('node:crypto')
  const {spawn} = await import('node:child_process')
  const {createServer} = await import('node:http')
  const {writeFile} = await import('node:fs/promises')
  const {setTimeout: delay} = await import('node:timers/promises')
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-local-agents-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const model = 'qwen3:8b-q4_K_M'
  const revision = 'f'.repeat(64)
  let seen = 0
  const upstream = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/tags') {
      response.end(JSON.stringify({models: [{name: model, digest: revision,
        details: {family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M'}}]}))
      return
    }
    assert.equal(request.url, '/api/chat')
    const parts = []
    for await (const chunk of request) parts.push(chunk)
    const data = JSON.parse(Buffer.concat(parts).toString())
    assert.equal(data.model, model)
    assert.equal(data.stream, false)
    assert.match(data.messages[0].content, /Harness/)
    assert.equal(data.messages.at(-1).content, 'Review the local checks.')
    seen++
    response.end(JSON.stringify({model, done: true, message: {content: 'Local response'}}))
  }).listen(0, '127.0.0.1')
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())))
  await once(upstream, 'listening')
  const address = upstream.address()
  assert.ok(address && typeof address === 'object')
  const spare = createServer().listen(0, '127.0.0.1')
  await once(spare, 'listening')
  const bind = spare.address()
  assert.ok(bind && typeof bind === 'object')
  await new Promise<void>(resolve => spare.close(() => resolve()))
  const options = path.join(directory, 'worker.json')
  await writeFile(options, JSON.stringify({mode: 'local', account: 'localagent',
    ollama: 'http://127.0.0.1:' + address.port, modelRevision: revision}))
  const token = randomBytes(32).toString('base64url')
  const workerProcess = spawn(process.execPath, ['lib/index.js', 'agents', 'serve', '--config', options,
    '--db', path.join(directory, 'agent.sqlite'), '--port', String(bind.port)], {
    cwd: new URL('../../', import.meta.url), env: {PATH: '/usr/bin:/bin', HARBOR_AGENT_TOKEN: token},
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const launched = once(workerProcess, 'spawn')
  let exited = false
  const stopped = once(workerProcess, 'exit').then(([status]) => { exited = true; return status })
  let startupError = ''
  workerProcess.stderr.on('data', chunk => { startupError += String(chunk) })
  const endpoint = 'http://127.0.0.1:' + bind.port + '/v1'
  const call = (resource: string, data?: object) => fetch(endpoint + resource, {
    method: data ? 'POST' : 'GET', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
    body: data ? JSON.stringify(data) : undefined,
  })
  try {
    await launched
    let state
    for (let i = 0; i < 40 && !exited; i++) {
      state = await call('/state').then(response => response.json()).catch(() => undefined)
      if (state) break
      await delay(25)
    }
    assert.equal(state?.execution, 'local', startupError)
    const input = {name: 'Harness fixture', specialty: 'harness-coder', perRun: 0, total: 0, requestId: revision}
    assert.equal((await call('/agents', {...input, files: [randomUUID().replaceAll('-', '').repeat(2)]})).status, 403)
    const agent = await call('/agents', input).then(response => response.json())
    const quote = await call('/agents/' + agent.id + '/quote', {message: 'Review the local checks.'})
      .then(response => response.json())
    assert.equal(quote.maxCost, 0)
    assert.equal(seen, 0)
    const run = await call('/confirm/' + quote.id, {}).then(response => response.json())
    let result
    for (let i = 0; i < 60; i++) {
      result = (await call('/state').then(response => response.json())).runs.find((item: {id: string}) => item.id === run.id)
      if (result.status === 'completed') break
      await delay(50)
    }
    assert.equal(result.status, 'completed')
    assert.equal(result.paid, 0)
    assert.equal(result.inferId, undefined)
    assert.equal(result.modelRevision, revision)
    assert.equal(result.result, 'Local response')
    assert.equal(seen, 1)
  } finally {
    if (!exited) workerProcess.kill('SIGTERM')
    await stopped
  }
})

test('local MLX refreshes approval before quoting and records the exact served expert', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'harbor-worker-mlx-'))
  const token = randomBytes(32).toString('base64url')
  const modelToken = randomBytes(32).toString('base64url')
  const baseRevision = 'a'.repeat(64)
  const approvedRevision = 'b'.repeat(64)
  const suite = 'c'.repeat(64)
  let active: string | undefined
  let served: {model: string; digest: string} | undefined
  const upstream = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer ' + modelToken)
    const models = [{name: 'qwen3:8b-mlx-4bit', digest: baseRevision}]
    if (active) models.push({name: 'harness-coder:' + active, digest: active})
    if (request.url === '/api/tags') {
      response.end(JSON.stringify({models, suite}))
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    served = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    response.end(JSON.stringify({done: true, ...served, message: {content: 'Fixture response'}}))
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const local = localAgentConfig({
    backend: 'mlx', account: 'agenttest', mlx: 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port,
    modelRevision: baseRevision, suite,
  }, {HARBOR_AGENT_MLX_TOKEN: modelToken})
  const worker = new AgentWorker(path.join(temp, 'worker.sqlite'), 'Local MLX', new LocalAgentNetwork(local))
  const server = workerServer(worker, token).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1'
  const post = (resource: string, data: object) => fetch(base + resource, {
    method: 'POST', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
    body: JSON.stringify(data),
  })
  try {
    const harness = await post('/agents', {specialty: 'harness-coder', name: 'Harness', perRun: 0, total: 0})
      .then(response => response.json())
    const research = await post('/agents', {specialty: 'researcher', name: 'Research', perRun: 0, total: 0})
      .then(response => response.json())
    const trigger = await post(`/agents/${harness.id}/routines`, {
      name: 'Local routine', kind: 'trigger', prompt: 'Routine prompt', maxCost: 0,
    }).then(response => response.json())
    const prior = await post(`/agents/${harness.id}/quote`, {message: 'Before activation'})
      .then(response => response.json())
    assert.equal(prior.modelRevision, baseRevision)
    active = approvedRevision
    const invoked = await fetch(base + '/triggers/' + trigger.routine.id, {
      method: 'POST', headers: {authorization: 'Bearer ' + trigger.token, 'content-type': 'application/json'},
      body: JSON.stringify({eventId: 'after-approval'}),
    }).then(response => response.json())
    await worker.tick()
    const routineRun = worker.snapshot(harness.id).runs.find(item => item.id === invoked.id)
    assert.equal(routineRun?.status, 'completed')
    assert.equal(routineRun?.modelRevision, approvedRevision)
    assert.equal((await post(`/confirm/${prior.id}`, {})).status, 409)
    const other = await post(`/agents/${research.id}/quote`, {message: 'Use the base'})
      .then(response => response.json())
    assert.equal(other.modelRevision, baseRevision)
    const expert = await post(`/agents/${harness.id}/quote`, {message: 'After activation'})
      .then(response => response.json())
    assert.equal(expert.modelRevision, approvedRevision)
    assert.equal(expert.maxCost, 0)
    const approved = await post(`/confirm/${expert.id}`, {}).then(response => response.json())
    await worker.tick()
    const state = await fetch(base + '/state/' + harness.id, {headers: {authorization: 'Bearer ' + token}})
      .then(response => response.json())
    const run = state.runs.find((item: {id: string}) => item.id === approved.id)
    assert.equal(run.status, 'completed')
    assert.equal(run.modelRevision, approvedRevision)
    assert.equal(run.paid, 0)
    assert.equal(served?.model, 'harness-coder:' + approvedRevision)
    assert.equal(served?.digest, approvedRevision)
    active = undefined
    const rolledBack = await post(`/agents/${harness.id}/quote`, {message: 'After rollback'})
      .then(response => response.json())
    assert.equal(rolledBack.modelRevision, baseRevision)
  } finally {
    await Promise.all([server, upstream].map(service => new Promise<void>(resolve => service.close(() => resolve()))))
    worker.close()
    await rm(temp, {recursive: true, force: true})
  }
})
