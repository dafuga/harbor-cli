import { ResolveArtifactOptions, ResolvedArtifact, ServiceRuntime } from './artifacts.js';
export interface HarborRunOptions extends Omit<ResolveArtifactOptions, 'service'> {
    config?: string;
    dataDir?: string;
    port?: string | number;
    json?: boolean;
    dryRun?: boolean;
}
export interface HarborRunPlan {
    service: string;
    daemon: string;
    version: string;
    source: string;
    binary?: string;
    config: string;
    data_dir: string;
    port: number;
    command: string[];
    artifact?: ResolvedArtifact;
    dry_run: boolean;
}
export declare function renderRuntimeConfig(input: {
    dataDir: string;
    basePort: number;
    historyRepo?: string;
}): string;
export declare function ensureRuntimeConfig(options: {
    config: string;
    dataDir: string;
    service: ServiceRuntime;
    port: number;
    force?: boolean;
}): Promise<{
    config: string;
    basePort: number;
}>;
export declare function buildRunPlan(service: ServiceRuntime, options: HarborRunOptions): Promise<HarborRunPlan>;
export declare function runServiceForeground(service: ServiceRuntime, options: HarborRunOptions): Promise<HarborRunPlan>;
