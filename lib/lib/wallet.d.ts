import { PrivateKey } from '@wharfkit/antelope';
export interface WalletKey {
    name: string;
    privateKey: string;
    publicKey: string;
}
export declare function walletPath(): string;
export declare function looksLikePrivateKey(value: string): boolean;
export declare function addWalletKey(name: string, privateKeyValue: string): Promise<WalletKey>;
export declare function listWalletKeys(): Promise<WalletKey[]>;
export declare function resolvePrivateKey(keyNameOrValue?: string, actor?: string): Promise<PrivateKey>;
