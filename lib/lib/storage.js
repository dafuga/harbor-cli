import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
async function hashFile(filePath) {
    const hash = crypto.createHash('sha256');
    const handle = await fs.open(filePath, 'r');
    try {
        for await (const chunk of handle.createReadStream()) {
            hash.update(chunk);
        }
    }
    finally {
        await handle.close();
    }
    return hash.digest('hex');
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
