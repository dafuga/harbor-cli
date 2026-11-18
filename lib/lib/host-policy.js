import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isWsl } from './runtime-host.js';
const exec = promisify(execFile);
const GiB = 2 ** 30;
async function read(file) {
    return fs.readFile(file, 'utf8').then((value) => value.trim()).catch(() => '');
}
async function command(file, args) {
    return exec(file, args, { timeout: 2000, maxBuffer: 1024 * 1024 }).then(({ stdout }) => stdout).catch(() => '');
}
export async function hostState() {
    if (process.platform === 'darwin') {
        const [battery, thermal, input] = await Promise.all([
            command('/usr/bin/pmset', ['-g', 'batt']),
            command('/usr/bin/pmset', ['-g', 'therm']),
            command('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-r', '-d', '1']),
        ]);
        const idle = input.match(/"HIDIdleTime"\s*=\s*(\d+)/)?.[1];
        const speed = thermal.match(/CPU_Speed_Limit\s*=\s*(\d+)/)?.[1];
        return {
            on_battery: battery ? battery.includes("'Battery Power'") : null,
            active: idle ? Number(idle) < 5 * 60 * 1e9 : null,
            hot: thermal ? (Boolean(speed && Number(speed) < 80) || /thermal pressure.*(?:serious|critical)/i.test(thermal)) : null,
            available_memory_bytes: os.freemem(),
        };
    }
    const supplies = await fs.readdir('/sys/class/power_supply').catch(() => []);
    const zones = await fs.readdir('/sys/class/thermal').catch(() => []);
    const [battery, temperatures, idle, memory, windowsPower] = await Promise.all([
        Promise.all(supplies.map((name) => read(`/sys/class/power_supply/${name}/status`))),
        Promise.all(zones.filter((zone) => zone.startsWith('thermal_zone')).map(async (zone) => {
            const type = await read(`/sys/class/thermal/${zone}/type`);
            return /cpu|pkg|soc|acpi|x86_pkg/i.test(type) ? read(`/sys/class/thermal/${zone}/temp`) : '';
        })),
        command('loginctl', ['show-user', String(process.getuid?.()), '--property=IdleHint', '--value']),
        read('/proc/meminfo'),
        isWsl()
            ? command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus'])
            : '',
    ]);
    const available = memory.match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1];
    return {
        on_battery: ['Online', 'Offline'].includes(windowsPower.trim()) ? windowsPower.trim() === 'Offline'
            : battery.some(Boolean) ? battery.some((value) => value === 'Discharging') : null,
        active: idle.trim() === 'yes' ? false : idle.trim() === 'no' ? true : null,
        hot: temperatures.some(Boolean) ? temperatures.some((value) => Number(value) >= 85_000) : null,
        available_memory_bytes: available ? Number(available) * 1024 : os.freemem(),
    };
}
export function hostPolicy(state, idleOnly) {
    let blocked;
    if (state.on_battery)
        blocked = 'host is on battery';
    else if (state.hot)
        blocked = 'host is thermally constrained';
    else if (state.available_memory_bytes < GiB)
        blocked = 'less than 1 GiB of host memory is available';
    else if (idleOnly && state.active !== false)
        blocked = 'training requires confirmed user inactivity';
    return { blocked, cpuScale: state.active ? 0.5 : 1 };
}
export async function checkDiskFloor(directory) {
    let probe = path.resolve(directory);
    for (;;) {
        try {
            const info = await fs.statfs(probe, { bigint: true });
            if (info.bavail * info.bsize < 2n * BigInt(GiB))
                throw new Error(`less than 2 GiB of disk space is available at ${probe}`);
            return;
        }
        catch (error) {
            const parent = path.dirname(probe);
            if (error.code !== 'ENOENT' || parent === probe)
                throw error;
            probe = parent;
        }
    }
}
export async function gpuCapacity() {
    if (process.platform === 'darwin' && process.arch === 'arm64')
        return { kind: 'apple-unified', bytes: os.totalmem() };
    const result = await command('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits']);
    const sizes = result.trim().split(/\s+/).map(Number).filter((value) => value > 0);
    return sizes.length ? { kind: 'nvidia', bytes: Math.max(...sizes) * 2 ** 20 } : { kind: 'cpu-or-undetected', bytes: null };
}
