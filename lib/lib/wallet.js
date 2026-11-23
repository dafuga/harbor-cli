import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Base58, KeyType, PrivateKey, PublicKey } from '@wharfkit/antelope';
import sodium from 'sodium-native';
import { antelopePublicKey, generateAntelopeSecret, signAntelopeMessage } from './antelope-key.js';
import { harborHome } from './config.js';
import { createEnclaveKey, enclaveAvailable, signWithEnclave } from './enclave.js';
import { readKeyPassword, readRotationPassword } from './key-prompt.js';
import { decryptKey, encryptKey, keyName, listStoredKeys, readKeyEntry, readStoredKey, replaceEncryptedKey, storeKey } from './keystore.js';
export function walletPath() {
    return path.join(harborHome(), 'wallet.json');
}
async function legacyKeys() {
    try {
        return JSON.parse(await fs.readFile(walletPath(), 'utf8')).keys;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw new Error('unable to read legacy Harbor wallet');
    }
}
function publicRecord(record) {
    const { name, publicKey, type, storage } = record;
    return { name, publicKey, type, storage };
}
export async function listWalletKeys() {
    const secure = (await listStoredKeys()).map(publicRecord);
    const legacy = (await legacyKeys()).map(({ name, publicKey }) => {
        const key = PublicKey.from(publicKey);
        return { name, publicKey: key.toString(), type: key.type === KeyType.R1 ? 'R1' : 'K1', storage: 'legacy' };
    });
    return [...secure, ...legacy];
}
function parseAntelopePrivateKey(value) {
    try {
        const key = PrivateKey.from(value);
        if (key.type === KeyType.R1 || key.type === KeyType.K1)
            return key;
    }
    catch {
        // The underlying parser may put its input in an error.
    }
    throw new Error('invalid Antelope K1 or R1 private key');
}
function solanaKeyPair(seed) {
    const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
    const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
    sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed);
    return { publicKey, secretKey };
}
function publicKeyFor(type, secret) {
    if (type !== 'ed25519')
        return antelopePublicKey(type, secret).toString();
    const { publicKey, secretKey } = solanaKeyPair(secret);
    secretKey.fill(0);
    return Base58.encode(publicKey);
}
function solanaSeed(input) {
    let value;
    try {
        value = JSON.parse(input.toString('utf8'));
    }
    catch {
        throw new Error('expected a Solana JSON array of 32 seed bytes or 64 keypair bytes');
    }
    if (!Array.isArray(value) || ![32, 64].includes(value.length) ||
        !value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
        throw new Error('expected a Solana JSON array of 32 seed bytes or 64 keypair bytes');
    }
    const bytes = Buffer.from(value);
    value.fill(0);
    const seed = Buffer.from(bytes.subarray(0, 32));
    try {
        if (bytes.length === 64) {
            const { publicKey, secretKey } = solanaKeyPair(seed);
            secretKey.fill(0);
            if (!bytes.subarray(32).equals(publicKey))
                throw new Error('Solana keypair does not match its public key');
        }
        return seed;
    }
    catch (error) {
        seed.fill(0);
        throw error;
    }
    finally {
        bytes.fill(0);
    }
}
async function saveEncrypted(name, type, secret) {
    const password = await readKeyPassword(name, true);
    try {
        const record = await encryptKey({ name, type, publicKey: publicKeyFor(type, secret) }, secret, password);
        await storeKey(record);
        return publicRecord(record);
    }
    finally {
        password.fill(0);
    }
}
export async function createWalletKey(name, type, storage) {
    keyName(name);
    if (await readStoredKey(name))
        throw new Error('a key already uses this name');
    if (storage === 'enclave' && type !== 'R1')
        throw new Error('Secure Enclave supports only Antelope R1 keys');
    if (storage === 'enclave' || (storage === undefined && type === 'R1' && await enclaveAvailable())) {
        const record = { version: 1, name, type, storage: 'enclave', ...await createEnclaveKey() };
        await storeKey(record);
        return publicRecord(record);
    }
    const secret = type === 'ed25519' ? randomBytes(32) : generateAntelopeSecret(type);
    try {
        return await saveEncrypted(name, type, secret);
    }
    finally {
        secret.fill(0);
    }
}
export async function importWalletKey(name, input, solana) {
    keyName(name);
    if (await readStoredKey(name))
        throw new Error('a key already uses this name');
    if (solana) {
        const seed = solanaSeed(input);
        input.fill(0);
        try {
            return await saveEncrypted(name, 'ed25519', seed);
        }
        finally {
            seed.fill(0);
        }
    }
    const key = parseAntelopePrivateKey(input.toString('utf8').trim());
    input.fill(0);
    try {
        return await saveEncrypted(name, key.type, Buffer.from(key.data.array.buffer, key.data.array.byteOffset, 32));
    }
    finally {
        key.data.array.fill(0);
    }
}
async function decryptVerifiedKey(record, password) {
    const secret = await decryptKey(record, password);
    try {
        if (publicKeyFor(record.type, secret) === record.publicKey)
            return secret;
    }
    catch {
        // Treat an invalid scalar like any other key that cannot match the stored public key.
    }
    secret.fill(0);
    throw new Error('keystore entry does not match its public key');
}
async function unlockKey(record) {
    const password = await readKeyPassword(record.name);
    try {
        return await decryptVerifiedKey(record, password);
    }
    finally {
        password.fill(0);
    }
}
export async function changeWalletKeyPassword(name) {
    const entry = await readKeyEntry(name);
    if (!entry)
        throw new Error('named keystore entry not found');
    const { record } = entry;
    if (record.storage === 'enclave')
        throw new Error('Secure Enclave keys have no password to change');
    const current = await readRotationPassword(name, 'current');
    let secret;
    let password;
    try {
        secret = await decryptVerifiedKey(record, current);
        const next = await readRotationPassword(name, 'new');
        password = next;
        if (current.length === next.length && timingSafeEqual(current, next)) {
            throw new Error('new password must differ from the current password');
        }
        current.fill(0);
        const replacement = await encryptKey({ name, type: record.type, publicKey: record.publicKey }, secret, next);
        secret.fill(0);
        await replaceEncryptedKey(entry, replacement, async (staged) => {
            const verified = await decryptVerifiedKey(staged, next);
            verified.fill(0);
        });
    }
    finally {
        current.fill(0);
        secret?.fill(0);
        password?.fill(0);
    }
}
export function signSolanaMessage(seed, message) {
    const { secretKey } = solanaKeyPair(seed);
    try {
        const signature = Buffer.alloc(sodium.crypto_sign_BYTES);
        sodium.crypto_sign_detached(signature, message, secretKey);
        return signature;
    }
    finally {
        secretKey.fill(0);
    }
}
export async function openSolanaSigner(name) {
    const key = await readStoredKey(name);
    if (key?.storage !== 'encrypted' || key.type !== 'ed25519')
        throw new Error('named ed25519 key not found');
    return {
        publicKey: key.publicKey,
        async sign(message) {
            const seed = await unlockKey(key);
            try {
                return signSolanaMessage(seed, message);
            }
            finally {
                seed.fill(0);
            }
        },
    };
}
function legacySigner(privateKey) {
    const type = privateKey.type;
    const secret = Buffer.from(privateKey.data.array.buffer, privateKey.data.array.byteOffset, 32);
    const publicKey = antelopePublicKey(type, secret);
    return {
        publicKey,
        async sign(message) { return signAntelopeMessage(type, secret, message, publicKey); },
    };
}
function storedSigner(key) {
    if (key.type === 'ed25519')
        throw new Error('ed25519 keys can sign only on the Solana command path');
    const publicKey = PublicKey.from(key.publicKey);
    return {
        publicKey,
        async sign(message) {
            if (key.storage === 'enclave')
                return signWithEnclave(key.wrapped, key.name, message, publicKey);
            if (key.type === 'ed25519')
                throw new Error('expected an Antelope key');
            const secret = await unlockKey(key);
            try {
                return signAntelopeMessage(key.type, secret, message, publicKey);
            }
            finally {
                secret.fill(0);
            }
        },
    };
}
export async function resolveAntelopeSigner(candidate, actor) {
    if (candidate && !candidate.startsWith('PUB_')) {
        const key = await readStoredKey(candidate);
        if (key)
            return storedSigner(key);
    }
    const secure = (await listStoredKeys()).filter((key) => key.type !== 'ed25519');
    const bySecureKey = secure.find((key) => key.publicKey === candidate || key.name === (candidate ?? actor));
    if (bySecureKey)
        return storedSigner(bySecureKey);
    const legacy = await legacyKeys();
    const byLegacyKey = legacy.find((key) => key.publicKey === candidate || key.name === (candidate ?? actor));
    if (byLegacyKey)
        return legacySigner(parseAntelopePrivateKey(byLegacyKey.privateKey));
    if (candidate)
        throw new Error('named Antelope key was not found');
    const defaultStored = secure.find((key) => key.name === 'default');
    if (defaultStored)
        return storedSigner(defaultStored);
    const defaultLegacy = legacy.find((key) => key.name === 'default');
    if (defaultLegacy)
        return legacySigner(parseAntelopePrivateKey(defaultLegacy.privateKey));
    if (secure.length === 1 && !legacy.length)
        return storedSigner(secure[0]);
    if (secure.length)
        throw new Error('select an Antelope signer with --key <name>');
    if (legacy.length)
        return legacySigner(parseAntelopePrivateKey(legacy[0].privateKey));
    throw new Error('no Antelope signer is available; create one with harbor keys create');
}
export async function openAntelopeWorkerSigner(name) {
    const key = await readStoredKey(name);
    if (key?.storage !== 'encrypted' || key.type === 'ed25519') {
        throw new Error('The worker requires a named encrypted Antelope key.');
    }
    const type = key.type;
    const secret = await unlockKey(key);
    const publicKey = PublicKey.from(key.publicKey);
    let open = true;
    return {
        publicKey,
        async sign(message) {
            if (!open)
                throw new Error('Worker signer is closed.');
            return signAntelopeMessage(type, secret, message, publicKey);
        },
        close() {
            open = false;
            secret.fill(0);
        },
    };
}
