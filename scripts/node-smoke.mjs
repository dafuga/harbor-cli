import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {once} from 'node:events'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-node-smoke-'))
const config = path.join(home, 'peer.ini')
const env = {...process.env, HARBOR_HOME: home}

async function reserve() {
  const socket = net.createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  return {socket, port: socket.address().port}
}

async function harbor(...args) {
  const {stdout} = await exec(process.execPath, [cli, 'service', ...args, 'nodeos', '--json'], {env, timeout: 120_000})
  return JSON.parse(stdout)
}

let registered = false
try {
  const [http, p2p] = await Promise.all([reserve(), reserve()])
  await Promise.all([http.socket, p2p.socket].map((socket) => new Promise((resolve) => socket.close(resolve))))
  const settings = [
    'plugin = eosio::chain_api_plugin',
    `p2p-listen-endpoint = 127.0.0.1:${p2p.port}`,
    'chain-state-db-size-mb = 64',
    'chain-state-db-guard-size-mb = 8',
  ]
  await fs.writeFile(config, `${settings.join('\n')}\n`, {mode: 0o600})
  const args = ['service', 'install', 'nodeos', '--config', config, '--port', String(http.port), '--source', 'local', '--json']
  const {stdout} = await exec(process.execPath, [cli, ...args], {env, timeout: 30_000})
  const install = JSON.parse(stdout)
  registered = true
  assert.equal(install.plan.port, http.port)
  assert.equal((await harbor('start')).healthy, true)
  const endpoint = `http://127.0.0.1:${http.port}/v1/chain/get_info`
  const info = await fetch(endpoint).then((response) => response.json())
  assert.match(info.chain_id, /^[a-f0-9]{64}$/)
  assert.ok(info.head_block_num >= 1)
  assert.equal((await harbor('restart')).healthy, true)
  assert.equal((await harbor('stop')).state, 'stopped')
  assert.equal(await fetch(endpoint, {signal: AbortSignal.timeout(1000)}).then(() => true).catch(() => false), false)
  console.log(`${install.plan.target} ${install.manager}: nodeos RPC, restart, and closed port verified on an isolated chain`)
} catch (error) {
  const log = await fs.readFile(path.join(home, 'logs', 'nodeos.log'), 'utf8').catch(() => '')
  if (log) console.error(log.split('\n').slice(-35).join('\n'))
  throw error
} finally {
  if (registered) await harbor('uninstall')
  await fs.rm(home, {recursive: true, force: true})
}
