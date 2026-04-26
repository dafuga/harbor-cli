import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { storeObject } from './storage.js';
async function makeTempDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'harbor-storage-'));
}
test('storeObject stores plaintext bytes and returns harborstore action data', async () => {
    const root = await makeTempDir();
    const sourcePath = path.join(root, 'sample.txt');
    await fs.writeFile(sourcePath, 'hello harbor');
    const result = await storeObject({ root, file: sourcePath, metadata: 'sample' });
    const stored = await fs.readFile(result.storedPath);
    const expectedHash = crypto.createHash('sha256').update('hello harbor').digest('hex');
    assert.equal(stored.toString(), 'hello harbor');
    assert.equal(result.contentHash, expectedHash);
    assert.equal(result.sourceHash, expectedHash);
    assert.equal(result.encrypted, false);
    assert.equal(result.encryptionKeyHash, '0'.repeat(64));
    assert.deepEqual(result.registerAction.data, [
        '<owner>',
        expectedHash,
        stored.length,
        false,
        '0'.repeat(64),
        'sample',
    ]);
});
test('storeObject encrypts bytes when requested', async () => {
    const root = await makeTempDir();
    const sourcePath = path.join(root, 'secret.txt');
    await fs.writeFile(sourcePath, 'secret harbor');
    const result = await storeObject({
        root,
        file: sourcePath,
        encrypt: true,
        privateKey: 'local-private-key',
    });
    const stored = JSON.parse(await fs.readFile(result.storedPath, 'utf8'));
    assert.equal(result.encrypted, true);
    assert.equal(stored.algorithm, 'aes-256-gcm');
    assert.notEqual(result.contentHash, result.sourceHash);
    assert.notEqual(result.encryptionKeyHash, '0'.repeat(64));
});
test('storeObject requires a private key for encryption', async () => {
    const root = await makeTempDir();
    const sourcePath = path.join(root, 'secret.txt');
    await fs.writeFile(sourcePath, 'secret harbor');
    await assert.rejects(() => storeObject({ root, file: sourcePath, encrypt: true }), /--private-key is required/);
});
