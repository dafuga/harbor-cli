import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {once} from 'node:events'
import {createReadStream} from 'node:fs'
import fs from 'node:fs/promises'
import {createServer} from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const artifact = process.env.HARBOR_NODEOS_ARTIFACT
const scope = process.argv.includes('--system') ? ['--system'] : []
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
  const {stdout} = await exec(process.execPath, [cli, 'agent', 'service', ...args, ...scope, '--json'], {env, timeout: 120_000})
  return JSON.parse(stdout)
}

let registered = false
let downloadServer
try {
  const [http, p2p] = await Promise.all([reserve(), reserve()])
  await Promise.all([http.socket, p2p.socket].map((socket) => new Promise((resolve) => socket.close(resolve))))
  const settings = [
    'plugin = eosio::chain_api_plugin',
    `p2p-listen-endpoint = 127.0.0.1:${p2p.port}`,
    'chain-state-db-size-mb = 64',
    'chain-state-db-guard-size-mb = 8',
    'resource-monitor-space-absolute-gb = 2',
  ]
  await fs.writeFile(config, `${settings.join('\n')}\n`, {mode: 0o600})
  let source = ['--source', 'local']
  let checksum
  if (artifact) {
    const {size} = await fs.stat(artifact)
    const manifest = await fs.readFile(`${artifact}.sha256`, 'utf8')
    const asset = path.basename(artifact)
    const [digest, name] = manifest.trim().split(/\s+/)
    assert.match(digest, /^[a-f0-9]{64}$/)
    assert.equal(name, asset)
    checksum = digest
    downloadServer = createServer((request, response) => {
      if (request.url !== `/${asset}`) return response.writeHead(404).end()
      response.writeHead(200, {'Content-Length': size})
      const input = createReadStream(artifact)
      input.on('error', (error) => response.destroy(error))
      input.pipe(response)
    })
    await new Promise((resolve) => downloadServer.listen(0, '127.0.0.1', resolve))
    source = ['--source', 'url', '--binary-url', `http://127.0.0.1:${downloadServer.address().port}/${asset}`, '--sha256', checksum]
  }
  const install = await harbor('install', 'nodeos', '--config', config, '--port', String(http.port), ...source)
  registered = true
  assert.equal(install.plan.port, http.port)
  if (artifact) {
    assert.equal(install.plan.release_asset, path.basename(artifact))
    assert.equal(install.plan.artifact.sha256, checksum)
  }
  assert.equal((await harbor('status', 'nodeos')).state, 'stopped')
  const running = await harbor('start', 'nodeos')
  assert.equal(running.healthy, true)
  assert.equal(running.system, scope.length > 0)
  const endpoint = `http://127.0.0.1:${http.port}/v1/chain/get_info`
  const info = await fetch(endpoint).then((response) => response.json())
  assert.match(info.chain_id, /^[a-f0-9]{64}$/)
  assert.ok(info.head_block_num >= 1)
  assert.equal((await harbor('restart', 'nodeos')).healthy, true)
  assert.equal((await harbor('stop', 'nodeos')).state, 'stopped')
  assert.equal(await fetch(endpoint, {signal: AbortSignal.timeout(1000)}).then(() => true).catch(() => false), false)
  assert.equal((await harbor('uninstall', 'nodeos')).installed, false)
  registered = false
  console.log(`${install.plan.target} ${install.manager} ${scope.length ? 'system' : 'user'}: nodeos install, RPC, restart, stop, and uninstall verified on an isolated chain${checksum ? ` (SHA-256 ${checksum})` : ''}`)
} catch (error) {
  const log = await fs.readFile(path.join(home, 'logs', 'nodeos.log'), 'utf8').catch(() => '')
  if (log) console.error(log.split('\n').slice(-35).join('\n'))
  throw error
} finally {
  try {
    if (registered) await harbor('uninstall', 'nodeos')
    await fs.rm(home, {recursive: true, force: true})
  } finally {
    if (downloadServer) await new Promise((resolve) => downloadServer.close(resolve))
  }
}
