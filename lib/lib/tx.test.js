import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABI, PrivateKey, Serializer, SignedTransaction } from '@wharfkit/antelope';
import test from 'node:test';
import { readContractNextId } from './tx.js';
async function listen(server) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
}
async function close(server) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}
test('readContractNextId reads singleton params without assuming payload id is the physical key', async () => {
    const nextObjectId = '9007199254740993';
    let requestUrl;
    let requestBody;
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
            requestUrl = request.url;
            requestBody = JSON.parse(Buffer.concat(chunks).toString());
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                rows: [{ id: 0, required_replicas: 2, next_object_id: nextObjectId }],
                more: false,
            }));
        });
    });
    try {
        const url = await listen(server);
        assert.equal(await readContractNextId('harborstore', 'next_object_id', { url }), nextObjectId);
        assert.equal(requestUrl, '/v1/chain/get_table_rows');
        assert.equal(requestBody?.code, 'harborstore');
        assert.equal(requestBody?.scope, 'harborstore');
        assert.equal(requestBody?.table, 'params');
        assert.equal(requestBody?.limit, 2);
        assert.equal('lower_bound' in (requestBody ?? {}), false);
        assert.equal('upper_bound' in (requestBody ?? {}), false);
        assert.equal('index_position' in (requestBody ?? {}), false);
    }
    finally {
        await close(server);
    }
});
test('readContractNextId accepts a singleton payload without an id member', async () => {
    const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
            rows: [{ next_artifact_id: '18446744073709551614' }],
            more: false,
        }));
    });
    try {
        const url = await listen(server);
        assert.equal(await readContractNextId('harborai', 'next_artifact_id', { url }), '18446744073709551614');
    }
    finally {
        await close(server);
    }
});
test('readContractNextId rejects absent, ambiguous, and unsafe numeric allocators', async (t) => {
    const cases = [
        {
            name: 'missing allocator field',
            rows: [{ id: 0, next_model_id: '7' }],
            error: /harborstore params do not expose next_object_id/,
        },
        {
            name: 'ambiguous allocator rows',
            rows: [
                { id: 0, next_object_id: '7' },
                { id: 1, next_object_id: '8' },
            ],
            error: /harborstore params do not expose next_object_id/,
        },
        {
            name: 'unsafe JSON number',
            rows: [{ id: 0, next_object_id: 9_007_199_254_740_992 }],
            error: /harborstore next_object_id must be an unsigned 64-bit integer/,
        },
    ];
    for (const fixture of cases) {
        await t.test(fixture.name, async () => {
            const server = http.createServer((_request, response) => {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ rows: fixture.rows, more: false }));
            });
            try {
                const url = await listen(server);
                await assert.rejects(() => readContractNextId('harborstore', 'next_object_id', { url }), fixture.error);
            }
            finally {
                await close(server);
            }
        });
    }
});
function runCli(args, env = {}) {
    return new Promise((resolve, reject) => {
        const entry = fileURLToPath(new URL('../index.js', import.meta.url));
        const child = execFile(process.execPath, [entry, ...args], {
            timeout: 10_000,
            env: { ...process.env, HARBOR_PRIVATE_KEY: undefined, WHARFKIT_DEPLOY_KEY: undefined, ...env },
        }, (error, stdout, stderr) => {
            if (error && typeof error.code !== 'number')
                reject(new Error('Harbor CLI fixture failed to run'));
            else
                resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
        });
        child.stdin?.end('yes\n');
    });
}
test('transaction help omits the private key environment value', async () => {
    const marker = 'synthetic-environment-value-for-help-regression';
    for (const command of [['action', 'sign'], ['msig', 'propose'], ['contract', 'deploy']]) {
        const { code, stdout, stderr } = await runCli([...command, '--help'], { HARBOR_PRIVATE_KEY: marker });
        assert.equal(code, 0);
        assert.match(stdout, /--key/);
        assert(!(stdout + stderr).includes(marker), 'help exposed the private key environment value');
    }
});
const chainId = 'ab'.repeat(32);
const blockId = '00'.repeat(8) + '01' + '00'.repeat(23);
const transferData = { from: 'alice', to: 'bob', quantity: '12.3400 SYS' };
const transferFields = [
    { name: 'from', type: 'name' }, { name: 'to', type: 'name' }, { name: 'quantity', type: 'asset' },
];
const transactionFields = [
    { name: 'expiration', type: 'time_point_sec' }, { name: 'ref_block_num', type: 'uint16' },
    { name: 'ref_block_prefix', type: 'uint32' }, { name: 'max_net_usage_words', type: 'varuint32' },
    { name: 'max_cpu_usage_ms', type: 'uint8' }, { name: 'delay_sec', type: 'varuint32' },
    { name: 'context_free_actions', type: 'action[]' }, { name: 'actions', type: 'action[]' },
    { name: 'transaction_extensions', type: 'extension[]' },
];
async function signingFixture(t) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-cli-sign-test-'));
    const key = PrivateKey.generate('K1');
    const requests = [];
    const fixtureAbi = (account) => {
        const transfer = account === 'eosio.token';
        return {
            version: 'eosio::abi/1.1',
            actions: [{ name: transfer ? 'transfer' : 'propose', type: transfer ? 'transfer' : 'propose', ricardian_contract: '' }],
            structs: transfer ? [{ name: 'transfer', base: '', fields: transferFields }] : [
                { name: 'permission_level', base: '', fields: [{ name: 'actor', type: 'name' }, { name: 'permission', type: 'name' }] },
                { name: 'action', base: '', fields: [
                        { name: 'account', type: 'name' }, { name: 'name', type: 'name' },
                        { name: 'authorization', type: 'permission_level[]' }, { name: 'data', type: 'bytes' },
                    ] },
                { name: 'extension', base: '', fields: [{ name: 'type', type: 'uint16' }, { name: 'data', type: 'bytes' }] },
                { name: 'transaction', base: '', fields: transactionFields },
                { name: 'propose', base: '', fields: [
                        { name: 'proposer', type: 'name' }, { name: 'proposal_name', type: 'name' },
                        { name: 'requested', type: 'permission_level[]' }, { name: 'trx', type: 'transaction' },
                    ] },
            ],
        };
    };
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request)
            chunks.push(Buffer.from(chunk));
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        response.setHeader('content-type', 'application/json');
        switch (request.url) {
            case '/v1/chain/get_info':
                response.end(JSON.stringify({
                    server_version: 'test', chain_id: chainId, head_block_num: 2, last_irreversible_block_num: 1,
                    last_irreversible_block_id: blockId, head_block_id: blockId,
                    head_block_time: '2026-01-01T00:00:00.000', head_block_producer: 'eosio',
                    virtual_block_cpu_limit: 1, virtual_block_net_limit: 1, block_cpu_limit: 1, block_net_limit: 1,
                }));
                break;
            case '/v1/chain/get_abi':
                response.end(JSON.stringify({ account_name: body.account_name, abi: fixtureAbi(body.account_name) }));
                break;
            case '/v1/chain/get_raw_abi': {
                const abi = Buffer.from(Serializer.encode({ object: ABI.from(fixtureAbi(body.account_name)) }).array);
                response.end(JSON.stringify({
                    account_name: body.account_name,
                    code_hash: '00'.repeat(32),
                    abi_hash: createHash('sha256').update(abi).digest('hex'),
                    abi: abi.toString('base64'),
                }));
                break;
            }
            case '/v1/chain/send_transaction':
                requests.push(request.url);
                response.end(JSON.stringify({ transaction_id: 'cd'.repeat(32), processed: { receipt: { status: 'executed' } } }));
                break;
            default:
                response.writeHead(404).end('{}');
        }
    });
    const url = await listen(server);
    t.after(async () => {
        key.data.array.fill(0);
        await close(server);
        await fs.rm(home, { recursive: true });
    });
    await fs.writeFile(path.join(home, 'wallet.json'), JSON.stringify({
        keys: [{ name: 'fixture', privateKey: key.toString(), publicKey: key.toPublic().toString() }],
    }), { mode: 0o600 });
    return {
        key, requests,
        env: { HARBOR_HOME: home, HARBOR_API_URL: url, HARBOR_ACTOR: 'alice', HARBOR_PERMISSION: 'active', HARBOR_MSIG_CONTRACT: 'eosio.msig' },
    };
}
test('explicit raw private keys and raw key environment variables are rejected safely', async (t) => {
    const { key, env } = await signingFixture(t);
    const args = ['action', 'push', 'eosio.token', 'transfer', JSON.stringify(transferData)];
    for (const secret of [key.toString(), key.toWif()]) {
        for (const { options, overrides } of [
            { options: ['--key', secret], overrides: {} },
            { options: ['--key', `fixture,${secret}`], overrides: {} },
            { options: [], overrides: { HARBOR_PRIVATE_KEY: secret } },
            { options: [], overrides: { WHARFKIT_DEPLOY_KEY: secret } },
        ]) {
            const { code, stdout, stderr } = await runCli([...args, ...options], { ...env, ...overrides });
            assert(!(stdout + stderr).includes(secret), 'command exposed raw fixture private key');
            assert.equal(code, 1);
            assert.match(stderr, /raw private keys.*keystore/i);
        }
    }
    const selected = await runCli(args, { ...env, HARBOR_PRIVATE_KEY: 'fixture' });
    assert.equal(selected.code, 0, selected.stderr);
});
test('action sign reviews the exact transaction and requires a terminal or --yes', async (t) => {
    const { key, env, requests } = await signingFixture(t);
    const args = ['action', 'sign', 'eosio.token', 'transfer', JSON.stringify(Object.values(transferData)), '--key', 'fixture'];
    const refused = await runCli(args, env);
    assert.equal(refused.stdout, '');
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /interactive terminal.*--yes/);
    for (const value of ['eosio.token::transfer', 'alice@active', 'bob', '12.3400 SYS', '2026-01-01T00:05:00']) {
        assert(refused.stderr.includes(value), `missing action review field: ${value}`);
    }
    const accepted = await runCli([...args, '--yes'], env);
    assert.equal(accepted.code, 0, accepted.stderr);
    const output = JSON.parse(accepted.stdout);
    const signed = SignedTransaction.from(output.transaction);
    assert(accepted.stderr.includes(String(signed.expiration)));
    assert(signed.signatures[0].verifyDigest(signed.transaction.signingDigest(output.chain_id), key.toPublic()));
    assert.deepEqual(requests, []);
});
test('msig propose reviews the proposal and outer expiry before it can broadcast', async (t) => {
    const { env, requests } = await signingFixture(t);
    const args = [
        'msig', 'propose', 'reviewtest', 'eosio.token', 'transfer', JSON.stringify(transferData),
        '--requested', 'bob@active,carol@active', '--action-auth', 'alice@active', '--key', 'fixture', '--json',
    ];
    const refused = await runCli(args, env);
    assert.equal(refused.stdout, '');
    assert.equal(refused.code, 1);
    assert.deepEqual(requests, []);
    assert.match(refused.stderr, /interactive terminal.*--yes/);
    for (const value of [
        'eosio.msig::propose', 'reviewtest', 'alice@active', 'bob@active', 'carol@active',
        'eosio.token::transfer', '12.3400 SYS', '2026-01-01T00:05:00', '2026-01-02T00:00:00',
    ]) {
        assert(refused.stderr.includes(value), `missing proposal review field: ${value}`);
    }
    const accepted = await runCli([...args, '--yes'], env);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.match(accepted.stderr, /12\.3400 SYS/);
    assert.equal(JSON.parse(accepted.stdout).status, 'executed');
    assert.deepEqual(requests, ['/v1/chain/send_transaction']);
});
test('action push pins the signing chain before opening the wallet', async (t) => {
    const { env, requests } = await signingFixture(t);
    const args = ['action', 'push', 'eosio.token', 'transfer', JSON.stringify(transferData)];
    const wrong = await runCli([...args, '--expect-chain-id', 'cd'.repeat(32), '--key', 'missing'], env);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /does not match the expected chain ID/);
    assert.deepEqual(requests, []);
    const right = await runCli([...args, '--expect-chain-id', chainId, '--key', 'fixture'], env);
    assert.equal(right.code, 0, right.stderr);
    assert.deepEqual(requests, ['/v1/chain/send_transaction']);
});
