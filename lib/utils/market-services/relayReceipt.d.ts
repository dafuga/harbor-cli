import type { Bytes } from '@wharfkit/antelope';
import type { RelayReceipt, SignedRelayReceipt } from './relayReceipt.types.js';
export declare function relayReceipt(receipt: RelayReceipt): Bytes;
export declare function verifyRelayReceipt(receipt: SignedRelayReceipt, expectedKey: string, now?: number): void;
