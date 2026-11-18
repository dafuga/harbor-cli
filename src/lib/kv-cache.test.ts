import assert from 'node:assert/strict'
import {once} from 'node:events'
import fs from 'node:fs/promises'
import {createServer, Server} from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {createKvGateway} from './kv-cache.js'

async function port(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no test listener')
  return address.port
}

test('local chat slots spill to private files and reload following a pressure pause', {skip: process.platform === 'win32'}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-kv-'))
  t.after(() => fs.rm(directory, {recursive: true, force: true}))
  const slot = new Map<number, string>()
  const engine = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    response.setHeader('content-type', 'application/json')
    if (url.pathname === '/v1/chat/completions') {
      assert.equal(body.cache_prompt, true)
      const previous = slot.get(body.id_slot)
      slot.set(body.id_slot, body.messages[0].content)
      response.end(JSON.stringify({previous}))
      return
    }
    const id = Number(url.pathname.split('/').at(-1))
    const file = path.join(directory, body.filename ?? 'unused')
    if (url.searchParams.get('action') === 'save') {
      await fs.writeFile(file, slot.get(id) ?? '')
      response.end(JSON.stringify({n_saved: slot.has(id) ? 1 : 0}))
    } else if (url.searchParams.get('action') === 'restore') {
      slot.set(id, await fs.readFile(file, 'utf8'))
      response.end(JSON.stringify({n_restored: 1}))
    } else {
      slot.delete(id)
      response.end('{}')
    }
  })
  const target = new URL(`http://127.0.0.1:${await port(engine)}/v1/chat/completions`)
  t.after(() => { engine.closeAllConnections(); engine.close() })
  const reservation = createServer()
  const front = new URL(`http://127.0.0.1:${await port(reservation)}/v1/chat/completions`)
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const gateway = await createKvGateway(front, target, {directory, parallel: 1, idleMs: 100})
  t.after(() => gateway.close())
  async function chat(content: string, id = 'harbor-test-chat-0001') {
    return fetch(front, {
      method: 'POST', headers: {'content-type': 'application/json', 'x-harbor-chat-id': id},
      body: JSON.stringify({messages: [{role: 'user', content}]}),
    })
  }
  gateway.resume()
  assert.deepEqual(await chat('private prefix').then((response) => response.json()), {})
  await gateway.pause()
  assert.equal((await chat('paused input')).status, 503)
  assert.equal(slot.size, 0)
  const files = await fs.readdir(directory)
  assert.equal(files.length, 1)
  assert.match(files[0], /^[a-f0-9]{64}\.bin$/)
  assert.equal((await fs.stat(path.join(directory, files[0]))).mode & 0o777, 0o600)
  gateway.resume()
  assert.deepEqual(await chat('resumed input').then((response) => response.json()), {previous: 'private prefix'})
  assert.deepEqual(await chat('separate chat', 'harbor-test-chat-0002').then((response) => response.json()), {})
  assert.deepEqual(gateway.stats(), {saved: 2, restored: 1})
  const deadline = Date.now() + 3000
  while (gateway.stats().saved < 3 && Date.now() < deadline) await delay(20)
  assert.equal(gateway.stats().saved, 3)
  assert.deepEqual(await chat('idle resume', 'harbor-test-chat-0002').then((response) => response.json()), {previous: 'separate chat'})
})
