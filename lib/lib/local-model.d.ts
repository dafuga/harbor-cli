import { ResourceLimits } from './resource-limits.js';
export declare const LOCAL_BACKEND_ENDPOINT = "http://127.0.0.1:11434/v1/chat/completions";
export declare const LOCAL_BACKEND_KEY_ENV = "HARBOR_LOCAL_INFERENCE_TOKEN";
export declare function localModel(profile?: string, totalMemory?: number, memoryBudget?: number): {
    backend_endpoint: string;
    fits_memory_cap: boolean;
    model: "qwen3:8b-mlx-4bit";
    engine: "mlx";
    working_memory_gib: 7.25;
    profile: string;
} | {
    backend_endpoint: string;
    fits_memory_cap: boolean;
    model: "inkling-2-mini:8.33gb";
    engine: "llama.cpp";
    working_memory_gib: 8.62;
    profile: string;
} | {
    backend_endpoint: string;
    fits_memory_cap: boolean;
    model: "inkling-2-mini:12.28gb";
    engine: "llama.cpp";
    working_memory_gib: 12.43;
    profile: string;
} | {
    quantization: string;
    expert_training: string;
    expert_adapter_base: "Qwen/Qwen3-8B";
    backend_endpoint: string;
    fits_memory_cap: boolean;
    minimum_host_memory_gib: number;
    model: "qwen3:8b-q4_K_M";
    base_checkpoint: "Qwen/Qwen3-8B";
    awq_checkpoint: "Qwen/Qwen3-8B-AWQ";
    mlx_checkpoint: "Qwen/Qwen3-8B-MLX-4bit";
    layers: 36;
    working_memory_gib: 5.7;
    profile: string;
};
export declare function isLocalHttp(endpoint: string): boolean;
export interface ManagedBackendOptions {
    harborRuntime?: string;
    harborPython?: string;
    harborWeights?: string;
    harborPrefix?: string;
    harborContext?: string;
    harborPrefillBatch?: string;
    harborPrefillUbatch?: string;
    ollama?: string;
    llamaServer?: string;
    baseGguf?: string;
    expertGguf?: string;
}
export interface ManagedBackend {
    command: string[];
    endpoint: string;
    readiness: string;
    model: string;
    engine: 'ollama' | 'llama.cpp' | 'mlx';
    parallel: number;
    startupTimeoutMs?: number;
    cacheDirectory?: string;
    environment?: Record<string, string>;
}
export declare function llamaCacheDirectory(root: string, files: string[], model: string, parallel: number, dryRun?: boolean): Promise<string>;
export declare function planManagedBackend(options: ManagedBackendOptions, endpoint: string, model: string, protocol: string, limits: ResourceLimits, profile: ReturnType<typeof localModel> | undefined, dryRun: boolean): Promise<ManagedBackend | undefined>;
