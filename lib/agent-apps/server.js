import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { AgentError, record } from './validation.js';
function digest(value) {
    return createHash('sha256').update(value).digest();
}
function bearer(request) {
    return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
}
async function input(request) {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
        throw new AgentError('Use application/json.', 415);
    }
    const parts = [];
    let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > 48_000)
            throw new AgentError('Request is too large.', 413);
        parts.push(chunk);
    }
    try {
        return record(JSON.parse(Buffer.concat(parts).toString('utf8')));
    }
    catch {
        throw new AgentError('Invalid JSON object.');
    }
}
function send(response, status, data) {
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(data));
}
export function workerServer(worker, token) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
        throw new Error('Worker token must be 32 random bytes encoded as base64url.');
    const owner = digest(token);
    return createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
        try {
            // Origin-form paths and headers keep reusable credentials out of URLs and browsers.
            const [api, collection, id, action, extra] = (request.url ?? '').split('/').slice(1);
            if (api !== 'v1' || !collection || extra !== undefined || /[?%#]/.test(request.url ?? '')) {
                throw new AgentError('Endpoint not found.', 404);
            }
            const credential = bearer(request);
            if (collection === 'triggers' && request.method === 'POST' && id && !action) {
                if (!credential)
                    throw new AgentError('Invalid trigger credential.', 401);
                const { eventId } = await input(request);
                return send(response, 202, worker.trigger(id, credential, eventId));
            }
            if (!credential || !timingSafeEqual(owner, digest(credential))) {
                throw new AgentError('Worker authentication is required.', 401);
            }
            const expected = request.headers['x-harbor-agent-identity'];
            if (expected && expected !== worker.identity)
                throw new AgentError('Worker identity changed.', 409);
            if (collection === 'state' && !action && request.method === 'GET') {
                return send(response, 200, worker.snapshot(id));
            }
            if (collection === 'agents' && request.method === 'POST') {
                const data = await input(request);
                if (!id && !action)
                    return send(response, 201, worker.createAgent(data));
                if (id && !action)
                    return send(response, 200, worker.saveAgent(id, data));
                if (id && action === 'status')
                    return send(response, 200, worker.setStatus(id, data.status));
                if (id && action === 'quote')
                    return send(response, 200, await worker.quote(id, data.message));
                if (id && action === 'routines')
                    return send(response, 201, worker.createRoutine(id, data));
            }
            if (request.method === 'POST' && id && !action) {
                if (collection === 'confirm')
                    return send(response, 202, worker.confirm(id));
                if (collection === 'routines')
                    return send(response, 200, worker.setRoutine(id, (await input(request)).enabled));
                if (collection === 'reconcile')
                    return send(response, 200, await worker.reconcile(id));
            }
            throw new AgentError('Endpoint not found.', 404);
        }
        catch (error) {
            const exposed = error instanceof AgentError;
            if (!response.headersSent && !response.destroyed) {
                send(response, exposed ? error.status : 500, { error: exposed ? error.message : 'Worker could not complete the request.' });
            }
        }
    });
}
