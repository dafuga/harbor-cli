import { createHash } from 'node:crypto';
import { AgentError, record } from './validation.js';
export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
export function serviceUrl(value, label) {
    let url;
    try {
        url = new URL(String(value));
    }
    catch {
        throw new AgentError(`Invalid ${label} URL.`);
    }
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (loopback && url.protocol === 'http:')) ||
        url.username || url.password || url.search || url.hash) {
        throw new AgentError(`${label} must use HTTPS or local loopback, with no URL credentials.`);
    }
    return url;
}
export async function responseBytes(response, maximum) {
    if (Number(response.headers.get('content-length')) > maximum || !response.body) {
        await response.body?.cancel();
        throw new AgentError('Service response exceeded its size limit or was empty.', 502);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                return Buffer.concat(chunks, bytes);
            bytes += value.length;
            if (bytes > maximum)
                throw new AgentError('Service response exceeded its size limit.', 502);
            chunks.push(value);
        }
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
export async function postJson(url, body, options = {}) {
    const deadline = AbortSignal.timeout(options.timeout ?? 15_000);
    const response = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', ...options.headers },
        signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline,
        redirect: 'error',
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new AgentError(`Service returned HTTP ${response.status}.`, 502);
    }
    const raw = (await responseBytes(response, 1024 * 1024)).toString('utf8');
    return { raw, data: record(JSON.parse(raw)) };
}
