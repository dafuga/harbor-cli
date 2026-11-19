import {expect, test} from 'vitest'
import {marketSupervision} from '../../../src/utils/market-services/marketSupervision.js'

test('market supervision drains the old service before switching and stops on market failure', async () => {
  const shutdown = new AbortController()
  const order: string[] = []
  let tick = 0
  await marketSupervision({
    async inspect() {
      if (tick === 2) throw new Error('Test market unavailable')
      return [{name: tick ? 'storage' : 'relay', status: 'open'}]
    },
    async prepare(name) { return name },
    start(name, {signal, onReady}) {
      order.push('start ' + name)
      queueMicrotask(onReady)
      return new Promise(resolve => signal.addEventListener('abort', () => {
        order.push('stop ' + name)
        resolve()
      }, {once: true}))
    },
    async wait() {
      if (++tick === 3) shutdown.abort()
    },
    report({event}) { if (event === 'market-unavailable') order.push(event) },
  }, {signal: shutdown.signal, cooldownMs: 100})
  expect(order).toEqual(['start relay', 'stop relay', 'start storage', 'stop storage', 'market-unavailable'])
})

test('a failed preparation moves the supervisor to another eligible service during cooldown', async () => {
  const shutdown = new AbortController()
  const order: string[] = []
  let tick = 0
  await marketSupervision({
    async inspect() { return [{name: 'relay', status: 'open'}, {name: 'storage', status: 'open'}] },
    async prepare(name) {
      order.push(name)
      if (name === 'relay') throw new Error('Missing relay runtime')
      return name
    },
    start(_name, {signal}) {
      return new Promise(resolve => signal.addEventListener('abort', () => resolve(), {once: true}))
    },
    async wait() { if (++tick === 2) shutdown.abort() },
    report() {},
  }, {signal: shutdown.signal, cooldownMs: 60_000})
  expect(order).toEqual(['relay', 'storage'])
})
