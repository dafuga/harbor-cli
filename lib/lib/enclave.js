import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@wharfkit/antelope';
import { recoverableR1Signature } from './antelope-key.js';
function enclaveRequest(request) {
    if (process.platform !== 'darwin')
        throw new Error('Secure Enclave requires macOS');
    const helper = fileURLToPath(new URL('../../src/lib/secure-enclave.swift', import.meta.url));
    return new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/swift', [helper], { stdio: ['pipe', 'pipe', 'pipe'] });
        const output = [];
        const errors = [];
        child.stdout.on('data', (chunk) => output.push(chunk));
        child.stderr.on('data', (chunk) => errors.push(chunk));
        child.stdin.on('error', reject);
        child.on('error', () => reject(new Error('unable to launch Swift; install the macOS Command Line Tools')));
        child.on('close', (code) => {
            if (code !== 0) {
                const status = Buffer.concat(errors).toString().trim();
                const detail = /^[\w.-]+ -?\d+$/.test(status) ? ` (${status})` : '';
                reject(new Error(`Secure Enclave operation failed${detail}; use an unlocked macOS desktop for authentication`));
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(output).toString()));
            }
            catch {
                reject(new Error('invalid Secure Enclave response'));
            }
        });
        child.stdin.end(JSON.stringify(request));
    });
}
export async function enclaveAvailable() {
    return process.platform === 'darwin' && (await enclaveRequest({ operation: 'probe' })).available === true;
}
export async function createEnclaveKey() {
    const { publicKey, wrapped } = await enclaveRequest({ operation: 'create' });
    if (!publicKey || !wrapped)
        throw new Error('invalid Secure Enclave key response');
    const compressed = Buffer.from(publicKey, 'base64');
    if (compressed.length !== 33 || (compressed[0] !== 2 && compressed[0] !== 3)) {
        throw new Error('invalid Secure Enclave public key');
    }
    return { publicKey: PublicKey.from({ type: 'R1', compressed }).toString(), wrapped };
}
export async function signWithEnclave(wrapped, name, message, key) {
    const { signature } = await enclaveRequest({
        operation: 'sign',
        wrapped,
        label: name,
        message: Buffer.from(message.array).toString('base64'),
    });
    if (!signature)
        throw new Error('missing Secure Enclave signature');
    return recoverableR1Signature(Buffer.from(signature, 'base64'), message, key);
}
