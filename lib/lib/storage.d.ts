import http from 'node:http';
import type { AuthOptions } from './tx.js';
export interface StorageManifestEntry {
    path: string;
    bytes: number;
    sha256: string;
}
export interface StoreObjectOptions {
    root: string;
    file: string;
    encrypt?: boolean;
    privateKey?: string;
    metadata?: string;
}
export interface PreparedStorageObject {
    sourcePath: string;
    storedBytes: Buffer;
    contentHash: string;
    sourceHash: string;
    bytes: number;
    encrypted: boolean;
    encryptionKeyHash: string;
    metadata: string;
}
export interface StoredObjectResult {
    sourcePath: string;
    storedPath: string;
    contentHash: string;
    sourceHash: string;
    bytes: number;
    encrypted: boolean;
    encryptionKeyHash: string;
    metadata: string;
    registerAction: {
        contract: string;
        action: string;
        data: [string, string, number, boolean, string, string];
    };
}
export interface MarketServiceRow {
    id: number | string;
    provider: string;
    service_type: number | string;
    range_start?: number | string;
    range_end?: number | string;
    capacity_bytes?: number | string;
    active: boolean | number | string;
    last_heartbeat?: string;
    endpoint: string;
    metadata?: string;
}
export interface StorageObjectRow {
    id: number | string;
    owner: string;
    content_hash: string;
    bytes: number | string;
    encrypted: boolean | number | string;
    encryption_key_hash: string;
    required_replicas?: number | string;
    metadata?: string;
}
export interface StorageReplicaRow {
    id: number | string;
    object_id: number | string;
    provider: string;
    assigned_by?: string;
    active: boolean | number | string;
}
export interface StorageDownloadOptions {
    contentHash: string;
    output?: string;
    url?: string;
    marketContract?: string;
    storageContract?: string;
    expectedSha256?: string;
}
export interface StorageDownloadResult {
    content_hash: string;
    bytes: number;
    sha256: string;
    output?: string;
    provider: Pick<MarketServiceRow, 'provider' | 'endpoint'>;
}
export interface RouterUploadInput {
    router: Pick<MarketServiceRow, 'id' | 'provider' | 'endpoint'>;
    objectId: number;
    owner: string;
    contentHash: string;
    bytes: Buffer;
}
export interface RouterDistributionResult {
    ok?: boolean;
    content_hash?: string;
    object_id?: number;
    router?: string;
    selected_storage_providers?: string[];
    replica_count?: number;
    assignment_tx?: string;
    assignment_broadcast?: boolean;
    [key: string]: unknown;
}
export interface ReplicatedPutOptions extends AuthOptions {
    file: string;
    owner: string;
    metadata?: string;
    encrypt?: boolean;
    privateKey?: string;
    marketContract?: string;
    storageContract?: string;
    routerUrl?: string;
}
export interface WalrusPutOptions extends AuthOptions {
    file: string;
    owner: string;
    metadata?: string;
    encrypt?: boolean;
    privateKey?: string;
    storageContract?: string;
    walrusCommand?: string;
    walrusPublisherUrl?: string;
    walrusAggregatorUrl?: string;
    walrusEpochs?: string | number;
    contentFormat?: string;
}
export interface ReplicatedPutResult {
    sourcePath: string;
    content_hash: string;
    source_hash: string;
    bytes: number;
    encrypted: boolean;
    encryption_key_hash: string;
    object_id: number;
    put_tx?: string;
    router: Pick<MarketServiceRow, 'id' | 'provider' | 'endpoint'>;
    selected_storage_providers: string[];
    replica_count: number;
    assignment_tx?: string;
    distribution: RouterDistributionResult;
}
export interface WalrusStoreRefs {
    blob_id: string;
    sui_object_id?: string;
    publisher_url?: string;
    aggregator_url?: string;
    epochs?: number;
    content_format?: string;
    response: unknown;
}
export interface WalrusPutResult {
    sourcePath: string;
    content_hash: string;
    source_hash: string;
    bytes: number;
    encrypted: boolean;
    encryption_key_hash: string;
    object_id: number;
    put_tx?: string;
    metadata: string;
    walrus: WalrusStoreRefs;
}
export declare function sha256Bytes(bytes: Buffer | string): string;
export declare function parseWalrusStoreResponse(output: string, refs?: Omit<WalrusStoreRefs, 'blob_id' | 'response'>): WalrusStoreRefs;
export declare function buildWalrusMetadata(metadata: string, walrus: WalrusStoreRefs): string;
export declare function prepareStoredObject(options: Omit<StoreObjectOptions, 'root'>): Promise<PreparedStorageObject>;
export declare function storeObject(options: StoreObjectOptions): Promise<StoredObjectResult>;
export declare function selectBestRouter(services: MarketServiceRow[]): MarketServiceRow;
export declare function discoverBestRouter(options: {
    url?: string;
    marketContract: string;
}): Promise<MarketServiceRow>;
export declare function buildRouterUploadHeaders(input: Omit<RouterUploadInput, 'router'>): Record<string, string>;
export declare function uploadToRouter(input: RouterUploadInput): Promise<RouterDistributionResult>;
export declare function resolveStorageObjectId(options: {
    url?: string;
    storageContract: string;
    owner: string;
    contentHash: string;
}): Promise<number>;
export declare function resolveStorageObjectByHash(options: {
    url?: string;
    storageContract: string;
    contentHash: string;
}): Promise<StorageObjectRow>;
export declare function storageProvidersForReplicas(replicas: StorageReplicaRow[], services: MarketServiceRow[], objectId: number): Array<Pick<MarketServiceRow, 'provider' | 'endpoint'>>;
export declare function downloadStoredObjectBytes(options: Omit<StorageDownloadOptions, 'output'>): Promise<{
    bytes: Buffer;
    provider: Pick<MarketServiceRow, 'provider' | 'endpoint'>;
}>;
export declare function downloadStoredObject(options: StorageDownloadOptions): Promise<StorageDownloadResult>;
export declare function putReplicatedObject(options: ReplicatedPutOptions): Promise<ReplicatedPutResult>;
export declare function putWalrusObject(options: WalrusPutOptions): Promise<WalrusPutResult>;
export declare function distributeStoredObject(options: Omit<ReplicatedPutOptions, 'storageContract'> & {
    objectId: number;
    contentHash: string;
}): Promise<RouterDistributionResult>;
export declare function buildStorageManifest(root: string): Promise<{
    generatedAt: string;
    root: string;
    totalFiles: number;
    totalBytes: number;
    manifestHash: string;
    files: StorageManifestEntry[];
}>;
export declare function serveStorageManifest(root: string, port: number): http.Server;
