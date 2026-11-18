import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { Command } from 'commander';
import { NODE_RUNTIME, normalizeServiceName, SERVICE_RUNTIMES } from '../lib/artifacts.js';
import { controlService, installService, registeredService, serviceStatus, superviseRegisteredService } from '../lib/service-manager.js';
import { addRuntimeOptions, validateRuntimeSource } from './run.js';
function printStatus(result, json) {
    if (json)
        console.log(JSON.stringify(result, null, 2));
    else if (Array.isArray(result))
        console.table(result.map(({ service, state, healthy }) => ({ service, state, healthy })));
    else
        console.log(`${result.service} ${result.state}${result.healthy ? ' (healthy)' : ''}`);
}
async function readLog(file, lines, follow) {
    const log = await fs.open(file, 'a', 0o600);
    await log.close();
    const child = spawn('tail', ['-n', String(lines), ...(follow ? ['-F'] : []), file], { stdio: 'inherit' });
    const [code, signal] = await once(child, 'exit');
    if (code !== 0 && !signal)
        throw new Error(`tail exited with status ${code}`);
}
export function createServiceCommand() {
    const command = new Command('service').description('Manage Harbor runtime services using launchd or systemd');
    addRuntimeOptions(command.command('install <service>').description('Register a service with the user service manager'))
        .option('--system', 'use the Linux system service manager')
        .action(async (name, options) => {
        validateRuntimeSource(options.source);
        const result = await installService(normalizeServiceName(name), options, [process.execPath, process.argv[1]], options.system);
        if (options.json || options.dryRun)
            console.log(JSON.stringify(result, null, 2));
        else
            console.log(`Installed ${result.plan.service} with ${result.manager}`);
    });
    command.command('status [service]').description('Show installed, running, and healthy state')
        .option('--json', 'print JSON output')
        .option('--system', 'use the Linux system service manager')
        .action(async (name, options) => {
        const result = name ? await serviceStatus(normalizeServiceName(name), options.system)
            : await Promise.all([NODE_RUNTIME, ...SERVICE_RUNTIMES].map((service) => serviceStatus(service, options.system)));
        printStatus(result, Boolean(options.json));
    });
    for (const action of ['start', 'stop', 'restart', 'uninstall']) {
        command.command(`${action} <service>`)
            .description(`${action[0].toUpperCase()}${action.slice(1)} a registered service`)
            .option('--json', 'print JSON output')
            .option('--system', 'use the Linux system service manager')
            .action(async (name, options) => printStatus(await controlService(normalizeServiceName(name), action, options.system), Boolean(options.json)));
    }
    command.command('logs <service>').description('Read a registered service log')
        .option('-n, --lines <count>', 'number of lines to show', '50')
        .option('-f, --follow', 'follow the log')
        .option('--supervisor', 'read the service manager startup log')
        .option('--system', 'use the Linux system service manager')
        .action(async (name, options) => {
        const lines = Number(options.lines);
        if (!Number.isSafeInteger(lines) || lines < 0)
            throw new Error('--lines must be a nonnegative integer');
        const { plan, spec } = await registeredService(normalizeServiceName(name), options.system);
        if (options.supervisor && spec.manager === 'systemd') {
            const child = spawn('journalctl', [...(spec.system ? [] : ['--user']), '--unit', `${spec.id}.service`, '--no-pager', '-n', String(lines), ...(options.follow ? ['-f'] : [])], { stdio: 'inherit' });
            const [code, signal] = await once(child, 'exit');
            if (code !== 0 && !signal)
                throw new Error(`journalctl exited with status ${code}`);
            return;
        }
        await readLog(options.supervisor ? `${plan.log}.supervisor` : plan.log, lines, Boolean(options.follow));
    });
    command.command('supervise <registration>', { hidden: true }).action(superviseRegisteredService);
    return command;
}
