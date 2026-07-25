import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { actionUint64Return, canonicalUint64, getAllTableRows, getTableRows, pushAction, readContractNextId, } from './tx.js';
import { encryptVaultBytes, MAX_GOVERNED_PLAINTEXT_BYTES, requireInitialCustodyEnvelope, vaultEnvelopeCommitment, vaultEnvelopeToBytes, } from './vault-crypto.js';
export async function hashFile(filePath) {
    const hash = crypto.createHash('sha256');
    const handle = await fs.open(filePath, 'r');
    try {
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
            hash.update(chunk);
        }
    }
    finally {
        await handle.close();
    }
    return hash.digest('hex');
}
function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}
const UINT64_MAX = (1n << 64n) - 1n;
const CHECKSUM256_MAX = (1n << 256n) - 1n;
function uint64ExclusiveUpper(value, label) {
    const canonical = canonicalUint64(value, label);
    const parsed = BigInt(canonical);
    return parsed === UINT64_MAX ? undefined : (parsed + 1n).toString();
}
function compareUint64(left, right, label) {
    const lhs = BigInt(canonicalUint64(left, label));
    const rhs = BigInt(canonicalUint64(right, label));
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}
function checksum256ExclusiveUpper(value) {
    const parsed = BigInt(`0x${value}`);
    return parsed === CHECKSUM256_MAX
        ? undefined
        : (parsed + 1n).toString(16).padStart(64, '0');
}
function antelopeTimePointSec(unixSeconds) {
    if (!Number.isSafeInteger(unixSeconds) || unixSeconds <= 0 || unixSeconds > 0xffff_ffff) {
        throw new Error('time_point_sec is out of range');
    }
    return new Date(unixSeconds * 1000).toISOString().replace(/\.000Z$/, '');
}
export function storageRegistrationAction(owner, prepared, metadata = prepared.metadata) {
    if (prepared.temporary) {
        return {
            action: 'puttempat',
            data: {
                owner,
                content_hash: prepared.contentHash,
                bytes: prepared.bytes,
                encrypted: true,
                encryption_key_hash: prepared.encryptionKeyHash,
                expires_at: antelopeTimePointSec(prepared.expiresAt),
                key_custodians: prepared.keyCustodians,
                metadata,
            },
        };
    }
    return {
        action: 'putobject',
        data: {
            owner,
            content_hash: prepared.contentHash,
            bytes: prepared.bytes,
            encrypted: false,
            encryption_key_hash: prepared.encryptionKeyHash,
            metadata,
        },
    };
}
function preparedRecoveryError(error, preparedPath) {
    const cause = error instanceof Error ? error : new Error(String(error));
    if (!preparedPath)
        return cause;
    return new Error(`${cause.message}; exact governed envelope retained at ${preparedPath} for recovery`, { cause });
}
export function sha256Bytes(bytes) {
    return sha256(bytes);
}
function objectPath(root, contentHash) {
    return path.join(root, 'objects', contentHash.slice(0, 2), contentHash);
}
function collectStrings(value, keyMatcher) {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    for (const [key, child] of Object.entries(value)) {
        if (keyMatcher(key) && typeof child === 'string' && child.length > 0) {
            return child;
        }
        const nested = collectStrings(child, keyMatcher);
        if (nested) {
            return nested;
        }
    }
    return undefined;
}
export function parseWalrusStoreResponse(output, refs = {}) {
    let response;
    try {
        response = JSON.parse(output);
    }
    catch {
        response = { stdout: output };
    }
    const blobId = collectStrings(response, (key) => ['blob_id', 'blobId', 'blobID'].includes(key));
    if (!blobId) {
        throw new Error('Walrus store response did not include a blob id');
    }
    return {
        blob_id: blobId,
        sui_object_id: collectStrings(response, (key) => ['sui_object_id', 'suiObjectId', 'object_id', 'objectId'].includes(key)),
        ...refs,
        response,
    };
}
export function buildWalrusMetadata(metadata, walrus) {
    let base;
    try {
        const parsed = JSON.parse(metadata);
        base = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
    }
    catch {
        base = metadata ? { label: metadata } : {};
    }
    return JSON.stringify({
        ...base,
        storage_backend: 'walrus',
        walrus: {
            blob_id: walrus.blob_id,
            sui_object_id: walrus.sui_object_id,
            publisher_url: walrus.publisher_url,
            aggregator_url: walrus.aggregator_url,
            epochs: walrus.epochs,
            content_format: walrus.content_format,
        },
    });
}
async function runWalrusStore(file, options) {
    const command = options.walrusCommand ?? process.env.WALRUS_CLI ?? 'walrus';
    const args = ['store', file, '--json'];
    if (options.walrusPublisherUrl) {
        args.push('--publisher', options.walrusPublisherUrl);
    }
    if (options.walrusEpochs !== undefined) {
        args.push('--epochs', String(options.walrusEpochs));
    }
    const output = await new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
        child.on('error', reject);
        child.on('close', (code) => {
            const out = Buffer.concat(stdout).toString();
            const err = Buffer.concat(stderr).toString();
            if (code !== 0) {
                reject(new Error(`walrus store failed (${code}): ${err || out}`));
                return;
            }
            resolve(out);
        });
    });
    return parseWalrusStoreResponse(output, {
        publisher_url: options.walrusPublisherUrl,
        aggregator_url: options.walrusAggregatorUrl,
        epochs: options.walrusEpochs === undefined ? undefined : Number(options.walrusEpochs),
        content_format: options.contentFormat,
    });
}
export async function prepareStoredObject(options) {
    if (options.privateKey) {
        throw new Error('password-derived storage encryption was removed; use a governed recipient public key');
    }
    if (options.encrypt && !options.governed) {
        throw new Error('governed encryption options are required when --encrypt is set');
    }
    const sourcePath = path.resolve(options.file);
    const sourceStat = await fs.stat(sourcePath);
    if (!sourceStat.isFile())
        throw new Error('storage input must be a regular file');
    if (options.governed && sourceStat.size > MAX_GOVERNED_PLAINTEXT_BYTES) {
        throw new Error(`governed encryption exceeds this Node platform's HGD1 limit of ${MAX_GOVERNED_PLAINTEXT_BYTES} plaintext bytes`);
    }
    const source = await fs.readFile(sourcePath);
    const sourceHash = sha256(source);
    const encrypted = Boolean(options.governed);
    let storedBytes = source;
    let encryptionKeyHash = '0'.repeat(64);
    let envelopeCommitment;
    let ttlSec;
    let expiresAt;
    let keyCustodians = [];
    if (options.governed) {
        try {
            const { context, recipient, recipientPublicKey } = options.governed;
            const now = options.governed.now ?? Math.floor(Date.now() / 1000);
            if (!Number.isSafeInteger(now) || now <= 0 || context.created_at > now || now >= context.expires_at) {
                throw new Error('governed storage envelope must be active when prepared');
            }
            ttlSec = context.expires_at - now;
            expiresAt = context.expires_at;
            if (!Number.isSafeInteger(ttlSec) || ttlSec <= 0 || ttlSec > 0xffff_ffff ||
                !Number.isSafeInteger(expiresAt) || expiresAt > 0xffff_ffff) {
                throw new Error('governed storage expiry is outside HarborStore time range');
            }
            keyCustodians = [...new Set(options.governed.keyCustodians)];
            if (keyCustodians.length === 0 || keyCustodians.some((account) => !account)) {
                throw new Error('at least one key custodian is required for governed temporary storage');
            }
            const envelope = encryptVaultBytes(source, recipientPublicKey, context, recipient, now);
            requireInitialCustodyEnvelope(envelope);
            storedBytes = vaultEnvelopeToBytes(envelope);
            // HarborStore tracks the erasable, per-object recipient key rather than
            // the randomized sealed-box bytes. Reusing this commitment for another
            // object is rejected on-chain, so a custodian's erasure attestation is
            // bound to the exact private-key material whose destruction makes this
            // envelope permanently unreadable.
            encryptionKeyHash = envelope.recipient_key_commitment;
            envelopeCommitment = vaultEnvelopeCommitment(envelope);
        }
        finally {
            source.fill(0);
        }
    }
    const contentHash = sha256(storedBytes);
    const metadata = options.metadata ?? (encrypted ? '{"kind":"governed-data"}' : path.basename(sourcePath));
    return {
        sourcePath,
        storedBytes,
        contentHash,
        sourceHash,
        bytes: storedBytes.length,
        encrypted,
        encryptionKeyHash,
        temporary: encrypted,
        ttlSec,
        expiresAt,
        keyCustodians,
        envelopeCommitment,
        metadata,
    };
}
export async function prepareObjectForUpload(options) {
    if (options.privateKey) {
        throw new Error('password-derived storage encryption was removed; use a governed recipient public key');
    }
    if (options.encrypt && !options.governed) {
        throw new Error('governed encryption options are required when --encrypt is set');
    }
    if (options.governed) {
        const buffered = await prepareStoredObject(options);
        const preparedPath = await persistPreparedStorageObject(buffered, options.preparedOutput);
        if (!preparedPath)
            throw new Error('governed upload did not persist its recovery envelope');
        return { prepared: { ...buffered, uploadPath: preparedPath }, preparedPath };
    }
    const sourcePath = path.resolve(options.file);
    const before = await fs.stat(sourcePath);
    if (!before.isFile())
        throw new Error('storage input must be a regular file');
    if (!Number.isSafeInteger(before.size) || before.size <= 0) {
        throw new Error('public storage input size must be a positive safe integer');
    }
    const contentHash = await hashFile(sourcePath);
    const after = await fs.stat(sourcePath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
        throw new Error('public storage input changed while it was being hashed');
    }
    return {
        prepared: {
            sourcePath,
            uploadPath: sourcePath,
            contentHash,
            sourceHash: contentHash,
            bytes: before.size,
            encrypted: false,
            encryptionKeyHash: '0'.repeat(64),
            temporary: false,
            keyCustodians: [],
            metadata: options.metadata ?? path.basename(sourcePath),
        },
    };
}
export async function persistPreparedStorageObject(prepared, output) {
    if (!prepared.temporary)
        return undefined;
    const target = path.resolve(output ?? path.join(process.env.HARBOR_PREPARED_STORAGE_DIR ?? path.join(os.homedir(), '.harbor', 'prepared-storage'), `${prepared.contentHash}.hgd1.json`));
    const directory = path.dirname(target);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    let linked = false;
    try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(prepared.storedBytes);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        try {
            await fs.link(temporary, target);
            linked = true;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const stat = await fs.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new Error(`prepared governed object path is not a regular file: ${target}`);
            }
            const existing = await fs.readFile(target);
            if (sha256(existing) !== prepared.contentHash || !existing.equals(prepared.storedBytes)) {
                throw new Error(`prepared governed object path already contains different bytes: ${target}`);
            }
        }
    }
    finally {
        await fs.rm(temporary, { force: true });
    }
    if (linked) {
        await fs.chmod(target, 0o600);
    }
    return target;
}
export async function storeObject(options) {
    const prepared = await prepareStoredObject(options);
    const storedPath = objectPath(options.root, prepared.contentHash);
    await fs.mkdir(path.dirname(storedPath), { recursive: true });
    await fs.writeFile(storedPath, prepared.storedBytes);
    return {
        sourcePath: prepared.sourcePath,
        storedPath,
        contentHash: prepared.contentHash,
        sourceHash: prepared.sourceHash,
        bytes: prepared.bytes,
        encrypted: prepared.encrypted,
        encryptionKeyHash: prepared.encryptionKeyHash,
        temporary: prepared.temporary,
        ttlSec: prepared.ttlSec,
        expiresAt: prepared.expiresAt,
        keyCustodians: prepared.keyCustodians,
        envelopeCommitment: prepared.envelopeCommitment,
        metadata: prepared.metadata,
        registerAction: {
            contract: 'harborstore',
            action: prepared.temporary ? 'puttempat' : 'putobject',
            data: prepared.temporary
                ? [
                    '<owner>', prepared.contentHash, prepared.bytes, true,
                    prepared.encryptionKeyHash, prepared.expiresAt, prepared.keyCustodians,
                    prepared.metadata,
                ]
                : [
                    '<owner>', prepared.contentHash, prepared.bytes, false,
                    prepared.encryptionKeyHash, prepared.metadata,
                ],
        },
    };
}
function isActive(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
}
function assetValue(value, label) {
    const match = /^(-?\d+)(?:\.(\d+))? ([A-Z]{1,7})$/.exec(value);
    if (!match)
        throw new Error(`${label} is not a canonical asset`);
    const fraction = match[2] ?? '';
    const magnitude = BigInt(`${match[1].startsWith('-') ? '-' : ''}${match[1].replace('-', '')}${fraction}`);
    return { amount: magnitude, symbol: `${fraction.length},${match[3]}` };
}
export function filterEligibleMarketServices(services, providers, serviceTypes) {
    const providersByOwner = new Map(providers.map((provider) => [provider.owner, provider]));
    const typesById = new Map(serviceTypes.map((type) => [
        canonicalUint64(type.id, 'service type id'), type,
    ]));
    return services.filter((service) => {
        if (!isActive(service.active))
            return false;
        const provider = providersByOwner.get(service.provider);
        const serviceType = typesById.get(canonicalUint64(service.service_type, 'service type id'));
        if (!provider || !isActive(provider.active) || !serviceType || !isActive(serviceType.enabled))
            return false;
        try {
            const stake = assetValue(provider.stake, `provider ${provider.owner} stake`);
            const minimum = assetValue(serviceType.min_provider_stake, `service type ${service.service_type} minimum stake`);
            return stake.amount > 0n && stake.symbol === minimum.symbol && stake.amount >= minimum.amount;
        }
        catch {
            return false;
        }
    });
}
async function marketServiceRows(options) {
    const common = { url: options.url, scope: options.marketContract, limit: 1000 };
    const [services, providers, serviceTypes] = await Promise.all([
        getAllTableRows(options.marketContract, 'services', common),
        getAllTableRows(options.marketContract, 'providers', common),
        getAllTableRows(options.marketContract, 'svctypes', common),
    ]);
    return { services, providers, serviceTypes };
}
function lifecycleEpochSeconds(value, field) {
    if (typeof value === 'number' || /^\d+$/.test(String(value))) {
        const seconds = Number(value);
        if (Number.isSafeInteger(seconds) && seconds >= 0) {
            return seconds;
        }
        throw new Error(`storage lifecycle ${field} is invalid`);
    }
    const raw = String(value);
    const normalized = /(Z|[+-]\d\d:?\d\d)$/.test(raw) ? raw : `${raw}Z`;
    const milliseconds = Date.parse(normalized);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new Error(`storage lifecycle ${field} is invalid`);
    }
    return Math.floor(milliseconds / 1000);
}
export function requireDownloadableStorageObject(object, lifecycle, nowEpochSec = Math.floor(Date.now() / 1000)) {
    if (Number(object.status) !== 1) {
        throw new Error(`storage object ${object.id} is not active`);
    }
    if (!Number.isSafeInteger(nowEpochSec) || nowEpochSec < 0) {
        throw new Error('storage lifecycle comparison time is invalid');
    }
    if (!lifecycle) {
        return;
    }
    if (canonicalUint64(lifecycle.object_id, 'storage lifecycle object id') !==
        canonicalUint64(object.id, 'storage object id')) {
        throw new Error(`storage lifecycle does not match object ${object.id}`);
    }
    const expiresAt = lifecycleEpochSeconds(lifecycle.expires_at, 'expires_at');
    const tombstonedAt = lifecycleEpochSeconds(lifecycle.tombstoned_at, 'tombstoned_at');
    const completedAt = lifecycleEpochSeconds(lifecycle.completed_at, 'completed_at');
    if (tombstonedAt !== 0) {
        throw new Error(`storage object ${object.id} is tombstoned`);
    }
    if (completedAt !== 0) {
        throw new Error(`storage object ${object.id} deletion is complete`);
    }
    if (expiresAt !== 0 && nowEpochSec >= expiresAt) {
        throw new Error(`storage object ${object.id} has expired`);
    }
}
function routerLoad(service) {
    if (!service.metadata) {
        return 0;
    }
    try {
        const metadata = JSON.parse(service.metadata);
        for (const key of ['load', 'load_percent', 'inflight', 'pending', 'queue_depth']) {
            const value = metadata[key];
            if (typeof value === 'number') {
                return value;
            }
            if (typeof value === 'string' && value.trim() !== '') {
                return Number(value);
            }
        }
    }
    catch {
        return 0;
    }
    return 0;
}
function heartbeatFresh(service) {
    if (!service.last_heartbeat) {
        return true;
    }
    const raw = String(service.last_heartbeat);
    const normalized = /(Z|[+-]\d\d:?\d\d)$/.test(raw) ? raw : `${raw}Z`;
    const heartbeat = Date.parse(normalized);
    if (Number.isNaN(heartbeat)) {
        return true;
    }
    const maxAgeSec = Number(process.env.HARBOR_ROUTER_HEARTBEAT_MAX_AGE_SEC ?? 300);
    return Date.now() - heartbeat <= maxAgeSec * 1000;
}
export function selectBestRouter(services) {
    const routers = services
        .filter((service) => canonicalUint64(service.service_type, 'service type id') === '14')
        .filter((service) => isActive(service.active))
        .filter((service) => heartbeatFresh(service))
        .filter((service) => service.endpoint.startsWith('http://') || service.endpoint.startsWith('https://'))
        .sort((a, b) => routerLoad(a) - routerLoad(b) ||
        compareUint64(a.id, b.id, 'service id'));
    const router = routers[0];
    if (!router) {
        throw new Error('no active router services found');
    }
    return router;
}
async function isRouterHealthy(router) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
        const response = await fetch(new URL('/health', router.endpoint), { signal: controller.signal });
        return response.ok;
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timeout);
    }
}
export async function discoverBestRouter(options) {
    const market = await marketServiceRows(options);
    const candidates = filterEligibleMarketServices(market.services, market.providers, market.serviceTypes)
        .filter((service) => canonicalUint64(service.service_type, 'service type id') === '14')
        .filter((service) => isActive(service.active))
        .filter((service) => service.endpoint.startsWith('http://') || service.endpoint.startsWith('https://'));
    const healthy = [];
    for (const router of candidates) {
        if (await isRouterHealthy(router)) {
            healthy.push(router);
        }
    }
    return selectBestRouter(healthy);
}
function normalizedServiceEndpoint(endpoint) {
    const parsed = new URL(endpoint);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('router endpoint must be a credential-free HTTP(S) origin and path');
    }
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${pathname}`;
}
export async function discoverRouterAtEndpoint(options) {
    const expected = normalizedServiceEndpoint(options.endpoint);
    const market = await marketServiceRows(options);
    const matches = filterEligibleMarketServices(market.services, market.providers, market.serviceTypes).filter((service) => {
        if (canonicalUint64(service.service_type, 'service type id') !== '14')
            return false;
        try {
            return normalizedServiceEndpoint(service.endpoint) === expected;
        }
        catch {
            return false;
        }
    });
    if (matches.length === 0) {
        throw new Error('explicit router endpoint is not an active on-chain router service');
    }
    const identities = new Set(matches.map((service) => service.provider));
    if (identities.size !== 1) {
        throw new Error('explicit router endpoint maps to multiple active on-chain router identities');
    }
    return selectBestRouter(matches);
}
async function routerForUpload(options) {
    return options.routerUrl
        ? discoverRouterAtEndpoint({
            url: options.url,
            marketContract: options.marketContract,
            endpoint: options.routerUrl,
        })
        : discoverBestRouter({ url: options.url, marketContract: options.marketContract });
}
async function authorizeObjectRouter(options) {
    const now = Math.floor(Date.now() / 1000);
    return pushAction({
        contract: options.storageContract,
        action: 'authroute',
        data: {
            owner: options.owner,
            object_id: canonicalUint64(options.objectId, 'storage object id'),
            router: options.router,
            expires_at: antelopeTimePointSec(now + 600),
        },
        url: options.url,
        actor: options.actor ?? options.owner,
        permission: options.permission,
        key: options.key,
        expiration: options.expiration,
        json: options.json,
    });
}
async function waitForObjectRouterAuthorization(options) {
    const objectId = canonicalUint64(options.objectId, 'storage object id');
    const parsedObjectId = BigInt(objectId);
    const upperBound = parsedObjectId < ((1n << 64n) - 1n)
        ? (parsedObjectId + 1n).toString()
        : undefined;
    const deadline = Date.now() + (options.timeoutMs ?? 10_000);
    let lastState = 'authorization row is not visible';
    while (Date.now() < deadline) {
        const result = await getTableRows(options.storageContract, 'routeauths', {
            url: options.url,
            scope: options.storageContract,
            lowerBound: objectId,
            upperBound,
            limit: 2,
            indexPosition: '1',
            keyType: 'i64',
        });
        const matching = result.rows.filter((row) => {
            try {
                return canonicalUint64(row.object_id, 'route authorization object id') === objectId;
            }
            catch {
                return false;
            }
        });
        if (matching.length === 1) {
            const row = matching[0];
            const authorizedAtText = String(row.authorized_at ?? '');
            const expiresAtText = String(row.expires_at ?? '');
            const usedAtText = String(row.used_at ?? '');
            const parseChainTime = (value) => Date.parse(value.endsWith('Z') ? value : `${value}Z`);
            const authorizedAt = parseChainTime(authorizedAtText);
            const expiresAt = parseChainTime(expiresAtText);
            const usedAt = parseChainTime(usedAtText);
            const now = Date.now();
            if (row.owner === options.owner
                && row.router === options.router
                && Number.isFinite(authorizedAt)
                && authorizedAt <= now
                && Number.isFinite(expiresAt)
                && expiresAt > now
                && (!Number.isFinite(usedAt) || usedAt === 0)) {
                return;
            }
            lastState = 'authorization row is visible but not yet live and unused';
        }
        else if (matching.length > 1) {
            throw new Error(`router authorization for storage object ${objectId} is ambiguous`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`router authorization for storage object ${objectId} did not become live: ${lastState}`);
}
export function buildRouterUploadHeaders(input) {
    const byteLength = input.bytes?.length ?? input.byteLength;
    return {
        'content-type': 'application/octet-stream',
        'content-length': String(byteLength),
        'x-harbor-object-id': canonicalUint64(input.objectId, 'storage object id'),
        'x-harbor-content-hash': input.contentHash,
        'x-harbor-owner': input.owner,
        'x-harbor-bytes': String(byteLength),
        'x-harbor-required-replicas': String(input.requiredReplicas),
        'x-harbor-encrypted': input.encrypted ? 'true' : 'false',
        'x-harbor-encryption-key-hash': input.encryptionKeyHash,
    };
}
export async function uploadToRouter(input) {
    const body = input.bytes
        ? input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength)
        : createReadStream(input.file);
    const request = {
        method: 'POST',
        headers: buildRouterUploadHeaders(input),
        body: body,
    };
    if (!input.bytes)
        request.duplex = 'half';
    const response = await fetch(new URL('/storage/objects', input.router.endpoint), request);
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
        throw new Error(`router upload failed: ${response.status} ${text}`);
    }
    if (payload.object_id !== undefined) {
        payload.object_id = canonicalUint64(payload.object_id, 'router response object id');
    }
    return payload;
}
export async function resolveStorageObjectId(options) {
    const minimum = canonicalUint64(options.minimumIdInclusive, 'pre-registration next object id');
    const maximum = canonicalUint64(options.maximumIdExclusive ?? await readContractNextId(options.storageContract, 'next_object_id', { url: options.url }), 'post-registration next object id');
    if (BigInt(maximum) <= BigInt(minimum)) {
        throw new Error('storage registration did not advance next_object_id');
    }
    const returned = actionUint64Return(options.transactionResult, options.storageContract, options.action);
    const lowerBound = returned ?? minimum;
    const upperBound = returned ? (BigInt(returned) + 1n).toString() : maximum;
    if (BigInt(lowerBound) < BigInt(minimum) || BigInt(lowerBound) >= BigInt(maximum)) {
        throw new Error('storage action returned an object id outside its registration window');
    }
    const rows = await getAllTableRows(options.storageContract, 'objects', {
        url: options.url,
        scope: options.storageContract,
        lowerBound,
        upperBound,
        limit: 1000,
        indexPosition: '1',
        keyType: 'i64',
    });
    const matches = rows.filter((row) => row.content_hash === options.contentHash &&
        row.owner === options.owner &&
        BigInt(canonicalUint64(row.id, 'storage object id')) >= BigInt(minimum) &&
        BigInt(canonicalUint64(row.id, 'storage object id')) < BigInt(maximum));
    if (matches.length !== 1) {
        throw new Error(`storage registration resolved ${matches.length} newly created objects for owner ${options.owner} and hash ${options.contentHash}`);
    }
    if (returned && canonicalUint64(matches[0].id, 'storage object id') !== returned) {
        throw new Error('storage action return value does not match the created object row');
    }
    return canonicalUint64(matches[0].id, 'storage object id');
}
async function resolveStorageObjectById(options) {
    const objectId = canonicalUint64(options.objectId, 'storage object id');
    const upperBound = uint64ExclusiveUpper(objectId, 'storage object id');
    const result = await getTableRows(options.storageContract, 'objects', {
        url: options.url,
        scope: options.storageContract,
        lowerBound: objectId,
        ...(upperBound ? { upperBound } : {}),
        limit: 2,
        indexPosition: '1',
        keyType: 'i64',
    });
    const exact = result.rows.filter((row) => canonicalUint64(row.id, 'storage object row id') === objectId);
    if (exact.length !== 1) {
        throw new Error(`storage object ${objectId} was not uniquely found`);
    }
    return exact[0];
}
function routerUploadIdentity(object, expected) {
    const objectId = canonicalUint64(expected.objectId, 'storage object id');
    const objectBytes = canonicalUint64(object.bytes, 'storage object bytes');
    const requiredReplicas = Number(object.required_replicas);
    const encrypted = isActive(object.encrypted);
    if (canonicalUint64(object.id, 'storage object row id') !== objectId ||
        object.owner !== expected.owner || object.content_hash !== expected.contentHash ||
        BigInt(objectBytes) !== BigInt(expected.byteLength) || Number(object.status) !== 1) {
        throw new Error(`storage object ${objectId} does not match the upload identity`);
    }
    if (!Number.isSafeInteger(requiredReplicas) || requiredReplicas <= 0 || requiredReplicas > 0xff) {
        throw new Error(`storage object ${objectId} has invalid required replicas`);
    }
    if (!/^[0-9a-f]{64}$/.test(object.encryption_key_hash) ||
        (encrypted && object.encryption_key_hash === '0'.repeat(64)) ||
        (!encrypted && object.encryption_key_hash !== '0'.repeat(64))) {
        throw new Error(`storage object ${objectId} has invalid encryption metadata`);
    }
    if ((expected.encrypted !== undefined && encrypted !== expected.encrypted) ||
        (expected.encryptionKeyHash !== undefined &&
            object.encryption_key_hash !== expected.encryptionKeyHash)) {
        throw new Error(`storage object ${objectId} encryption metadata does not match registration`);
    }
    return {
        requiredReplicas,
        encrypted,
        encryptionKeyHash: object.encryption_key_hash,
    };
}
export async function storageObjectsByHash(options) {
    if (!/^[0-9a-f]{64}$/.test(options.contentHash)) {
        throw new Error('storage content hash must be 64 lowercase hexadecimal characters');
    }
    const upperBound = checksum256ExclusiveUpper(options.contentHash);
    const byHash = await getAllTableRows(options.storageContract, 'objects', {
        url: options.url,
        scope: options.storageContract,
        indexPosition: '3',
        keyType: 'sha256',
        lowerBound: options.contentHash,
        ...(upperBound ? { upperBound } : {}),
        limit: 1000,
    });
    return byHash.filter((row) => row.content_hash === options.contentHash);
}
export async function resolveStorageObjectByHash(options) {
    const exact = await storageObjectsByHash(options);
    if (exact[0])
        return exact[0];
    throw new Error(`storage object not found for hash ${options.contentHash}`);
}
export function storageProvidersForReplicas(replicas, services, objectId, providers, serviceTypes) {
    const canonicalObjectId = canonicalUint64(objectId, 'storage object id');
    const replicaProviders = new Set(replicas
        .filter((replica) => canonicalUint64(replica.object_id, 'replica object id') === canonicalObjectId)
        .filter((replica) => isActive(replica.active))
        .map((replica) => replica.provider));
    return filterEligibleMarketServices(services, providers, serviceTypes)
        .filter((service) => replicaProviders.has(service.provider))
        .filter((service) => canonicalUint64(service.service_type, 'service type id') === '3')
        .filter((service) => isActive(service.active))
        .filter((service) => service.endpoint.startsWith('http://') || service.endpoint.startsWith('https://'))
        .map((service) => ({ provider: service.provider, endpoint: service.endpoint }));
}
export async function downloadStoredObjectBytes(options) {
    const storageContract = options.storageContract ?? process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore';
    const marketContract = options.marketContract ?? process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket';
    const object = await resolveStorageObjectByHash({
        url: options.url,
        storageContract,
        contentHash: options.contentHash,
    });
    const objectId = canonicalUint64(object.id, 'storage object id');
    if (objectId === '0') {
        throw new Error(`storage object id is invalid for hash ${options.contentHash}`);
    }
    const objectUpperBound = uint64ExclusiveUpper(object.id, 'storage object id');
    const lifecycleRows = await getTableRows(storageContract, 'lifecycles', {
        url: options.url,
        scope: storageContract,
        lowerBound: objectId,
        ...(objectUpperBound ? { upperBound: objectUpperBound } : {}),
        limit: 2,
    });
    const lifecycle = lifecycleRows.rows.find((row) => canonicalUint64(row.object_id, 'storage lifecycle object id') === objectId);
    requireDownloadableStorageObject(object, lifecycle);
    const replicas = await getAllTableRows(storageContract, 'replicas', {
        url: options.url,
        scope: storageContract,
        indexPosition: '2',
        keyType: 'i64',
        lowerBound: objectId,
        ...(objectUpperBound ? { upperBound: objectUpperBound } : {}),
        limit: 1000,
    });
    const market = await marketServiceRows({ url: options.url, marketContract });
    const storageProviders = storageProvidersForReplicas(replicas, market.services, objectId, market.providers, market.serviceTypes);
    if (storageProviders.length === 0) {
        throw new Error(`no active storage replicas found for object ${objectId}`);
    }
    const failures = [];
    for (const provider of storageProviders) {
        try {
            const response = await fetch(new URL(`/objects/${options.contentHash}`, provider.endpoint));
            const body = Buffer.from(await response.arrayBuffer());
            const actual = sha256(body);
            if (!response.ok) {
                failures.push(`${provider.provider}: ${response.status}`);
                continue;
            }
            if (actual !== options.contentHash) {
                failures.push(`${provider.provider}: hash mismatch ${actual}`);
                continue;
            }
            if (options.expectedSha256 && actual !== options.expectedSha256) {
                failures.push(`${provider.provider}: checksum mismatch ${actual}`);
                continue;
            }
            return { bytes: body, provider };
        }
        catch (error) {
            failures.push(`${provider.provider}: ${error.message}`);
        }
    }
    throw new Error(`failed to download object ${options.contentHash}: ${failures.join('; ')}`);
}
export async function downloadStoredObject(options) {
    const { bytes, provider } = await downloadStoredObjectBytes(options);
    const actual = sha256(bytes);
    if (options.output) {
        await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
        await fs.writeFile(options.output, bytes);
    }
    return {
        content_hash: options.contentHash,
        bytes: bytes.length,
        sha256: actual,
        output: options.output ? path.resolve(options.output) : undefined,
        provider,
    };
}
export async function putReplicatedObject(options) {
    const marketContract = options.marketContract ?? process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket';
    const storageContract = options.storageContract ?? process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore';
    const { prepared, preparedPath } = await prepareObjectForUpload(options);
    try {
        const router = await routerForUpload({
            url: options.url,
            marketContract,
            routerUrl: options.routerUrl,
        });
        const registration = storageRegistrationAction(options.owner, prepared);
        const minimumObjectId = await readContractNextId(storageContract, 'next_object_id', { url: options.url });
        const putResult = await pushAction({
            contract: storageContract,
            action: registration.action,
            data: registration.data,
            url: options.url,
            actor: options.actor ?? options.owner,
            permission: options.permission,
            key: options.key,
            expiration: options.expiration,
            json: options.json,
        });
        const objectId = await resolveStorageObjectId({
            url: options.url,
            storageContract,
            owner: options.owner,
            contentHash: prepared.contentHash,
            minimumIdInclusive: minimumObjectId,
            transactionResult: putResult,
            action: registration.action,
        });
        const registeredObject = await resolveStorageObjectById({
            url: options.url,
            storageContract,
            objectId,
        });
        const uploadIdentity = routerUploadIdentity(registeredObject, {
            objectId,
            owner: options.owner,
            contentHash: prepared.contentHash,
            byteLength: prepared.bytes,
            encrypted: prepared.encrypted,
            encryptionKeyHash: prepared.encryptionKeyHash,
        });
        const routeAuthorization = await authorizeObjectRouter({
            ...options,
            storageContract,
            owner: options.owner,
            objectId,
            router: router.provider,
        });
        await waitForObjectRouterAuthorization({
            url: options.url,
            storageContract,
            owner: options.owner,
            objectId,
            router: router.provider,
        });
        const distribution = await uploadToRouter({
            router,
            objectId,
            owner: options.owner,
            contentHash: prepared.contentHash,
            ...uploadIdentity,
            file: prepared.uploadPath,
            byteLength: prepared.bytes,
        });
        return {
            sourcePath: prepared.sourcePath,
            content_hash: prepared.contentHash,
            source_hash: prepared.sourceHash,
            bytes: prepared.bytes,
            encrypted: prepared.encrypted,
            encryption_key_hash: prepared.encryptionKeyHash,
            temporary: prepared.temporary,
            expires_in_sec: prepared.ttlSec,
            expires_at: prepared.expiresAt,
            key_custodians: prepared.keyCustodians,
            envelope_commitment: prepared.envelopeCommitment,
            prepared_path: preparedPath,
            object_id: objectId,
            put_tx: putResult.transaction_id,
            route_authorization_tx: routeAuthorization.transaction_id,
            router: {
                id: canonicalUint64(router.id, 'router service id'),
                provider: router.provider,
                endpoint: router.endpoint,
            },
            selected_storage_providers: distribution.selected_storage_providers ?? [],
            replica_count: Number(distribution.replica_count ?? 0),
            assignment_tx: typeof distribution.assignment_tx === 'string' ? distribution.assignment_tx : undefined,
            distribution,
        };
    }
    catch (error) {
        throw preparedRecoveryError(error, preparedPath);
    }
}
export async function putWalrusObject(options) {
    const storageContract = options.storageContract ?? process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore';
    const { prepared, preparedPath } = await prepareObjectForUpload(options);
    try {
        const writtenHash = await hashFile(prepared.uploadPath);
        if (writtenHash !== prepared.contentHash) {
            throw new Error(`prepared Walrus bytes failed SHA-256 verification: ${writtenHash}`);
        }
        const walrus = await runWalrusStore(prepared.uploadPath, options);
        const metadata = buildWalrusMetadata(prepared.metadata, walrus);
        const registration = storageRegistrationAction(options.owner, prepared, metadata);
        const minimumObjectId = await readContractNextId(storageContract, 'next_object_id', { url: options.url });
        const putResult = await pushAction({
            contract: storageContract,
            action: registration.action,
            data: registration.data,
            url: options.url,
            actor: options.actor ?? options.owner,
            permission: options.permission,
            key: options.key,
            expiration: options.expiration,
            json: options.json,
        });
        const objectId = await resolveStorageObjectId({
            url: options.url,
            storageContract,
            owner: options.owner,
            contentHash: prepared.contentHash,
            minimumIdInclusive: minimumObjectId,
            transactionResult: putResult,
            action: registration.action,
        });
        return {
            sourcePath: prepared.sourcePath,
            content_hash: prepared.contentHash,
            source_hash: prepared.sourceHash,
            bytes: prepared.bytes,
            encrypted: prepared.encrypted,
            encryption_key_hash: prepared.encryptionKeyHash,
            temporary: prepared.temporary,
            expires_in_sec: prepared.ttlSec,
            expires_at: prepared.expiresAt,
            key_custodians: prepared.keyCustodians,
            envelope_commitment: prepared.envelopeCommitment,
            prepared_path: preparedPath,
            object_id: objectId,
            put_tx: putResult.transaction_id,
            metadata,
            walrus,
        };
    }
    catch (error) {
        throw preparedRecoveryError(error, preparedPath);
    }
}
export async function distributeStoredObject(options) {
    const marketContract = options.marketContract ?? process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket';
    const storageContract = options.storageContract ?? process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore';
    const { prepared } = await prepareObjectForUpload(options);
    if (prepared.contentHash !== options.contentHash) {
        throw new Error(`content hash mismatch: expected ${options.contentHash}, got ${prepared.contentHash}`);
    }
    const registeredObject = await resolveStorageObjectById({
        url: options.url,
        storageContract,
        objectId: options.objectId,
    });
    const uploadIdentity = routerUploadIdentity(registeredObject, {
        objectId: options.objectId,
        owner: options.owner,
        contentHash: options.contentHash,
        byteLength: prepared.bytes,
    });
    const router = await routerForUpload({ url: options.url, marketContract, routerUrl: options.routerUrl });
    const routeAuthorization = await authorizeObjectRouter({
        ...options,
        storageContract,
        owner: options.owner,
        objectId: options.objectId,
        router: router.provider,
    });
    await waitForObjectRouterAuthorization({
        url: options.url,
        storageContract,
        owner: options.owner,
        objectId: options.objectId,
        router: router.provider,
    });
    const distribution = await uploadToRouter({
        router,
        objectId: options.objectId,
        owner: options.owner,
        contentHash: options.contentHash,
        ...uploadIdentity,
        file: prepared.uploadPath,
        byteLength: prepared.bytes,
    });
    return {
        ...distribution,
        route_authorization_tx: routeAuthorization.transaction_id,
    };
}
async function walk(root, current = root) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
        if (entry.name.startsWith('.')) {
            continue;
        }
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
            result.push(...(await walk(root, fullPath)));
            continue;
        }
        if (!entry.isFile()) {
            continue;
        }
        const stat = await fs.stat(fullPath);
        result.push({
            path: path.relative(root, fullPath),
            bytes: stat.size,
            sha256: await hashFile(fullPath),
        });
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
}
export async function buildStorageManifest(root) {
    await fs.mkdir(root, { recursive: true });
    const files = await walk(root);
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const manifestHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(files))
        .digest('hex');
    return {
        generatedAt: new Date().toISOString(),
        root,
        totalFiles: files.length,
        totalBytes,
        manifestHash,
        files,
    };
}
function resolveStoragePath(root, requestPath) {
    const decoded = decodeURIComponent(requestPath);
    const fullPath = path.resolve(root, decoded.replace(/^\/+/, ''));
    const resolvedRoot = path.resolve(root);
    if (!fullPath.startsWith(`${resolvedRoot}${path.sep}`) && fullPath !== resolvedRoot) {
        throw new Error('path escapes storage root');
    }
    return fullPath;
}
export function serveStorageManifest(root, port) {
    const server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
            if (url.pathname === '/health') {
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify({ ok: true }));
                return;
            }
            if (url.pathname === '/manifest') {
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify(await buildStorageManifest(root), null, 2));
                return;
            }
            if (url.pathname.startsWith('/files/')) {
                const fullPath = resolveStoragePath(root, url.pathname.slice('/files/'.length));
                const file = await fs.readFile(fullPath);
                response.end(file);
                return;
            }
            response.statusCode = 404;
            response.end('not found');
        }
        catch (error) {
            response.statusCode = 400;
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
    });
    server.listen(port, '127.0.0.1');
    return server;
}
