import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { workerServer } from './server.js';
import { AgentWorker } from './worker.js';
test('worker and trigger credentials are isolated, with no token in URLs or state', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'harbor-worker-http-'));
    const network = {
        identity: 'test/agenttest', models: [{ id: 'flagship', label: 'Qwen3 8B 4-bit' }], currency: { symbol: 'TEST', precision: 4 },
        async quote() { return { maxCost: 10, deployment: '1' }; },
        async execute() { throw new Error('Fixture has no network'); },
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
        const replacement = await post(`/agents/${agent.id}/quote`, { message: 'Replacement', replaceOpen: true })
            .then(response => response.json());
        assert.equal((await post(`/confirm/${quote.id}`, {})).status, 409);
        const legacy = await post(`/agents/${agent.id}/quote`, { message: 'Independent legacy quote' })
            .then(response => response.json());
        const quoted = await get(`/state/${agent.id}`).then(response => response.json());
        assert.deepEqual(quoted.quotes, [legacy, replacement]);
        assert.equal('input' in quoted.quotes[0], false);
        assert.equal((await post(`/cancel/${legacy.id}`, {})).status, 200);
        assert.equal((await post(`/cancel/${replacement.id}`, {})).status, 200);
        assert.equal((await post(`/confirm/${quote.id}`, {})).status, 409);
        const next = await post(`/agents/${agent.id}/quote`, { message: 'Another update' }).then(response => response.json());
        assert.equal((await post(`/confirm/${next.id}`, {})).status, 202);
        assert.equal((await post(`/cancel/${next.id}`, {})).status, 409);
        assert.deepEqual((await get(`/state/${agent.id}`).then(response => response.json())).quotes, []);
        const scheduled = await post(`/agents/${agent.id}/routines`, {
            name: 'Review schedule', prompt: 'Check status', kind: 'interval', intervalMinutes: 15, maxCost: 10, enabled: false,
        }).then(response => response.json());
        assert.equal(scheduled.routine.enabled, false);
        assert.equal(scheduled.routine.nextAt, null);
        const enabled = await post(`/routines/${scheduled.routine.id}`, { enabled: true }).then(response => response.json());
        assert.equal(enabled.enabled, true);
        assert.ok(enabled.nextAt > Date.now());
        const bytes = Buffer.from(JSON.stringify({
            name: 'Reviewed author', instructions: 'Write a verified report', model: 'flagship',
            perRun: 20, total: 100, files: ['a'.repeat(64)], secrets: ['mock-grant'],
        }));
        const sha256 = (value) => createHash('sha256').update(value).digest('hex');
        const receipt = Buffer.from(JSON.stringify({
            schema: 1, runId: 'run-1', sourceCommit: 'b'.repeat(40), profile: 'harbor-agent',
            verification: { build: 'passed', test: 'passed' },
            artifact: { format: 'harbor-agent-definition', sha256: sha256(bytes), base64: bytes.toString('base64') },
        }));
        const importedBody = { receipt: receipt.toString('base64'), approvedSha256: sha256(receipt) };
        assert.equal((await post('/import', { ...importedBody, approvedSha256: '0'.repeat(64) })).status, 409);
        const importedResponse = await post('/import', importedBody);
        assert.equal(importedResponse.status, 201);
        const imported = await importedResponse.json();
        assert.equal(imported.status, 'paused');
        assert.equal((await post(`/agents/${imported.id}/quote`, { message: 'No implicit approval' })).status, 409);
        assert.equal((await post('/import', importedBody).then(response => response.json())).id, imported.id);
        const reviewed = await get(`/state/${imported.id}`).then(response => response.json());
        assert.deepEqual(reviewed.agents[0].files, ['a'.repeat(64)]);
        assert.deepEqual(reviewed.agents[0].secrets, ['mock-grant']);
        assert.equal(reviewed.audit.filter((entry) => entry.event === 'agent_imported').length, 1);
        assert.equal(reviewed.runs.length, 0);
        assert.equal((await post(`/agents/${imported.id}/status`, { status: 'active' })).status, 200);
        assert.equal((await post(`/agents/${imported.id}/quote`, { message: 'Quote only after activation' })).status, 200);
    }
    finally {
        await new Promise(resolve => server.close(() => resolve()));
        worker.close();
        await rm(temp, { recursive: true, force: true });
    }
});
