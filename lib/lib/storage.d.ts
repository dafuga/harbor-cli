import http from 'node:http';
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
export declare function storeObject(options: StoreObjectOptions): Promise<StoredObjectResult>;
export declare function buildStorageManifest(root: string): Promise<{
    generatedAt: string;
    root: string;
    totalFiles: number;
    totalBytes: number;
    manifestHash: string;
    files: StorageManifestEntry[];
}>;
export declare function serveStorageManifest(root: string, port: number): http.Server;
