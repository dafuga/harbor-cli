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

test('buildRunPlan dry-run does not require an installed binary', async () => {
  const plan = await buildRunPlan(normalizeServiceName('router'), {
    dryRun: true,
    version: 'dev',
    config: '/tmp/harbor-runtime.toml',
    dataDir: '/tmp/harbor-runtime-data',
    port: 9213,
  })

  assert.equal(plan.service, 'router')
  assert.equal(plan.daemon, 'harbor-routerd')
  assert.equal(plan.port, 9213)
  assert.deepEqual(plan.command, [plan.binary, '--config', '/tmp/harbor-runtime.toml'])
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

test('harbor run --source url downloads, installs, starts, logs, and stops', {timeout: 20_000}, async () => {
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
    await fs.access(path.join(harborHome, 'bin', 'router', 'url-run-test', 'harbor-routerd'))
    await fs.access(path.join(harborHome, 'logs', 'router.log'))
    assert.match(await fs.readFile(path.join(harborHome, 'artifacts.json'), 'utf8'), /url-run-test/)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    await new Promise<void>((resolve, reject) => artifactServer.close((error) => error ? reject(error) : resolve()))
  }
})
