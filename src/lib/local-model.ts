import os from 'node:os'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {executableExists} from './artifacts.js'
import {harborHome} from './config.js'
import {verifyQwenGguf} from './gguf.js'
import {gpuCapacity} from './host-policy.js'
import {DEFAULT_RESOURCE_PERCENT, ResourceLimits} from './resource-limits.js'

const GiB = 1024 ** 3
const MINIMUM_HOST_MEMORY_GIB = 16
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

const HARBOR_RUNTIME_PROFILES = {
  'qwen3-8b-mlx': {model: 'qwen3:8b-mlx-4bit', engine: 'mlx', working_memory_gib: 7.25},
  'inkling-8': {model: 'inkling-2-mini:8.33gb', engine: 'llama.cpp', working_memory_gib: 8.62},
  'inkling-12': {model: 'inkling-2-mini:12.28gb', engine: 'llama.cpp', working_memory_gib: 12.43},
} as const

function harborRuntimeProfile(name: string) {
  if (!Object.hasOwn(HARBOR_RUNTIME_PROFILES, name)) return undefined
  return HARBOR_RUNTIME_PROFILES[name as keyof typeof HARBOR_RUNTIME_PROFILES]
}

export function localModel(profile = 'auto', totalMemory = os.totalmem(), memoryBudget = totalMemory * DEFAULT_RESOURCE_PERCENT / 100) {
  const runtime = harborRuntimeProfile(profile)
  if (runtime) return {
    profile,
    ...runtime,
    backend_endpoint: LOCAL_BACKEND_ENDPOINT,
    fits_memory_cap: memoryBudget >= runtime.working_memory_gib * GiB,
  }
  if (profile !== 'auto' && profile !== 'flagship') throw new Error('use the Qwen3 8B 4-bit auto or flagship profile, qwen3-8b-mlx, inkling-8, or inkling-12')
  return {
    profile: 'flagship',
    ...QWEN3_8B,
    quantization: 'Q4_K_M',
    expert_training: 'QLoRA',
    expert_adapter_base: QWEN3_8B.base_checkpoint,
    backend_endpoint: LOCAL_BACKEND_ENDPOINT,
    fits_memory_cap: totalMemory >= MINIMUM_HOST_MEMORY_GIB * GiB && memoryBudget >= QWEN3_8B.working_memory_gib * GiB,
    minimum_host_memory_gib: MINIMUM_HOST_MEMORY_GIB,
  }
}

export function isLocalHttp(endpoint: string): boolean {
  if (!endpoint) return false
  const {hostname, protocol} = new URL(endpoint)
  return protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
}

export interface ManagedBackendOptions {
  harborRuntime?: string
  harborPython?: string
  harborWeights?: string
  harborPrefix?: string
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
  engine: 'ollama' | 'llama.cpp' | 'mlx'
  parallel: number
  startupTimeoutMs?: number
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

async function planHarborRuntime(
  options: ManagedBackendOptions, endpoint: string, model: string, url: URL,
  limits: ResourceLimits, profile: ReturnType<typeof localModel> | undefined,
): Promise<ManagedBackend> {
  const name = profile?.profile ?? 'qwen3-8b-mlx'
  const selected = harborRuntimeProfile(name)
  if (!selected || selected.model !== model || !options.harborWeights || !options.harborPython ||
      options.ollama || options.baseGguf || options.expertGguf ||
      Boolean(options.llamaServer) !== (selected.engine === 'llama.cpp')) {
    throw new Error('Harbor runtime requires the selected model profile, --harbor-python and --harbor-weights; Inkling also requires the patched --llama-server')
  }
  const gpu = await gpuCapacity()
  if (gpu.kind !== 'apple-unified' || !gpu.bytes || !limits.gpu_percent) {
    throw new Error('the selected Harbor runtime needs Apple Silicon GPU support')
  }
  const budget = Math.floor(Math.min(limits.memory_bytes, gpu.bytes * limits.gpu_percent / 100, gpu.bytes - 2 ** 30) / 2 ** 20)
  const executable = path.resolve(options.harborPython)
  const args = [
    path.resolve(options.harborRuntime!), '--profile', name, '--weights', path.resolve(options.harborWeights),
    '--port', url.port, '--memory-mib', String(budget),
    ...(options.harborPrefix ? ['--prefix-file', path.resolve(options.harborPrefix)] : []),
    ...(options.llamaServer ? ['--llama-server', path.resolve(options.llamaServer)] : []),
  ]
  const {stdout} = await promisify(execFile)(executable, [...args, '--print-plan'], {timeout: 5000})
  const plan = JSON.parse(stdout) as {engine?: string; model?: string; slots?: number}
  if (plan.engine !== selected.engine || plan.model !== model || !Number.isSafeInteger(plan.slots) || plan.slots! < 1) {
    throw new Error('the configured Harbor runtime returned an incompatible model plan')
  }
  return {engine: selected.engine, command: [executable, ...args], endpoint, model,
    readiness: new URL('/v1/models', url).href, parallel: plan.slots!, startupTimeoutMs: 180_000}
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
  if (!options.harborRuntime && (options.harborPython || options.harborWeights || options.harborPrefix)) {
    throw new Error('--harbor-python, --harbor-weights and --harbor-prefix require --harbor-runtime')
  }
  if (!options.harborRuntime && !options.ollama && !options.llamaServer && !options.baseGguf && !options.expertGguf) return undefined
  if (!isLocalHttp(endpoint) || protocol !== 'openai' || !model) {
    throw new Error('a managed backend needs a loopback OpenAI-compatible endpoint and a model')
  }
  const url = new URL(endpoint)
  if (url.pathname !== '/v1/chat/completions' || !url.port || url.search || url.hash) {
    throw new Error('use /v1/chat/completions on an explicit loopback port for a managed backend')
  }
  if (options.harborRuntime) {
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('Harbor runtime uses IPv4 loopback')
    return planHarborRuntime(options, endpoint, model, url, limits, profile)
  }
  if (Boolean(options.ollama) === Boolean(options.llamaServer) || (options.ollama && (options.baseGguf || options.expertGguf))) {
    throw new Error('choose --ollama or --llama-server; GGUF options require --llama-server')
  }
  const executable = path.resolve((options.ollama ?? options.llamaServer)!)
  const tier = profile ?? localModel('auto', os.totalmem(), limits.memory_bytes)
  if ('engine' in tier) throw new Error('the selected profile requires --harbor-runtime')
  if (!dryRun && !tier.fits_memory_cap) {
    throw new Error(`Qwen3 8B 4-bit needs at least ${tier.minimum_host_memory_gib} GiB of host memory and an estimated ${tier.working_memory_gib} GiB within the configured memory cap`)
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
