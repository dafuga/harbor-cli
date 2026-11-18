import { ResolveArtifactOptions, ResolvedArtifact, ServiceRuntime } from './artifacts.js';
import { localModel, ManagedBackend, ManagedBackendOptions } from './local-model.js';
import { LimitOptions, ResourceLimits } from './resource-limits.js';
interface BackendOptions {
    backendEndpoint?: string;
    backendProtocol?: string;
    backendModel?: string;
    backendApiKeyEnv?: string;
}
export interface HarborRunOptions extends Omit<ResolveArtifactOptions, 'service'>, LimitOptions, BackendOptions, ManagedBackendOptions {
    config?: string;
    dataDir?: string;
    port?: string | number;
    json?: boolean;
    dryRun?: boolean;
    modelProfile?: string;
    genesisJson?: string;
    idleOnly?: boolean;
}
export interface HarborRunPlan {
    service: string;
    daemon: string;
    version: string;
    source: string;
    binary: string;
    target: string;
    release_asset: string;
    config: string;
    data_dir: string;
    port: number;
    command: string[];
    log: string;
    usage_file: string;
    limits: ResourceLimits;
    cwd: string;
    backend_key_env?: string;
    backend_local?: boolean;
    model_profile?: ReturnType<typeof localModel>;
    managed_backend?: ManagedBackend;
    idle_only?: boolean;
    artifact?: ResolvedArtifact;
    dry_run: boolean;
}
export declare function renderRuntimeConfig(input: {
    dataDir: string;
    basePort: number;
    historyRepo?: string;
    url?: string;
    marketContract?: string;
    storageContract?: string;
} & BackendOptions): string;
export declare function buildRunPlan(service: ServiceRuntime, options: HarborRunOptions): Promise<HarborRunPlan>;
export declare function serviceHealthy(port: number, service: string): Promise<boolean>;
export declare function waitForHealth(plan: Pick<HarborRunPlan, 'port' | 'service'>, childExited?: () => boolean, timeout?: number): Promise<void>;
export declare function runServiceForeground(service: ServiceRuntime, options: HarborRunOptions): Promise<HarborRunPlan>;
export declare function superviseRuntime(plan: HarborRunPlan, options: {
    mirror: 'both' | 'stderr';
    kernelLimits: boolean;
}): Promise<void>;
export {};
