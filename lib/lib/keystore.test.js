import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Bytes, PrivateKey, PublicKey } from '@wharfkit/antelope';
import { recoverableR1Signature } from './antelope-key.js';
import { decryptKey, encryptKey, readStoredKey, storeKey } from './keystore.js';
test('encrypted keystore rejects incorrect passwords and authenticated record changes', async () => {
    const generated = PrivateKey.generate('K1');
    const secret = Buffer.from(generated.data.array);
    const password = randomBytes(32);
    const badPassword = randomBytes(32);
    const metadata = { name: 'fallback', publicKey: generated.toPublic().toString(), type: 'K1' };
    try {
        const record = await encryptKey(metadata, secret, password);
        const restored = await decryptKey(record, password);
        assert(restored.equals(secret));
        restored.fill(0);
        assert(!JSON.stringify(record).includes(secret.toString('base64')));
        const changed = Buffer.from(record.ciphertext, 'base64');
        changed[0] ^= 1;
        const invalid = /incorrect password or modified/;
        await assert.rejects(decryptKey(record, badPassword), invalid);
        await assert.rejects(decryptKey({ ...record, ciphertext: changed.toString('base64') }, password), invalid);
        await assert.rejects(decryptKey({ ...record, name: 'substituted' }, password), invalid);
    }
    finally {
        generated.data.array.fill(0);
        secret.fill(0);
        password.fill(0);
        badPassword.fill(0);
    }
});
test('keystore publishes owner-only records and refuses overwrites, unsafe permissions and links', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-keystore-test-'));
    const previous = process.env.HARBOR_HOME;
    process.env.HARBOR_HOME = home;
    const generated = PrivateKey.generate('R1');
    try {
        const record = {
            version: 1, storage: 'enclave', name: 'device', type: 'R1',
            publicKey: generated.toPublic().toString(), wrapped: Buffer.from('fixture reference').toString('base64'),
        };
        const writes = await Promise.allSettled([storeKey(record), storeKey(record)]);
        assert.equal(writes.filter(({ status }) => status === 'fulfilled').length, 1);
        const rejected = writes.find(({ status }) => status === 'rejected');
        assert(rejected?.status === 'rejected');
        assert.match(String(rejected.reason), /already uses this name/);
        const dir = path.join(home, 'keys');
        const file = path.join(dir, 'device.json');
        assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
        assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
        assert.deepEqual(await readStoredKey('device'), record);
        await fs.chmod(file, 0o644);
        await assert.rejects(readStoredKey('device'), /mode 0600/);
        await fs.chmod(file, 0o600);
        await fs.symlink(file, path.join(dir, 'link.json'));
        await assert.rejects(readStoredKey('link'), { code: 'ELOOP' });
        await assert.rejects(readStoredKey('../device'), /key name/);
    }
    finally {
        generated.data.array.fill(0);
        if (previous === undefined)
            delete process.env.HARBOR_HOME;
        else
            process.env.HARBOR_HOME = previous;
        await fs.rm(home, { recursive: true });
    }
});
test('a native P-256 signature becomes a canonical recoverable Antelope signature', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const { x, y } = publicKey.export({ format: 'jwk' });
    const xBytes = Buffer.from(x, 'base64url');
    const yBytes = Buffer.from(y, 'base64url');
    const compressed = Buffer.concat([Buffer.of(2 | (yBytes[31] & 1)), xBytes]);
    const key = PublicKey.from({ type: 'R1', compressed });
    const input = Buffer.from('disposable R1 signature fixture');
    const raw = sign('sha256', input, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    // Force the high-S case to exercise normalization.
    const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const s = BigInt('0x' + raw.subarray(32).toString('hex'));
    if (s <= order / 2n)
        Buffer.from((order - s).toString(16).padStart(64, '0'), 'hex').copy(raw, 32);
    const message = Bytes.from(input);
    const signature = recoverableR1Signature(raw, message, key);
    assert(signature.recoverMessage(message).equals(key));
    assert(signature.verifyMessage(message, key));
    assert(BigInt('0x' + Buffer.from(signature.data.array.subarray(33)).toString('hex')) <= order / 2n);
    assert.throws(() => recoverableR1Signature(raw, Bytes.from(Buffer.of(0)), key), /did not match/);
});
