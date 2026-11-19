import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import fs from 'node:fs/promises'
import {createServer} from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {normalizeServiceName, sha256Bytes} from './artifacts.js'
import {buildRunPlan, renderRuntimeConfig} from './run.js'
import {runtimeTarget} from './runtime-host.js'

async function tempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harbor-run-'))
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('unable to allocate test port')
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function waitForHealth(port: number, child?: ReturnType<typeof spawn>, output?: () => string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child?.exitCode !== null || child?.signalCode !== null) {
      throw new Error(`harbor run exited before health was ready\n${output?.() ?? ''}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(500)})
      if (response.ok) {
        return
      }
    } catch {
      // Retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`test daemon did not become healthy on ${port}\n${output?.() ?? ''}`)
}

test('buildRunPlan dry-run does not require an installed binary', {skip: process.platform === 'win32'}, async () => {
  const home = await tempHome()
  const config = path.join(home, 'harbor-runtime.toml')
  const plan = await buildRunPlan(normalizeServiceName('router'), {
    dryRun: true,
    version: 'dev',
    config,
    dataDir: path.join(home, 'runtime-data'),
    port: 9213,
  })

  assert.equal(plan.service, 'router')
  assert.equal(plan.daemon, 'harbor-routerd')
  assert.equal(plan.port, 9213)
  assert.deepEqual(plan.command, [plan.binary, '--config', config])
  assert.equal(plan.limits.cpu_percent, 40)
  assert.equal(plan.limits.memory_percent, 40)
  await assert.rejects(fs.access(config), {code: 'ENOENT'})
})

test('sealed runtime planning requires a configured guest only for a live run', {skip: process.platform === 'win32'}, async (t) => {
  const home = await tempHome()
  t.after(() => fs.rm(home, {recursive: true, force: true}))
  const config = path.join(home, 'sealed.toml')
  const service = normalizeServiceName('sealedcompute')
  const plan = await buildRunPlan(service, {config, dryRun: true})
  assert.deepEqual(plan.command, [plan.binary, '--config', config])
  const required = process.platform === 'linux' && process.arch === 'x64'
    ? /requires an existing provider config/
    : /requires a Linux x64 SEV-SNP or TDX guest/
  await assert.rejects(buildRunPlan(service, {config, source: 'url'}), required)
  await assert.rejects(fs.access(config), {code: 'ENOENT'})
})

test('run plan reads existing runtime ports and protects the config from option conflicts', {skip: process.platform === 'win32'}, async () => {
  const home = await tempHome()
  const config = path.join(home, 'runtime.toml')
  const dataDir = path.join(home, 'harbor#data')
  const original = renderRuntimeConfig({dataDir, basePort: 9300})
  await fs.writeFile(config, original)
  const service = normalizeServiceName('aiinfer')
  const plan = await buildRunPlan(service, {config, dryRun: true})
  assert.equal(plan.port, 9317)
  assert.equal(plan.data_dir, dataDir)
  await assert.rejects(buildRunPlan(service, {config, dryRun: true, port: 9117}), /conflicts/)
  await assert.rejects(buildRunPlan(service, {config, dryRun: true, cpuPercent: 0}), /--cpu-percent/)
  assert.equal(await fs.readFile(config, 'utf8'), original)
})

test('renderRuntimeConfig sets base port and includes all service providers', () => {
  const config = renderRuntimeConfig({
    dataDir: '/tmp/harbor-data',
    basePort: 9200,
    historyRepo: '/tmp/harbor-history',
  })

  assert.match(config, /base_port = 9200/)
  assert.equal(config.includes('data_dir = "/tmp/harbor-data"'), true)
  assert.match(config, /service_type = "router"/)
  assert.match(config, /service_type = "appealcmte"/)
  assert.match(config, /service_type = "keycustody"/)
  assert.match(config, /trusted_checker_endpoint = ""/)
  assert.match(config, /trusted_checker_min_score_bps = 8500/)
  assert.equal(config.includes('repo = "/tmp/harbor-history"'), true)
})

test('harbor run --source url downloads, installs, starts, logs, and stops', {timeout: 20_000, skip: process.platform === 'win32'}, async () => {
  const harborHome = await tempHome()
  const port = await freePort()
  const fakeDaemon = Buffer.from(`#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const config = process.argv[process.argv.indexOf('--config') + 1]
const text = fs.readFileSync(config, 'utf8')
const basePort = Number(text.match(/base_port = ([0-9]+)/)[1])
const port = basePort + 13
const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, {'content-type': 'application/json'})
    response.end(JSON.stringify({ok: true, role: 'router'}))
    return
  }
  response.writeHead(200, {'content-type': 'application/json'})
  response.end(JSON.stringify({ok: true}))
})
server.listen(port, '127.0.0.1')
process.on('SIGTERM', () => server.close(() => process.exit(0)))
process.on('SIGINT', () => server.close(() => process.exit(0)))
`)
  const checksum = sha256Bytes(fakeDaemon)
  const artifactServer = createServer((request, response) => {
    if (request.url === '/harbor-routerd') {
      response.writeHead(200, {'content-type': 'application/octet-stream'})
      response.end(fakeDaemon)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => artifactServer.listen(0, '127.0.0.1', resolve))
  const artifactAddress = artifactServer.address()
  if (!artifactAddress || typeof artifactAddress === 'string') {
    throw new Error('artifact server did not bind a TCP port')
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const cli = path.resolve(moduleDir, '..', 'index.js')
  const config = path.join(harborHome, 'runtime.toml')
  const dataDir = path.join(harborHome, 'data')
  const child = spawn(process.execPath, [
    cli,
    'run',
    'router',
    '--source',
    'url',
    '--version',
    'url-run-test',
    '--binary-url',
    `http://127.0.0.1:${artifactAddress.port}/harbor-routerd`,
    '--sha256',
    checksum,
    '--config',
    config,
    '--data-dir',
    dataDir,
    '--port',
    String(port),
    '--force-install',
  ], {
    env: {
      ...process.env,
      HARBOR_HOME: harborHome,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk) => { output += chunk.toString() })

  try {
    await waitForHealth(port, child, () => output)
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(child.exitCode, null, output)
    child.kill('SIGTERM')
    const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
    assert.equal(code, 0, output)
    const install = path.join(harborHome, 'bin', 'router', 'url-run-test', runtimeTarget())
    await fs.access(path.join(install, checksum, 'harbor-routerd'))
    await fs.access(path.join(harborHome, 'logs', 'router.log'))
    assert.match(await fs.readFile(path.join(install, 'artifact.json'), 'utf8'), /url-run-test/)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    await new Promise<void>((resolve, reject) => artifactServer.close((error) => error ? reject(error) : resolve()))
  }
})

