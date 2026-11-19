// @harness-uid u_q4zbame5nv
import { permissionLevel, serializeAction, transactActions } from '../../lib/tx.js';
import { reviewTransaction } from '../../lib/terminal-ui.js';
import { verifyRelayReceipt } from './relayReceipt.js';
/** Example: a signed 0.1000 HRBR receipt records and transfers exactly 0.1000 HRBR atomically. */
export async function relayPayment(receipt, options) {
    const signer = permissionLevel(options);
    if (!options.expectChainId || options.expectChainId.toLowerCase() !== receipt.chain_id) {
        throw new TypeError('--expect-chain-id must match the signed relay receipt');
    }
    if (receipt.contract !== options.relayContract || receipt.payer !== signer.actor || options.auth) {
        throw new TypeError('the relay contract and signing payer must match the signed receipt');
    }
    verifyRelayReceipt(receipt, options.recipientKey);
    const { chain_id, contract, ...data } = receipt;
    const actions = await Promise.all([
        serializeAction({ ...options, contract, action: 'record', data }),
        serializeAction({ ...options, contract: 'eosio.token', action: 'transfer', data: {
                from: receipt.payer, to: contract, quantity: receipt.charge, memo: `relay:${receipt.receipt_id}`,
            } }),
    ]);
    return transactActions(options, actions, () => reviewTransaction({
        chain: chain_id, settlement: contract, payer: receipt.payer, provider: receipt.provider,
        delivery: receipt.receipt_id, bytes: receipt.bytes, charge: receipt.charge, expires_at: receipt.expires_at,
    }, options.yes));
}
