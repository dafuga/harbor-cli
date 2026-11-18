import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import {executableExists} from './artifacts.js'

const GiB = 1024 ** 3
export const MODEL_PROFILES = {
  flagship: {model: 'qwen3:8b-q4_K_M', base_checkpoint: 'Qwen/Qwen3-8B'},
  compact: {model: 'qwen3:4b-q4_K_M', base_checkpoint: 'Qwen/Qwen3-4B'},
  large: {model: 'qwen3.5:27b-q4_K_M', base_checkpoint: 'Qwen/Qwen3.5-27B', minimum_memory_gib: 48},
} as const

export const LOCAL_BACKEND_ENDPOINT = 'http://127.0.0.1:11434/v1/chat/completions'
export const LOCAL_BACKEND_KEY_ENV = 'HARBOR_LOCAL_INFERENCE_TOKEN'

export function localModel(profile = 'auto', totalMemory = os.totalmem()) {
  const selected = profile === 'auto' ? (totalMemory < 16 * GiB ? 'compact' : 'flagship') : profile
  const key = (Object.keys(MODEL_PROFILES) as Array<keyof typeof MODEL_PROFILES>).find((item) => item === selected)
  if (!key) throw new Error('--model-profile must be auto, flagship, compact, or large')
  const model = MODEL_PROFILES[key]
  if ('minimum_memory_gib' in model && totalMemory < model.minimum_memory_gib * GiB) {
    throw new Error(`the ${selected} model profile requires at least ${model.minimum_memory_gib} GiB of visible memory`)
  }
  return {
    profile: key,
    ...model,
    quantization: 'Q4_K_M',
    expert_training: 'QLoRA',
    expert_adapter_base: model.base_checkpoint,
    backend_endpoint: LOCAL_BACKEND_ENDPOINT,
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
  environment?: Record<string, string>
}

export async function planManagedBackend(
  options: ManagedBackendOptions,
  endpoint: string,
  model: string,
  protocol: string,
  cores: number,
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
  if (!dryRun && !await executableExists(executable)) throw new Error(`backend executable is unavailable: ${executable}`)
  if (options.ollama) {
    return {
      engine: 'ollama',
      command: [executable, 'serve'],
      endpoint,
      readiness: new URL('/api/tags', url).href,
      model,
      environment: {
        OLLAMA_HOST: url.host,
        OLLAMA_NUM_PARALLEL: '1',
        OLLAMA_MAX_LOADED_MODELS: '1',
        OLLAMA_CONTEXT_LENGTH: '4096',
      },
    }
  }

  if (!options.baseGguf) throw new Error('--base-gguf is required with --llama-server')
  const base = path.resolve(options.baseGguf)
  const expert = options.expertGguf ? path.resolve(options.expertGguf) : undefined
  if (!dryRun) {
    for (const file of [base, expert]) {
      if (file && !(await fs.stat(file)).isFile()) throw new Error(`expected a GGUF file: ${file}`)
    }
  }
  return {
    engine: 'llama.cpp',
    command: [
      executable, '--model', base, '--host', url.hostname.replace(/^\[|\]$/g, ''), '--port', url.port,
      '--alias', model, '--ctx-size', '4096', '--threads', String(Math.max(1, Math.floor(cores))),
      ...(expert ? ['--lora', expert] : []),
    ],
    endpoint,
    readiness: new URL('/v1/models', url).href,
    model,
  }
}
