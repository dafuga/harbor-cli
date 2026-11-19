import os from 'node:os'
import {createHash} from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {executableExists} from './artifacts.js'
import {harborHome} from './config.js'
import {verifyQwenGguf} from './gguf.js'
import {gpuCapacity} from './host-policy.js'
import {ResourceLimits} from './resource-limits.js'

const GiB = 1024 ** 3
const QWEN3_8B = {
  model: 'qwen3:8b-q4_K_M',
  base_checkpoint: 'Qwen/Qwen3-8B',
  awq_checkpoint: 'Qwen/Qwen3-8B-AWQ',
  mlx_checkpoint: 'Qwen/Qwen3-8B-MLX-4bit',
  layers: 36,
  working_memory_gib: 5.7,
} as const

export const LOCAL_BACKEND_ENDPOINT = 'http://127.0.0.1:11434/v1/chat/completions'
export const LOCAL_BACKEND_KEY_ENV = 'HARBOR_LOCAL_INFERENCE_TOKEN'

export function localModel(profile = 'auto', totalMemory = os.totalmem(), memoryBudget = totalMemory * 0.4) {
  if (profile !== 'auto' && profile !== 'flagship') throw new Error('the local model profile is Qwen3 8B 4-bit; use auto or flagship')
  return {
    profile: 'flagship',
    ...QWEN3_8B,
    quantization: 'Q4_K_M',
    expert_training: 'QLoRA',
    expert_adapter_base: QWEN3_8B.base_checkpoint,
    backend_endpoint: LOCAL_BACKEND_ENDPOINT,
    fits_memory_cap: memoryBudget >= QWEN3_8B.working_memory_gib * GiB,
    meets_hardware_minimum: totalMemory >= 16 * GiB,
  }
}

export function isLocalHttp(endpoint: string): boolean {
  if (!endpoint) return false
  const {hostname, protocol} = new URL(endpoint)
  return protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
}

export interface ManagedBackendOptions {
  ollama?: string
  llamaServer?: string
  baseGguf?: string
  expertGguf?: string
}

export interface ManagedBackend {
  command: string[]
  endpoint: string
  readiness: string
  model: string
  engine: 'ollama' | 'llama.cpp'
  parallel: number
  cacheDirectory?: string
  environment?: Record<string, string>
}

export async function llamaCacheDirectory(
  root: string,
  files: string[],
  model: string,
  parallel: number,
  dryRun = false,
): Promise<string> {
  const identities = dryRun ? files : await Promise.all(files.map(async (file) => {
    const stat = await fs.stat(file)
    if (!stat.isFile()) throw new Error(`expected a backend executable or GGUF file: ${file}`)
    return `${file}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
  }))
  const fingerprint = createHash('sha256').update(JSON.stringify([...identities, model, parallel, 'q8_0'])).digest('hex')
  return path.resolve(root, fingerprint)
}

export async function planManagedBackend(
  options: ManagedBackendOptions,
  endpoint: string,
  model: string,
  protocol: string,
  limits: ResourceLimits,
  profile: ReturnType<typeof localModel> | undefined,
  dryRun: boolean,
): Promise<ManagedBackend | undefined> {
  if (!options.ollama && !options.llamaServer && !options.baseGguf && !options.expertGguf) return undefined
  if (Boolean(options.ollama) === Boolean(options.llamaServer) || (options.ollama && (options.baseGguf || options.expertGguf))) {
    throw new Error('choose --ollama or --llama-server; GGUF options require --llama-server')
  }
  if (!isLocalHttp(endpoint) || protocol !== 'openai' || !model) {
    throw new Error('a managed backend needs a loopback OpenAI-compatible endpoint and a model')
  }
  const url = new URL(endpoint)
  if (url.pathname !== '/v1/chat/completions' || !url.port || url.search || url.hash) {
    throw new Error('use /v1/chat/completions on an explicit loopback port for a managed backend')
  }
  const executable = path.resolve((options.ollama ?? options.llamaServer)!)
  const tier = profile ?? localModel('auto', os.totalmem(), limits.memory_bytes)
  if (!dryRun && !tier.fits_memory_cap) {
    throw new Error(`Qwen3 8B 4-bit needs an estimated ${tier.working_memory_gib} GiB within the configured memory cap`)
  }
  const gpu = await gpuCapacity()
  // Qwen GQA at 4K and q8 KV needs roughly 288 MiB per stream. Leave headroom for allocator overhead.
  const remaining = limits.memory_bytes - tier.working_memory_gib * GiB
  const parallel = [32, 16, 8, 4, 1].find((size) => remaining >= size * 384 * 2 ** 20) ?? 1
  if (!dryRun && !await executableExists(executable)) throw new Error(`backend executable is unavailable: ${executable}`)
  if (options.ollama) {
    if (model !== QWEN3_8B.model) throw new Error(`managed Ollama requires ${QWEN3_8B.model}`)
    return {
      engine: 'ollama',
      command: [executable, 'serve'],
      endpoint,
      readiness: new URL('/api/tags', url).href,
      model,
      parallel,
      environment: {
        OLLAMA_HOST: url.host,
        OLLAMA_NUM_PARALLEL: String(parallel),
        OLLAMA_MAX_LOADED_MODELS: '1',
        OLLAMA_CONTEXT_LENGTH: '4096',
        OLLAMA_FLASH_ATTENTION: '1',
        OLLAMA_KV_CACHE_TYPE: 'q8_0',
        OLLAMA_NO_CLOUD: '1',
        ...(gpu.bytes ? {OLLAMA_GPU_OVERHEAD: String(Math.floor(gpu.bytes * (100 - limits.gpu_percent) / 100))} : {}),
      },
    }
  }

  if (!options.baseGguf) throw new Error('--base-gguf is required with --llama-server')
  const base = path.resolve(options.baseGguf)
  const expert = options.expertGguf ? path.resolve(options.expertGguf) : undefined
  const files = [executable, base, ...(expert ? [expert] : [])]
  if (!dryRun) await verifyQwenGguf(base)
  const cacheDirectory = await llamaCacheDirectory(path.resolve(harborHome(), 'kv-cache'), files, model, parallel, dryRun)
  const cacheRamMiB = Math.max(0, Math.min(256, Math.floor(remaining / (2 ** 20) - parallel * 384)))
  return {
    engine: 'llama.cpp',
    command: [
      executable, '--model', base, '--host', url.hostname.replace(/^\[|\]$/g, ''), '--port', url.port,
      '--alias', model, '--ctx-size', String(4096 * parallel), '--parallel', String(parallel),
      '--threads', String(Math.max(1, Math.floor(limits.cpu_cores))),
      '--n-gpu-layers', String(gpu.bytes ? Math.floor(tier.layers * limits.gpu_percent / 100) : 0),
      '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0',
      '--slots', '--slot-save-path', cacheDirectory, '--cache-ram', String(cacheRamMiB), '--cache-prompt', '--no-webui',
      ...(expert ? ['--lora', expert] : []),
    ],
    endpoint,
    readiness: new URL('/v1/models', url).href,
    model,
    parallel,
    cacheDirectory,
  }
}
