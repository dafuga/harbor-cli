import { open } from 'node:fs/promises';
import { HARBOR_TESTNET } from './config.js';
import { postJson, serviceUrl, sha256 } from './http.js';
const MAX_RECEIPT = 24_000;
async function receiptBytes(file) {
    const handle = await open(file, 'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_RECEIPT) {
            throw new Error('Use a Harness agent receipt file of 1 to 24,000 bytes.');
        }
        const buffer = Buffer.alloc(MAX_RECEIPT + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
            if (!bytesRead)
                return buffer.subarray(0, offset);
            offset += bytesRead;
        }
        throw new Error('Harness agent receipt exceeded the size limit.');
    }
    finally {
        await handle.close();
    }
}
async function importAgent(options) {
    const token = process.env.HARBOR_AGENT_TOKEN ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
        throw new Error('Set the dedicated HARBOR_AGENT_TOKEN from the worker credential store.');
    if (!/^[a-z1-5.]{1,12}$/.test(options.account))
        throw new Error('Provide the worker’s Harbor testnet account.');
    const origin = serviceUrl(options.worker, 'agent worker');
    if (origin.href !== origin.origin + '/')
        throw new Error('Provide the worker origin only.');
    const bytes = await receiptBytes(options.receipt);
    if (sha256(bytes) !== options.approvedSha256)
        throw new Error('The receipt differs from the reviewed SHA-256.');
    const { data } = await postJson(new URL('/v1/import', origin), JSON.stringify({
        receipt: bytes.toString('base64'), approvedSha256: options.approvedSha256,
    }), { headers: { authorization: `Bearer ${token}`, 'x-harbor-agent-identity': `${HARBOR_TESTNET}/${options.account}` } });
    console.log(JSON.stringify({ id: data.id, status: data.status }));
}
export function addImportCommand(agents) {
    agents.command('import').description('Import a reviewed Harness agent definition into the testnet worker, paused')
        .requiredOption('--receipt <file>', 'Harness agent receipt JSON')
        .requiredOption('--approved-sha256 <digest>', 'Reviewed SHA-256 of the exact receipt file')
        .requiredOption('--worker <origin>', 'Worker HTTPS or loopback origin')
        .requiredOption('--account <name>', 'Expected Harbor testnet worker account')
        .action(importAgent);
}
