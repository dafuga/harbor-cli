import { Bytes, PublicKey, Signature } from '@wharfkit/antelope';
type AntelopeKeyType = 'K1' | 'R1';
export declare function generateAntelopeSecret(type: AntelopeKeyType): Buffer;
export declare function antelopePublicKey(type: AntelopeKeyType, secret: Buffer): PublicKey;
export declare function recoverableR1Signature(raw: Buffer, message: Bytes, key: PublicKey): Signature;
export declare function signAntelopeMessage(type: AntelopeKeyType, secret: Buffer, message: Bytes, key: PublicKey): Signature;
export {};
