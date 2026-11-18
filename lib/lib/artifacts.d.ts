export { sha256Bytes } from './storage.js';
export { hostPlatform } from './runtime-host.js';
export type ArtifactSource = 'auto' | 'local' | 'harbor-storage' | 'github' | 'url';
export interface ServiceRuntime {
    name: string;
    aliases: string[];
    daemon: string;
    serviceTypeId: number;
    portOffset: number;
}
export interface ArtifactManifest {
    kind: 'harbor-artifact-manifest';
    service: string;
    version: string;
    platform: string;
    arch: string;
    binary_object_hash: string;
    sha256: string;
    bytes: number;
    entrypoint: string;
}
export interface ArtifactRecord {
    service: string;
    version: string;
    source: ArtifactSource | 'path';
    binary: string;
    sha256?: string;
    installedAt: string;
    provenance: string;
    target?: string;
}
export interface ResolveArtifactOptions {
    service: ServiceRuntime;
    source?: ArtifactSource;
    version?: string;
    binaryUrl?: string;
    artifactHash?: string;
    sha256?: string;
    forceInstall?: boolean;
    url?: string;
    marketContract?: string;
    storageContract?: string;
}
export interface ResolvedArtifact {
    binary: string;
    version: string;
    source: ArtifactRecord['source'];
    sha256?: string;
    installed: boolean;
    provenance: string;
}
export declare const SERVICE_RUNTIMES: ServiceRuntime[];
export declare function normalizeServiceName(name: string): ServiceRuntime;
export declare function executableExists(binary: string): Promise<boolean>;
export declare function validateArtifactVersion(version: string): void;
export declare function artifactBinary(service: ServiceRuntime, version: string, sha256?: string): string;
export declare function installDownloadedBinary(input: {
    service: ServiceRuntime;
    version: string;
    bytes: Buffer;
    expectedSha256: string;
    source: ArtifactSource;
    provenance: string;
}): Promise<ResolvedArtifact>;
export declare function resolveArtifact(options: ResolveArtifactOptions): Promise<ResolvedArtifact>;
export declare function defaultRuntimeConfigPath(): string;
export declare function defaultRuntimeDataDir(): string;
