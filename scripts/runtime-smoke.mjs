import assert from 'node:assert/strict'
import {execFile, spawn} from 'node:child_process'
import {once} from 'node:events'
import fs from 'node:fs/promises'
import {createServer} from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-runtime-smoke-'))
const config = path.join(home, 'runtime.toml')
const env = {...process.env, HARBOR_HOME: home}
const foregroundOnly = process.argv.includes('--foreground-only')
const evidence = process.env.HARBOR_SMOKE_EVIDENCE
const transcript = []
let registered = false
let installed
let foreground

function report(command, result) {
  transcript.push(`$ ${command}`, result, '')
  console.log(`${command}\n  ${result}`)
}

async function harbor(...args) {
  const {stdout} = await exec(process.execPath, [cli, ...args], {env, timeout: 30_000})
  return JSON.parse(stdout)
}

async function bind(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

async function stopForeground() {
  if (foreground && foreground.exitCode === null && foreground.signalCode === null) {
    const finished = once(foreground, 'exit')
    foreground.kill('SIGTERM')
    await finished
  }
}

const backend = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const payload = JSON.parse(Buffer.concat(chunks))
  const model = 'qwen3:8b-q4_K_M'
  if (payload.model !== model || request.headers.authorization !== 'Bearer harbor-local') {
    response.writeHead(400).end('{}')
    return
  }
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({
    model,
    choices: [{index: 0, message: {role: 'assistant', content: `Received: ${payload.messages.at(-1).content}`}, finish_reason: 'stop'}],
    usage: {prompt_tokens: 4, completion_tokens: 5},
  }))
})
const portReservation = createServer()

try {
  const doctor = await harbor('doctor', '--json')
  const manager = doctor.checks.find(({check}) => check === 'service-manager')
  if (!foregroundOnly) assert.equal(manager.ok, true, manager.value)
  report('harbor doctor --json', `${doctor.platform} · ${doctor.runtime} · ${manager.value}`)
  const backendPort = await bind(backend)
  const servicePort = await bind(portReservation)
  await new Promise((resolve) => portReservation.close(resolve))
  const health = `http://127.0.0.1:${servicePort}/health`
  const options = [
    'aiinfer', '--source', 'local', '--config', config, '--port', String(servicePort),
    '--model-profile', 'flagship', '--backend-endpoint', `http://127.0.0.1:${backendPort}/v1/chat/completions`,
  ]
  const plan = await harbor('run', ...options, '--dry-run')
  assert.equal(plan.port, servicePort)
  assert.equal(plan.limits.cpu_percent, 40)
  assert.equal(plan.limits.memory_percent, 40)
  assert.equal(plan.model_profile.model, 'qwen3:8b-q4_K_M')
  report('harbor run aiinfer --dry-run', `${plan.release_asset} · 40% CPU · 40% memory`)
  const model = await harbor('ai', 'local-model', '--model-profile', 'flagship', '--json')
  assert.equal(model.expert_training, 'QLoRA')
  report('harbor ai local-model --model-profile flagship', `${model.model} · ${model.expert_adapter_base} adapter base`)
  if (foregroundOnly) {
    foreground = spawn(process.execPath, [cli, 'run', ...options], {env, stdio: 'inherit'})
    for (let attempt = 0; attempt < 100; attempt++) {
      if (foreground.exitCode !== null) throw new Error(`harbor run exited with ${foreground.exitCode}`)
      if (await fetch(health, {signal: AbortSignal.timeout(500)}).then((response) => response.ok).catch(() => false)) break
      await delay(100)
    }
  } else {
    const install = await harbor('service', 'install', ...options, '--json')
    installed = install
    registered = true
    assert.equal(install.manager, manager.value)
    assert.equal((await harbor('service', 'status', 'aiinfer', '--json')).state, 'stopped')
    report('harbor service install aiinfer', `Registered with ${install.manager}`)
    assert.equal((await harbor('service', 'start', 'aiinfer', '--json')).healthy, true)
    report('harbor service start aiinfer', 'Running and healthy')
  }
  assert.deepEqual(await fetch(health).then((response) => response.json()), {ok: true, role: 'aiinfer'})
  const infer = await fetch(health.replace('/health', '/ai/infer'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({infer_id: 0, model_id: 1, prompt: 'Harbor smoke check', max_output_tokens: 16}),
  })
  const result = await infer.json()
  assert.equal(infer.status, 200, JSON.stringify(result))
  assert.match(JSON.stringify(result), /Received: Harbor smoke check/)
  assert.match(result.result_hash, /^[a-f0-9]{64}$/)
  report('POST /ai/infer', `HTTP ${infer.status} · OpenAI-compatible test backend response verified`)
  if (foregroundOnly) {
    await stopForeground()
    report('Stop foreground Harbor', 'Process exited')
  } else {
    const restart = await harbor('service', 'restart', 'aiinfer', '--json')
    assert.equal(restart.healthy, true)
    report('harbor service restart aiinfer', 'Running and healthy')
    assert.equal((await harbor('service', 'stop', 'aiinfer', '--json')).state, 'stopped')
    assert.equal((await harbor('service', 'uninstall', 'aiinfer', '--json')).installed, false)
    registered = false
    report('harbor service stop / uninstall aiinfer', 'Stopped and unregistered')
  }
  assert.equal(await fetch(health, {signal: AbortSignal.timeout(1000)}).then(() => true).catch(() => false), false)
  report('Verify shutdown', 'Inference port closed')
  if (evidence) {
    await fs.mkdir(evidence, {recursive: true})
    const stem = doctor.runtime === 'wsl2' ? `windows-wsl2-${process.arch}` : doctor.platform
    const base = path.join(evidence, stem)
    const text = transcript.join('\n')
    await fs.writeFile(`${base}.txt`, text)
    const font = process.platform === 'darwin' ? '/System/Library/Fonts/Menlo.ttc' : 'DejaVu-Sans-Mono'
    const args = ['-background', '#161d29', '-fill', '#e9eef6', '-font', font, '-pointsize', '18',
      `label:${text}`, '-bordercolor', '#161d29', '-border', '28x24', `${base}.png`]
    try {
      await exec('magick', args)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await exec('convert', args)
    }
  }
} catch (error) {
  if (installed?.manager === 'launchd') {
    const status = await exec('/bin/launchctl', ['print', `gui/${process.getuid()}/${installed.id}`]).catch((error) => error)
    if (status.stdout) console.error(status.stdout)
  }
  for (const file of ['aiinfer.log', 'aiinfer.log.supervisor']) {
    const output = await fs.readFile(path.join(home, 'logs', file), 'utf8').catch(() => '')
    if (output) console.error(`${file}\n${output}`)
  }
  throw error
} finally {
  if (registered) await harbor('service', 'uninstall', 'aiinfer', '--json')
  await stopForeground()
  backend.closeAllConnections()
  backend.close()
  portReservation.close()
  await fs.rm(home, {recursive: true, force: true})
}
