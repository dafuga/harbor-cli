import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
const source = {
    name: 'Project review', instructions: 'Identify open decisions.', model: 'flagship',
    perRun: 100, total: 150, files: ['a'.repeat(64)], secrets: [],
};
test('the worker persists scheduled and triggered runs, reserves spend, and verifies tools first', async () => {
    const { AgentWorker } = await import('./worker.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'harbor-agent-test-'));
    const file = path.join(dir, 'agent.sqlite');
    const actions = [];
    let now = Date.UTC(2026, 10, 18);
    let request = 0;
    const network = {
        models: [{ id: 'flagship', label: 'Qwen3 8B 4-bit' }],
        currency: { symbol: 'TEST', precision: 4 },
        async quote() { return { maxCost: 100, deployment: '1' }; },
        async execute({ starting, submitted }) {
            starting();
            actions.push('inference');
            submitted(String(++request));
            return { text: 'Result', calls: [{ name: 'read_file', resource: 'a'.repeat(64) }], paid: 30 };
        },
        async reconcile() { return 30; },
        async verify() { actions.push('verified'); return 'b'.repeat(64); },
        async readFile() { actions.push('read'); return 'Project files'; },
        async useSecret() { throw new Error('Unexpected secret tool'); },
    };
    const workers = [];
    const open = () => {
        const worker = new AgentWorker(file, 'Test worker', network, () => now);
        workers.push(worker);
        return worker;
    };
    try {
        const first = open();
        const agent = first.createAgent(source);
        const quote = await first.quote(agent.id, 'Review the daily notes');
        assert.equal(quote.maxCost, 100);
        assert.deepEqual(actions, []);
        const chat = first.confirm(quote.id);
        assert.equal(first.confirm(quote.id).id, chat.id);
        const scheduled = first.createRoutine(agent.id, {
            kind: 'interval', name: 'Daily review', prompt: 'Review today', intervalMinutes: 1, maxCost: 100,
        });
        const triggered = first.createRoutine(agent.id, {
            kind: 'trigger', name: 'Review on request', prompt: 'Review now', maxCost: 100,
        });
        assert.ok(triggered.token);
        assert.throws(() => first.trigger(triggered.routine.id, 'invalid', 'event-1'), /invalid trigger/i);
        const hook = first.trigger(triggered.routine.id, triggered.token, 'event-1');
        assert.equal(first.trigger(triggered.routine.id, triggered.token, 'event-1').id, hook.id);
        first.close();
        now += 60_000;
        const restarted = open();
        await restarted.tick();
        await restarted.tick();
        await restarted.tick();
        const { runs, audit } = restarted.snapshot(agent.id);
        assert.equal(runs.filter(run => run.routineId === scheduled.routine.id).length, 1);
        assert.equal(runs.find(run => run.id === chat.id)?.status, 'completed');
        assert.equal(runs.find(run => run.id === hook.id)?.status, 'completed');
        assert.equal(runs.find(run => run.routineId === scheduled.routine.id)?.status, 'blocked');
        assert.deepEqual(actions, ['inference', 'verified', 'read', 'inference', 'verified', 'read']);
        assert.ok(audit.some(entry => entry.event === 'tool_executed'));
        assert.ok(audit.every(entry => Number.isSafeInteger(entry.id)));
        assert.equal(new Set(audit.map(entry => entry.id)).size, audit.length);
        restarted.setStatus(agent.id, 'paused');
        assert.throws(() => restarted.trigger(triggered.routine.id, triggered.token, 'event-2'), /paused/i);
        restarted.setStatus(agent.id, 'killed');
        assert.throws(() => restarted.setStatus(agent.id, 'active'), /killed/i);
    }
    finally {
        for (const worker of workers)
            worker.close();
        await rm(dir, { recursive: true, force: true });
    }
});
test('a paused in-flight run retains its reservation without rebroadcast across workers', async () => {
    const { AgentWorker } = await import('./worker.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'harbor-agent-reservation-'));
    const file = path.join(dir, 'agent.sqlite');
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const network = {
        models: [{ id: 'flagship', label: 'Qwen3 8B 4-bit' }],
        currency: { symbol: 'TEST', precision: 4 },
        async quote(_agent, _prompt, budget) {
            if (budget < 100)
                throw new Error('Insufficient budget');
            return { maxCost: 100, deployment: '1' };
        },
        async execute({ starting, submitted, signal }) {
            starting();
            submitted('7');
            markStarted();
            return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        },
        async reconcile() { return 30; },
        async verify() { throw new Error('Unexpected verifier'); },
        async readFile() { throw new Error('Unexpected file read'); },
        async useSecret() { throw new Error('Unexpected secret use'); },
    };
    const first = new AgentWorker(file, 'Studio worker', network);
    const second = new AgentWorker(file, 'Studio worker', network);
    try {
        const agent = first.createAgent(source);
        const original = first.confirm((await first.quote(agent.id, 'First authorized task')).id);
        const queued = second.confirm((await second.quote(agent.id, 'Second authorized task')).id);
        const working = first.tick();
        await started;
        await second.tick();
        assert.equal(second.snapshot(agent.id).runs.find(run => run.id === queued.id)?.status, 'queued');
        first.setStatus(agent.id, 'paused');
        await working;
        const snapshot = second.snapshot(agent.id);
        assert.equal(snapshot.runs.find(run => run.id === original.id)?.status, 'needs_attention');
        assert.equal(snapshot.runs.find(run => run.id === queued.id)?.status, 'cancelled');
        assert.equal(snapshot.agents[0].reserved, 100);
        first.close();
        assert.equal((await second.reconcile(original.id)).paid, 30);
        assert.equal(second.snapshot(agent.id).agents[0].reserved, 0);
        assert.equal(second.snapshot(agent.id).audit.filter(entry => entry.event === 'inference_dispatch').length, 1);
    }
    finally {
        first.close();
        second.close();
        await rm(dir, { recursive: true, force: true });
    }
});
