import { AgentToolSafetyService } from '@dafuga01/harness-agent-safety';
import { specialtyManifest } from './specialties.js';
import { AgentError, alias, hash } from './validation.js';
export function workerToolDispatch(context) {
    const tools = {
        read_file: definition('read_file', context),
        use_secret: definition('use_secret', context),
    };
    const safety = new AgentToolSafetyService({
        tools,
        journal: context.journal,
        now: context.now,
        policy: agentId => {
            context.assertActive();
            const agent = context.agent();
            if (agent.id === agentId && !context.network.localOnly)
                return toolPolicy(agent);
        },
    });
    return async (raw) => {
        const agentId = context.agent().id;
        const proposal = modelProposal(raw);
        let decision = await safety.submit(agentId, proposal);
        if (decision.status === 'held') {
            const call = toolCall('use_secret', JSON.parse(proposal).input);
            if (!call?.message)
                throw new AgentError('Tool review is unavailable.', 409);
            const visible = { ...decision.review, agentId, runId: context.runId, content: call.message };
            if (!await context.reviews.wait(visible, context.signal, context.now())) {
                context.declined();
                throw new AgentError('Tool review was declined or expired.', 403);
            }
            decision = await safety.approve(agentId, decision.review.id, proposal);
        }
        if (decision.status === 'denied')
            throw new AgentError('Tool denied by worker safety policy.', 403);
        if (decision.status !== 'executed')
            throw new AgentError('Tool execution could not be verified.', 403);
        return decision.output;
    };
}
function toolPolicy(agent) {
    const manifest = agent.specialty && specialtyManifest(agent.specialty, agent.specialtyVersion);
    return {
        revision: String(agent.revision),
        specialty: manifest ? `${manifest.id}:${manifest.version}` : 'legacy',
        declaredTools: manifest
            ? manifest.tools.includes('harborstore.read:approved-content') ? ['read_file'] : []
            : ['read_file', 'use_secret'],
        grants: [
            ...agent.files.map(resource => ({ tool: 'read_file', resource })),
            ...agent.secrets.map(resource => ({ tool: 'use_secret', resource })),
        ],
        maxCallsPerMinute: 16,
    };
}
function modelProposal(value) {
    if (!value || typeof value !== 'object' || !('name' in value))
        return '';
    return JSON.stringify({ tool: value.name, input: value });
}
function toolCall(name, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return;
    if (!('name' in input) || input.name !== name || !('resource' in input) || typeof input.resource !== 'string')
        return;
    const { resource } = input;
    if (name === 'read_file')
        return Object.keys(input).length === 2 && hash(resource) ? { name, resource } : undefined;
    if (!alias(resource) || Object.keys(input).length !== 3 || !('message' in input) || typeof input.message !== 'string')
        return;
    const message = input.message.trim();
    // An exact-text review must not hide or visually reorder signed bytes.
    if (message.length && Buffer.byteLength(message) <= 512 && !/[\p{Cf}\p{Cc}]/u.test(message)) {
        return { name, resource, message };
    }
}
function definition(name, context) {
    return {
        action: name === 'read_file' ? 'file-read' : 'credential-use',
        prepare(input) {
            const call = toolCall(name, input);
            if (!call)
                return;
            return {
                resource: call.resource,
                summary: name === 'read_file' ? 'Read the specified HarborStore object'
                    : 'Sign this text with HarborVault grant ' + call.resource,
                execute: assertCurrent => executeTool(context, call, assertCurrent),
            };
        },
    };
}
async function executeTool(context, call, assertCurrent) {
    const { network, signal, runId, inferId, prompt, response } = context;
    const verification = await network.verify(call, { runId, inferId, prompt, response }, signal);
    if (!hash(verification))
        throw new AgentError('Independent tool verification failed.', 403);
    assertCurrent();
    const result = call.name === 'read_file' ? await network.readFile(call.resource, signal)
        : await network.useSecret(call.resource, call.message, { runId, assertActive: assertCurrent }, signal);
    return { name: call.name, resource: call.resource, verification, result };
}
