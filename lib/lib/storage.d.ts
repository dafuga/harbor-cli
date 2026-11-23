import http from 'node:http';
import type { AuthOptions } from './tx.js';
import { GovernedDataContext, VaultRecipient } from './vault-crypto.js';
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
    governed?: GovernedStorageEncryption;
    metadata?: string;
}
export interface GovernedStorageEncryption {
    recipientPublicKey: Buffer;
    context: GovernedDataContext;
    recipient: VaultRecipient;
    keyCustodians: string[];
    now?: number;
}
export interface PreparedStorageObject {
    sourcePath: string;
    storedBytes: Buffer;
    contentHash: string;
    sourceHash: string;
    bytes: number;
    encrypted: boolean;
    encryptionKeyHash: string;
    temporary: boolean;
    ttlSec?: number;
    expiresAt?: number;
    keyCustodians: string[];
    envelopeCommitment?: string;
    metadata: string;
}
export type PreparedUploadObject = Omit<PreparedStorageObject, 'storedBytes'> & {
    storedBytes?: Buffer;
    uploadPath: string;
};
export interface StoredObjectResult {
    sourcePath: string;
    storedPath: string;
    contentHash: string;
    sourceHash: string;
    bytes: number;
    encrypted: boolean;
    encryptionKeyHash: string;
    temporary: boolean;
    ttlSec?: number;
    expiresAt?: number;
    keyCustodians: string[];
    envelopeCommitment?: string;
    metadata: string;
    registerAction: {
        contract: string;
        action: string;
        data: unknown[];
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
export interface MarketProviderRow {
    owner: string;
    stake: string;
    active: boolean | number | string;
    metadata?: string;
}
export interface MarketServiceTypeRow {
    id: number | string;
    enabled: boolean | number | string;
    min_provider_stake: string;
    [key: string]: unknown;
}
export interface StorageObjectRow {
    id: number | string;
    owner: string;
    content_hash: string;
    bytes: number | string;
    encrypted: boolean | number | string;
    encryption_key_hash: string;
    required_replicas?: number | string;
    status: number | string;
    metadata?: string;
}
export interface StorageLifecycleRow {
    object_id: number | string;
    expires_at: number | string;
    tombstoned_at: number | string;
    completed_at: number | string;
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
    readReplica?: (url: URL) => Promise<{
        status: number;
        bytes: Buffer;
    }>;
}
export interface StorageDownloadResult {
    content_hash: string;
    bytes: number;
    sha256: string;
    output?: string;
    provider: Pick<MarketServiceRow, 'provider' | 'endpoint'>;
}
interface RouterUploadIdentity {
    router: Pick<MarketServiceRow, 'id' | 'provider' | 'endpoint'>;
    objectId: number | string;
    owner: string;
    contentHash: string;
    requiredReplicas: number | string;
    encrypted: boolean;
    encryptionKeyHash: string;
}
export type RouterUploadInput = RouterUploadIdentity & ({
    bytes: Buffer;
    file?: never;
    byteLength?: never;
} | {
    file: string;
    byteLength: number;
    bytes?: never;
});
export interface RouterDistributionResult {
    ok?: boolean;
    content_hash?: string;
    object_id?: string;
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
    governed?: GovernedStorageEncryption;
    preparedOutput?: string;
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
    governed?: GovernedStorageEncryption;
    preparedOutput?: string;
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
    temporary: boolean;
    expires_in_sec?: number;
    expires_at?: number;
    key_custodians: string[];
    envelope_commitment?: string;
    prepared_path?: string;
    object_id: string;
    put_tx?: string;
    route_authorization_tx?: string;
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
    temporary: boolean;
    expires_in_sec?: number;
    expires_at?: number;
    key_custodians: string[];
    envelope_commitment?: string;
    prepared_path?: string;
    object_id: string;
    put_tx?: string;
    metadata: string;
    walrus: WalrusStoreRefs;
}
export declare function hashFile(filePath: string): Promise<string>;
export declare function storageRegistrationAction(owner: string, prepared: Omit<PreparedStorageObject, 'storedBytes'>, metadata?: string): {
    action: 'putobject' | 'puttempat';
    data: Record<string, unknown>;
};
export declare function sha256Bytes(bytes: Buffer | string): string;
export declare function parseWalrusStoreResponse(output: string, refs?: Omit<WalrusStoreRefs, 'blob_id' | 'response'>): WalrusStoreRefs;
export declare function buildWalrusMetadata(metadata: string, walrus: WalrusStoreRefs): string;
export declare function prepareStoredObject(options: Omit<StoreObjectOptions, 'root'>): Promise<PreparedStorageObject>;
export declare function prepareObjectForUpload(options: Omit<StoreObjectOptions, 'root'> & {
    preparedOutput?: string;
}): Promise<{
    prepared: PreparedUploadObject;
    preparedPath?: string;
}>;
export declare function persistPreparedStorageObject(prepared: PreparedStorageObject, output?: string): Promise<string | undefined>;
export declare function storeObject(options: StoreObjectOptions): Promise<StoredObjectResult>;
export declare function filterEligibleMarketServices(services: MarketServiceRow[], providers: MarketProviderRow[], serviceTypes: MarketServiceTypeRow[]): MarketServiceRow[];
export declare function requireDownloadableStorageObject(object: StorageObjectRow, lifecycle?: StorageLifecycleRow, nowEpochSec?: number): void;
export declare function selectBestRouter(services: MarketServiceRow[]): MarketServiceRow;
export declare function discoverBestRouter(options: {
    url?: string;
    marketContract: string;
}): Promise<MarketServiceRow>;
export declare function discoverRouterAtEndpoint(options: {
    url?: string;
    marketContract: string;
    endpoint: string;
}): Promise<MarketServiceRow>;
export declare function buildRouterUploadHeaders(input: Omit<RouterUploadInput, 'router'>): Record<string, string>;
export declare function uploadToRouter(input: RouterUploadInput): Promise<RouterDistributionResult>;
export declare function resolveStorageObjectId(options: {
    url?: string;
    storageContract: string;
    owner: string;
    contentHash: string;
    minimumIdInclusive: string;
    maximumIdExclusive?: string;
    transactionResult?: unknown;
    action: 'putobject' | 'puttempat';
}): Promise<string>;
export declare function storageObjectsByHash(options: {
    url?: string;
    storageContract: string;
    contentHash: string;
}): Promise<StorageObjectRow[]>;
export declare function resolveStorageObjectByHash(options: {
    url?: string;
    storageContract: string;
    contentHash: string;
}): Promise<StorageObjectRow>;
export declare function storageProvidersForReplicas(replicas: StorageReplicaRow[], services: MarketServiceRow[], objectId: number | string, providers: MarketProviderRow[], serviceTypes: MarketServiceTypeRow[]): Array<Pick<MarketServiceRow, 'provider' | 'endpoint'>>;
export declare function downloadStoredObjectBytes(options: Omit<StorageDownloadOptions, 'output'>): Promise<{
    bytes: Buffer;
    provider: Pick<MarketServiceRow, 'provider' | 'endpoint'>;
}>;
export declare function downloadStoredObject(options: StorageDownloadOptions): Promise<StorageDownloadResult>;
export declare function putReplicatedObject(options: ReplicatedPutOptions): Promise<ReplicatedPutResult>;
export declare function putWalrusObject(options: WalrusPutOptions): Promise<WalrusPutResult>;
export declare function distributeStoredObject(options: ReplicatedPutOptions & {
    objectId: number | string;
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
export {};
