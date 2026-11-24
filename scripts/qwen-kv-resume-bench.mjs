import fs from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {performance} from 'node:perf_hooks'

const [address, reportFile] = process.argv.slice(2)
if (!address || !reportFile) throw new Error('usage: node scripts/qwen-kv-resume-bench.mjs <isolated llama-server URL> <report.json>')
const engine = new URL(address)
if (engine.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(engine.hostname) || engine.username || engine.password) {
  throw new Error('use a dedicated HTTP loopback llama-server')
}
const key = process.env.HARBOR_BENCH_ENGINE_KEY
const headers = {'content-type': 'application/json', ...(key ? {authorization: `Bearer ${key}`} : {})}

async function post(endpoint, value) {
  const response = await fetch(new URL(endpoint, engine), {
    method: 'POST', headers, body: JSON.stringify(value), signal: AbortSignal.timeout(300_000),
  })
  if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}`)
  return response.json()
}

const tokenization = await post('/tokenize', {content: 'Harbor benchmark: verify the local chain ID and the wallet permission. '.repeat(900)})
if (tokenization.tokens?.length < 3900) throw new Error('tokenizer returned too few tokens')
const prefix = tokenization.tokens.slice(0, 3800)
const continuation = [...prefix, ...tokenization.tokens.slice(3807, 3863)]
const complete = (prompt) => post('/completion', {prompt, id_slot: 0, n_predict: 1, temperature: 0, cache_prompt: true})
const slot = (action, body = {}) => post(`/slots/0?action=${action}`, body)
const filename = `harbor-bench-${randomUUID()}.bin`
const rows = []
await slot('erase')
await complete(prefix)
const saveStarted = performance.now()
const saved = await slot('save', {filename})
const saveMs = performance.now() - saveStarted
if (saved.n_saved < 1000 || saved.n_written <= 0) throw new Error('the backend did not persist the requested prefix')

for (let round = 1; round <= 5; round++) {
  await slot('erase')
  const recomputeAt = performance.now()
  const cold = await complete(continuation)
  const recomputeMs = performance.now() - recomputeAt
  if (cold.tokens_cached > 32 && cold.timings?.prompt_n < continuation.length / 2) {
    throw new Error('cold run reused RAM cache; restart the benchmark engine with --cache-ram 0')
  }
  await slot('erase')
  const resumeAt = performance.now()
  const restored = await slot('restore', {filename})
  const restoreMs = performance.now() - resumeAt
  const warm = await complete(continuation)
  const resumeMs = performance.now() - resumeAt
  if (restored.n_restored !== saved.n_saved) throw new Error('restored token count differs from the saved prefix')
  rows.push({
    round, recompute_ms: recomputeMs, ssd_restore_ms: restoreMs, resume_ms: resumeMs,
    cold_prompt_tokens: cold.timings?.prompt_n, warm_prompt_tokens: warm.timings?.prompt_n,
  })
}
await slot('erase')
const data = {
  cache: 'q8_0', prompt_tokens: continuation.length,
  file: filename, cached_tokens: saved.n_saved, bytes_per_saved_chat: saved.n_written, save_ms: saveMs, rows,
  budget_16_gib_at_50_percent: {
    memory_bytes: 8 * 2 ** 30,
    estimated_active_slots: 4,
    idle_full_prefixes_in_2_gib_disk_cache: Math.floor(2 * 2 ** 30 / saved.n_written),
  },
}
await fs.writeFile(reportFile, `${JSON.stringify(data, null, 2)}\n`, {mode: 0o600, flag: 'wx'})
console.log(JSON.stringify(data))
