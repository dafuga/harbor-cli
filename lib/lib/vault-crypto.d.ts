declare const ENVELOPE_FORMAT: "harbor.governed-data-envelope.v1";
declare const ENVELOPE_JSON_FORMAT: "harbor.governed-data-envelope-json.v1";
declare const CIPHER_SUITE: "xchacha20poly1305-ietf+curve25519-sealedbox";
declare const PUBLIC_KEY_FORMAT: "harbor.governed-data-public-key.v1";
declare const PRIVATE_KEY_FORMAT: "harbor.governed-data-private-key.v1";
declare const KEY_ALGORITHM: "curve25519-sealedbox";
export declare const MAX_GOVERNED_CIPHERTEXT_BYTES: number;
export declare const MAX_GOVERNED_PLAINTEXT_BYTES: number;
export declare const MAX_GOVERNED_JSON_CANONICAL_BYTES: number;
export interface VaultKeyPair {
    algorithm: typeof KEY_ALGORITHM;
    publicKey: Buffer;
    privateKey: Buffer;
    publicKeyHash: string;
}
export interface VaultPublicKeyFile {
    format: typeof PUBLIC_KEY_FORMAT;
    algorithm: typeof KEY_ALGORITHM;
    key_id: string;
    public_key: string;
    public_key_commitment: string;
}
export interface VaultPrivateKeyFile {
    format: typeof PRIVATE_KEY_FORMAT;
    algorithm: typeof KEY_ALGORITHM;
    key_id: string;
    public_key: string;
    public_key_commitment: string;
    private_key: string;
}
export interface GovernedDataContext {
    policy_id: string;
    consent_id: string;
    receipt_id: string;
    object_id: string;
    purpose: string;
    created_at: number;
    expires_at: number;
}
export interface VaultRecipient {
    grant_id: string;
    processor: string;
    key_id: string;
}
export interface VaultEnvelope {
    format: typeof ENVELOPE_FORMAT;
    cipher_suite: typeof CIPHER_SUITE;
    context: GovernedDataContext;
    recipient_grant_id: string;
    recipient_processor: string;
    recipient_key_id: string;
    recipient_key_commitment: string;
    associated_data_commitment: string;
    wrapped_dek_commitment: string;
    ciphertext_commitment: string;
    nonce: Buffer;
    wrapped_dek: Buffer;
    ciphertext: Buffer;
}
export interface VaultEnvelopeJson {
    format: typeof ENVELOPE_JSON_FORMAT;
    canonical_hex: string;
    envelope_commitment: string;
}
export declare function canonicalVaultEnvelopeBytes(envelope: VaultEnvelope): Buffer;
export declare function vaultEnvelopeFromCanonicalBytes(bytes: Buffer): VaultEnvelope;
export declare function vaultEnvelopeToJson(envelope: VaultEnvelope): string;
export declare function vaultEnvelopeFromJson(value: string): VaultEnvelope;
/**
 * Return the deterministic persisted HGD1 representation. Existing, smaller
 * envelopes retain the canonical JSON wrapper; larger envelopes use the same
 * canonical HGD1 bytes directly to avoid the JSON hex string ceiling.
 */
export declare function vaultEnvelopeToBytes(envelope: VaultEnvelope): Buffer;
/** Read either the original canonical JSON wrapper or canonical binary HGD1. */
export declare function vaultEnvelopeFromBytes(value: Buffer): VaultEnvelope;
export declare function parseVaultPublicKey(value: string | Buffer): {
    keyId: string;
    publicKey: Buffer;
    publicKeyHash: string;
};
export declare function parseVaultPrivateKey(value: string | Buffer): {
    keyId: string;
    publicKey: Buffer;
    privateKey: Buffer;
    publicKeyHash: string;
};
export declare function vaultPublicKeyToJson(pair: VaultKeyPair, keyId: string): string;
export declare function vaultPrivateKeyToJson(pair: VaultKeyPair, keyId: string): string;
export declare function generateVaultKeyPair(): VaultKeyPair;
export declare function encryptVaultBytes(plaintext: Buffer, recipientPublicKey: Buffer, context: GovernedDataContext, recipient: VaultRecipient, now?: number): VaultEnvelope;
export declare function decryptVaultBytes(envelope: VaultEnvelope, recipientPublicKey: Buffer, recipientPrivateKey: Buffer, now?: number): Buffer;
export declare function rewrapVaultEnvelope(envelope: VaultEnvelope, currentPublicKey: Buffer, currentPrivateKey: Buffer, nextPublicKey: Buffer, nextRecipient: VaultRecipient, now?: number): VaultEnvelope;
export declare function vaultEnvelopeCommitment(envelope: VaultEnvelope): string;
export declare function vaultAssociatedDataCommitment(context: GovernedDataContext): string;
export declare function requireInitialCustodyEnvelope(envelope: VaultEnvelope): void;
export {};
