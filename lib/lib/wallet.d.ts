import { Bytes, PublicKey, Signature } from '@wharfkit/antelope';
import type { KeyMetadata, KeyType as StoredKeyType, StoredKey } from './keystore.js';
type PublicWalletKey = KeyMetadata & {
    storage: StoredKey['storage'] | 'legacy';
};
export interface AntelopeSigner {
    publicKey: PublicKey;
    sign(message: Bytes): Promise<Signature>;
}
export declare function walletPath(): string;
export declare function listWalletKeys(): Promise<PublicWalletKey[]>;
export declare function createWalletKey(name: string, type: StoredKeyType, storage?: StoredKey['storage']): Promise<PublicWalletKey>;
export declare function importWalletKey(name: string, input: Buffer, solana: boolean): Promise<PublicWalletKey>;
export declare function changeWalletKeyPassword(name: string): Promise<void>;
export declare function signSolanaMessage(seed: Buffer, message: Buffer): Buffer;
export declare function openSolanaSigner(name: string): Promise<{
    publicKey: string;
    sign(message: Buffer): Promise<Buffer>;
}>;
export declare function resolveAntelopeSigner(candidate: string | undefined, actor?: string): Promise<AntelopeSigner>;
export declare function openAntelopeWorkerSigner(name: string): Promise<AntelopeSigner & {
    close(): void;
}>;
export {};
