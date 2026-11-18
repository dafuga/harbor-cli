export interface LimitOptions {
    cpuPercent?: string | number;
    memoryPercent?: string | number;
}
export interface ResourceLimits {
    cpu_percent: number;
    memory_percent: number;
    cpu_cores: number;
    memory_bytes: number;
}
export declare function resourceLimits(options?: LimitOptions): ResourceLimits;
export declare function signalGroup(pid: number, signal: NodeJS.Signals): void;
export declare function watchProcessGroups(groups: () => readonly number[], limits: ResourceLimits, onError: (error: Error) => void): () => void;
