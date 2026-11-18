import { ServiceRuntime } from './artifacts.js';
import { HarborRunOptions, HarborRunPlan } from './run.js';
type Manager = 'launchd' | 'systemd';
type ServiceState = 'running' | 'starting' | 'stopping' | 'stopped' | 'failed';
export interface ServiceRegistration {
    manager: Manager;
    id: string;
    record: string;
    definition: string;
}
export declare function serviceManager(): Manager;
export declare function registration(service: ServiceRuntime): ServiceRegistration;
export declare function verifyServiceManager(): Promise<void>;
export declare function renderServiceDefinition(spec: ServiceRegistration, plan: HarborRunPlan, launcher: string[]): string;
interface RecordedService {
    schema: 1;
    spec: ServiceRegistration;
    plan: HarborRunPlan;
}
export declare function installService(service: ServiceRuntime, options: HarborRunOptions, launcher: string[]): Promise<{
    plan: HarborRunPlan;
    preview: string;
    manager: Manager;
    id: string;
    record: string;
    definition: string;
} | {
    plan: HarborRunPlan;
    manager: Manager;
    id: string;
    record: string;
    definition: string;
}>;
export declare function serviceStatus(service: ServiceRuntime): Promise<{
    service: string;
    manager: Manager;
    target: string;
    installed: boolean;
    state: ServiceState;
    healthy: boolean;
    port: number;
    limits: import("./resource-limits.js").ResourceLimits;
    log: string;
    config: string;
    backend: {
        engine: "ollama" | "llama.cpp";
        model: string;
    } | undefined;
} | {
    service: string;
    manager: Manager;
    target: "macos-arm64" | "macos-x64" | "linux-arm64" | "linux-x64";
    installed: boolean;
    state: string;
    healthy: boolean;
}>;
export declare function registeredService(service: ServiceRuntime): Promise<RecordedService>;
export declare function controlService(service: ServiceRuntime, action: 'start' | 'stop' | 'restart' | 'uninstall'): Promise<{
    service: string;
    manager: Manager;
    target: string;
    installed: boolean;
    state: ServiceState;
    healthy: boolean;
    port: number;
    limits: import("./resource-limits.js").ResourceLimits;
    log: string;
    config: string;
    backend: {
        engine: "ollama" | "llama.cpp";
        model: string;
    } | undefined;
} | {
    service: string;
    manager: Manager;
    target: "macos-arm64" | "macos-x64" | "linux-arm64" | "linux-x64";
    installed: boolean;
    state: string;
    healthy: boolean;
}>;
export declare function superviseRegisteredService(file: string): Promise<void>;
export {};
