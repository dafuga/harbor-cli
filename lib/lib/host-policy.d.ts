export interface HostState {
    on_battery: boolean | null;
    active: boolean | null;
    hot: boolean | null;
    available_memory_bytes: number;
}
export declare function hostState(): Promise<HostState>;
export declare function hostPolicy(state: HostState, idleOnly: boolean): {
    blocked: string | undefined;
    cpuScale: number;
};
export declare function checkDiskFloor(directory: string): Promise<void>;
export declare function gpuCapacity(): Promise<{
    kind: string;
    bytes: number | null;
}>;
