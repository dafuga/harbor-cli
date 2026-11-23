export class AgentError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
export function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new AgentError('Expected a JSON object.');
    return value;
}
export function text(value, label, max) {
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) {
        throw new AgentError(`${label} must contain 1 to ${max} bytes.`);
    }
    return value.trim();
}
export function amount(value, label) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) {
        throw new AgentError(`${label} must be a whole number of minor units from 0 to 1 trillion.`);
    }
    return value;
}
export function hash(value) {
    return /^[0-9a-f]{64}$/.test(value);
}
export function alias(value) {
    return /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}
export function permissions(value, validate, label) {
    if (!Array.isArray(value) || value.length > 16 || value.some(item => typeof item !== 'string' || !validate(item))) {
        throw new AgentError(`Invalid ${label}. Specify at most 16 distinct entries.`);
    }
    return [...new Set(value)];
}
