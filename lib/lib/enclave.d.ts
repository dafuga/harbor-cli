import { Bytes, PublicKey, Signature } from '@wharfkit/antelope';
export declare function enclaveAvailable(): Promise<boolean>;
export declare function createEnclaveKey(): Promise<{
    publicKey: string;
    wrapped: string;
}>;
export declare function signWithEnclave(wrapped: string, name: string, message: Bytes, key: PublicKey): Promise<Signature>;
