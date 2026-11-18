import { execFile } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const SAMPLE_MS = 500;
function percent(value, name) {
    const number = value === undefined ? 40 : Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 100) {
        throw new Error(`${name} must be an integer from 1 to 100`);
    }
    return number;
}
export function resourceLimits(options = {}) {
    const cpu_percent = percent(options.cpuPercent, '--cpu-percent');
    const memory_percent = percent(options.memoryPercent, '--memory-percent');
    return {
        cpu_percent,
        memory_percent,
        cpu_cores: os.availableParallelism() * cpu_percent / 100,
        memory_bytes: Math.floor(os.totalmem() * memory_percent / 100),
    };
}
function cpuSeconds(time) {
    // BSD uses minutes:seconds.hundredths, while procps can include hours or days.
    const [clock, days = '0'] = time.split('-').reverse();
    return Number(days) * 86400 + clock.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
}
export function signalGroup(pid, signal) {
    try {
        process.kill(-pid, signal);
    }
    catch (error) {
        if (error.code !== 'ESRCH')
            throw error;
    }
}
export function watchProcessGroups(groups, limits, onError) {
    let stopped = false;
    let cancelled = false;
    let timer;
    let previous = new Map();
    let sampledAt = performance.now();
    let credit = 0;
    async function sample() {
        try {
            const { stdout } = await exec('/bin/ps', ['-A', '-o', 'pid=,pgid=,rss=,time='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
            if (cancelled)
                return;
            const pids = groups();
            let rss = 0;
            let used = 0;
            const next = new Map();
            for (const line of stdout.trim().split('\n')) {
                const [id, group, kib, time] = line.trim().split(/\s+/);
                if (!pids.includes(Number(group)))
                    continue;
                const member = Number(id);
                const cpu = cpuSeconds(time);
                next.set(member, cpu);
                used += Math.max(0, cpu - (previous.get(member) ?? 0));
                rss += Number(kib) * 1024;
            }
            if (rss > limits.memory_bytes) {
                throw new Error(`Harbor service exceeded its memory limit (${rss} / ${limits.memory_bytes} bytes RSS)`);
            }
            const now = performance.now();
            const intervalBudget = (now - sampledAt) / 1000 * limits.cpu_cores;
            credit = Math.min(intervalBudget, credit + intervalBudget - used);
            sampledAt = now;
            previous = next;
            if ((credit < 0) !== stopped) {
                stopped = credit < 0;
                for (const pid of pids)
                    signalGroup(pid, stopped ? 'SIGSTOP' : 'SIGCONT');
            }
            timer = setTimeout(sample, SAMPLE_MS);
        }
        catch (error) {
            if (!cancelled)
                onError(error);
        }
    }
    timer = setTimeout(sample, SAMPLE_MS);
    return () => {
        cancelled = true;
        clearTimeout(timer);
        if (stopped)
            for (const pid of groups())
                signalGroup(pid, 'SIGCONT');
    };
}
