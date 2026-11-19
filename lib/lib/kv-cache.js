import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
const KEEP_MS = 7 * 24 * 60 * 60_000;
const DISK_BUDGET = 2 * 2 ** 30;
/** Manage disk-backed slots only for chat IDs explicitly supplied by a local client. */
export async function createKvGateway(front, engine, settings) {
    const { directory, parallel, idleMs = 60_000, engineKey } = settings;
    const engineHeaders = { 'content-type': 'application/json', ...(engineKey ? { Authorization: `Bearer ${engineKey}` } : {}) };
    const slots = Array.from({ length: parallel }, (_, id) => ({ id, busy: false, touched: 0 }));
    const activeChats = new Set();
    let paused = false;
    let connected = false;
    let saved = 0;
    let restored = 0;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
        throw new Error('the KV cache directory must be private and owned by the service user');
    }
    async function slotAction(id, action, filename) {
        const url = new URL(`/slots/${id}?action=${action}`, engine);
        const response = await fetch(url, {
            method: 'POST',
            headers: engineHeaders,
            body: JSON.stringify(filename ? { filename } : {}),
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`llama.cpp cache ${action} returned HTTP ${response.status}`);
        }
        return response.json();
    }
    async function prune() {
        const files = await fs.readdir(directory);
        const entries = (await Promise.all(files.filter((name) => /^[a-f0-9]{64}\.bin$/.test(name)).map(async (name) => {
            const file = path.join(directory, name);
            const stat = await fs.lstat(file).catch(() => undefined);
            return stat?.isFile() ? { file, time: stat.mtimeMs, size: stat.size } : undefined;
        }))).filter((entry) => Boolean(entry));
        let retained = 0;
        for (const entry of entries.sort((a, b) => b.time - a.time)) {
            retained += entry.size;
            if (retained > DISK_BUDGET || Date.now() - entry.time > KEEP_MS)
                await fs.rm(entry.file, { force: true });
        }
    }
    async function save(slot) {
        if (!slot.chat)
            return false;
        const temporary = `${randomUUID()}.tmp`;
        const temporaryPath = path.join(directory, temporary);
        try {
            const result = await slotAction(slot.id, 'save', temporary);
            if (!result.n_saved)
                return false;
            await fs.chmod(temporaryPath, 0o600);
            await fs.rename(temporaryPath, path.join(directory, `${slot.chat}.bin`));
            await prune();
            return true;
        }
        finally {
            await fs.rm(temporaryPath, { force: true });
        }
    }
    async function bind(slot, chat) {
        if (slot.chat === chat)
            return;
        const savedToDisk = await save(slot);
        await slotAction(slot.id, 'erase');
        slot.chat = chat;
        if (savedToDisk)
            saved++;
        if (chat) {
            const filename = `${chat}.bin`;
            const file = path.join(directory, filename);
            const stat = await fs.lstat(file).catch(() => undefined);
            if (stat?.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && Date.now() - stat.mtimeMs <= KEEP_MS) {
                try {
                    const result = await slotAction(slot.id, 'restore', filename);
                    if (result.n_restored) {
                        restored++;
                        await fs.utimes(file, new Date(), new Date());
                    }
                }
                catch {
                    await fs.rm(file, { force: true });
                }
            }
        }
    }
    async function spill(all) {
        if (!connected)
            return;
        const deadline = all ? Date.now() + 5000 : Infinity;
        for (const slot of slots) {
            if (Date.now() >= deadline)
                break;
            if (!slot.chat || slot.busy || (!all && Date.now() - slot.touched < idleMs))
                continue;
            slot.busy = true;
            try {
                await bind(slot);
            }
            finally {
                slot.busy = false;
            }
        }
    }
    function reply(response, status, error) {
        if (response.headersSent)
            response.destroy();
        else
            response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: error } }));
    }
    async function handle(request, response) {
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
            reply(response, 404, 'unknown inference endpoint');
            return;
        }
        if (paused || !connected) {
            reply(response, 503, 'local inference is paused');
            return;
        }
        const value = request.headers['x-harbor-chat-id'];
        if (value !== undefined && (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value))) {
            reply(response, 400, 'invalid local chat ID');
            return;
        }
        const chat = typeof value === 'string' ? createHash('sha256').update(value).digest('hex') : undefined;
        const matching = chat && slots.find((slot) => slot.chat === chat);
        const slot = matching || slots.filter(({ busy }) => !busy).sort((a, b) => a.touched - b.touched)[0];
        if (!slot || slot.busy || (chat && activeChats.has(chat))) {
            reply(response, 429, 'all local inference slots are busy');
            return;
        }
        slot.busy = true;
        if (chat)
            activeChats.add(chat);
        try {
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
                size += chunk.length;
                if (size > 1024 * 1024)
                    throw new Error('inference request exceeds cache gateway input limit');
                chunks.push(chunk);
            }
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            await bind(slot, chat);
            // The gateway owns slot selection and adapter configuration.
            delete parsed.lora;
            const body = JSON.stringify({ ...parsed, id_slot: slot.id, cache_prompt: true });
            const upstream = await fetch(engine, {
                method: 'POST',
                headers: engineHeaders,
                body,
                signal: AbortSignal.timeout(5 * 60_000),
            });
            response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
            if (upstream.body)
                await pipeline(Readable.fromWeb(upstream.body), response);
            else
                response.end();
        }
        finally {
            if (chat)
                activeChats.delete(chat);
            slot.touched = Date.now();
            slot.busy = false;
        }
    }
    const server = createServer((request, response) => {
        void handle(request, response).catch(() => reply(response, 502, 'local inference backend request failed'));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number(front.port), front.hostname.replace(/^\[|\]$/g, ''), resolve);
    });
    let spilling = false;
    const timer = setInterval(() => {
        if (spilling || paused)
            return;
        spilling = true;
        void spill(false).catch(() => { }).finally(() => { spilling = false; });
    }, Math.min(idleMs, 10_000));
    return {
        stats: () => ({ saved, restored }),
        resume: () => {
            connected = true;
            paused = false;
        },
        pause: async () => {
            paused = true;
            const deadline = Date.now() + 5000;
            while ((spilling || slots.some(({ busy }) => busy)) && Date.now() < deadline)
                await delay(50);
            await spill(true).catch(() => { });
            connected = false;
            for (const slot of slots)
                slot.chat = undefined;
        },
        close: async () => {
            paused = true;
            clearInterval(timer);
            server.closeAllConnections();
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
