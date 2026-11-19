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
    let preferred;
    const network = {
        identity: 'test/agenttest', models: [{ id: 'flagship', label: 'Qwen3 8B 4-bit' }, { id: 'expert', label: 'Qualified Harness Coder' }],
        baseModel: 'flagship', specialtyModel: id => id === 'harness-coder' ? preferred : undefined, currency: { symbol: 'TEST', precision: 4 },
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
        const input = { requestId: 'a'.repeat(64), name: 'Build reviewer', specialty: 'harness-coder', perRun: 10, total: 100, files: [], secrets: [] };
        assert.equal((await post('/agents', { ...input, specialty: 'unknown' })).status, 400);
        assert.equal((await post('/agents', { ...input, secrets: ['wallet-key'] })).status, 403);
        const owner = { name: 'Ops desk', specialty: 'chief-of-staff', perRun: 10, total: 100, managedAgents: [agent.id] };
        assert.equal((await post('/agents', { ...owner, specialty: 'coder' })).status, 403);
        const chief = await post('/agents', owner).then(response => response.json());
        assert.equal((await post('/agents/' + chief.id + '/quote', { message: 'Review agent status.' })).status, 200);
        const context = JSON.parse(quotedPrompts.at(-1));
        assert.deepEqual(context.managedAgentStatus, [{ id: agent.id, name: 'Reporter', status: 'active' }]);
        assert.equal(context.managedAgentStatus[0].instructions, undefined);
        const specialtyAgent = await post('/agents', input).then(response => response.json());
        assert.equal(specialtyAgent.specialty, 'harness-coder');
        assert.equal(specialtyAgent.specialtyVersion, 1);
        assert.equal(specialtyAgent.model, 'flagship');
        const replayAgent = await post('/agents', input).then(response => response.json());
        assert.equal(replayAgent.id, specialtyAgent.id);
        assert.equal((await post('/agents', { ...input, name: 'Different' })).status, 409);
        const snapshot = await get(`/state/${specialtyAgent.id}`).then(response => response.json());
        assert.equal(snapshot.routines.length, 1);
        assert.equal(snapshot.routines[0].enabled, false);
        assert.equal(snapshot.routines[0].nextAt, null);
        assert.equal((await post(`/agents/${specialtyAgent.id}`, { ...input, specialty: 'researcher' })).status, 409);
        preferred = 'expert';
        const promotedQuote = await post('/agents/' + specialtyAgent.id + '/quote', { message: 'Verify the version.' })
            .then(response => response.json());
        assert.equal(promotedQuote.model, 'expert');
        preferred = undefined;
        assert.equal((await post('/confirm/' + promotedQuote.id, {})).status, 409);
        const specialtyQuote = await post(`/agents/${specialtyAgent.id}/quote`, { message: 'Verify the requested behavior.' })
            .then(response => response.json());
        assert.match(JSON.parse(quotedPrompts.at(-1)).specialtyInstructions, /Harness/);
        const specialtyRun = await post(`/confirm/${specialtyQuote.id}`, {}).then(response => response.json());
        const feedbackPath = `/runs/${specialtyRun.id}/feedback`;
        const vote = { kind: 'answer', rating: 'up', policy: 'harbor.agent-feedback.v1', correction: 'Check the contract.' };
        assert.equal(specialtyRun.specialty, 'harness-coder');
        assert.equal(specialtyRun.model, 'flagship');
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
        const clearPath = '/agents/' + specialtyAgent.id + '/clear-feedback';
        assert.equal((await post(clearPath, {}, request.token)).status, 401);
        assert.equal((await post(clearPath, {})).status, 200);
        const cleared = await get('/state/' + specialtyAgent.id).then(response => response.json());
        assert.deepEqual(cleared.feedback, []);
    }
    finally {
        await new Promise(resolve => server.close(() => resolve()));
        worker.close();
        await rm(temp, { recursive: true, force: true });
    }
});
test('the local worker runs a confirmed specialty without chain credentials or paid inference', async (t) => {
    const { randomUUID } = await import('node:crypto');
    const { spawn } = await import('node:child_process');
    const { createServer } = await import('node:http');
    const { writeFile } = await import('node:fs/promises');
    const { setTimeout: delay } = await import('node:timers/promises');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-local-agents-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const model = 'qwen3:8b-q4_K_M';
    const revision = 'f'.repeat(64);
    let seen = 0;
    const upstream = createServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/api/tags') {
            response.end(JSON.stringify({ models: [{ name: model, digest: revision,
                        details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' } }] }));
            return;
        }
        assert.equal(request.url, '/api/chat');
        const parts = [];
        for await (const chunk of request)
            parts.push(chunk);
        const data = JSON.parse(Buffer.concat(parts).toString());
        assert.equal(data.model, model);
        assert.equal(data.stream, false);
        assert.match(data.messages[0].content, /Harness/);
        assert.equal(data.messages.at(-1).content, 'Review the local checks.');
        seen++;
        response.end(JSON.stringify({ model, done: true, message: { content: 'Local response' } }));
    }).listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => upstream.close(() => resolve())));
    await once(upstream, 'listening');
    const address = upstream.address();
    assert.ok(address && typeof address === 'object');
    const spare = createServer().listen(0, '127.0.0.1');
    await once(spare, 'listening');
    const bind = spare.address();
    assert.ok(bind && typeof bind === 'object');
    await new Promise(resolve => spare.close(() => resolve()));
    const options = path.join(directory, 'worker.json');
    await writeFile(options, JSON.stringify({ mode: 'local', account: 'localagent',
        ollama: 'http://127.0.0.1:' + address.port, modelRevision: revision }));
    const token = randomBytes(32).toString('base64url');
    const workerProcess = spawn(process.execPath, ['lib/index.js', 'agents', 'serve', '--config', options,
        '--db', path.join(directory, 'agent.sqlite'), '--port', String(bind.port)], {
        cwd: new URL('../../', import.meta.url), env: { PATH: '/usr/bin:/bin', HARBOR_AGENT_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const launched = once(workerProcess, 'spawn');
    let exited = false;
    const stopped = once(workerProcess, 'exit').then(([status]) => { exited = true; return status; });
    let startupError = '';
    workerProcess.stderr.on('data', chunk => { startupError += String(chunk); });
    const endpoint = 'http://127.0.0.1:' + bind.port + '/v1';
    const call = (resource, data) => fetch(endpoint + resource, {
        method: data ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: data ? JSON.stringify(data) : undefined,
    });
    try {
        await launched;
        let state;
        for (let i = 0; i < 40 && !exited; i++) {
            state = await call('/state').then(response => response.json()).catch(() => undefined);
            if (state)
                break;
            await delay(25);
        }
        assert.equal(state?.execution, 'local', startupError);
        const input = { name: 'Harness fixture', specialty: 'harness-coder', perRun: 0, total: 0, requestId: revision };
        assert.equal((await call('/agents', { ...input, files: [randomUUID().replaceAll('-', '').repeat(2)] })).status, 403);
        const agent = await call('/agents', input).then(response => response.json());
        const quote = await call('/agents/' + agent.id + '/quote', { message: 'Review the local checks.' })
            .then(response => response.json());
        assert.equal(quote.maxCost, 0);
        assert.equal(seen, 0);
        const run = await call('/confirm/' + quote.id, {}).then(response => response.json());
        let result;
        for (let i = 0; i < 60; i++) {
            result = (await call('/state').then(response => response.json())).runs.find((item) => item.id === run.id);
            if (result.status === 'completed')
                break;
            await delay(50);
        }
        assert.equal(result.status, 'completed');
        assert.equal(result.paid, 0);
        assert.equal(result.inferId, undefined);
        assert.equal(result.modelRevision, revision);
        assert.equal(result.result, 'Local response');
        assert.equal(seen, 1);
    }
    finally {
        if (!exited)
            workerProcess.kill('SIGTERM');
        await stopped;
    }
});
