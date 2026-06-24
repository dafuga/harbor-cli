import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { addJsonActionCommand } from './action-fields.js';
import { addTxOptions } from './action.js';
import { getTableRows, printResult, serializeAction, transactActions } from '../lib/tx.js';
const AI_CONTRACT = process.env.HARBOR_AI_CONTRACT ?? 'harborai';
const MARKET_CONTRACT = process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket';
const AI_SERVICE_TYPES = {
    inference: { id: 18, name: 'aiinfer', aliases: ['infer', 'aiinfer', 'model-host', 'host'] },
    training: { id: 19, name: 'aitrain', aliases: ['train', 'aitrain', 'trainer'] },
    router: { id: 20, name: 'airouter', aliases: ['route', 'airouter', 'ai-router'] },
};
function addAiAction(root, spec) {
    addJsonActionCommand(root, AI_CONTRACT, spec);
}
export function renderAegisConfig(options = {}) {
    const reviewer = options.reviewer ?? 'local-small-judge';
    const command = options.command ?? 'fake-local';
    return `${JSON.stringify({
        models: [
            {
                id: reviewer,
                adapter: 'local',
                command,
                trustLevel: 'trusted',
            },
        ],
        trustedReviewer: reviewer,
        policy: {
            allowedPaths: ['HARBOR_AI_OUTPUT.md'],
            allowedOperations: ['write'],
            maxPatchBytes: 1_000_000,
            requireVerification: false,
        },
    }, null, 2)}\n`;
}
export function aegisHarborCheckCommand(configPath, options = {}) {
    const aegisCommand = options.aegisCommand?.trim() || process.env.HARBOR_AEGIS_COMMAND || 'aegis';
    return `${aegisCommand} harbor-check --config ${shellQuote(path.resolve(configPath))}`;
}
function resolveAiService(kind) {
    for (const [canonical, service] of Object.entries(AI_SERVICE_TYPES)) {
        if (canonical === kind) {
            return service;
        }
        if (service.name === kind || service.aliases.includes(kind)) {
            return service;
        }
    }
    const names = Object.values(AI_SERVICE_TYPES).map((service) => service.name).join(', ');
    throw new Error(`unknown AI service kind: ${kind}; expected one of ${names}`);
}
function positiveAsset(quantity) {
    const [amount] = quantity.trim().split(/\s+/);
    return Number(amount) > 0;
}
async function providerIsRegistered(marketContract, provider, options) {
    const rows = await getTableRows(marketContract, 'providers', {
        url: options.url,
        lowerBound: provider,
        upperBound: provider,
        limit: 1,
    });
    return rows.rows.some((row) => row.owner === provider);
}
function parseMetadata(metadata) {
    if (!metadata) {
        return {};
    }
    try {
        const parsed = JSON.parse(metadata);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function metadataText(metadata, keys) {
    for (const key of keys) {
        const value = metadata[key];
        if (typeof value === 'string' && value.trim() !== '') {
            return value.trim();
        }
    }
    return undefined;
}
function metadataNumber(metadata, keys) {
    for (const key of keys) {
        const value = Number(metadata[key]);
        if (Number.isFinite(value)) {
            return value;
        }
    }
    return undefined;
}
function metadataBoolean(metadata, keys) {
    for (const key of keys) {
        const value = metadata[key];
        if (typeof value === 'boolean') {
            return value;
        }
    }
    return undefined;
}
function metadataMatchesUser(metadata, user) {
    if (!user) {
        return true;
    }
    for (const key of ['user', 'current_user', 'requester', 'account', 'owner']) {
        if (metadata[key] === user) {
            return true;
        }
    }
    const users = metadata.users;
    return Array.isArray(users) && users.includes(user);
}
function hasTrustedSignal(metadata) {
    return metadata.trusted_ai_checked === true ||
        typeof metadata.trusted_ai_adapter === 'string' ||
        metadataNumber(metadata, ['trusted_ai_score_bps', 'trust_score_bps']) !== undefined ||
        metadataBoolean(metadata, ['trusted_ai_needs_tune']) !== undefined;
}
function routeNeedsTune(route, metadata, confidenceThreshold) {
    const confidence = Number(route.confidence_bps);
    if (Number.isFinite(confidence) && confidence > 0 && confidence < confidenceThreshold) {
        return true;
    }
    const trustedScore = metadataNumber(metadata, ['trusted_ai_score_bps', 'trust_score_bps']);
    if (trustedScore !== undefined && trustedScore > 0 && trustedScore < confidenceThreshold) {
        return true;
    }
    if (metadata.needs_tune === true || metadata.needs_finetune === true) {
        return true;
    }
    const outcome = metadataText(metadata, ['outcome', 'status', 'reason']);
    return outcome ? ['fallback', 'miss', 'low_confidence', 'low-confidence', 'weak'].includes(outcome) : false;
}
export function buildTuneNeeds(routes, subcalls, options = {}) {
    const confidenceThreshold = options.confidenceThreshold ?? 8500;
    const minCount = options.minCount ?? 1;
    const subcallsByInfer = new Map();
    for (const subcall of subcalls) {
        const inferId = Number(subcall.parent_infer_id);
        if (Number.isFinite(inferId) && inferId > 0) {
            subcallsByInfer.set(inferId, (subcallsByInfer.get(inferId) ?? 0) + 1);
        }
    }
    const groups = new Map();
    for (const route of routes) {
        const metadata = parseMetadata(route.metadata);
        if (!metadataMatchesUser(metadata, options.user)) {
            continue;
        }
        if (options.trustedOnly && !hasTrustedSignal(metadata)) {
            continue;
        }
        if (!routeNeedsTune(route, metadata, confidenceThreshold)) {
            continue;
        }
        const baseModelId = Number(route.selected_model_id);
        if (!Number.isFinite(baseModelId) || baseModelId <= 0) {
            continue;
        }
        const task = metadataText(metadata, ['task', 'goal', 'domain', 'intent', 'choice']) ?? `model-${baseModelId}`;
        const key = `${baseModelId}:${task}`;
        const confidence = Number(route.confidence_bps);
        const inferId = Number(route.infer_id ?? 0);
        const group = groups.get(key) ?? {
            base_model_id: baseModelId,
            task,
            route_count: 0,
            low_confidence_count: 0,
            subcall_count: 0,
            confidence_sum: 0,
            infer_ids: new Set(),
            request_hashes: new Set(),
            signals: new Set(),
        };
        group.route_count += 1;
        if (Number.isFinite(confidence)) {
            group.confidence_sum += confidence;
            if (confidence < confidenceThreshold) {
                group.low_confidence_count += 1;
            }
        }
        if (inferId > 0) {
            group.infer_ids.add(inferId);
            group.subcall_count += subcallsByInfer.get(inferId) ?? 0;
        }
        if (route.request_hash) {
            group.request_hashes.add(route.request_hash);
        }
        const signal = metadataText(metadata, ['outcome', 'status', 'reason']);
        if (signal) {
            group.signals.add(signal);
        }
        groups.set(key, group);
    }
    return [...groups.values()]
        .filter((group) => group.route_count >= minCount)
        .sort((a, b) => b.route_count - a.route_count || b.subcall_count - a.subcall_count || a.base_model_id - b.base_model_id)
        .map((group) => {
        const title = `Fine-tune ${group.task}`;
        const metadata = {
            source: 'harbor-ai-tune-needs',
            task: group.task,
            signals: [...group.signals],
            route_count: group.route_count,
            low_confidence_count: group.low_confidence_count,
            subcall_count: group.subcall_count,
            trusted_signal_count: options.trustedOnly ? group.route_count : undefined,
        };
        const proposer = options.proposer ?? '<proposer>';
        const dataset = options.datasetArtifactId ?? '<dataset_artifact_id>';
        const evalArtifact = options.evalArtifactId ?? '0';
        const expires = options.expiresSec ?? '604800';
        return {
            base_model_id: group.base_model_id,
            title,
            route_count: group.route_count,
            low_confidence_count: group.low_confidence_count,
            subcall_count: group.subcall_count,
            avg_confidence_bps: Math.round(group.confidence_sum / group.route_count),
            infer_ids: [...group.infer_ids],
            request_hashes: [...group.request_hashes],
            metadata,
            request_template: `harbor ai tune request ${proposer} ${group.base_model_id} ${dataset} ${evalArtifact} ${JSON.stringify(title)} '${JSON.stringify(metadata)}' ${expires}`,
        };
    });
}
function normalizeTask(value) {
    return (value ?? '').trim().toLowerCase();
}
function tuneTask(tune) {
    const metadata = parseMetadata(tune.metadata);
    return metadataText(metadata, ['task', 'goal', 'domain', 'intent', 'choice']);
}
function tuneMatchesNeed(tune, need) {
    if (Number(tune.status) !== 0) {
        return false;
    }
    if (Number(tune.base_model_id) !== need.base_model_id) {
        return false;
    }
    const needTask = normalizeTask(String(need.metadata.task ?? ''));
    if (!needTask) {
        return true;
    }
    const proposalTask = normalizeTask(tuneTask(tune));
    if (proposalTask && proposalTask === needTask) {
        return true;
    }
    return normalizeTask(tune.title).includes(needTask);
}
export function buildTuneAutoVotePlan(needs, tunes, options) {
    const plans = [];
    const usedTuneIds = new Set();
    for (const need of needs) {
        const tune = tunes.find((candidate) => !usedTuneIds.has(Number(candidate.id)) && tuneMatchesNeed(candidate, need));
        if (!tune) {
            continue;
        }
        const tuneId = Number(tune.id);
        usedTuneIds.add(tuneId);
        plans.push({
            tune_id: tuneId,
            approve: true,
            quantity: options.quantity,
            reason: `matched ${need.route_count} tune-need route(s) for ${need.metadata.task ?? need.title}`,
            need,
            tune,
        });
    }
    return plans;
}
function parseTrustedAiDecision(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return { raw };
    }
    try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' ? { ...parsed, raw: parsed } : { raw: parsed };
    }
    catch {
        return { raw };
    }
}
function shellQuote(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
export async function runTrustedAiAdapter(input, options) {
    if (options.adapterUrl) {
        const response = await fetch(options.adapterUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
            signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`trusted AI adapter returned ${response.status}: ${text}`);
        }
        return parseTrustedAiDecision(text);
    }
    if (options.adapterCommand) {
        const payloadPath = path.join(os.tmpdir(), `harbor-trusted-ai-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
        await fs.writeFile(payloadPath, JSON.stringify(input));
        return new Promise((resolve, reject) => {
            const child = spawn(`${options.adapterCommand} ${shellQuote(payloadPath)}`, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
            const timeout = setTimeout(() => {
                child.kill('SIGTERM');
                void fs.rm(payloadPath, { force: true });
                reject(new Error('trusted AI adapter timed out'));
            }, options.timeoutMs ?? 120_000);
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
            child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
            child.on('error', (error) => {
                clearTimeout(timeout);
                void fs.rm(payloadPath, { force: true });
                reject(error);
            });
            child.on('close', (code) => {
                clearTimeout(timeout);
                void fs.rm(payloadPath, { force: true });
                if (code !== 0) {
                    reject(new Error(`trusted AI adapter exited ${code}: ${stderr || stdout}`));
                    return;
                }
                resolve(parseTrustedAiDecision(stdout));
            });
        });
    }
    return {};
}
function decisionScore(decision) {
    for (const value of [decision.useful_bps, decision.score_bps, decision.trust_score_bps]) {
        const score = Number(value);
        if (Number.isFinite(score)) {
            return score;
        }
    }
    return 0;
}
function decisionApproves(decision, minUsefulBps) {
    if (typeof decision.approve === 'boolean') {
        return decision.approve;
    }
    if (typeof decision.useful === 'boolean') {
        return decision.useful;
    }
    if (typeof decision.needs_tune === 'boolean') {
        return decision.needs_tune;
    }
    const score = decisionScore(decision);
    return score === 0 || score >= minUsefulBps;
}
async function existingTuneVote(contract, tuneId, voter, options) {
    const rows = await getTableRows(contract, 'votes', {
        url: options.url,
        scope: String(tuneId),
        lowerBound: voter,
        upperBound: voter,
        limit: 1,
    });
    return rows.rows.some((row) => row.voter === voter);
}
function addTuneNeedsCommand(tune) {
    tune
        .command('needs')
        .description('Analyze routing audit logs and suggest fine-tune requests')
        .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
        .option('-c, --contract <account>', 'Harbor AI contract account', AI_CONTRACT)
        .option('--confidence-bps <bps>', 'confidence below this threshold is a tune signal', '8500')
        .option('--min-count <count>', 'minimum matching route count', '1')
        .option('--limit <count>', 'maximum suggestions to print', '20')
        .option('--user <account>', 'only analyze route logs for this current user')
        .option('--trusted-only', 'only use route logs carrying trusted AI checker signals')
        .option('--proposer <account>', 'fill proposer in request templates')
        .option('--dataset-artifact-id <id>', 'fill dataset artifact id in request templates')
        .option('--eval-artifact-id <id>', 'fill eval artifact id in request templates', '0')
        .option('--expires-sec <seconds>', 'fill tune request expiry seconds', '604800')
        .option('--json', 'print JSON')
        .action(async (options) => {
        const contract = options.contract ?? AI_CONTRACT;
        const [routes, subcalls] = await Promise.all([
            getTableRows(contract, 'routelogs', { url: options.url, scope: contract, limit: 1000 }),
            getTableRows(contract, 'subcalls', { url: options.url, scope: contract, limit: 1000 }),
        ]);
        const needs = buildTuneNeeds(routes.rows, subcalls.rows, {
            confidenceThreshold: Number(options.confidenceBps ?? 8500),
            minCount: Number(options.minCount ?? 1),
            proposer: options.proposer,
            datasetArtifactId: options.datasetArtifactId,
            evalArtifactId: options.evalArtifactId,
            expiresSec: options.expiresSec,
            user: options.user,
            trustedOnly: Boolean(options.trustedOnly),
        }).slice(0, Number(options.limit ?? 20));
        if (options.json) {
            console.log(JSON.stringify({ needs }, null, 2));
            return;
        }
        if (needs.length === 0) {
            console.log('No fine-tune needs found from current route logs.');
            return;
        }
        console.table(needs.map((need) => ({
            base_model_id: need.base_model_id,
            title: need.title,
            routes: need.route_count,
            low_confidence: need.low_confidence_count,
            subcalls: need.subcall_count,
            avg_confidence_bps: need.avg_confidence_bps,
        })));
        for (const need of needs) {
            console.log(need.request_template);
        }
    });
}
function addTuneAutoVoteCommand(tune) {
    addTxOptions(tune
        .command('auto-vote')
        .description('Vote for open fine-tune proposals that match current-user trusted tune needs')
        .requiredOption('--voter <account>', 'account casting the fine-tune vote')
        .option('-c, --contract <account>', 'Harbor AI contract account', AI_CONTRACT)
        .option('--quantity <asset>', 'vote escrow quantity', process.env.HARBOR_AI_AUTO_VOTE_QUANTITY ?? '1.0000 SYS')
        .option('--confidence-bps <bps>', 'confidence below this threshold is a tune signal', '8500')
        .option('--min-count <count>', 'minimum matching route count', '1')
        .option('--limit <count>', 'maximum auto-votes to plan', '20')
        .option('--user <account>', 'only vote for route logs for this current user')
        .option('--include-untrusted-signals', 'also vote from ordinary low-confidence route signals')
        .option('--adapter-command <command>', 'trusted AI adapter command; receives JSON payload file path as argv[1] and returns JSON')
        .option('--adapter-url <url>', 'trusted AI adapter HTTP endpoint')
        .option('--min-useful-bps <bps>', 'minimum adapter usefulness score for a yes vote', '8500')
        .option('--revote', 'replace an existing vote from the same voter')
        .option('--dry-run', 'print planned votes without broadcasting')).action(async (options) => {
        const contract = options.contract ?? AI_CONTRACT;
        const quantity = options.quantity ?? '1.0000 SYS';
        const [routes, subcalls, tunes] = await Promise.all([
            getTableRows(contract, 'routelogs', { url: options.url, scope: contract, limit: 1000 }),
            getTableRows(contract, 'subcalls', { url: options.url, scope: contract, limit: 1000 }),
            getTableRows(contract, 'tunereqs', { url: options.url, scope: contract, limit: 1000 }),
        ]);
        const needs = buildTuneNeeds(routes.rows, subcalls.rows, {
            confidenceThreshold: Number(options.confidenceBps ?? 8500),
            minCount: Number(options.minCount ?? 1),
            user: options.user ?? options.voter,
            trustedOnly: !options.includeUntrustedSignals,
        });
        const initialPlans = buildTuneAutoVotePlan(needs, tunes.rows, { quantity }).slice(0, Number(options.limit ?? 20));
        const minUsefulBps = Number(options.minUsefulBps ?? 8500);
        const plans = [];
        const skipped = [];
        for (const plan of initialPlans) {
            if (!options.revote && await existingTuneVote(contract, plan.tune_id, options.voter, { url: options.url })) {
                skipped.push({ tune_id: plan.tune_id, reason: 'voter already has a vote' });
                continue;
            }
            if (options.adapterCommand || options.adapterUrl) {
                const decision = await runTrustedAiAdapter({
                    kind: 'harbor.ai.tune_auto_vote',
                    voter: options.voter,
                    need: plan.need,
                    proposal: plan.tune,
                }, {
                    adapterCommand: options.adapterCommand,
                    adapterUrl: options.adapterUrl,
                });
                if (!decisionApproves(decision, minUsefulBps)) {
                    skipped.push({ tune_id: plan.tune_id, reason: decision.reason ?? 'trusted AI adapter did not approve' });
                    continue;
                }
                plan.reason = decision.reason ?? plan.reason;
            }
            plans.push(plan);
        }
        const printablePlans = plans.map((plan) => ({
            tune_id: plan.tune_id,
            approve: plan.approve,
            quantity: plan.quantity,
            base_model_id: plan.need.base_model_id,
            task: plan.need.metadata.task,
            route_count: plan.need.route_count,
            reason: plan.reason,
        }));
        const summary = { voter: options.voter, planned_votes: printablePlans, skipped, needs };
        if (options.dryRun || plans.length === 0) {
            printResult(summary, options.json);
            return;
        }
        const actorOptions = { ...options, actor: options.actor ?? options.voter };
        const actions = [];
        for (const plan of plans) {
            actions.push(await serializeAction({
                contract,
                action: 'votetune',
                data: {
                    voter: options.voter,
                    tune_id: plan.tune_id,
                    approve: plan.approve,
                    quantity: plan.quantity,
                },
                url: options.url,
                actor: actorOptions.actor,
                permission: actorOptions.permission,
                key: actorOptions.key,
                authorization: actorOptions.auth,
                expiration: actorOptions.expiration,
            }));
        }
        const result = await transactActions(actorOptions, actions);
        printResult({ ...summary, result }, options.json);
    });
}
function addTrustCommand(ai) {
    const trust = new Command('trust');
    trust.description('Configure trusted AI safety adapters for Harbor routing and fine-tune voting');
    trust
        .command('aegis-config <output>')
        .description('Write a starter Aegis trusted-reviewer config for Harbor')
        .option('--reviewer <id>', 'trusted reviewer model id', 'local-small-judge')
        .option('--command <command>', 'local trusted model command; receives an Aegis JSON payload path')
        .option('--force', 'overwrite an existing config file')
        .option('--json', 'print JSON')
        .action(async (output, options) => {
        const file = path.resolve(output);
        if (!options.force) {
            try {
                await fs.access(file);
                throw new Error(`refusing to overwrite existing file: ${file}`);
            }
            catch (error) {
                if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) {
                    throw error;
                }
            }
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, renderAegisConfig({
            reviewer: options.reviewer,
            command: options.command ?? process.env.HARBOR_AEGIS_TRUSTED_COMMAND,
        }), 'utf8');
        const adapterCommand = aegisHarborCheckCommand(file);
        printResult({
            config: file,
            reviewer: options.reviewer ?? 'local-small-judge',
            trusted_checker_command: adapterCommand,
            env: { HARBOR_AI_TRUSTED_CHECKER_COMMAND: adapterCommand },
        }, options.json);
    });
    trust
        .command('aegis-env')
        .description('Print the Harbor runtime env var for an Aegis trusted checker')
        .requiredOption('--config <path>', 'Aegis config path')
        .option('--aegis-command <command>', 'Aegis executable or command prefix', process.env.HARBOR_AEGIS_COMMAND ?? 'aegis')
        .option('--json', 'print JSON')
        .action((options) => {
        const adapterCommand = aegisHarborCheckCommand(options.config, { aegisCommand: options.aegisCommand });
        const envLine = `export HARBOR_AI_TRUSTED_CHECKER_COMMAND=${shellQuote(adapterCommand)}`;
        if (options.json) {
            printResult({
                trusted_checker_command: adapterCommand,
                env: { HARBOR_AI_TRUSTED_CHECKER_COMMAND: adapterCommand },
                export: envLine,
            }, true);
            return;
        }
        console.log(envLine);
    });
    trust
        .command('aegis-smoke')
        .description('Run a sample Harbor route-verification payload through Aegis')
        .requiredOption('--config <path>', 'Aegis config path')
        .option('--aegis-command <command>', 'Aegis executable or command prefix', process.env.HARBOR_AEGIS_COMMAND ?? 'aegis')
        .option('--task <task>', 'sample task label', 'harbor-safety-smoke')
        .option('--prompt <text>', 'sample prompt', 'Answer safely and identify gaps.')
        .option('--output <text>', 'sample model output', 'fallback: I do not know')
        .option('--user <account>', 'sample current user')
        .option('--json', 'print JSON')
        .action(async (options) => {
        const adapterCommand = aegisHarborCheckCommand(options.config, { aegisCommand: options.aegisCommand });
        const payload = {
            kind: 'harbor.ai.route_verification',
            router: 'harbor-cli',
            provider: 'smoke',
            policy_id: 0,
            infer_id: 0,
            model_id: 0,
            request_hash: 'smoke',
            user: options.user ?? '',
            task: options.task ?? 'harbor-safety-smoke',
            prompt: options.prompt ?? '',
            output: options.output ?? '',
        };
        const decision = await runTrustedAiAdapter(payload, { adapterCommand });
        printResult({ trusted_checker_command: adapterCommand, payload, decision }, options.json);
    });
    ai.addCommand(trust);
}
function addOfferCommand(ai) {
    addTxOptions(ai
        .command('offer <kind> <provider> <endpoint>')
        .description('Register an AI inference, training, or router service in svcmarket')
        .option('--market-contract <account>', 'service market contract account', MARKET_CONTRACT)
        .option('--range-start <value>', 'model/task range start', '0')
        .option('--range-end <value>', 'model/task range end', '0')
        .option('--capacity-bytes <bytes>', 'declared capacity', '0')
        .option('--stake <quantity>', 'provider stake to add before service registration', process.env.HARBOR_AI_PROVIDER_STAKE ?? '20.0000 SYS')
        .option('--metadata <json>', 'service metadata JSON', '{}')
        .option('--skip-register-provider', 'do not create svcmarket provider row if missing')
        .option('--dry-run', 'print planned actions without broadcasting')).action(async (kind, provider, endpoint, options) => {
        const service = resolveAiService(kind);
        const marketContract = options.marketContract ?? MARKET_CONTRACT;
        const actorOptions = { ...options, actor: options.actor ?? provider };
        const metadata = options.metadata ?? '{}';
        const planned = [];
        if (!options.skipRegisterProvider) {
            const registered = await providerIsRegistered(marketContract, provider, options);
            if (!registered) {
                planned.push({
                    contract: marketContract,
                    action: 'regprovider',
                    data: { provider, metadata: JSON.stringify({ source: 'harbor-ai-offer', service: service.name }) },
                });
            }
        }
        const stake = options.stake ?? '20.0000 SYS';
        if (positiveAsset(stake)) {
            planned.push({
                contract: marketContract,
                action: 'stakeprov',
                data: { provider, quantity: stake },
            });
        }
        planned.push({
            contract: marketContract,
            action: 'addservice',
            data: {
                provider,
                service_type: service.id,
                segment_kind: 1,
                range_start: options.rangeStart ?? '0',
                range_end: options.rangeEnd ?? '0',
                capacity_bytes: Number(options.capacityBytes ?? 0),
                endpoint,
                metadata,
            },
        });
        if (options.dryRun) {
            printResult({ service_type: service.name, provider, endpoint, actions: planned }, options.json);
            return;
        }
        const actions = [];
        for (const action of planned) {
            actions.push(await serializeAction({
                contract: action.contract,
                action: action.action,
                data: action.data,
                url: options.url,
                actor: actorOptions.actor,
                permission: actorOptions.permission,
                key: actorOptions.key,
                authorization: actorOptions.auth,
                expiration: actorOptions.expiration,
            }));
        }
        const result = await transactActions(actorOptions, actions);
        printResult({ service_type: service.name, provider, endpoint, actions: planned.map((action) => action.action), result }, options.json);
    });
}
function group(name, description, specs) {
    const cmd = new Command(name);
    cmd.description(description);
    for (const spec of specs) {
        addAiAction(cmd, spec);
    }
    return cmd;
}
export function createAiCommand() {
    const ai = new Command('ai');
    ai.description('Manage Harbor AI models, tuning, training, inference, and routing');
    addOfferCommand(ai);
    addTrustCommand(ai);
    addAiAction(ai, {
        command: 'configure',
        action: 'setparams',
        fields: [
            'token_symbol',
            'token_contract',
            'storage_contract',
            'svcmarket_contract',
            ['max_title_size', 'number'],
            ['max_metadata_size', 'number'],
            ['tune_quorum_bps', 'number'],
            ['tune_threshold_bps', 'number'],
            ['min_train_scores', 'number'],
        ],
    });
    addAiAction(ai, { command: 'claim', action: 'claim', fields: ['owner', 'quantity'], signerField: 'owner' });
    ai.addCommand(group('artifact', 'Register Harbor AI artifact references', [
        {
            command: 'add',
            action: 'addartifact',
            fields: ['owner', ['kind', 'number'], ['storage_object_id', 'number'], 'content_hash', 'metadata'],
            signerField: 'owner',
        },
    ]));
    ai.addCommand(group('model', 'Register and retire AI models', [
        {
            command: 'register',
            action: 'regmodel',
            fields: ['owner', ['model_type', 'number'], ['parent_model_id', 'number'], ['weights_artifact_id', 'number'], ['eval_artifact_id', 'number'], 'title', 'metadata'],
            signerField: 'owner',
        },
        {
            command: 'set',
            action: 'setmodel',
            fields: ['owner', ['model_id', 'number'], ['status', 'number'], 'metadata'],
            signerField: 'owner',
        },
    ]));
    const tune = group('tune', 'Request and vote on community fine-tunes', [
        {
            command: 'propose',
            action: 'proptune',
            fields: ['proposer', ['base_model_id', 'number'], ['dataset_artifact_id', 'number'], ['eval_artifact_id', 'number'], 'title', 'metadata', ['expires_sec', 'number']],
            signerField: 'proposer',
        },
        {
            command: 'request',
            action: 'proptune',
            fields: ['proposer', ['base_model_id', 'number'], ['dataset_artifact_id', 'number'], ['eval_artifact_id', 'number'], 'title', 'metadata', ['expires_sec', 'number']],
            signerField: 'proposer',
        },
        { command: 'vote', action: 'votetune', fields: ['voter', ['tune_id', 'number'], ['approve', 'boolean'], 'quantity'], signerField: 'voter' },
        { command: 'close', action: 'closetune', fields: [['tune_id', 'number']] },
        { command: 'reclaim', action: 'reclaim', fields: ['voter', ['tune_id', 'number']], signerField: 'voter' },
        {
            command: 'contribute-data',
            action: 'contribdata',
            fields: ['contributor', ['tune_id', 'number'], ['dataset_artifact_id', 'number'], ['reward_weight', 'number'], 'metadata'],
            signerField: 'contributor',
        },
        {
            command: 'reward-data',
            action: 'rewarddata',
            fields: ['payer', ['tune_id', 'number'], 'reward', 'memo'],
            signerField: 'payer',
        },
    ]);
    addTuneNeedsCommand(tune);
    addTuneAutoVoteCommand(tune);
    ai.addCommand(tune);
    ai.addCommand(group('train', 'Run Harbor AI training job lifecycle actions', [
        {
            command: 'start',
            action: 'starttrain',
            fields: ['creator', ['tune_id', 'number'], ['base_model_id', 'number'], ['dataset_artifact_id', 'number'], 'reward', ['min_score', 'number'], 'metadata', ['expires_sec', 'number']],
            signerField: 'creator',
        },
        {
            command: 'submit',
            action: 'submittrain',
            fields: ['trainer', ['train_id', 'number'], ['weights_artifact_id', 'number'], 'metrics_hash', 'metadata'],
            signerField: 'trainer',
        },
        {
            command: 'score',
            action: 'scoretrain',
            fields: ['validator', ['submission_id', 'number'], ['score', 'number'], 'report_hash'],
            signerField: 'validator',
        },
        { command: 'settle', action: 'settletrain', fields: [['train_id', 'number']] },
    ]));
    ai.addCommand(group('infer', 'Request and settle Harbor AI inference jobs', [
        {
            command: 'request',
            action: 'reqinfer',
            fields: ['requester', ['model_id', 'number'], 'prompt_hash', ['max_input_tokens', 'number'], ['max_output_tokens', 'number'], 'max_fee', 'metadata'],
            signerField: 'requester',
        },
        {
            command: 'complete',
            action: 'completeinf',
            fields: ['provider', ['infer_id', 'number'], 'result_hash', ['input_tokens', 'number'], ['output_tokens', 'number'], 'fee', 'metadata'],
            signerField: 'provider',
        },
        { command: 'fail', action: 'failjob', fields: ['actor', ['infer_id', 'number'], 'reason_hash', 'metadata'], signerField: 'actor' },
        { command: 'cancel', action: 'canceljob', fields: ['requester', ['infer_id', 'number']], signerField: 'requester' },
    ]));
    ai.addCommand(group('route', 'Configure and audit AI routing decisions', [
        {
            command: 'policy',
            action: 'setroutepol',
            fields: ['owner', ['policy_id', 'number'], ['default_model_id', 'number'], ['classifier_model_id', 'number'], ['token_interval', 'number'], 'metadata'],
            signerField: 'owner',
        },
        {
            command: 'log',
            action: 'logroute',
            fields: ['router', ['policy_id', 'number'], ['infer_id', 'number'], 'request_hash', ['selected_model_id', 'number'], ['token_start', 'number'], ['token_end', 'number'], ['classifier_model_id', 'number'], ['confidence_bps', 'number'], 'metadata'],
            signerField: 'router',
        },
        {
            command: 'subcall',
            action: 'logsubcall',
            fields: ['caller', ['parent_infer_id', 'number'], ['from_model_id', 'number'], ['to_model_id', 'number'], 'call_hash', ['token_start', 'number'], ['token_end', 'number'], 'metadata'],
            signerField: 'caller',
        },
    ]));
    return ai;
}
