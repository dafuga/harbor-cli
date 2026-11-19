import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { workerServer } from './server.js';
import { AgentWorker } from './worker.js';
test('worker and trigger credentials are isolated, with no token in URLs or state', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'harbor-worker-http-'));
    const quotedPrompts = [];
    const network = {
        identity: 'test/agenttest', models: [{ id: 'flagship', label: 'Qwen3 8B 4-bit' }], currency: { symbol: 'TEST', precision: 4 },
        async quote(_agent, prompt) { quotedPrompts.push(prompt); return { maxCost: 10, deployment: '1' }; },
        async execute({ starting, submitted }) {
            starting();
            submitted('1');
            return { text: 'Fixture response', calls: [], paid: 5 };
        },
        async reconcile() { return null; },
        async verify() { throw new Error('Unexpected verifier'); },
        async readFile() { throw new Error('Unexpected file read'); },
        async useSecret() { throw new Error('Unexpected secret operation'); },
    };
    const worker = new AgentWorker(path.join(temp, 'worker.sqlite'), 'Fixture host', network);
    const token = randomBytes(32).toString('base64url');
    const server = workerServer(worker, token).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/v1`;
    const get = (resource, credential = token, identity = network.identity) => fetch(base + resource, { headers: { authorization: 'Bearer ' + credential, 'x-harbor-agent-identity': identity } });
    const post = (resource, data, credential = token) => fetch(base + resource, {
        method: 'POST', headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' }, body: JSON.stringify(data),
    });
    try {
        assert.equal((await get('/state', '')).status, 401);
        assert.equal((await get('/state', token, 'another-network')).status, 409);
        assert.equal((await get('/state?auth=placeholder', '')).status, 404);
        const agent = await post('/agents', { name: 'Reporter', instructions: 'Write notes', model: 'flagship',
            perRun: 10, total: 100, files: [], secrets: [] }).then(response => response.json());
        assert.match(agent.id, /^[a-f0-9-]{36}$/);
        const request = await post(`/agents/${agent.id}/routines`, { name: 'Run on request', prompt: 'Write notes',
            kind: 'trigger', maxCost: 10 }).then(response => response.json());
        assert.ok(request.token);
        const state = await get('/state').then(response => response.text());
        assert.equal(state.includes(request.token), false);
        assert.equal(state.includes(token), false);
        assert.equal(state.includes('credential'), false);
        assert.equal((await get('/state', request.token)).status, 401);
        assert.equal((await post(`/triggers/${request.routine.id}`, { eventId: 'first' })).status, 401);
        const first = await post(`/triggers/${request.routine.id}`, { eventId: 'first' }, request.token).then(response => response.json());
        assert.deepEqual(Object.keys(first).sort(), ['id', 'status']);
        const replay = await post(`/triggers/${request.routine.id}`, { eventId: 'first' }, request.token).then(response => response.json());
        assert.equal(replay.id, first.id);
        const quote = await post(`/agents/${agent.id}/quote`, { message: 'Draft an update' }).then(response => response.json());
        assert.equal(quote.maxCost, 10);
        assert.equal((await post(`/confirm/${quote.id}`, {})).status, 202);
        const catalog = await get('/state').then(response => response.json());
        assert.deepEqual(catalog.specialties?.map((item) => item.id), ['researcher', 'chief-of-staff', 'coder', 'harness-coder']);
        const input = { name: 'Build reviewer', specialty: 'harness-coder', perRun: 10, total: 100, files: [], secrets: [] };
        assert.equal((await post('/agents', { ...input, specialty: 'unknown' })).status, 400);
        assert.equal((await post('/agents', { ...input, secrets: ['wallet-key'] })).status, 403);
        const specialtyAgent = await post('/agents', input).then(response => response.json());
        assert.equal(specialtyAgent.specialty, 'harness-coder');
        assert.equal(specialtyAgent.specialtyVersion, 1);
        assert.equal(specialtyAgent.model, 'flagship');
        const snapshot = await get(`/state/${specialtyAgent.id}`).then(response => response.json());
        assert.equal(snapshot.routines.length, 1);
        assert.equal(snapshot.routines[0].enabled, false);
        assert.equal(snapshot.routines[0].nextAt, null);
        assert.equal((await post(`/agents/${specialtyAgent.id}`, { ...input, specialty: 'researcher' })).status, 409);
        const specialtyQuote = await post(`/agents/${specialtyAgent.id}/quote`, { message: 'Verify the requested behavior.' })
            .then(response => response.json());
        assert.match(JSON.parse(quotedPrompts.at(-1)).specialtyInstructions, /Harness/);
        const specialtyRun = await post(`/confirm/${specialtyQuote.id}`, {}).then(response => response.json());
        const feedbackPath = `/runs/${specialtyRun.id}/feedback`;
        const vote = { kind: 'answer', rating: 'up', policy: 'harbor.agent-feedback.v1', correction: 'Check the contract.' };
        assert.equal(specialtyRun.specialty, 'harness-coder');
        assert.equal((await post(feedbackPath, vote, request.token)).status, 401);
        assert.equal((await post(feedbackPath, vote)).status, 409);
        for (let i = 0; i < 3; i++)
            await worker.tick();
        assert.equal((await post(feedbackPath, { ...vote, policy: undefined })).status, 400);
        assert.equal((await post(feedbackPath, vote)).status, 200);
        assert.equal((await post(feedbackPath, { ...vote, rating: 'down' })).status, 200);
        assert.equal((await post(feedbackPath, { ...vote, kind: 'task' })).status, 200);
        const feedback = await get(`/state/${specialtyAgent.id}`).then(response => response.json());
        assert.deepEqual(feedback.feedback.map((item) => [item.kind, item.rating]), [['answer', 'down'], ['task', 'up']]);
        assert.equal((await post(feedbackPath, { kind: 'answer', rating: null })).status, 200);
        const updated = await get(`/state/${specialtyAgent.id}`).then(response => response.json());
        assert.deepEqual(updated.feedback.map((item) => item.kind), ['task']);
    }
    finally {
        await new Promise(resolve => server.close(() => resolve()));
        worker.close();
        await rm(temp, { recursive: true, force: true });
    }
});
