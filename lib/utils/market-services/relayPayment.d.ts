import type { SignedRelayReceipt } from './relayReceipt.types.js';
import type { RelayPaymentOptions } from './relayPayment.types.js';
/** Example: a signed 0.1000 HRBR receipt records and transfers exactly 0.1000 HRBR atomically. */
export declare function relayPayment(receipt: SignedRelayReceipt, options: RelayPaymentOptions): Promise<{
    transaction_id: string | undefined;
    status: string | undefined;
    response: {
        transaction_id?: string;
        processed?: {
            receipt?: {
                status?: string;
            };
        };
    } | undefined;
}>;
