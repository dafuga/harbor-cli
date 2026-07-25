import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildActionData } from './action-fields.js';
import { accessEnvelopeStorageMetadata, canonicalGrantId, consumeGrantUseOnChain, createGrantUseRecord, createVaultCommand, parseGrantUseRecord, randomGrantId, readVaultPrivateKeyFile, verifyCustodySourceOnChain, verifyAccessEnvelopeStorageObject, verifyGrantedEnvelopeOnChain, verifyRegisteredGrantRow, verifyRetainedRewrap, verifyRewrapAttestationRow, } from './vault.js';
import { encryptVaultBytes, generateVaultKeyPair, rewrapVaultEnvelope, vaultEnvelopeCommitment, vaultEnvelopeToJson } from '../lib/vault-crypto.js';
async function listen(server) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
}
test('vault contract commands preserve ABI argument order', () => {
    const vault = createVaultCommand();
    const args = (command) => vault.commands
        .find((candidate) => candidate.name() === command)?.registeredArguments
        .map((argument) => argument.name());
    assert.deepEqual(args('create-policy'), [
        'controller', 'manifest_hash', 'keyset_hash', 'max_retention_sec',
        'delete_quorum', 'key_quorum', 'review_quorum', 'metadata',
    ]);
    assert.deepEqual(args('add-policy-version'), [
        'controller', 'policy_id', 'manifest_hash', 'keyset_hash', 'max_retention_sec',
        'delete_quorum', 'key_quorum', 'review_quorum', 'metadata',
    ]);
    assert.deepEqual(args('put-receipt'), [
        'subject', 'collector', 'consent_id', 'storage_contract', 'storage_object_id',
        'ciphertext_hash', 'wrapped_key_hash', 'payload_ciphertext_commitment',
        'bytes', 'retention_until', 'metadata_hash',
    ]);
    assert.deepEqual(args('attest-rewrap'), [
        'custodian', 'receipt_id', 'grant_id', 'processor', 'source_ciphertext_commitment',
        'wrapped_key_commitment', 'access_envelope_commitment', 'expires_at',
    ]);
    assert.deepEqual(args('expire-rewrap'), ['actor', 'grant_id']);
    assert.deepEqual(args('grant-access'), [
        'grantor', 'receipt_id', 'grant_id', 'processor', 'purpose_hash', 'expires_at', 'max_uses',
        'required_transform_hash', 'derivative_mode', 'derivative_policy_id',
        'derivative_policy_hash', 'wrapped_key_commitment', 'source_ciphertext_commitment',
        'access_envelope_commitment',
    ]);
    assert.deepEqual(args('put-derived'), [
        'processor', 'use_id', 'output_consent_id', 'storage_contract', 'storage_object_id',
        'ciphertext_hash', 'wrapped_key_hash', 'payload_ciphertext_commitment',
        'bytes', 'retention_until', 'recipe_hash',
        'attestation_hash', 'metadata_hash',
    ]);
    assert.deepEqual(args('add-lineage'), [
        'processor', 'output_receipt_id', 'use_id', 'attestation_hash',
    ]);
});
test('HGR1 temporary storage metadata and lifecycle preserve uint64 ids losslessly', () => {
    const objectId = '9007199254740993';
    const receiptId = '9007199254740994';
    const grantId = '9007199254740995';
    const contentHash = 'a'.repeat(64);
    const encryptionKeyHash = 'b'.repeat(64);
    const metadata = accessEnvelopeStorageMetadata({
        vaultContract: 'harborvault',
        receiptId,
        grantId,
        processor: 'trainer',
        accessEnvelopeCommitment: 'c'.repeat(64),
        sourceCiphertextCommitment: 'd'.repeat(64),
    });
    assert.equal(JSON.parse(metadata).receipt_id, receiptId);
    assert.equal(JSON.parse(metadata).grant_id, grantId);
    assert.ok(Buffer.byteLength(metadata) <= 256);
    assert.notEqual(metadata, accessEnvelopeStorageMetadata({
        vaultContract: 'harborvault',
        receiptId,
        grantId,
        processor: 'trainer',
        accessEnvelopeCommitment: 'e'.repeat(64),
        sourceCiphertextCommitment: 'd'.repeat(64),
    }));
    assert.doesNotThrow(() => verifyAccessEnvelopeStorageObject({
        object: {
            id: objectId,
            owner: 'trainer',
            content_hash: contentHash,
            bytes: '123',
            encrypted: true,
            encryption_key_hash: encryptionKeyHash,
            status: 1,
            metadata,
        },
        lifecycle: {
            object_id: objectId,
            expires_at: 2_000,
            tombstoned_at: 0,
            completed_at: 0,
        },
        keyCustodians: [{ custodian: 'trainer' }],
        objectId,
        processor: 'trainer',
        contentHash,
        bytes: 123,
        encryptionKeyHash,
        expiresAt: 2_000,
        metadata,
    }));
});
test('random grant ids are canonical nonzero uint64 strings', () => {
    const ids = new Set(Array.from({ length: 32 }, () => randomGrantId()));
    assert.equal(ids.size, 32);
    for (const id of ids) {
        assert.match(id, /^\d+$/);
        assert.ok(BigInt(id) > 0n);
        assert.ok(BigInt(id) < (1n << 64n) - 1n);
    }
    assert.throws(() => canonicalGrantId('0'), /greater than 0/);
    assert.throws(() => canonicalGrantId('18446744073709551615'), /less than UINT64_MAX/);
});
test('grant-use recovery records are canonical and bound to one envelope authorization', () => {
    const binding = { grantId: '11', processor: 'trainer', envelopeCommitment: 'a'.repeat(64) };
    const record = createGrantUseRecord(binding);
    const serialized = `${JSON.stringify(record)}\n`;
    assert.deepEqual(parseGrantUseRecord(serialized, binding), record);
    assert.throws(() => parseGrantUseRecord(serialized, { ...binding, grantId: '12' }), /does not match this exact authorization/);
    assert.throws(() => parseGrantUseRecord(serialized.trim(), binding), /not canonical/);
});
test('retained HGR1 and completed chain steps resume only on exact workflow bindings', () => {
    const custodyKey = generateVaultKeyPair();
    const processorKey = generateVaultKeyPair();
    try {
        const source = encryptVaultBytes(Buffer.from('private'), custodyKey.publicKey, {
            policy_id: '7', consent_id: '8', receipt_id: '', object_id: '', purpose: 'review',
            created_at: 900, expires_at: 2_000,
        }, { grant_id: '', processor: '', key_id: 'custody-key' }, 1_000);
        const retained = rewrapVaultEnvelope(source, custodyKey.publicKey, custodyKey.privateKey, processorKey.publicKey, { grant_id: '11', processor: 'trainer', key_id: 'processor-key' }, 1_000);
        assert.doesNotThrow(() => verifyRetainedRewrap({
            source, retained, grantId: '11', processor: 'trainer', nextKeyId: 'processor-key',
            nextKeyHash: processorKey.publicKeyHash,
        }));
        assert.throws(() => verifyRetainedRewrap({
            source, retained, grantId: '12', processor: 'trainer', nextKeyId: 'processor-key',
            nextKeyHash: processorKey.publicKeyHash,
        }), /does not match the exact source/);
        const envelopeCommitment = vaultEnvelopeCommitment(retained);
        const purposeHash = crypto.createHash('sha256').update('review').digest('hex');
        assert.doesNotThrow(() => verifyRewrapAttestationRow({
            row: {
                grant_id: '11', receipt_id: '9', custodian: 'trustee', processor: 'trainer',
                source_ciphertext_commitment: source.ciphertext_commitment,
                wrapped_key_commitment: retained.wrapped_dek_commitment,
                access_envelope_commitment: envelopeCommitment, expires_at: 1_500,
            },
            receiptId: '9', grantId: '11', custodian: 'trustee', processor: 'trainer',
            sourceCiphertextCommitment: source.ciphertext_commitment,
            wrappedKeyCommitment: retained.wrapped_dek_commitment,
            accessEnvelopeCommitment: envelopeCommitment, expiresAt: 1_500,
        }));
        const grantWorkflow = {
            receiptId: '9', grantId: '11', grantor: 'alice', custodian: 'trustee', processor: 'trainer',
            purposeHash, sourceCiphertextCommitment: source.ciphertext_commitment,
            wrappedKeyCommitment: retained.wrapped_dek_commitment,
            accessEnvelopeCommitment: envelopeCommitment, expiresAt: 1_500, maxUses: 1,
            requiredTransformHash: '0'.repeat(64), derivativeMode: 0, derivativePolicyId: '0',
            derivativePolicyHash: '0'.repeat(64),
        };
        assert.doesNotThrow(() => verifyRegisteredGrantRow({
            row: {
                id: '11', receipt_id: '9', grantor: 'alice', rewrap_custodian: 'trustee', processor: 'trainer',
                purpose_hash: purposeHash, source_ciphertext_commitment: source.ciphertext_commitment,
                wrapped_key_commitment: retained.wrapped_dek_commitment,
                access_envelope_commitment: envelopeCommitment, expires_at: 1_500, max_uses: 1,
                required_transform_hash: '0'.repeat(64), derivative_mode: 0, derivative_policy_id: '0',
                derivative_policy_hash: '0'.repeat(64),
            },
            ...grantWorkflow,
        }));
        assert.throws(() => verifyRegisteredGrantRow({
            row: {
                id: '11', receipt_id: '9', grantor: 'alice', rewrap_custodian: 'trustee', processor: 'trainer',
                purpose_hash: purposeHash, source_ciphertext_commitment: source.ciphertext_commitment,
                wrapped_key_commitment: retained.wrapped_dek_commitment,
                access_envelope_commitment: 'f'.repeat(64), expires_at: 1_500, max_uses: 1,
                required_transform_hash: '0'.repeat(64), derivative_mode: 0, derivative_policy_id: '0',
                derivative_policy_hash: '0'.repeat(64),
            },
            ...grantWorkflow,
        }), /does not match the retained HGR1 workflow/);
    }
    finally {
        custodyKey.privateKey.fill(0);
        processorKey.privateKey.fill(0);
    }
});
test('uint64 action fields preserve ids beyond JavaScript safe integers', () => {
    assert.deepEqual(buildActionData([['grant_id', 'uint64']], ['18446744073709551615']), {
        grant_id: '18446744073709551615',
    });
});
test('custody and processor authorization use live receipt, grant, consent, storage, and key-custodian rows', async () => {
    const custodyKey = generateVaultKeyPair();
    const processorKey = generateVaultKeyPair();
    const purpose = 'review';
    const purposeHash = crypto.createHash('sha256').update(purpose).digest('hex');
    const custody = encryptVaultBytes(Buffer.from('private'), custodyKey.publicKey, {
        policy_id: '7', consent_id: '8', receipt_id: '', object_id: '', purpose,
        created_at: 900, expires_at: 2_000,
    }, { grant_id: '', processor: '', key_id: 'custody-key' }, 1_000);
    const contentHash = crypto.createHash('sha256').update(vaultEnvelopeToJson(custody), 'utf8').digest('hex');
    const granted = rewrapVaultEnvelope(custody, custodyKey.publicKey, custodyKey.privateKey, processorKey.publicKey, { grant_id: '11', processor: 'trainer', key_id: 'processor-key' }, 1_000);
    const rows = {
        grants: {
            id: '11', policy_id: '7', consent_id: '8', receipt_id: '9', processor: 'trainer',
            purpose_hash: purposeHash, expires_at: 1_500, max_uses: 1, uses: 0,
            rewrap_custodian: 'trustee', source_storage_contract: 'harborstore',
            source_storage_object_id: '10', source_storage_content_hash: contentHash,
            source_ciphertext_commitment: custody.ciphertext_commitment,
            wrapped_key_commitment: granted.wrapped_dek_commitment,
            access_envelope_commitment: vaultEnvelopeCommitment(granted), status: 1,
        },
        receipts: {
            id: '9', policy_id: '7', consent_id: '8', submitter: 'collector',
            storage_contract: 'harborstore', storage_object_id: '10', ciphertext_hash: contentHash,
            wrapped_key_hash: custody.recipient_key_commitment,
            payload_ciphertext_commitment: custody.ciphertext_commitment,
            status: 1, retention_until: 2_000,
        },
        consents: { id: '8', policy_id: '7', purpose_hash: purposeHash, status: 1, expires_at: 2_000 },
        objects: {
            id: '10', owner: 'collector', content_hash: contentHash,
            encryption_key_hash: custody.recipient_key_commitment, status: 1,
        },
        lifecycles: { object_id: '10', expires_at: 2_000, tombstoned_at: 0, completed_at: 0 },
        keycusts: { custodian: 'trustee' },
    };
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ rows: rows[body.table] ? [rows[body.table]] : [], more: false }));
        });
    });
    try {
        const url = await listen(server);
        await assert.doesNotReject(() => verifyCustodySourceOnChain({
            envelope: custody, receiptId: '9', custodian: 'trustee',
            vaultContract: 'harborvault', url, now: 1_000,
        }));
        const substituted = encryptVaultBytes(Buffer.from('other'), custodyKey.publicKey, custody.context, {
            grant_id: '', processor: '', key_id: 'custody-key',
        }, 1_000);
        await assert.rejects(() => verifyCustodySourceOnChain({
            envelope: substituted, receiptId: '9', custodian: 'trustee',
            vaultContract: 'harborvault', url, now: 1_000,
        }), /not accepted, live, or bound/);
        await assert.doesNotReject(() => verifyGrantedEnvelopeOnChain({
            envelope: granted, grantId: '11', processor: 'trainer',
            vaultContract: 'harborvault', url, now: 1_000,
        }));
        await assert.rejects(() => verifyGrantedEnvelopeOnChain({
            envelope: { ...granted, wrapped_dek_commitment: '0'.repeat(64) },
            grantId: '11', processor: 'trainer', vaultContract: 'harborvault', url, now: 1_000,
        }), /does not bind this processor HGR1 wrap/);
        rows.grants.source_ciphertext_commitment = '0'.repeat(64);
        await assert.rejects(() => verifyGrantedEnvelopeOnChain({
            envelope: granted, grantId: '11', processor: 'trainer',
            vaultContract: 'harborvault', url, now: 1_000,
        }), /does not bind this HGR1 to the admitted receipt ciphertext/);
        rows.grants.source_ciphertext_commitment = custody.ciphertext_commitment;
        const useRecord = createGrantUseRecord({
            grantId: '11', processor: 'trainer', envelopeCommitment: vaultEnvelopeCommitment(granted),
        });
        let pushes = 0;
        let accessChecks = 0;
        const consumed = await consumeGrantUseOnChain({
            envelope: granted,
            grantId: '11',
            processor: 'trainer',
            useHash: useRecord.use_hash,
            vaultContract: 'harborvault',
            url,
            now: 1_000,
            verifyAuthorization: async () => { accessChecks += 1; },
            pushUse: async () => {
                pushes += 1;
                rows.grants.uses = 1;
                rows.grants.status = 3;
                rows.grantuses = {
                    id: '21', grant_id: '11', receipt_id: '9', processor: 'trainer',
                    purpose_hash: purposeHash, use_hash: useRecord.use_hash, used_at: 1_000,
                };
                return { transaction_id: 'consume-once' };
            },
        });
        assert.equal(consumed.resumed, false);
        assert.equal(pushes, 1);
        assert.equal(accessChecks, 2);
        const resumed = await consumeGrantUseOnChain({
            envelope: granted,
            grantId: '11',
            processor: 'trainer',
            useHash: useRecord.use_hash,
            vaultContract: 'harborvault',
            url,
            now: 1_000,
            verifyAuthorization: async () => { accessChecks += 1; },
            pushUse: async () => {
                pushes += 1;
                throw new Error('must not push a second use');
            },
        });
        assert.equal(resumed.resumed, true);
        assert.equal(pushes, 1);
        assert.equal(accessChecks, 3);
    }
    finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        custodyKey.privateKey.fill(0);
        processorKey.privateKey.fill(0);
    }
});
test('private key reads reject permissive modes, symlinks, and hard links', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-vault-key-'));
    const privateKey = path.join(directory, 'private.json');
    const symlink = path.join(directory, 'private-link.json');
    const hardLink = path.join(directory, 'private-hard.json');
    try {
        await fs.writeFile(privateKey, '{"private":true}', { mode: 0o600 });
        assert.equal((await readVaultPrivateKeyFile(privateKey)).toString(), '{"private":true}');
        await fs.chmod(privateKey, 0o644);
        await assert.rejects(() => readVaultPrivateKeyFile(privateKey), /permissions/);
        await fs.chmod(privateKey, 0o600);
        await fs.symlink(privateKey, symlink);
        await assert.rejects(() => readVaultPrivateKeyFile(symlink));
        await fs.link(privateKey, hardLink);
        await assert.rejects(() => readVaultPrivateKeyFile(privateKey), /one link/);
    }
    finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
