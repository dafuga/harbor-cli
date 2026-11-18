import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Base58, PublicKey } from '@wharfkit/antelope';
import { harborHome } from './config.js';
const MAX_RECORD_BYTES = 8192;
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
export function keyName(name) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name) || name.startsWith('PVT_') || /^5[1-9A-HJ-NP-Za-km-z]{50}$/.test(name)) {
        throw new Error('key name must contain 1–64 letters, digits, dots, dashes or underscores and start with a letter or digit');
    }
    return name;
}
function derivedKey(password, salt) {
    if (!password.length)
        throw new Error('key password cannot be empty');
    return new Promise((resolve, reject) => {
        scrypt(password, salt, 32, SCRYPT, (error, key) => error ? reject(error) : resolve(key));
    });
}
function base64(value, bytes) {
    if (typeof value !== 'string' || !value.length)
        throw new Error('invalid key record');
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value || (bytes !== undefined && decoded.length !== bytes)) {
        throw new Error('invalid key record');
    }
    return decoded;
}
// Version 1 fixes the KDF and cipher parameters. Bind the identity and storage mode to the ciphertext.
function associatedData(record) {
    return Buffer.from(JSON.stringify(['harbor-keystore', 1, 'encrypted', record.name, record.type, record.publicKey]));
}
export async function encryptKey(metadata, secret, password) {
    if (secret.length !== 32)
        throw new Error('invalid private key size');
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const key = await derivedKey(password, salt);
    try {
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(associatedData(metadata));
        const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
        return {
            ...metadata, version: 1, storage: 'encrypted', salt: salt.toString('base64'),
            nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
        };
    }
    finally {
        key.fill(0);
    }
}
export async function decryptKey(record, password) {
    const key = await derivedKey(password, base64(record.salt, 16));
    let plaintext;
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, base64(record.nonce, 12));
        decipher.setAAD(associatedData(record));
        decipher.setAuthTag(base64(record.tag, 16));
        plaintext = decipher.update(base64(record.ciphertext, 32));
        decipher.final();
        return Buffer.from(plaintext);
    }
    catch {
        throw new Error('unable to unlock key: incorrect password or modified keystore entry');
    }
    finally {
        plaintext?.fill(0);
        key.fill(0);
    }
}
function checkDirectory(stat, forbidden) {
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & forbidden) !== 0) {
        throw new Error('Harbor key directories must be owned by the current user and restrict access');
    }
}
async function directory(create) {
    const home = harborHome();
    if (create)
        await fs.mkdir(home, { mode: 0o700, recursive: true });
    checkDirectory(await fs.lstat(home), 0o022);
    const dir = path.join(home, 'keys');
    if (create)
        await fs.mkdir(dir, { mode: 0o700, recursive: true });
    checkDirectory(await fs.lstat(dir), 0o077);
    return dir;
}
function decodeRecord(raw, name) {
    try {
        const record = JSON.parse(raw);
        if (record.version !== 1 || record.name !== name || typeof record.publicKey !== 'string' || !record.publicKey) {
            throw new Error();
        }
        if (record.type === 'ed25519') {
            if (Base58.decode(record.publicKey, 32).length !== 32)
                throw new Error();
        }
        else {
            const publicKey = PublicKey.from(record.publicKey);
            if (publicKey.toString() !== record.publicKey || publicKey.type !== record.type)
                throw new Error();
        }
        if (record.storage === 'enclave' && record.type === 'R1') {
            base64(record.wrapped);
            return record;
        }
        if (record.storage === 'encrypted' && ['K1', 'R1', 'ed25519'].includes(record.type)) {
            base64(record.salt, 16);
            base64(record.nonce, 12);
            base64(record.ciphertext, 32);
            base64(record.tag, 16);
            return record;
        }
    }
    catch {
        // JSON parse errors may echo the input.
    }
    throw new Error('invalid Harbor keystore entry');
}
async function readRecord(dir, name) {
    const file = await fs.open(path.join(dir, keyName(name) + '.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_RECORD_BYTES) {
            throw new Error('Harbor key entries must be owner-only regular files with mode 0600');
        }
        const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
        const { bytesRead } = await file.read(bytes);
        if (bytesRead > MAX_RECORD_BYTES)
            throw new Error('Harbor keystore entry is too large');
        return decodeRecord(bytes.toString('utf8', 0, bytesRead), name);
    }
    finally {
        await file.close();
    }
}
export async function readStoredKey(name) {
    try {
        return await readRecord(await directory(false), name);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
export async function listStoredKeys() {
    let dir;
    try {
        dir = await directory(false);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).sort();
    return Promise.all(names.map((name) => readRecord(dir, name.slice(0, -5))));
}
export async function storeKey(record) {
    const dir = await directory(true);
    const destination = path.join(dir, keyName(record.name) + '.json');
    const temporary = path.join(dir, '.new-' + randomBytes(16).toString('hex'));
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
        try {
            await file.chmod(0o600);
            await file.writeFile(JSON.stringify(record) + '\n');
            await file.sync();
        }
        finally {
            await file.close();
        }
        // Publish a complete record without replacing a key created by another process.
        await fs.link(temporary, destination);
    }
    catch (error) {
        if (error.code === 'EEXIST')
            throw new Error('a key already uses this name');
        throw error;
    }
    finally {
        await fs.unlink(temporary);
    }
    const handle = await fs.open(dir, 'r');
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
