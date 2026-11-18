import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { resourceLimits, signalGroup, watchProcessGroups } from './resource-limits.js';
test('foreground process group triggers its configured memory limit', {
    skip: process.platform === 'win32',
    timeout: 5000,
}, async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    await once(child, 'spawn');
    const closed = once(child, 'exit');
    const pid = child.pid;
    let problem;
    const stop = watchProcessGroups(() => [pid], { ...resourceLimits(), memory_bytes: 1 }, (error) => {
        problem = error;
        signalGroup(pid, 'SIGTERM');
    });
    try {
        const [, signal] = await closed;
        assert.equal(signal, 'SIGTERM');
        assert.match(problem?.message ?? '', /exceeded its memory limit/);
    }
    finally {
        stop();
        if (child.exitCode === null && child.signalCode === null)
            signalGroup(pid, 'SIGKILL');
    }
});
