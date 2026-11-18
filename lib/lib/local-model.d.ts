export declare const MODEL_PROFILES: {
    readonly flagship: {
        readonly model: "qwen3:8b-q4_K_M";
        readonly base_checkpoint: "Qwen/Qwen3-8B";
    };
    readonly compact: {
        readonly model: "qwen3:4b-q4_K_M";
        readonly base_checkpoint: "Qwen/Qwen3-4B";
    };
    readonly large: {
        readonly model: "qwen3.5:27b-q4_K_M";
        readonly base_checkpoint: "Qwen/Qwen3.5-27B";
        readonly minimum_memory_gib: 48;
    };
};
export declare const LOCAL_BACKEND_ENDPOINT = "http://127.0.0.1:11434/v1/chat/completions";
export declare const LOCAL_BACKEND_KEY_ENV = "HARBOR_LOCAL_INFERENCE_TOKEN";
export declare function localModel(profile?: string, totalMemory?: number): {
    quantization: string;
    expert_training: string;
    expert_adapter_base: "Qwen/Qwen3-8B" | "Qwen/Qwen3-4B" | "Qwen/Qwen3.5-27B";
    backend_endpoint: string;
    model: "qwen3:8b-q4_K_M";
    base_checkpoint: "Qwen/Qwen3-8B";
    profile: "compact" | "flagship" | "large";
} | {
    quantization: string;
    expert_training: string;
    expert_adapter_base: "Qwen/Qwen3-8B" | "Qwen/Qwen3-4B" | "Qwen/Qwen3.5-27B";
    backend_endpoint: string;
    model: "qwen3:4b-q4_K_M";
    base_checkpoint: "Qwen/Qwen3-4B";
    profile: "compact" | "flagship" | "large";
} | {
    quantization: string;
    expert_training: string;
    expert_adapter_base: "Qwen/Qwen3-8B" | "Qwen/Qwen3-4B" | "Qwen/Qwen3.5-27B";
    backend_endpoint: string;
    model: "qwen3.5:27b-q4_K_M";
    base_checkpoint: "Qwen/Qwen3.5-27B";
    minimum_memory_gib: 48;
    profile: "compact" | "flagship" | "large";
};
export declare function isLocalHttp(endpoint: string): boolean;
export interface ManagedBackendOptions {
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
    engine: 'ollama' | 'llama.cpp';
    environment?: Record<string, string>;
}
export declare function planManagedBackend(options: ManagedBackendOptions, endpoint: string, model: string, protocol: string, cores: number, dryRun: boolean): Promise<ManagedBackend | undefined>;
