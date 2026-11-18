import { ServiceRuntime } from './artifacts.js';
import { HarborRunOptions, HarborRunPlan } from './run.js';
type Manager = 'launchd' | 'systemd';
type ServiceState = 'running' | 'starting' | 'stopping' | 'stopped' | 'failed';
export interface ServiceRegistration {
    manager: Manager;
    system?: boolean;
    id: string;
    record: string;
    definition: string;
}
export declare function serviceManager(): Manager;
export declare function registration(service: ServiceRuntime, system?: boolean): ServiceRegistration;
export declare function verifyServiceManager(system?: boolean): Promise<void>;
export declare function renderServiceDefinition(spec: ServiceRegistration, plan: HarborRunPlan, launcher: string[]): string;
interface RecordedService {
    schema: 1;
    spec: ServiceRegistration;
    plan: HarborRunPlan;
}
export declare function installService(service: ServiceRuntime, options: HarborRunOptions, launcher: string[], system?: boolean): Promise<{
    plan: HarborRunPlan;
    preview: string;
    manager: Manager;
    system?: boolean;
    id: string;
    record: string;
    definition: string;
} | {
    plan: HarborRunPlan;
    manager: Manager;
    system?: boolean;
    id: string;
    record: string;
    definition: string;
}>;
export declare function serviceStatus(service: ServiceRuntime, system?: boolean): Promise<{
    service: string;
    manager: Manager;
    system: boolean;
    target: string;
    installed: boolean;
    state: ServiceState;
    healthy: boolean;
    port: number;
    limits: import("./resource-limits.js").ResourceLimits;
    usage: {
        measured_at: number;
        paused_reason?: string;
    } | undefined;
    log: string;
    config: string;
    backend: {
        engine: "ollama" | "llama.cpp";
        model: string;
        parallel: number;
    } | undefined;
} | {
    service: string;
    manager: Manager;
    system: boolean;
    target: "macos-arm64" | "macos-x64" | "linux-arm64" | "linux-x64";
    installed: boolean;
    state: string;
    healthy: boolean;
}>;
export declare function registeredService(service: ServiceRuntime, system?: boolean): Promise<RecordedService>;
export declare function controlService(service: ServiceRuntime, action: 'start' | 'stop' | 'restart' | 'uninstall', system?: boolean): Promise<{
    service: string;
    manager: Manager;
    system: boolean;
    target: string;
    installed: boolean;
    state: ServiceState;
    healthy: boolean;
    port: number;
    limits: import("./resource-limits.js").ResourceLimits;
    usage: {
        measured_at: number;
        paused_reason?: string;
    } | undefined;
    log: string;
    config: string;
    backend: {
        engine: "ollama" | "llama.cpp";
        model: string;
        parallel: number;
    } | undefined;
} | {
    service: string;
    manager: Manager;
    system: boolean;
    target: "macos-arm64" | "macos-x64" | "linux-arm64" | "linux-x64";
    installed: boolean;
    state: string;
    healthy: boolean;
}>;
export declare function superviseRegisteredService(file: string): Promise<void>;
export {};
