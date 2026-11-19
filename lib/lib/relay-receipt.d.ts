import type { Bytes } from '@wharfkit/antelope';
export interface RelayReceipt {
    chain_id: string;
    contract: string;
    payer: string;
    provider: string;
    receipt_id: string;
    ciphertext_hash: string;
    bytes: number;
    charge: string;
    expires_at: number;
}
export interface SignedRelayReceipt extends RelayReceipt {
    receipt_key: string;
    signed_receipt: string;
}
export declare function relayReceiptBytes(receipt: RelayReceipt): Bytes;
export declare function verifyRelayReceipt(receipt: SignedRelayReceipt, expectedKey: string, now?: number): void;
