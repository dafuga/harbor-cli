import http from 'node:http';
export interface StorageManifestEntry {
    path: string;
    bytes: number;
    sha256: string;
}
export declare function buildStorageManifest(root: string): Promise<{
    generatedAt: string;
    root: string;
    totalFiles: number;
    totalBytes: number;
    manifestHash: string;
    files: StorageManifestEntry[];
}>;
export declare function serveStorageManifest(root: string, port: number): http.Server;
