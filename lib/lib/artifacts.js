import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { harborHome } from './config.js';
import { releaseAsset, runtimeTarget } from './runtime-host.js';
import { downloadStoredObjectBytes, resolveStorageObjectByHash, sha256Bytes } from './storage.js';
import { getTableRows } from './tx.js';
export { sha256Bytes } from './storage.js';
export { hostPlatform } from './runtime-host.js';
export const SERVICE_RUNTIMES = [
    { name: 'chainapi', aliases: ['chain-api'], daemon: 'harbor-chainapid', serviceTypeId: 1, portOffset: 0 },
    { name: 'traceapi', aliases: ['trace-api'], daemon: 'harbor-traceapid', serviceTypeId: 2, portOffset: 1 },
    { name: 'storage', aliases: ['storaged'], daemon: 'harbor-storaged', serviceTypeId: 3, portOffset: 2 },
    { name: 'histcore', aliases: ['history-core'], daemon: 'harbor-histcored', serviceTypeId: 4, portOffset: 3 },
    { name: 'snapshot', aliases: ['snapshotd'], daemon: 'harbor-snapshotd', serviceTypeId: 5, portOffset: 4 },
    { name: 'p2pseed', aliases: ['p2p-seed'], daemon: 'harbor-p2pseedd', serviceTypeId: 6, portOffset: 5 },
    { name: 'ibcrelayer', aliases: ['ibc-relayer'], daemon: 'harbor-ibcrelayerd', serviceTypeId: 7, portOffset: 6 },
    { name: 'bp', aliases: ['block-producer'], daemon: 'harbor-bpd', serviceTypeId: 8, portOffset: 7 },
    { name: 'histactions', aliases: ['history-actions'], daemon: 'harbor-histactionsd', serviceTypeId: 9, portOffset: 8 },
    { name: 'histtx', aliases: ['history-tx'], daemon: 'harbor-histtxd', serviceTypeId: 10, portOffset: 9 },
    { name: 'histapi', aliases: ['history-api'], daemon: 'harbor-histapid', serviceTypeId: 11, portOffset: 10 },
    { name: 'histstream', aliases: ['history-stream'], daemon: 'harbor-histstreamd', serviceTypeId: 12, portOffset: 11 },
    { name: 'verifier', aliases: ['oracle'], daemon: 'harbor-verifierd', serviceTypeId: 13, portOffset: 12 },
    { name: 'router', aliases: ['routerd'], daemon: 'harbor-routerd', serviceTypeId: 14, portOffset: 13 },
    { name: 'sitegw', aliases: ['site-gateway'], daemon: 'harbor-sitegwd', serviceTypeId: 15, portOffset: 14 },
    { name: 'appealcmte', aliases: ['appeal-committee'], daemon: 'harbor-appeal-committeed', serviceTypeId: 16, portOffset: 15 },
    { name: 'pricefeed', aliases: ['price-feed'], daemon: 'harbor-pricefeedd', serviceTypeId: 17, portOffset: 16 },
    { name: 'aiinfer', aliases: ['ai-infer', 'inference', 'inference-host'], daemon: 'harbor-aiinferd', serviceTypeId: 18, portOffset: 17 },
    { name: 'aitrain', aliases: ['ai-train', 'training', 'trainer'], daemon: 'harbor-aitraind', serviceTypeId: 19, portOffset: 18 },
    { name: 'airouter', aliases: ['ai-router', 'model-router'], daemon: 'harbor-airouterd', serviceTypeId: 20, portOffset: 19 },
    { name: 'keycustody', aliases: ['key-custody', 'custody'], daemon: 'harbor-keycustodyd', serviceTypeId: 21, portOffset: 20 },
    { name: 'scheduler', aliases: ['check-scheduler'], daemon: 'harbor-check-scheduler', serviceTypeId: 13, portOffset: 50 },
];
export const NODE_RUNTIME = { name: 'nodeos', aliases: ['node', 'peer'], daemon: 'nodeos', serviceTypeId: 0, portOffset: 0 };
export function isNodeRuntime(service) {
    return service.name === NODE_RUNTIME.name;
}
export function normalizeServiceName(name) {
    const normalized = name.trim().toLowerCase().replaceAll('_', '-');
    const service = [NODE_RUNTIME, ...SERVICE_RUNTIMES].find((item) => item.name === normalized || item.aliases.includes(normalized));
    if (!service) {
        throw new Error(`unknown Harbor service: ${name}`);
    }
    return service;
}
function artifactsPath() {
    return path.join(harborHome(), 'artifacts.json');
}
async function readRecords() {
    try {
        return JSON.parse(await fs.readFile(artifactsPath(), 'utf8'));
    }
    catch {
        return [];
    }
}
async function writeAtomic(file, content, mode) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, content, { mode, flag: 'wx' });
        await fs.rename(temporary, file);
    }
    finally {
        await fs.rm(temporary, { force: true });
    }
}
export async function executableExists(binary) {
    try {
        await fs.access(binary, constants.X_OK);
        return (await fs.stat(binary)).isFile();
    }
    catch {
        return false;
    }
}
async function findCached(service, version) {
    const target = runtimeTarget();
    try {
        const record = JSON.parse(await fs.readFile(path.join(artifactDirectory(service, version), 'artifact.json'), 'utf8'));
        if (record.target === target && record.binary === artifactBinary(service, version, record.sha256) &&
            await executableExists(record.binary)) {
            return { ...record, installed: false };
        }
    }
    catch {
        // Check installations created by earlier versions.
    }
    const old = (await readRecords()).find((item) => item.service === service.name && item.version === version);
    if (old && await executableExists(old.binary) && await matchesLegacyHost(old.binary).catch(() => false))
        return { ...old, installed: false };
    return null;
}
async function matchesLegacyHost(binary) {
    const file = await fs.open(binary, 'r');
    try {
        const header = Buffer.alloc(20);
        await file.read(header);
        if (header.toString('ascii', 0, 2) === '#!')
            return true;
        if (header.readUInt32LE(0) === 0xfeedfacf) {
            return process.platform === 'darwin' && header.readUInt32LE(4) === (process.arch === 'arm64' ? 0x0100000c : 0x01000007);
        }
        if (header.readUInt32BE(0) === 0x7f454c46 && header[4] === 2 && header[5] === 1) {
            return process.platform === 'linux' && header.readUInt16LE(18) === (process.arch === 'arm64' ? 183 : 62);
        }
        // macOS can select the matching slice of a universal binary at launch.
        return process.platform === 'darwin' && [0xcafebabe, 0xcafebabf].includes(header.readUInt32BE(0));
    }
    finally {
        await file.close();
    }
}
function siblingOpportunitiesRepo() {
    return process.env.HARBOR_OPPORTUNITIES_DIR ?? path.resolve(process.cwd(), '..', 'harbor-opportunities');
}
async function resolvePathBinary(binary) {
    const paths = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const dir of paths) {
        const candidate = path.resolve(dir, binary);
        if (await executableExists(candidate)) {
            return candidate;
        }
    }
    return null;
}
async function resolveLocal(service, version, forceInstall) {
    const packagedDir = process.env.HARBOR_DAEMON_DIR;
    if (packagedDir) {
        const binary = path.resolve(packagedDir, service.daemon);
        if (await executableExists(binary))
            return { binary, version, source: 'local', installed: false, provenance: packagedDir };
    }
    if (isNodeRuntime(service)) {
        const binary = await resolvePathBinary(service.daemon);
        return binary && await matchesLegacyHost(binary) ? { binary, version, source: 'path', installed: false, provenance: 'PATH' } : null;
    }
    const repo = path.resolve(siblingOpportunitiesRepo());
    const buildBinary = path.join(repo, 'build', service.daemon);
    if (!forceInstall && await executableExists(buildBinary)) {
        return { binary: buildBinary, version, source: 'local', installed: false, provenance: repo };
    }
    try {
        await fs.access(path.join(repo, 'CMakeLists.txt'));
        const configure = spawnSync('cmake', ['-S', repo, '-B', path.join(repo, 'build')], { stdio: 'inherit' });
        if (configure.status !== 0) {
            throw new Error(`cmake configure failed with status ${configure.status}`);
        }
        const build = spawnSync('cmake', ['--build', path.join(repo, 'build'), '--target', service.daemon], { stdio: 'inherit' });
        if (build.status !== 0) {
            throw new Error(`cmake build failed with status ${build.status}`);
        }
        if (await executableExists(buildBinary)) {
            return { binary: buildBinary, version, source: 'local', installed: true, provenance: repo };
        }
    }
    catch (error) {
        if (forceInstall) {
            throw error;
        }
    }
    const pathBinary = await resolvePathBinary(service.daemon);
    return pathBinary ? { binary: pathBinary, version, source: 'path', installed: false, provenance: 'PATH' } : null;
}
class DownloadError extends Error {
    status;
    constructor(status, url) {
        super(`download failed ${status}: ${url}`);
        this.status = status;
    }
}
async function download(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
        throw new DownloadError(response.status, url);
    }
    return Buffer.from(await response.arrayBuffer());
}
export function validateArtifactVersion(version) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version))
        throw new Error(`invalid artifact version: ${version}`);
}
function artifactDirectory(service, version) {
    validateArtifactVersion(version);
    return path.resolve(harborHome(), 'bin', service.name, version, runtimeTarget());
}
export function artifactBinary(service, version, sha256) {
    if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256))
        throw new Error('invalid binary SHA-256');
    return path.join(artifactDirectory(service, version), ...(sha256 ? [sha256] : []), service.daemon);
}
export async function installDownloadedBinary(input) {
    const actual = sha256Bytes(input.bytes);
    if (actual !== input.expectedSha256.toLowerCase()) {
        throw new Error(`checksum mismatch for ${input.service.name}: expected ${input.expectedSha256}, got ${actual}`);
    }
    const binary = artifactBinary(input.service, input.version, actual);
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await writeAtomic(binary, input.bytes, 0o755);
    const record = {
        service: input.service.name,
        version: input.version,
        source: input.source,
        binary,
        sha256: actual,
        installedAt: new Date().toISOString(),
        provenance: input.provenance,
        target: runtimeTarget(),
    };
    await writeAtomic(path.join(artifactDirectory(input.service, input.version), 'artifact.json'), `${JSON.stringify(record, null, 2)}\n`, 0o600);
    return { binary, version: input.version, source: input.source, sha256: actual, installed: true, provenance: input.provenance };
}
async function resolveUrl(options, version) {
    if (!options.binaryUrl) {
        throw new Error('--binary-url is required with --source url');
    }
    if (!options.sha256) {
        throw new Error('--sha256 is required with --source url');
    }
    return installDownloadedBinary({
        service: options.service,
        version,
        bytes: await download(options.binaryUrl),
        expectedSha256: options.sha256,
        source: 'url',
        provenance: options.binaryUrl,
    });
}
function parseShaSums(text, artifactName) {
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) {
            continue;
        }
        const [hash, file] = line.split(/\s+/, 2);
        if (file?.replace(/^\*/, '') === artifactName) {
            return hash;
        }
    }
    return null;
}
async function resolveGithubRepository(options, version, repo, artifactName) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
        throw new Error('GitHub artifact repository must use owner/repo format');
    const release = version === 'latest' || version === 'dev' ? 'latest/download' : `download/${encodeURIComponent(version)}`;
    const base = `https://github.com/${repo}/releases/${release}`;
    let checksum = options.sha256;
    if (!checksum) {
        try {
            checksum = parseShaSums((await download(`${base}/SHASUMS256.txt`)).toString('utf8'), artifactName) ?? undefined;
        }
        catch {
            // Fall through to the per-artifact checksum path.
        }
    }
    if (!checksum) {
        checksum = (await download(`${base}/${artifactName}.sha256`)).toString('utf8').trim().split(/\s+/, 1)[0];
    }
    if (!checksum) {
        throw new Error(`no checksum found for ${artifactName}`);
    }
    return installDownloadedBinary({
        service: options.service,
        version,
        bytes: await download(`${base}/${artifactName}`),
        expectedSha256: checksum,
        source: 'github',
        provenance: `${repo}@${version}`,
    });
}
async function resolveGithub(options, version) {
    const resolveFrom = async (repo) => {
        const target = runtimeTarget();
        try {
            return await resolveGithubRepository(options, version, repo, releaseAsset(options.service.daemon, target));
        }
        catch (error) {
            if (!target.startsWith('macos-') || !(error instanceof DownloadError) || error.status !== 404)
                throw error;
            return resolveGithubRepository(options, version, repo, `${options.service.daemon}-${target}`);
        }
    };
    const repo = process.env.HARBOR_OPPORTUNITIES_GITHUB_REPO;
    if (repo)
        return resolveFrom(repo);
    try {
        return await resolveFrom('dafuga/harbor-cli');
    }
    catch (error) {
        if (!(error instanceof DownloadError) || error.status !== 404)
            throw error;
        return resolveFrom('dafuga/harbor-opportunities');
    }
}
function artifactMetadataMatches(row, service, version) {
    if (!row.metadata) {
        return false;
    }
    try {
        const metadata = JSON.parse(row.metadata);
        return metadata.kind === 'harbor-artifact-manifest' &&
            metadata.service === service.name &&
            metadata.version === version &&
            (!metadata.platform || manifestTarget(metadata.platform, metadata.arch) === runtimeTarget());
    }
    catch {
        return false;
    }
}
function manifestTarget(platform, arch) {
    if (typeof platform !== 'string')
        return '';
    const normalized = platform.replace(/^darwin(?=-|$)/, 'macos');
    const architecture = arch === 'aarch64' ? 'arm64' : arch === 'x86_64' ? 'x64' : arch;
    if (normalized.includes('-')) {
        return architecture && !normalized.endsWith(`-${architecture}`) ? '' : normalized;
    }
    return `${normalized}-${architecture ?? ''}`;
}
async function findArtifactManifestHash(options, version) {
    if (options.artifactHash) {
        return options.artifactHash;
    }
    const storageContract = options.storageContract ?? process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore';
    const objects = await getTableRows(storageContract, 'objects', {
        url: options.url,
        scope: storageContract,
        limit: 1000,
    });
    const manifest = objects.rows.find((row) => artifactMetadataMatches(row, options.service, version));
    if (!manifest) {
        throw new Error(`no Harbor storage artifact manifest found for ${options.service.name}@${version}`);
    }
    return manifest.content_hash;
}
async function resolveHarborStorage(options, version) {
    const manifestHash = await findArtifactManifestHash(options, version);
    const manifestObject = await resolveStorageObjectByHash({
        url: options.url,
        storageContract: options.storageContract ?? process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore',
        contentHash: manifestHash,
    });
    const manifestBytes = await downloadStoredObjectBytes({
        url: options.url,
        marketContract: options.marketContract,
        storageContract: options.storageContract,
        contentHash: manifestObject.content_hash,
        expectedSha256: manifestObject.content_hash,
    });
    const manifest = JSON.parse(manifestBytes.bytes.toString('utf8'));
    if (manifest.kind !== 'harbor-artifact-manifest' || manifest.service !== options.service.name ||
        manifest.version !== version || manifestTarget(manifest.platform, manifest.arch) !== runtimeTarget()) {
        throw new Error(`invalid artifact manifest for ${options.service.name}`);
    }
    const binary = await downloadStoredObjectBytes({
        url: options.url,
        marketContract: options.marketContract,
        storageContract: options.storageContract,
        contentHash: manifest.binary_object_hash,
        expectedSha256: manifest.sha256,
    });
    return installDownloadedBinary({
        service: options.service,
        version,
        bytes: binary.bytes,
        expectedSha256: manifest.sha256,
        source: 'harbor-storage',
        provenance: `harborstore:${manifestHash}`,
    });
}
export async function resolveArtifact(options) {
    const source = options.source ?? 'auto';
    const version = options.version ?? 'dev';
    runtimeTarget();
    validateArtifactVersion(version);
    if (!options.forceInstall && source === 'auto') {
        const cached = await findCached(options.service, version);
        if (cached) {
            return cached;
        }
    }
    if (source === 'auto' || source === 'local') {
        const local = await resolveLocal(options.service, version, options.forceInstall);
        if (local || source === 'local') {
            if (!local) {
                throw new Error(`local binary not found for ${options.service.name}`);
            }
            return local;
        }
    }
    if (source === 'auto' || source === 'harbor-storage') {
        try {
            return await resolveHarborStorage(options, version);
        }
        catch (error) {
            if (source === 'harbor-storage') {
                throw error;
            }
        }
    }
    if (source === 'auto' || source === 'github') {
        try {
            return await resolveGithub(options, version);
        }
        catch (error) {
            if (source === 'github') {
                throw error;
            }
        }
    }
    if (source === 'url') {
        return resolveUrl(options, version);
    }
    if (source === 'auto' && options.binaryUrl) {
        return resolveUrl(options, version);
    }
    throw new Error(`unable to resolve binary for ${options.service.name}`);
}
export function defaultRuntimeConfigPath() {
    return path.join(harborHome(), 'runtime.toml');
}
export function defaultRuntimeDataDir() {
    return path.join(harborHome(), 'runtime-data');
}