test('run auto switches healthy locally installed services as demand changes', {timeout: 25_000, skip: process.platform === 'win32'}, async (t) => {
  const home = await tempHome()
  t.after(() => fs.rm(home, {recursive: true, force: true}))
  const chainId = 'ef'.repeat(32)
  const basePort = (await freePort()) - 20_000
  const runtimeConfig = path.join(home, 'runtime.toml')
  const eventLog = path.join(home, 'events')
  const dataDir = path.join(home, 'data')
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  let best = 'relay'
  let chain = chainId
  const market = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const {table} = body ? JSON.parse(body) : {}
    const types = [
      [3, 'storage'],
      [24, 'relay'],
    ].map(([id, name]) => ({
      id, service_name: name, enabled: true, epoch_budget: '1.0000 SYS', base_provider_reward: '1.0000 SYS',
      metadata: JSON.stringify({demand: {unitsPerHour: name === best ? 7 : 1, unitPrice: '1.0000 SYS', expiresAt}}),
    }))
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(request.url?.endsWith('/get_info')
      ? {
        server_version: '1234', chain_id: chain, head_block_num: 3, last_irreversible_block_num: 1,
        last_irreversible_block_id: 'a1'.repeat(32), head_block_id: 'b1'.repeat(32),
        head_block_time: '2026-11-19T09:00:00.000', head_block_producer: 'eosio',
        virtual_block_cpu_limit: 200000, virtual_block_net_limit: 1048576, block_cpu_limit: 200000,
        block_net_limit: 1048576,
      }
      : {rows: table === 'svctypes' ? types : [], more: false}))
  })
  market.listen(0, '127.0.0.1')
  await once(market, 'listening')
  t.after(() => market.close())
  const {port: apiPort} = market.address() as {port: number}
  const url = `http://127.0.0.1:${apiPort}`
  await fs.writeFile(runtimeConfig, renderRuntimeConfig({dataDir, basePort, url, expectChainId: chainId}))
  for (const [role, file, offset] of [['relay', 'harbor-relayd', 23], ['storage', 'harbor-storaged', 2]] as const) {
    await fs.writeFile(path.join(home, file), `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const events = ${JSON.stringify(eventLog)};
const server = http.createServer((_request, response) => response.end('{"ok":true,"role":"${role}"}'));
server.listen(${basePort + offset}, '127.0.0.1', () => fs.appendFileSync(events, 'start:${role}\\n'));
process.once('SIGTERM', () => {
  fs.appendFileSync(events, 'stop:${role}\\n');
  server.close(() => process.exit(0));
});
`, {mode: 0o700})
  }
  const cli = fileURLToPath(new URL('../index.js', import.meta.url))
  const child = spawn(process.execPath, [
    cli, 'run', 'auto', '--json', '--interval', '1', '--url', url, '--expect-chain-id', chainId,
    '--config', runtimeConfig, '--data-dir', dataDir, '--always-on', '--bandwidth-mbps', '100',
  ], {env: {...process.env, HARBOR_HOME: home, HARBOR_DAEMON_DIR: home}, stdio: ['ignore', 'pipe', 'pipe']})
  const childExited = once(child, 'close')
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  async function waitForEvent(event: string, service?: string) {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (output.includes(JSON.stringify({event, ...(service && {service})}).slice(0, -1))) return
      if (child.exitCode !== null) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.fail(`missing ${event} ${service ?? ''}\n${output}`)
  }

  try {
    await waitForEvent('service-ready', 'relay')
    best = 'storage'
    await waitForEvent('service-ready', 'storage')
    chain = 'ab'.repeat(32)
    await waitForEvent('market-unavailable')
    assert.equal(await fs.readFile(eventLog, 'utf8'), 'start:relay\nstop:relay\nstart:storage\nstop:storage\n')
  } finally {
    child.kill('SIGTERM')
    await childExited
  }
})
