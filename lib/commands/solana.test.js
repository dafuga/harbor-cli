import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Base58 } from '@wharfkit/antelope';
import sodium from 'sodium-native';
import { signSolanaTransaction } from './solana.js';
import { encryptKey } from '../lib/keystore.js';
import { signSolanaMessage } from '../lib/wallet.js';
test('Solana signing preserves the wire message and other signer slots', async () => {
    const seed = randomBytes(32);
    const publicKey = Buffer.alloc(32);
    const secretKey = Buffer.alloc(64);
    sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed);
    secretKey.fill(0);
    const existingSignature = randomBytes(64);
    const otherPublicKey = randomBytes(32);
    const signer = {
        publicKey: Base58.encode(publicKey),
        sign: async (message) => signSolanaMessage(seed, message),
    };
    try {
        for (const version of ['legacy', 0]) {
            const message = Buffer.concat([
                version === 0 ? Buffer.of(0x80) : Buffer.alloc(0),
                Buffer.of(2, 1, 0, 2), // two signers, second read-only, two static account keys
                otherPublicKey, publicKey, randomBytes(32), // account keys and recent blockhash
                version === 0 ? Buffer.of(0, 0) : Buffer.of(0), // instructions and v0 lookups
            ]);
            const wire = Buffer.concat([Buffer.of(2), existingSignature, Buffer.alloc(64), message]);
            const signed = await signSolanaTransaction(wire, signer);
            assert(signed.subarray(1, 65).equals(existingSignature));
            assert(signed.subarray(129).equals(message));
            assert(sodium.crypto_sign_verify_detached(signed.subarray(65, 129), message, publicKey));
            await assert.rejects(signSolanaTransaction(Buffer.concat([wire, Buffer.of(0)]), signer), /invalid serialized/);
            await assert.rejects(signSolanaTransaction(wire, {
                ...signer, publicKey: Base58.encode(randomBytes(32)),
            }), /not a required signer/);
        }
    }
    finally {
        seed.fill(0);
    }
});
test('Solana CLI reviews transfer accounts, amount and expiry before signing', async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-solana-sign-test-'));
    const seed = randomBytes(32);
    const destination = randomBytes(32);
    const blockhash = randomBytes(32);
    const password = Buffer.from(randomBytes(32).toString('hex'));
    const key = Buffer.alloc(32);
    const secretKey = Buffer.alloc(64);
    sodium.crypto_sign_seed_keypair(key, secretKey, seed);
    secretKey.fill(0);
    t.after(async () => {
        seed.fill(0);
        password.fill(0);
        await fs.rm(home, { recursive: true });
    });
    const publicKey = Base58.encode(key);
    const record = await encryptKey({ name: 'fixture', type: 'ed25519', publicKey }, seed, password);
    await fs.mkdir(path.join(home, 'keys'), { mode: 0o700 });
    await fs.writeFile(path.join(home, 'keys', 'fixture.json'), JSON.stringify(record), { mode: 0o600 });
    const file = path.join(home, 'unsigned.b64');
    const output = path.join(home, 'signed.b64');
    const transfer = Buffer.alloc(12);
    transfer.writeUInt32LE(2);
    transfer.writeBigUInt64LE(1250000000n, 4);
    const message = Buffer.concat([
        Buffer.of(1, 0, 1, 3), key, destination, Buffer.alloc(32), blockhash,
        Buffer.of(1, 2, 2, 0, 1, transfer.length), transfer,
    ]);
    await fs.writeFile(file, Buffer.concat([Buffer.of(1), Buffer.alloc(64), message]).toString('base64'));
    const entry = fileURLToPath(new URL('../index.js', import.meta.url));
    const args = ['solana', 'sign-transaction', file, '--key', 'fixture'];
    const env = { ...process.env, HARBOR_HOME: home, HARBOR_KEY_PASSWORD_FD: '3' };
    const refused = spawnSync(process.execPath, [entry, ...args, '--output', output], {
        env, encoding: 'utf8', input: 'yes\n', timeout: 10_000,
    });
    assert.ifError(refused.error);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /interactive terminal.*--yes/);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    for (const value of ['SOL transfer', '1250000000 lamports', publicKey, Base58.encode(destination), Base58.encode(blockhash), 'Expiry']) {
        assert(refused.stderr.includes(value), `missing Solana review field: ${value}`);
    }
    const passwordFile = path.join(home, 'password');
    await fs.writeFile(passwordFile, password, { mode: 0o600 });
    const descriptor = await fs.open(passwordFile, 'r');
    try {
        const accepted = spawnSync(process.execPath, [entry, ...args, '--yes'], {
            env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', descriptor.fd], timeout: 10_000,
        });
        assert.ifError(accepted.error);
        assert.equal(accepted.status, 0, accepted.stderr);
        assert.match(accepted.stderr, /1250000000 lamports/);
        const signed = Buffer.from(accepted.stdout.trim(), 'base64');
        assert(signed.subarray(65).equals(message));
        assert(sodium.crypto_sign_verify_detached(signed.subarray(1, 65), message, key));
    }
    finally {
        await descriptor.close();
    }
});
