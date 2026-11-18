import { Command } from 'commander';
import { openSolanaSigner } from '../lib/wallet.js';
export declare function signSolanaTransaction(bytes: Buffer, signer: Awaited<ReturnType<typeof openSolanaSigner>>): Promise<Buffer<ArrayBuffer>>;
export declare function createSolanaCommand(): Command;
