import { Command } from 'commander';
import { VaultEnvelope } from '../lib/vault-crypto.js';
import type { RouterDistributionResult, StorageLifecycleRow, StorageObjectRow } from '../lib/storage.js';
export declare function randomGrantId(): string;
export declare function canonicalGrantId(value: unknown): string;
export interface GrantAuthorizationSnapshot {
    grant: Record<string, unknown>;
    receipt: Record<string, unknown>;
    consent: Record<string, unknown>;
    uses: number;
    maxUses: number;
}
export declare function verifyGrantedEnvelopeOnChain(input: {
    envelope: VaultEnvelope;
    grantId: string;
    processor: string;
    vaultContract: string;
    url?: string;
    now: number;
    mode?: 'available' | 'consumed';
}): Promise<GrantAuthorizationSnapshot>;
export interface VaultGrantUseRecord {
    format: 'harbor.vault-grant-use.v1';
    grant_id: string;
    processor: string;
    envelope_commitment: string;
    nonce: string;
    use_hash: string;
}
export declare function parseGrantUseRecord(value: string, binding: {
    grantId: string;
    processor: string;
    envelopeCommitment: string;
}): VaultGrantUseRecord;
export declare function createGrantUseRecord(binding: {
    grantId: string;
    processor: string;
    envelopeCommitment: string;
}): VaultGrantUseRecord;
export declare function verifyConsumedGrantUseOnChain(input: {
    envelope: VaultEnvelope;
    grantId: string;
    processor: string;
    useHash: string;
    vaultContract: string;
    url?: string;
    now: number;
    expectedPreviousUses?: number;
}): Promise<{
    use: Record<string, unknown>;
    authorization: GrantAuthorizationSnapshot;
}>;
export declare function consumeGrantUseOnChain(input: {
    envelope: VaultEnvelope;
    grantId: string;
    processor: string;
    useHash: string;
    vaultContract: string;
    url?: string;
    now: number;
    actor?: string;
    permission?: string;
    key?: string;
    expiration?: string;
    pushUse?: () => Promise<unknown>;
    verifyAuthorization?: (authorization: GrantAuthorizationSnapshot) => Promise<void>;
}): Promise<{
    resumed: boolean;
    transaction?: unknown;
    use: Record<string, unknown>;
}>;
export declare function verifyCustodySourceOnChain(input: {
    envelope: VaultEnvelope;
    receiptId: string;
    custodian: string;
    vaultContract: string;
    url?: string;
    now: number;
}): Promise<void>;
export declare function verifyRetainedRewrap(input: {
    source: VaultEnvelope;
    retained: VaultEnvelope;
    grantId: string;
    processor: string;
    nextKeyId: string;
    nextKeyHash: string;
}): void;
export declare function verifyRewrapAttestationRow(input: {
    row: Record<string, unknown>;
    receiptId: string;
    grantId: string;
    custodian: string;
    processor: string;
    sourceCiphertextCommitment: string;
    wrappedKeyCommitment: string;
    accessEnvelopeCommitment: string;
    expiresAt: number;
}): void;
export declare function verifyRegisteredGrantRow(input: {
    row: Record<string, unknown>;
    receiptId: string;
    grantId: string;
    grantor: string;
    custodian: string;
    processor: string;
    purposeHash: string;
    sourceCiphertextCommitment: string;
    wrappedKeyCommitment: string;
    accessEnvelopeCommitment: string;
    expiresAt: number;
    maxUses: number;
    requiredTransformHash: string;
    derivativeMode: number;
    derivativePolicyId: string;
    derivativePolicyHash: string;
}): void;
export interface AccessEnvelopeStorageBinding {
    vaultContract: string;
    receiptId: string;
    grantId: string;
    processor: string;
    accessEnvelopeCommitment: string;
    sourceCiphertextCommitment: string;
}
export declare function accessEnvelopeStorageMetadata(input: AccessEnvelopeStorageBinding): string;
export declare function verifyAccessEnvelopeStorageObject(input: {
    object: StorageObjectRow;
    lifecycle: StorageLifecycleRow;
    keyCustodians: Array<Record<string, unknown>>;
    objectId: string;
    processor: string;
    contentHash: string;
    bytes: number;
    encryptionKeyHash: string;
    expiresAt: number;
    metadata: string;
}): void;
export interface PersistedAccessEnvelopeResult {
    object_id: string;
    content_hash: string;
    metadata: string;
    registration_resumed: boolean;
    put_tx?: string;
    distribution: RouterDistributionResult;
}
export declare function persistAccessEnvelopeObject(input: AccessEnvelopeStorageBinding & {
    file: string;
    bytes: Buffer;
    encryptionKeyHash: string;
    expiresAt: number;
    storageContract: string;
    marketContract: string;
    processorSigningKey: string;
    routerUrl?: string;
    url?: string;
    permission?: string;
    expiration?: string;
    json?: boolean;
}): Promise<PersistedAccessEnvelopeResult>;
export declare function verifyAccessEnvelopeObjectOnChain(input: {
    envelope: VaultEnvelope;
    authorization: GrantAuthorizationSnapshot;
    grantId: string;
    processor: string;
    vaultContract: string;
    storageContract: string;
    objectId: string;
    url?: string;
}): Promise<void>;
export declare function readVaultPrivateKeyFile(file: string): Promise<Buffer>;
export declare function createVaultCommand(): Command;
