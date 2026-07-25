import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalVaultEnvelopeBytes, decryptVaultBytes, encryptVaultBytes, generateVaultKeyPair, parseVaultPrivateKey, parseVaultPublicKey, requireInitialCustodyEnvelope, rewrapVaultEnvelope, vaultEnvelopeCommitment, vaultEnvelopeFromBytes, vaultEnvelopeFromCanonicalBytes, vaultEnvelopeFromJson, vaultEnvelopeToBytes, vaultEnvelopeToJson, vaultPrivateKeyToJson, vaultPublicKeyToJson, } from './vault-crypto.js';
const context = {
    policy_id: '7',
    consent_id: '12',
    receipt_id: '19',
    object_id: 'sample-44',
    purpose: 'distillation-review',
    created_at: 1_000,
    expires_at: 2_000,
};
test('C++ and TypeScript share the fixed decrypting HGD1 golden vector', () => {
    const publicKey = Buffer.from('4701d08488451f545a409fb58ae3e58581ca40ac3f7f114698cd71deac73ca01', 'hex');
    const privateKey = Buffer.from('3d94eea49c580aef816935762be049559d6d1440dede12e6a125f1841fff8e6f', 'hex');
    const canonical = Buffer.from('4847443100000020686172626f722e676f7665726e65642d646174612d656e76656c6f70652e7631' +
        '0000002b786368616368613230706f6c79313330352d696574662b637572766532353531392d736561' +
        '6c6564626f780000006a484741310000000d706f6c6963792d676f6c64656e0000000e636f6e73656e' +
        '742d676f6c64656e0000000e726563656970742d676f6c64656e0000000d6f626a6563742d676f6c64' +
        '656e0000000c64697374696c6c6174696f6e000000006a597080000000006a5ac20000000002343200' +
        '00000b747261696e657270726f630000000a6b65792d676f6c64656e00000040666637333261633434' +
        '306635316133353633396533666635303236303034306666656231383965303032313939386432323839' +
        '313465373737616533333731660000004031393033636539663164643332313137353463373862663862' +
        '656564643961323239383565663365633035343333623130303062393437323832633639666437000000' +
        '403163336531386434616566346230623738313336303034313036666237363638393837343036393331' +
        '323230663064306538323263613664663238653437363300000040616233653235356265356236633363' +
        '356566643737396436363134653635643761303933303364656165383934303165313561316335303466' +
        '3664663061623000000018125208e726c03f44c8b4b18fc4e0410a4101291d82ca5dad00000050a14b' +
        '5c308320e161da1a4ff5cd5256db89a6e8096ea8f03e8d3dc7da543bda0881d274c17027e26f8a3a55' +
        '35bec807cec41a968b965b659ae5963d8233b7e2292604459fdcfe40e269665629f72239d7000000000' +
        '0000027929f98015115515ffe4ab7ec86b31eb359534123db255d3211820afb8fe34509c49b3ff67968' +
        '18', 'hex');
    const envelope = vaultEnvelopeFromCanonicalBytes(canonical);
    assert.equal(vaultEnvelopeCommitment(envelope), 'c91a690b041083a3ea20b74cfcd351304250ede6f3358f20e21dddb78e09c09b');
    assert.equal(envelope.recipient_grant_id, '42');
    assert.equal(envelope.recipient_processor, 'trainerproc');
    assert.equal(decryptVaultBytes(envelope, publicKey, privateKey, 1_784_246_401).toString(), 'golden governed payload');
    privateKey.fill(0);
});
test('governed envelope uses only a public key to encrypt and round-trips canonical HGD1', () => {
    const campaign = generateVaultKeyPair();
    const plaintext = Buffer.from('private prompt and response');
    const custodyContext = { ...context, receipt_id: '', object_id: '' };
    const envelope = encryptVaultBytes(plaintext, campaign.publicKey, custodyContext, {
        grant_id: '',
        processor: '',
        key_id: 'campaign-1',
    }, 1_000);
    assert.doesNotThrow(() => requireInitialCustodyEnvelope(envelope));
    assert.equal(envelope.context.receipt_id, '');
    assert.equal(envelope.context.object_id, '');
    assert.equal(envelope.recipient_grant_id, '');
    assert.equal(envelope.recipient_key_commitment, campaign.publicKeyHash);
    assert.match(vaultEnvelopeCommitment(envelope), /^[0-9a-f]{64}$/);
    assert.deepEqual(vaultEnvelopeFromCanonicalBytes(canonicalVaultEnvelopeBytes(envelope)), envelope);
    assert.deepEqual(vaultEnvelopeFromBytes(canonicalVaultEnvelopeBytes(envelope)), envelope);
    assert.deepEqual(vaultEnvelopeFromBytes(vaultEnvelopeToBytes(envelope)), envelope);
    assert.equal(vaultEnvelopeToBytes(envelope).toString(), vaultEnvelopeToJson(envelope));
    assert.deepEqual(decryptVaultBytes(envelope, campaign.publicKey, campaign.privateKey, 1_001), plaintext);
    campaign.privateKey.fill(0);
});
test('producer requires an active lifetime and canonical UTF-8 context', () => {
    const recipient = generateVaultKeyPair();
    const unicodeContext = { ...context, purpose: 'révision-模型' };
    assert.throws(() => encryptVaultBytes(Buffer.from('x'), recipient.publicKey, unicodeContext, {
        grant_id: '4', processor: 'reviewer', key_id: 'review-1',
    }, 999), /not active at producer time/);
    const envelope = encryptVaultBytes(Buffer.from('x'), recipient.publicKey, unicodeContext, {
        grant_id: '4', processor: 'reviewer', key_id: 'review-1',
    }, 1_001);
    assert.equal(vaultEnvelopeFromCanonicalBytes(canonicalVaultEnvelopeBytes(envelope)).context.purpose, 'révision-模型');
    assert.throws(() => encryptVaultBytes(Buffer.from('x'), recipient.publicKey, unicodeContext, {
        grant_id: '4', processor: 'reviewer', key_id: 'review-1',
    }, 2_000), /not active at producer time/);
    recipient.privateKey.fill(0);
});
test('strict JSON wrapper and commitments reject context, ciphertext, and wrapper tampering', () => {
    const campaign = generateVaultKeyPair();
    const attacker = generateVaultKeyPair();
    const envelope = encryptVaultBytes(Buffer.from('sensitive'), campaign.publicKey, context, {
        grant_id: 'review-grant-4',
        processor: 'reviewer',
        key_id: 'campaign-1',
    }, 1_000);
    const json = vaultEnvelopeToJson(envelope);
    assert.deepEqual(vaultEnvelopeFromJson(json), envelope);
    assert.throws(() => decryptVaultBytes(envelope, attacker.publicKey, attacker.privateKey, 1_001), /does not match/);
    assert.throws(() => decryptVaultBytes(envelope, campaign.publicKey, campaign.privateKey, 2_000), /not active/);
    assert.throws(() => canonicalVaultEnvelopeBytes({ ...envelope, context: { ...context, purpose: 'other' } }), /associated-data/);
    const ciphertext = Buffer.from(envelope.ciphertext);
    ciphertext[0] ^= 0x80;
    assert.throws(() => canonicalVaultEnvelopeBytes({ ...envelope, ciphertext }), /ciphertext commitment/);
    assert.throws(() => vaultEnvelopeFromJson(`${json}\n`), /not canonical/);
    const wrapper = JSON.parse(json);
    wrapper.canonical_hex = `00${wrapper.canonical_hex.slice(2)}`;
    assert.throws(() => vaultEnvelopeFromJson(JSON.stringify(wrapper)), /commitment/);
    campaign.privateKey.fill(0);
    attacker.privateKey.fill(0);
});
test('trustee rewrap binds the new grant and recipient without modifying content', () => {
    const campaign = generateVaultKeyPair();
    const trainer = generateVaultKeyPair();
    const original = encryptVaultBytes(Buffer.from('training rows'), campaign.publicKey, {
        ...context,
        receipt_id: '',
        object_id: '',
    }, {
        grant_id: '',
        processor: '',
        key_id: 'campaign-1',
    }, 1_000);
    const rewrapped = rewrapVaultEnvelope(original, campaign.publicKey, campaign.privateKey, trainer.publicKey, { grant_id: 'trainer-grant-8', processor: 'trainer', key_id: 'trainer-4' }, 1_001);
    assert.deepEqual(rewrapped.ciphertext, original.ciphertext);
    assert.deepEqual(rewrapped.nonce, original.nonce);
    assert.equal(rewrapped.ciphertext_commitment, original.ciphertext_commitment);
    assert.equal(rewrapped.associated_data_commitment, original.associated_data_commitment);
    assert.equal(rewrapped.recipient_grant_id, 'trainer-grant-8');
    assert.equal(rewrapped.recipient_processor, 'trainer');
    assert.equal(rewrapped.context.receipt_id, '');
    assert.equal(rewrapped.context.object_id, '');
    assert.equal(rewrapped.recipient_key_commitment, trainer.publicKeyHash);
    assert.notEqual(rewrapped.wrapped_dek_commitment, original.wrapped_dek_commitment);
    assert.deepEqual(decryptVaultBytes(rewrapped, trainer.publicKey, trainer.privateKey, 1_002), Buffer.from('training rows'));
    assert.throws(() => decryptVaultBytes(rewrapped, campaign.publicKey, campaign.privateKey, 1_002), /does not match/);
    campaign.privateKey.fill(0);
    trainer.privateKey.fill(0);
});
test('initial custody rejects predicted post-storage authorization identities', () => {
    const pair = generateVaultKeyPair();
    const legacy = encryptVaultBytes(Buffer.from('x'), pair.publicKey, context, {
        grant_id: 'predicted-grant', processor: 'trainer', key_id: 'trainer-key',
    }, 1_000);
    assert.throws(() => requireInitialCustodyEnvelope(legacy), /must not contain/);
    const custody = encryptVaultBytes(Buffer.from('x'), pair.publicKey, {
        ...context, receipt_id: '', object_id: '',
    }, { grant_id: '', processor: '', key_id: 'object-key' }, 1_000);
    assert.doesNotThrow(() => requireInitialCustodyEnvelope(custody));
    assert.throws(() => canonicalVaultEnvelopeBytes({ ...custody, context: { ...custody.context, receipt_id: 'only-one' } }), /both be empty/);
    pair.privateKey.fill(0);
});
test('key files carry raw libsodium keys and verify their public-key commitment', () => {
    const pair = generateVaultKeyPair();
    const publicFile = vaultPublicKeyToJson(pair, 'trustee-1');
    const privateFile = vaultPrivateKeyToJson(pair, 'trustee-1');
    const publicKey = parseVaultPublicKey(publicFile);
    const privateKey = parseVaultPrivateKey(privateFile);
    assert.equal(publicKey.keyId, 'trustee-1');
    assert.equal(publicKey.publicKeyHash, pair.publicKeyHash);
    assert.deepEqual(publicKey.publicKey, pair.publicKey);
    assert.equal(privateKey.privateKey.equals(pair.privateKey), true);
    assert.throws(() => parseVaultPublicKey(privateFile), /unsupported/);
    const tampered = JSON.parse(publicFile);
    tampered.public_key_commitment = '0'.repeat(64);
    assert.throws(() => parseVaultPublicKey(JSON.stringify(tampered)), /does not match/);
    const noncanonicalPublic = JSON.parse(publicFile);
    noncanonicalPublic.public_key = `${noncanonicalPublic.public_key}=`;
    assert.throws(() => parseVaultPublicKey(JSON.stringify(noncanonicalPublic)), /canonical base64/);
    const noncanonicalPrivate = JSON.parse(privateFile);
    noncanonicalPrivate.private_key = `${noncanonicalPrivate.private_key}=`;
    assert.throws(() => parseVaultPrivateKey(JSON.stringify(noncanonicalPrivate)), /canonical base64/);
    pair.privateKey.fill(0);
    privateKey.privateKey.fill(0);
});
