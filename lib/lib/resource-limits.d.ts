export interface LimitOptions {
    cpuPercent?: string | number;
    memoryPercent?: string | number;
    gpuPercent?: string | number;
}
export interface ResourceLimits {
    cpu_percent: number;
    memory_percent: number;
    gpu_percent: number;
    cpu_cores: number;
    memory_bytes: number;
}
export declare function resourceLimits(options?: LimitOptions): ResourceLimits;
export declare function configuredLimits(overrides?: LimitOptions): Promise<ResourceLimits>;
export declare function marketLimits(overrides?: LimitOptions): Promise<ResourceLimits>;
export declare function saveLimits(overrides: LimitOptions): Promise<ResourceLimits>;
export declare function signalGroup(pid: number, signal: NodeJS.Signals): void;
export declare function watchProcessGroups(groups: () => readonly number[], limits: ResourceLimits, onError: (error: Error) => void, policy?: () => {
    paused: boolean;
    cpuScale: number;
}, kernelLimits?: boolean, onUsage?: (usage: {
    cpu_cores: number;
    memory_bytes: number;
    throttled: boolean;
}) => void): () => void;
