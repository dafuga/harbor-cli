import { sha256 } from './http.js';
import { AgentError, hash, record, text } from './validation.js';
const RECEIPT_LIMIT = 24_000;
const DEFINITION_LIMIT = 12_000;
function decode(value, max) {
    if (typeof value !== 'string' || value.length > 4 * Math.ceil(max / 3)) {
        throw new AgentError('Invalid or oversized Harness artifact.');
    }
    const bytes = Buffer.from(value, 'base64');
    if (!bytes.length || bytes.length > max || bytes.toString('base64') !== value) {
        throw new AgentError('Expected canonical base64 Harness bytes.');
    }
    return bytes;
}
function json(bytes) {
    try {
        return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    }
    catch {
        throw new AgentError('Expected a UTF-8 JSON object in the Harness export.');
    }
}
function fields(value, allowed) {
    if (Object.keys(value).length !== allowed.length || !allowed.every(key => Object.hasOwn(value, key))) {
        throw new AgentError('Unexpected fields in the Harness export.');
    }
}
export function reviewedAgentDefinition(input) {
    const request = record(input);
    const bytes = decode(request.receipt, RECEIPT_LIMIT);
    const receiptHash = sha256(bytes);
    if (request.approvedSha256 !== receiptHash) {
        throw new AgentError('Harness receipt bytes differ from the reviewed digest.', 409);
    }
    const receipt = json(bytes);
    fields(receipt, ['schema', 'runId', 'sourceCommit', 'profile', 'verification', 'artifact']);
    if (receipt.schema !== 1 || receipt.profile !== 'harbor-agent') {
        throw new AgentError('Unsupported Harness agent receipt schema or profile.');
    }
    const runId = text(receipt.runId, 'Harness run ID', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(runId))
        throw new AgentError('Invalid Harness run ID.');
    const sourceCommit = text(receipt.sourceCommit, 'Source commit', 64);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit))
        throw new AgentError('Invalid source commit.');
    const verification = record(receipt.verification);
    fields(verification, ['build', 'test']);
    if (verification.build !== 'passed' || verification.test !== 'passed') {
        throw new AgentError('The reviewed Harness build and tests must pass.', 409);
    }
    const artifact = record(receipt.artifact);
    fields(artifact, ['format', 'sha256', 'base64']);
    if (artifact.format !== 'harbor-agent-definition')
        throw new AgentError('Expected a Harbor agent definition.');
    const definition = decode(artifact.base64, DEFINITION_LIMIT);
    const artifactHash = sha256(definition);
    if (typeof artifact.sha256 !== 'string' || !hash(artifact.sha256) || artifact.sha256 !== artifactHash) {
        throw new AgentError('Harness agent definition digest mismatch.', 409);
    }
    const data = json(definition);
    fields(data, ['name', 'instructions', 'model', 'perRun', 'total', 'files', 'secrets']);
    return { data, runId, sourceCommit, artifactHash, receiptHash };
}
