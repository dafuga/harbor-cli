export interface HostState {
    on_battery: boolean | null;
    active: boolean | null;
    hot: boolean | null;
    available_memory_bytes: number;
}
export declare function hostState(): Promise<HostState>;
export declare function hostPolicy(state: HostState, idleOnly: boolean, memoryFloor?: number): {
    blocked: string | undefined;
    cpuScale: number;
};
export declare function freeDiskBytes(directory: string): Promise<number>;
export declare function gpuCapacity(): Promise<{
    kind: string;
    bytes: number | null;
}>;
export declare function checkDiskFloor(directory: string): Promise<void>;
export type ConfidentialVm = 'sev-snp' | 'tdx';
export interface ServiceHost {
    cpuCores: number;
    memoryBytes: number;
    availableMemoryBytes: number;
    gpuKind: 'apple-unified' | 'nvidia' | 'none';
    gpuBytes: number;
    freeDiskBytes: number;
    bandwidthMbps: number;
    alwaysOn: boolean;
    confidentialVm: ConfidentialVm | null;
    state?: HostState;
}
export interface ServiceHostOptions {
    hardwareProfile?: string;
    alwaysOn?: boolean;
    bandwidthMbps?: string | number;
}
export declare function serviceHost(directory: string, options: ServiceHostOptions): Promise<ServiceHost>;
