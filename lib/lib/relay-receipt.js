import { ABI, Asset, Checksum256, Name, PublicKey, Serializer, Signature } from '@wharfkit/antelope';
const domain = 'harbor.relay.delivery.v1';
const receiptAbi = ABI.from({
    version: 'eosio::abi/1.2',
    structs: [{
            name: 'receipt',
            base: '',
            fields: [
                { name: 'domain', type: 'string' },
                { name: 'chain_id', type: 'checksum256' },
                { name: 'contract', type: 'name' },
                { name: 'payer', type: 'name' },
                { name: 'provider', type: 'name' },
                { name: 'receipt_id', type: 'checksum256' },
                { name: 'ciphertext_hash', type: 'checksum256' },
                { name: 'bytes', type: 'uint32' },
                { name: 'charge', type: 'asset' },
                { name: 'expires_at', type: 'uint32' },
            ],
        }],
});
export function relayReceiptBytes(receipt) {
    for (const hash of [receipt.chain_id, receipt.receipt_id, receipt.ciphertext_hash]) {
        if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || /^0{64}$/.test(hash)) {
            throw new Error('relay receipt requires three nonzero canonical hashes');
        }
    }
    for (const account of [receipt.contract, receipt.provider, receipt.payer]) {
        if (typeof account !== 'string' || !account || String(Name.from(account)) !== account) {
            throw new Error('relay receipt accounts must be canonical Antelope names');
        }
    }
    if (receipt.payer === receipt.provider || receipt.provider === receipt.contract || receipt.payer === receipt.contract) {
        throw new Error('relay receipt payer, provider, and settlement contract must be distinct');
    }
    if (!Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || receipt.bytes > 16 * 1024 * 1024) {
        throw new Error('relay receipt byte count is outside the accepted range');
    }
    if (!Number.isSafeInteger(receipt.expires_at) || receipt.expires_at < 1 || receipt.expires_at > 0xffffffff) {
        throw new Error('relay receipt expiry must be Unix seconds');
    }
    if (typeof receipt.charge !== 'string' || Asset.from(receipt.charge).value <= 0) {
        throw new Error('relay receipt requires a positive charge');
    }
    return Serializer.encode({ abi: receiptAbi, type: 'receipt', object: { ...receipt, domain } });
}
export function verifyRelayReceipt(receipt, expectedKey, now = Date.now()) {
    const message = relayReceiptBytes(receipt);
    const key = PublicKey.from(expectedKey);
    if (!key.equals(PublicKey.from(receipt.receipt_key)))
        throw new Error('relay receipt recipient key mismatch');
    if (receipt.expires_at * 1000 <= now || receipt.expires_at * 1000 - now > 7 * 86400 * 1000) {
        throw new Error('relay receipt is expired or outside the seven-day validity window');
    }
    if (!Signature.from(receipt.signed_receipt).verifyDigest(Checksum256.hash(message), key)) {
        throw new Error('relay receipt signature does not match delivery and charge');
    }
}
