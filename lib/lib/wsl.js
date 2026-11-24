import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export function parseWslDistributions(output) {
    const text = output.toString(output.includes(0) ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
    return text.split(/\r?\n/).flatMap((line) => {
        const row = line.match(/^\s*(\*?)\s+(.+?)\s{2,}\S.*?\s{2,}([12])\s*$/);
        if (!row)
            return [];
        return [{ name: row[2], version: row[3] === '2' ? 2 : 1, default: row[1] === '*' }];
    });
}
export async function wslDistributions() {
    const { stdout } = await exec('wsl.exe', ['--list', '--verbose'], { encoding: 'buffer', windowsHide: true, timeout: 10_000 });
    return parseWslDistributions(stdout);
}
export function selectWslDistribution(distributions, name = process.env.HARBOR_WSL_DISTRO) {
    if (name)
        return distributions.find((item) => item.name === name && item.version === 2);
    return distributions.find((item) => item.default && item.version === 2) ?? distributions.find((item) => item.version === 2);
}
export async function runInWsl(args) {
    const distributions = await wslDistributions().catch(() => []);
    const distribution = selectWslDistribution(distributions);
    if (!distribution)
        throw new Error('No eligible WSL2 distribution found. Run harbor doctor for Windows setup.');
    const harbor = process.env.HARBOR_WSL_CLI ?? 'harbor';
    const child = spawn('wsl.exe', ['--distribution', distribution.name, '--cd', '~', '--exec', harbor, ...args], { stdio: 'inherit' });
    const [code] = await once(child, 'exit');
    process.exitCode = code ?? 1;
}
