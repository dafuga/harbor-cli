export type KeyType = 'K1' | 'R1' | 'ed25519';
export type KeyMetadata = {
    name: string;
    type: KeyType;
    publicKey: string;
};
type EncryptedKey = KeyMetadata & {
    version: 1;
    storage: 'encrypted';
    salt: string;
    nonce: string;
    ciphertext: string;
    tag: string;
};
type EnclaveKey = KeyMetadata & {
    version: 1;
    storage: 'enclave';
    wrapped: string;
};
export type StoredKey = EncryptedKey | EnclaveKey;
export declare function isRawAntelopeKey(value: string): boolean;
export declare function keyName(name: string): string;
export declare function encryptKey(metadata: KeyMetadata, secret: Buffer, password: Buffer): Promise<EncryptedKey>;
export declare function decryptKey(record: EncryptedKey, password: Buffer): Promise<Buffer>;
export declare function readStoredKey(name: string): Promise<StoredKey | undefined>;
export declare function listStoredKeys(): Promise<StoredKey[]>;
export declare function storeKey(record: StoredKey): Promise<void>;
export {};
