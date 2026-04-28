import { Command } from 'commander';
import { addTxOptions, pushJsonAction } from './action.js';
function actionOptions(args) {
    const last = args.at(-1);
    if (last && typeof last.optsWithGlobals === 'function') {
        return last.optsWithGlobals();
    }
    if (last && typeof last.opts === 'function') {
        return last.opts();
    }
    return last;
}
function fieldName(field) {
    return Array.isArray(field) ? field[0] : field;
}
function fieldType(field) {
    return Array.isArray(field) ? field[1] : 'string';
}
function parseField(value, type) {
    if (type === 'number') {
        return Number(value);
    }
    if (type === 'boolean') {
        return value === 'true' || value === '1';
    }
    if (type === 'json') {
        return JSON.parse(value);
    }
    return value;
}
function addDomainAction(root, contractDefault, spec) {
    let cmd = root.command(spec.command);
    cmd.description(spec.description ?? `Push ${spec.action}`);
    for (const field of spec.fields) {
        cmd = cmd.argument(`<${fieldName(field)}>`);
    }
    cmd.option('-c, --contract <account>', 'contract account', contractDefault);
    addTxOptions(cmd).action(async (...args) => {
        const options = actionOptions(args);
        const values = args.slice(0, -1);
        const data = Object.fromEntries(spec.fields.map((field, index) => [fieldName(field), parseField(values[index], fieldType(field))]));
        const signer = spec.signerField ? String(data[spec.signerField]) : undefined;
        await pushJsonAction(String(options.contract), spec.action, data, { ...options, actor: String(options.actor ?? signer) });
    });
}
function domain(name, description, contractDefault, actions) {
    const root = new Command(name);
    root.description(description);
    for (const action of actions) {
        addDomainAction(root, contractDefault, action);
    }
    return root;
}
export function createSitesCommand() {
    return domain('sites', 'Manage Harbor Sites', 'harborsites', [
        { command: 'configure', action: 'setparams', fields: ['storage_contract', ['max_metadata_size', 'number'], ['max_entry_path_size', 'number']] },
        { command: 'register', action: 'regsite', fields: ['owner', 'slug', 'metadata'], signerField: 'owner' },
        { command: 'publish', action: 'publish', fields: ['owner', 'slug', ['manifest_object_id', 'number'], 'manifest_hash', 'entry_path', 'metadata'], signerField: 'owner' },
        { command: 'set-active', action: 'setactive', fields: ['owner', 'slug', ['version_id', 'number']], signerField: 'owner' },
        { command: 'unpublish', action: 'unpublish', fields: ['owner', 'slug'], signerField: 'owner' },
    ]);
}
export function createChatCommand() {
    return domain('chat', 'Manage Harbor Chat', 'harborchat', [
        { command: 'create-dm', action: 'createdm', fields: ['creator', 'recipient', 'metadata_hash', ['metadata_object_id', 'number']], signerField: 'creator' },
        { command: 'create-group', action: 'creategroup', fields: ['creator', ['members', 'json'], 'metadata_hash', ['metadata_object_id', 'number']], signerField: 'creator' },
        { command: 'create-channel', action: 'createchan', fields: ['creator', 'title', ['open_posting', 'boolean'], 'metadata_hash', ['metadata_object_id', 'number']], signerField: 'creator' },
        { command: 'set-meta', action: 'setmeta', fields: ['editor', ['conversation_id', 'number'], 'title', 'metadata_hash', ['metadata_object_id', 'number']], signerField: 'editor' },
        { command: 'add-member', action: 'addmember', fields: ['actor', ['conversation_id', 'number'], 'account', ['can_post', 'boolean']], signerField: 'actor' },
        { command: 'remove-member', action: 'rmmember', fields: ['actor', ['conversation_id', 'number'], 'account'], signerField: 'actor' },
        { command: 'set-poster', action: 'setposter', fields: ['actor', ['conversation_id', 'number'], 'account', ['can_post', 'boolean']], signerField: 'actor' },
        { command: 'set-policy', action: 'setpolicy', fields: ['actor', ['conversation_id', 'number'], ['open_posting', 'boolean']], signerField: 'actor' },
        { command: 'post', action: 'post', fields: ['sender', ['conversation_id', 'number'], 'encrypted_hash', ['storage_object_id', 'number'], 'key_hash', 'reply_to_hash'], signerField: 'sender' },
        { command: 'delete-message', action: 'delmsg', fields: ['actor', ['message_id', 'number']], signerField: 'actor' },
        { command: 'vouch', action: 'vouch', fields: ['referrer', 'account'], signerField: 'referrer' },
        { command: 'flag-bot', action: 'flagbot', fields: ['reporter', 'account'], signerField: 'reporter' },
    ]);
}
export function createDappsCommand() {
    return domain('dapps', 'Manage Harbor dApp registry', 'dappreg', [
        { command: 'configure', action: 'setparams', fields: ['stake_contract', ['max_metadata_size', 'number']] },
        { command: 'register', action: 'regdapp', fields: ['dapp', 'owner', 'title', 'metadata'], signerField: 'owner' },
        { command: 'set', action: 'setdapp', fields: ['dapp', 'owner', ['active', 'boolean'], 'title', 'metadata'], signerField: 'owner' },
        { command: 'use', action: 'usedapp', fields: ['user', 'dapp', ['usage_units', 'number']], signerField: 'user' },
        { command: 'rate', action: 'ratedapp', fields: ['voter', 'dapp', ['rating', 'number']], signerField: 'voter' },
    ]);
}
export function createAuditCommand() {
    return domain('audit', 'Manage Harbor audit market', 'auditmarket', [
        { command: 'configure', action: 'setparams', fields: ['token_symbol', 'base_reward', 'dapp_contract', ['max_metadata_size', 'number'], ['min_verifier_votes', 'number']] },
        { command: 'fund', action: 'fundreward', fields: ['from', 'quantity'], signerField: 'from' },
        { command: 'report', action: 'reportbug', fields: ['auditor', 'dapp', 'report_hash', 'metadata'], signerField: 'auditor' },
        { command: 'assign', action: 'assignverifs', fields: ['owner', ['report_id', 'number'], ['verifiers', 'json']], signerField: 'owner' },
        { command: 'verify', action: 'verifybug', fields: ['verifier', ['report_id', 'number'], ['severity', 'number'], ['accepted', 'boolean']], signerField: 'verifier' },
        { command: 'finalize', action: 'finalizebug', fields: [['report_id', 'number']] },
        { command: 'claim', action: 'claim', fields: ['owner', 'quantity'], signerField: 'owner' },
    ]);
}
export function createPowerupCommand() {
    return domain('powerup', 'Manage Harbor PowerUp sponsor', 'harborpwrup1', [
        { command: 'configure', action: 'setparams', fields: [['enabled', 'boolean'], ['days', 'number'], ['net_frac', 'number'], ['cpu_frac', 'number'], 'max_payment', 'daily_budget'] },
        { command: 'set-system', action: 'setsystem', fields: ['system_contract'] },
        { command: 'claim', action: 'claim', fields: ['receiver'] },
    ]);
}
export function createGovCommand() {
    return domain('gov', 'Manage Harbor governance', 'harborgov', [
        { command: 'configure', action: 'setparams', fields: ['token_symbol', 'token_contract', 'system_contract', ['popular_threshold_bps', 'number'], ['quorum_bps', 'number'], ['max_title_size', 'number'], ['max_metadata_size', 'number']] },
        { command: 'propose', action: 'propose', fields: ['proposer', 'title', 'metadata', ['expires_sec', 'number']], signerField: 'proposer' },
        { command: 'vote', action: 'vote', fields: ['voter', ['proposal_id', 'number'], ['approve', 'boolean'], 'quantity'], signerField: 'voter' },
        { command: 'expire', action: 'expire', fields: [['proposal_id', 'number']] },
        { command: 'accept', action: 'accept', fields: ['bp', ['proposal_id', 'number']], signerField: 'bp' },
        { command: 'reclaim', action: 'reclaim', fields: ['voter', ['proposal_id', 'number']], signerField: 'voter' },
    ]);
}
export function createProjectsCommand() {
    return domain('projects', 'Manage Harbor projects', 'hbrprojects', [
        { command: 'configure', action: 'setparams', fields: ['token_symbol', 'token_contract', ['max_title_size', 'number'], ['max_metadata_size', 'number']] },
        { command: 'create', action: 'create', fields: ['owner', 'title', 'metadata', ['approval_bps', 'number'], ['investor_profit_bps', 'number']], signerField: 'owner' },
        { command: 'set', action: 'setproject', fields: ['owner', ['project_id', 'number'], 'title', 'metadata', ['approval_bps', 'number'], ['investor_profit_bps', 'number'], ['status', 'number']], signerField: 'owner' },
        { command: 'add-member', action: 'addmember', fields: ['owner', ['project_id', 'number'], 'member', ['share_bps', 'number']], signerField: 'owner' },
        { command: 'remove-member', action: 'remmember', fields: ['owner', ['project_id', 'number'], 'member'], signerField: 'owner' },
        { command: 'invest', action: 'invest', fields: ['investor', ['project_id', 'number'], 'quantity'], signerField: 'investor' },
        { command: 'fund', action: 'fundproj', fields: ['from', ['project_id', 'number'], 'quantity'], signerField: 'from' },
        { command: 'post-work', action: 'postwork', fields: ['owner', ['project_id', 'number'], 'assignee', 'fee', 'metadata'], signerField: 'owner' },
        { command: 'accept-work', action: 'acceptwork', fields: ['worker', ['work_id', 'number']], signerField: 'worker' },
        { command: 'submit-work', action: 'submitwork', fields: ['worker', ['work_id', 'number'], 'result_hash', 'metadata'], signerField: 'worker' },
        { command: 'approve-work', action: 'approvework', fields: ['owner', ['work_id', 'number']], signerField: 'owner' },
        { command: 'cancel-work', action: 'cancelwork', fields: ['owner', ['work_id', 'number']], signerField: 'owner' },
        { command: 'record-profit', action: 'recordprofit', fields: ['from', ['project_id', 'number'], 'quantity'], signerField: 'from' },
        { command: 'propose', action: 'propose', fields: ['proposer', ['project_id', 'number'], 'kind', 'metadata', ['expires_sec', 'number']], signerField: 'proposer' },
        { command: 'vote', action: 'vote', fields: ['voter', ['proposal_id', 'number'], ['approve', 'boolean']], signerField: 'voter' },
        { command: 'claim', action: 'claim', fields: ['owner', 'quantity'], signerField: 'owner' },
    ]);
}
export function createIbcCommand() {
    return domain('ibc', 'Manage Harbor IBC', 'harboribc', [
        { command: 'set-config', action: 'setconfig', fields: [['policy_cache_expiry', 'number'], ['proof_cache_expiry', 'number']] },
        { command: 'set-policy', action: 'setfpolicy', fields: [['policy', 'json'], ['from_block_num', 'number']] },
        { command: 'check-proof', action: 'checkproof', fields: [['proof', 'json']] },
        { command: 'test-bitset', action: 'testbitset', fields: ['bitset_string', ['bitset_vector', 'json'], ['finalizers_count', 'number']] },
    ]);
}
