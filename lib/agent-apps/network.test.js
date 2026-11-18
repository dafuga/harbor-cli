import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { PrivateKey } from '@wharfkit/antelope';
import { HarborNetwork, routerSignature } from './network.js';
import { HARBOR_TESTNET, harborConfig } from './config.js';
import { sha256 } from './http.js';
const flagship = {
    id: 'flagship', label: 'Qwen3 8B 4-bit', family: 'Qwen3-8B', bits: 4, weights: 'MLX',
    kind: 'flagship', computeClass: 1, modelId: '1', programId: '1', policyId: '1', revision: 'a'.repeat(64),
};
const profile = {
    chainId: HARBOR_TESTNET, rpc: 'http://127.0.0.1:18900', router: 'http://127.0.0.1:9113',
    checker: 'http://127.0.0.1:9114/check', account: 'agenttest', permission: 'agentapps',
    key: 'mock', currency: { symbol: 'TEST', precision: 4 }, models: [flagship],
};
const agent = {
    id: 'agent', name: 'Reviewer', instructions: 'Read the project summary', revision: 1, status: 'active',
    model: 'flagship', perRun: 100, total: 500, files: ['f'.repeat(64)], secrets: [],
};
test('only Qwen3 8B 4-bit and exact-base LoRA experts are admitted', () => {
    assert.equal(harborConfig(profile).models[0].kind, 'flagship');
    assert.throws(() => harborConfig({ ...profile, models: [{ ...flagship, family: 'Qwen3-27B' }] }), /Qwen3 8B/);
    assert.throws(() => harborConfig({ ...profile, models: [{ ...flagship, family: 'Qwen3-4B' }] }), /Qwen3 8B/);
    const expert = { ...flagship, id: 'review', kind: 'lora', revision: 'b'.repeat(64), baseRevision: 'c'.repeat(64) };
    assert.throws(() => harborConfig({ ...profile, models: [flagship, expert] }), /exact base/);
    assert.equal(harborConfig({ ...profile, models: [flagship, { ...expert, baseRevision: flagship.revision }] }).models.length, 2);
    assert.throws(() => harborConfig({ ...profile, chainId: '18f03ef8'.padEnd(64, '0') }), /testnet/);
    assert.throws(() => harborConfig({ ...profile, permission: 'active' }), /dedicated/);
});
test('HRA3 gateway authentication matches the Harbor router golden vector', () => {
    assert.equal(routerSignature('gateway-golden-secret', 'airouter-unit', 'alice', '/ai/infer', 1784246400, 'nonce-golden-0001', '{"user":"alice"}'), '69c6ee9eab873b41ca869f76a690c1b16c35e01beb6a054970c7e34479821f30');
});
test('quotes without the prompt, submits once, verifies the exact provider commitment and scopes the checker', async () => {
    const privateKey = PrivateKey.generate('K1');
    const publicKey = privateKey.toPublic();
    const signal = AbortSignal.timeout(10_000);
    const actions = [];
    const owner = profile.account;
    const prompt = '{"user":"Review the file"}';
    const promptHash = sha256(prompt);
    const result = JSON.stringify({ text: 'The review is ready.', calls: [{ name: 'read_file', resource: agent.files[0] }] });
    const provider = JSON.stringify({ result });
    const key = { key: String(publicKey), weight: 1 };
    const job = { id: '7', requester: owner, provider: 'provider', status: 0, prompt_hash: promptHash,
        result_hash: sha256(provider), paid_fee: '0.0030 TEST' };
    let blocked = false;
    let malformed = false;
    let extraLink = false;
    const upstream = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req)
            chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let data;
        switch (req.url) {
            case '/v1/chain/get_info':
                data = { chain_id: HARBOR_TESTNET };
                break;
            case '/v1/chain/get_account':
                data = { permissions: [{ perm_name: 'agentapps', required_auth: { threshold: 1, keys: [key] },
                            linked_actions: ['reqroute', 'commitseed', 'ackinfer', 'canceljob', ...(extraLink ? ['reqinfer'] : [])]
                                .map(action => ({ account: 'harborai', action })) }] };
                break;
            case '/v1/chain/get_table_rows':
                data = { rows: body.table === 'models'
                        ? [{ id: '1', status: 1, model_type: 1, parent_model_id: '0' }]
                        : body.table === 'modelmanifs'
                            ? [{ model_id: '1', source_type: 1, capabilities: 1, revision_hash: flagship.revision }]
                            : [job], more: false };
                if (body.index_position === '3')
                    assert.equal(body.key_type, 'i64');
                break;
            case '/ai/route':
            case '/ai/infer': {
                if (req.url === '/ai/route') {
                    assert.equal(body.prompt, undefined);
                }
                else {
                    assert.equal(sha256(body.prompt), promptHash);
                    assert.deepEqual(actions.slice(-2), ['reqroute', 'commitseed']);
                    job.status = 5;
                }
                const route = { ok: true, selected_model_id: '1', model_revision: flagship.revision, deployment_id: '4',
                    request_hash: promptHash, gross_inference_fee_ceiling: '0.0100 TEST', selected_provider: { account: 'provider' } };
                if (req.url === '/ai/infer') {
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify(route).slice(0, -1) + ',"provider_result":' + (malformed ? '{"result":"tampered"}' : provider) + '}');
                    return;
                }
                data = route;
                break;
            }
            default:
                assert.fail('Unexpected RPC path.');
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(data));
    }).listen(0, '127.0.0.1');
    const checker = createServer(async (req, res) => {
        const parts = [];
        for await (const chunk of req)
            parts.push(chunk);
        const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
        assert.equal(body.tool_call.resource, agent.files[0]);
        assert.equal(req.headers.authorization, 'Bearer test-checker-token');
        res.end(JSON.stringify({ approved: !blocked, call_hash: body.call_hash }));
    }).listen(0, '127.0.0.1');
    await Promise.all([once(upstream, 'listening'), once(checker, 'listening')]);
    const base = (server) => {
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        return `http://127.0.0.1:${address.port}`;
    };
    const config = harborConfig({ ...profile, rpc: base(upstream), router: base(upstream), checker: base(checker) + '/check' }, { HARBOR_AGENT_CHECKER_TOKEN: 'test-checker-token' });
    const transact = async (input) => {
        assert.equal(input.expectChainId, HARBOR_TESTNET);
        assert.equal(input.actor, owner);
        assert.equal(input.permission, profile.permission);
        actions.push(input.action);
        if (input.action === 'reqroute') {
            assert.equal(input.data.max_fee, '0.0100 TEST');
            job.status = 0;
        }
        if (input.action === 'ackinfer')
            job.status = 1;
        return { transaction_id: 'a'.repeat(64), response: undefined, status: 'executed' };
    };
    try {
        const network = new HarborNetwork(config, { publicKey, async sign() { throw new Error('fixture signs no transactions'); } }, transact);
        await network.ready();
        extraLink = true;
        await assert.rejects(network.ready(), /exact HarborAI/);
        extraLink = false;
        const price = await network.quote(agent, prompt, 100, signal);
        assert.deepEqual(price, { maxCost: 100, deployment: '4' });
        assert.deepEqual(actions, []);
        let started = 0;
        const request = { agent, prompt, price, signal, starting: () => started++, assertActive: () => { },
            submitted: (id) => assert.equal(id, '7') };
        const delivery = await network.execute(request);
        assert.equal(started, 1);
        assert.equal(delivery.text, 'The review is ready.');
        assert.equal(delivery.paid, 30);
        assert.deepEqual(actions, ['reqroute', 'commitseed', 'ackinfer']);
        const context = { runId: 'any', inferId: '7', prompt, response: delivery.text };
        assert.match(await network.verify(delivery.calls[0], context, signal), /^[a-f0-9]{64}$/);
        blocked = true;
        await assert.rejects(network.verify(delivery.calls[0], context, signal), /rejected/);
        malformed = true;
        await assert.rejects(network.execute(request), /no matching on-chain/);
        assert.equal(actions.filter(action => action === 'ackinfer').length, 1);
        job.status = 3;
        const run = { inferId: '7', promptHash };
        assert.equal(await network.reconcile(run, agent, signal), 0);
        assert.equal(await network.reconcile({ ...run, promptHash: 'c'.repeat(64) }, agent, signal), null);
    }
    finally {
        await Promise.all([upstream, checker].map(server => new Promise(resolve => server.close(() => resolve()))));
    }
});
