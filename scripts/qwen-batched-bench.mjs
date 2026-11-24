import {execFile} from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {promisify} from 'node:util'
import {verifyQwenGguf} from '../lib/lib/gguf.js'
import {hostPolicy, hostState} from '../lib/lib/host-policy.js'
import {configuredLimits} from '../lib/lib/resource-limits.js'

const exec = promisify(execFile)
const [binary, model, output, mode] = process.argv.slice(2)
if (!binary || !model || !output || (mode && mode !== '--plan')) {
  throw new Error('usage: node scripts/qwen-batched-bench.mjs <llama-batched-bench> <Qwen3-8B-Q4_K_M.gguf> <report.json> [--plan]')
}
if (!/qwen3[-_.]8b.*q4[_-]k[_-]m/i.test(path.basename(model))) {
  throw new Error('provide a Qwen3 8B Q4_K_M weights file')
}
const weights = (await fs.stat(model)).size
if (mode !== '--plan') await verifyQwenGguf(model)
const limits = await configuredLimits()
const report = {host: os.hostname(), platform: process.platform, arch: process.arch, model: path.basename(model), weights_bytes: weights, limits, rows: []}
const generation = 128
const kvElementsPerToken = 2 * 36 * 8 * 128
const gpuLayers = Math.floor(36 * limits.gpu_percent / 100)
for (const cache of ['q8_0', 'f16']) {
  for (const context of [2048, 4096, 8192]) {
    for (const batch of [1, 4, 8, 16, 32]) {
      const estimatedBytes = weights + 2 ** 30 + Math.ceil(batch * context * kvElementsPerToken * (cache === 'q8_0' ? 1.0625 : 2))
      const row = {cache, context, batch, estimated_bytes: estimatedBytes}
      report.rows.push(row)
      if (estimatedBytes > limits.memory_bytes) {
        row.state = 'above_memory_cap'
        continue
      }
      if (mode === '--plan') {
        row.state = 'eligible'
        continue
      }
      const policy = hostPolicy(await hostState(), false)
      if (policy.blocked) {
        row.state = 'host_unavailable'
        row.error = policy.blocked
        continue
      }
      const args = [
        '-m', path.resolve(model), '-c', String(context * batch), '-npp', String(context - generation), '-ntg', String(generation),
        '-npl', String(batch), '-fa', 'on', '-ctk', cache, '-ctv', cache, '-ngl', String(gpuLayers),
        '-t', String(Math.max(1, Math.floor(limits.cpu_cores * policy.cpuScale))), '--output-format', 'jsonl',
      ]
      try {
        const {stdout} = await exec(path.resolve(binary), args, {timeout: 10 * 60_000})
        const measurement = stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
          .find(({pp, tg, pl}) => pp === context - generation && tg === generation && pl === batch)
        if (!Number.isFinite(measurement?.speed_tg) || !Number.isFinite(measurement?.speed_pp)) throw new Error('benchmark returned no matching token-rate row')
        row.state = 'measured'
        row.generation_tokens_per_second = measurement.speed_tg
        row.prefill_tokens_per_second = measurement.speed_pp
      } catch (error) {
        row.state = 'failed'
        row.error = error.message
      }
    }
  }
}
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx', mode: 0o600})
console.log(JSON.stringify(report.rows.reduce((counts, row) => ({...counts, [row.state]: (counts[row.state] ?? 0) + 1}), {})))
