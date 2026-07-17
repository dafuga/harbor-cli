import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { addJsonActionCommand } from './action-fields.js';
import { addTxOptions } from './action.js';
import { getTableRows, printResult, pushAction, serializeAction, transactActions } from '../lib/tx.js';
import { putReplicatedObject, putWalrusObject, sha256Bytes } from '../lib/storage.js';
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
export const AI_DATA_SCOPE_TRAINING = 1;
export const AI_DATA_SCOPE_PROMPT = 2;
export const AI_DATA_SCOPE_RESPONSE = 4;
export const AI_DATA_REQUIRED_SCOPES = AI_DATA_SCOPE_TRAINING | AI_DATA_SCOPE_PROMPT | AI_DATA_SCOPE_RESPONSE;
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function stableValue(value) {
    if (Array.isArray(value)) {
        return value.map((item) => stableValue(item));
    }
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value)
            .filter(([, child]) => child !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, stableValue(child)]));
    }
    return value;
}
export function canonicalJson(value) {
    return `${JSON.stringify(stableValue(value))}\n`;
}
function jsonLineHash(value) {
    return sha256Bytes(Buffer.from(canonicalJson(value)));
}
function unknownRecordString(record, key) {
    const value = record[key];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
function unknownRecordNumber(record, key) {
    const value = Number(record[key]);
    return Number.isFinite(value) ? value : undefined;
}
function unknownRecordBoolean(record, key) {
    const value = record[key];
    if (typeof value === 'boolean') {
        return value;
    }
    if (value === 'true' || value === '1') {
        return true;
    }
    if (value === 'false' || value === '0') {
        return false;
    }
    return undefined;
}
function nestedString(record, parent, key) {
    const value = record[parent];
    if (!isPlainObject(value)) {
        return undefined;
    }
    return unknownRecordString(value, key);
}
function nestedNumber(record, parent, key) {
    const value = record[parent];
    if (!isPlainObject(value)) {
        return undefined;
    }
    return unknownRecordNumber(value, key);
}
function extractText(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (isPlainObject(parsed)) {
                for (const key of ['text', 'completion', 'content', 'generated_text', 'response', 'output']) {
                    const child = extractText(parsed[key]);
                    if (child) {
                        return child;
                    }
                }
            }
        }
        catch {
            return value;
        }
    }
    return value;
}
function firstText(record, keys) {
    for (const key of keys) {
        const value = extractText(record[key]);
        if (value) {
            return value;
        }
    }
    return undefined;
}
function traceModelId(record) {
    for (const key of ['fusion_model_id', 'model_id', 'selected_model_id']) {
        const value = unknownRecordNumber(record, key);
        if (value !== undefined && value > 0) {
            return value;
        }
    }
    return undefined;
}
function traceUsefulScore(record) {
    for (const key of ['feedback_score_bps', 'router_confidence_bps', 'confidence_bps']) {
        const value = unknownRecordNumber(record, key);
        if (value !== undefined && value > 0) {
            return value;
        }
    }
    for (const key of ['score_bps', 'trust_score_bps', 'useful_bps']) {
        const value = nestedNumber(record, 'trusted_ai', key);
        if (value !== undefined && value > 0) {
            return value;
        }
    }
    return undefined;
}
function incrementSkipped(skipped, reason) {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
}
function positiveInteger(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function epochSeconds(value) {
    if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
    }
    return undefined;
}
function hash256(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}
function consentScopeBits(receipt) {
    const numeric = Number(receipt.scope_bits ?? receipt.scopes);
    if (Number.isSafeInteger(numeric) && numeric >= 0) {
        return numeric;
    }
    const scopes = receipt.scopes;
    if (!Array.isArray(scopes)) {
        return 0;
    }
    return scopes.reduce((bits, scope) => {
        if (scope === 'training') {
            return bits | AI_DATA_SCOPE_TRAINING;
        }
        if (scope === 'prompt') {
            return bits | AI_DATA_SCOPE_PROMPT;
        }
        if (scope === 'response') {
            return bits | AI_DATA_SCOPE_RESPONSE;
        }
        return bits;
    }, 0);
}
export function parseActiveDataConsent(record, asOfEpochSec = Math.floor(Date.now() / 1000)) {
    const candidate = record.consent_receipt ?? record.data_consent;
    if (!isPlainObject(candidate)) {
        return undefined;
    }
    const status = unknownRecordString(candidate, 'status');
    if (unknownRecordBoolean(candidate, 'active') !== true || (status && status !== 'active')) {
        return undefined;
    }
    if (candidate.revoked_at && epochSeconds(candidate.revoked_at)) {
        return undefined;
    }
    const campaignId = positiveInteger(candidate.campaign_id);
    const programId = positiveInteger(candidate.program_id);
    const consentVersion = positiveInteger(candidate.consent_version ?? candidate.version);
    const policyHash = hash256(candidate.policy_hash);
    const receiptHash = hash256(candidate.receipt_hash);
    const expiresAt = epochSeconds(candidate.expires_at);
    const scopeBits = consentScopeBits(candidate);
    if (!campaignId || !programId || !consentVersion || !policyHash || !receiptHash || !expiresAt) {
        return undefined;
    }
    if (expiresAt <= asOfEpochSec) {
        return undefined;
    }
    if ((scopeBits & AI_DATA_REQUIRED_SCOPES) !== AI_DATA_REQUIRED_SCOPES) {
        return undefined;
    }
    return {
        campaign_id: campaignId,
        program_id: programId,
        consent_version: consentVersion,
        scope_bits: scopeBits,
        policy_hash: policyHash,
        receipt_hash: receiptHash,
        expires_at: expiresAt,
    };
}
function passedPrivacyReview(record) {
    const review = record.privacy_review ?? record.privacy;
    if (!isPlainObject(review)) {
        return false;
    }
    const status = unknownRecordString(review, 'status');
    const filtered = unknownRecordBoolean(review, 'pii_filtered');
    const reportHash = hash256(review.report_hash ?? review.redaction_hash);
    return (status === 'passed' || filtered === true) && Boolean(reportHash);
}
function privacyReviewHash(record) {
    const review = record.privacy_review ?? record.privacy;
    return isPlainObject(review) ? hash256(review.report_hash ?? review.redaction_hash) : undefined;
}
function traceMatchesPackFilters(record, options, skipped) {
    if (!options.include_all && unknownRecordBoolean(record, 'training_candidate') !== true) {
        incrementSkipped(skipped, 'not_training_candidate');
        return false;
    }
    if (options.task && unknownRecordString(record, 'task') !== options.task) {
        incrementSkipped(skipped, 'task_mismatch');
        return false;
    }
    if (options.user && unknownRecordString(record, 'user') !== options.user) {
        incrementSkipped(skipped, 'user_mismatch');
        return false;
    }
    if (options.model_id && traceModelId(record) !== options.model_id) {
        incrementSkipped(skipped, 'model_mismatch');
        return false;
    }
    return true;
}
export function buildQueryDatasetFromTraces(lines, options = {}) {
    const minUsefulBps = Number(options.min_useful_bps ?? 8500);
    const maxExamples = Number(options.max_examples ?? 0);
    const asOfEpochSec = Number(options.as_of_epoch_sec ?? Math.floor(Date.now() / 1000));
    const examples = [];
    const skipped = {};
    const promptHashes = [];
    const traceHashes = [];
    const exampleHashes = [];
    const campaignIds = [];
    const consentPolicyHashes = [];
    const consentReceiptHashes = [];
    const seenExamples = new Set();
    for (const line of lines) {
        if (maxExamples > 0 && examples.length >= maxExamples) {
            incrementSkipped(skipped, 'max_examples');
            continue;
        }
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        let record;
        try {
            const parsed = JSON.parse(trimmed);
            if (!isPlainObject(parsed)) {
                incrementSkipped(skipped, 'not_object');
                continue;
            }
            record = parsed;
        }
        catch {
            incrementSkipped(skipped, 'invalid_json');
            continue;
        }
        if (!traceMatchesPackFilters(record, options, skipped)) {
            continue;
        }
        const consent = parseActiveDataConsent(record, asOfEpochSec);
        if (!consent) {
            incrementSkipped(skipped, 'missing_or_inactive_consent');
            continue;
        }
        if (!passedPrivacyReview(record)) {
            incrementSkipped(skipped, 'privacy_review_required');
            continue;
        }
        const prompt = unknownRecordString(record, 'prompt');
        if (!prompt) {
            incrementSkipped(skipped, 'missing_prompt');
            continue;
        }
        const corrected = firstText(record, ['corrected_output', 'expected_output']);
        const accepted = firstText(record, ['accepted_output']);
        const capturedOutput = firstText(record, ['completion', 'output_text', 'output']);
        const completion = corrected ?? accepted ?? capturedOutput;
        if (!completion) {
            incrementSkipped(skipped, 'missing_completion');
            continue;
        }
        const supervised = Boolean(corrected || accepted);
        const score = traceUsefulScore(record);
        if (!supervised && !options.include_low_score) {
            if (score === undefined && !options.include_unscored) {
                incrementSkipped(skipped, 'unscored_output');
                continue;
            }
            if (score !== undefined && score < minUsefulBps) {
                incrementSkipped(skipped, 'low_score_output');
                continue;
            }
        }
        const promptHash = hash256(record.prompt_hash) ?? sha256Bytes(Buffer.from(prompt));
        const traceHash = sha256Bytes(Buffer.from(trimmed));
        const metadata = {
            source: 'harbor-ai-query-traces',
            source_trace_hash: traceHash,
            trace_kind: unknownRecordString(record, 'kind'),
            request_hash: unknownRecordString(record, 'request_hash') ?? promptHash,
            prompt_hash: promptHash,
            model_id: traceModelId(record),
            task: unknownRecordString(record, 'task'),
            router_confidence_bps: unknownRecordNumber(record, 'router_confidence_bps'),
            expert_disagreement_bps: unknownRecordNumber(record, 'expert_disagreement_bps'),
            trusted_ai_score_bps: nestedNumber(record, 'trusted_ai', 'score_bps'),
            feedback_score_bps: unknownRecordNumber(record, 'feedback_score_bps'),
            target_source: corrected ? 'correction' : accepted ? 'accepted_output' : 'captured_output',
            campaign_id: consent.campaign_id,
            program_id: consent.program_id,
            consent_version: consent.consent_version,
            consent_scope_bits: consent.scope_bits,
            consent_policy_hash: consent.policy_hash,
            consent_receipt_hash: consent.receipt_hash,
            consent_expires_at: consent.expires_at,
            privacy_review_hash: privacyReviewHash(record),
        };
        const rejected = corrected ? firstText(record, ['rejected_output', 'output']) : firstText(record, ['rejected_output']);
        const example = {
            messages: [
                { role: 'user', content: prompt },
                { role: 'assistant', content: completion },
            ],
            metadata,
            rejected_completion: rejected && rejected !== completion ? rejected : undefined,
        };
        const dedupeHash = jsonLineHash({ messages: example.messages, rejected_completion: example.rejected_completion });
        if (seenExamples.has(dedupeHash)) {
            incrementSkipped(skipped, 'duplicate_example');
            continue;
        }
        seenExamples.add(dedupeHash);
        const exampleHash = jsonLineHash(example);
        examples.push(example);
        promptHashes.push(promptHash);
        traceHashes.push(traceHash);
        exampleHashes.push(exampleHash);
        campaignIds.push(consent.campaign_id);
        consentPolicyHashes.push(consent.policy_hash);
        consentReceiptHashes.push(consent.receipt_hash);
    }
    const datasetJsonl = examples.map((example) => canonicalJson(example)).join('');
    const datasetHash = sha256Bytes(Buffer.from(datasetJsonl));
    const trainingMetadata = options.expert_role ? {
        training_kind: 'expert',
        expert_role: options.expert_role,
        fusion_parent_model_id: options.fusion_parent_model_id ?? options.base_model_id,
    } : undefined;
    const manifest = {
        format: 'harbor.ai.query-dataset.v2',
        dataset_format: 'chat_messages_jsonl',
        dataset_hash: datasetHash,
        source: 'harbor-ai-query-traces',
        contributor: options.contributor,
        base_model_id: options.base_model_id,
        model_id: options.model_id,
        expert_role: options.expert_role,
        fusion_parent_model_id: options.fusion_parent_model_id,
        task: options.task,
        example_count: examples.length,
        example_hashes: exampleHashes,
        prompt_hashes: [...new Set(promptHashes)],
        trace_hashes: traceHashes,
        campaign_ids: [...new Set(campaignIds)].sort((left, right) => left - right),
        consent_policy_hashes: [...new Set(consentPolicyHashes)].sort(),
        consent_receipt_hashes: [...new Set(consentReceiptHashes)].sort(),
        quality_policy: {
            require_training_candidate: !options.include_all,
            min_useful_bps: minUsefulBps,
            include_low_score: Boolean(options.include_low_score),
            include_unscored: Boolean(options.include_unscored),
            supervised_targets_always_allowed: true,
        },
        privacy_policy: {
            requires_active_versioned_consent: true,
            required_scopes: ['training', 'prompt', 'response'],
            requires_pii_review: true,
            excludes_direct_user_identifiers_from_manifest: true,
            requires_privacy_reviewed_prompt: true,
            stores_raw_prompts: true,
            stores_raw_completions: true,
            encrypted_at_rest_required: true,
            prospective_revocation: true,
            source_traces_remain_edge_local: true,
        },
        training_metadata: trainingMetadata,
    };
    const manifestJson = canonicalJson(manifest);
    return {
        examples,
        dataset_jsonl: datasetJsonl,
        dataset_hash: datasetHash,
        manifest,
        manifest_json: manifestJson,
        manifest_hash: sha256Bytes(Buffer.from(manifestJson)),
        skipped,
    };
}
function parseObjectJson(value, label) {
    const parsed = JSON.parse(value);
    if (!isPlainObject(parsed)) {
        throw new Error(`${label} must be a JSON object`);
    }
    return parsed;
}
function parseLogitMode(value) {
    const mode = value ?? 'none';
    if (mode !== 'none' && mode !== 'top_k' && mode !== 'full') {
        throw new Error(`invalid logit mode: ${mode}; expected none, top_k, or full`);
    }
    return mode;
}
export function parseFusionExpertSpec(value) {
    const [modelRaw, roleRaw, weightRaw] = value.split(':');
    const modelId = Number(modelRaw);
    const weight = Number(weightRaw ?? 1);
    if (!Number.isInteger(modelId) || modelId <= 0) {
        throw new Error(`invalid fusion expert model id in ${value}`);
    }
    const role = roleRaw && roleRaw.trim() !== '' ? roleRaw.trim() : 'auto';
    if (!Number.isFinite(weight) || weight <= 0) {
        throw new Error(`invalid fusion expert weight in ${value}`);
    }
    return { model_id: modelId, role, weight };
}
export function buildFusionManifest(input) {
    if (!Number.isInteger(input.base_model_id) || input.base_model_id <= 0) {
        throw new Error('base_model_id must be a positive integer');
    }
    const autoExpertCount = Number(input.auto_expert_count ?? 0);
    if (!Number.isInteger(autoExpertCount) || autoExpertCount < 0) {
        throw new Error('auto_expert_count must be a non-negative integer');
    }
    if (input.experts.length === 0 && autoExpertCount === 0) {
        throw new Error('at least one fusion expert or --auto-experts count is required');
    }
    const seen = new Set();
    for (const expert of input.experts) {
        if (seen.has(expert.model_id)) {
            throw new Error(`duplicate fusion expert model id: ${expert.model_id}`);
        }
        seen.add(expert.model_id);
    }
    const logitMode = input.logit_mode ?? 'none';
    const topK = Number(input.logit_top_k ?? 0);
    if (!Number.isInteger(topK) || topK < 0) {
        throw new Error('logit_top_k must be a non-negative integer');
    }
    const selectionPolicy = input.selection_policy ?? (autoExpertCount > 0
        ? {
            type: 'capability_profile',
            auto_discover_roles: true,
            max_experts: autoExpertCount,
        }
        : {
            type: 'top_weight',
            max_experts: input.experts.length,
        });
    const manifest = {
        format: 'harbor.fusion.v1',
        base_model_id: input.base_model_id,
        expert_model_ids: input.experts.map((expert) => expert.model_id),
        expert_roles: input.experts.map((expert) => expert.role),
        expert_weights: input.experts.map((expert) => expert.weight),
        fusion_strategy: 'routed_expert',
        logit_mode: logitMode,
        logit_top_k: topK,
        selection_policy: selectionPolicy,
        eval_artifact_id: Number(input.eval_artifact_id ?? 0),
    };
    if (autoExpertCount > 0) {
        manifest.auto_expert_count = autoExpertCount;
    }
    return manifest;
}
export function buildFusionRegisterPlan(input) {
    const aiContract = input.aiContract ?? AI_CONTRACT;
    const manifestJson = canonicalJson(input.manifest);
    const manifestHash = sha256Bytes(Buffer.from(manifestJson));
    const storageObjectId = input.storageObjectId ?? '<storage_object_id>';
    const contentHash = input.contentHash ?? manifestHash;
    const weightsArtifactId = input.weightsArtifactId ?? '<weights_artifact_id>';
    const artifactMetadata = {
        format: 'harbor.fusion.v1',
        kind: 'fusion_manifest',
        manifest_hash: manifestHash,
        base_model_id: input.manifest.base_model_id,
        expert_model_ids: input.manifest.expert_model_ids,
        auto_expert_count: input.manifest.auto_expert_count,
        logit_mode: input.manifest.logit_mode,
        ...input.manifestMetadata,
    };
    const modelMetadata = {
        format: 'harbor.fusion.v1',
        source: 'harbor-ai-fusion-register',
        fusion_strategy: input.manifest.fusion_strategy,
        fusion_manifest_hash: manifestHash,
        fusion_manifest_artifact_id: weightsArtifactId,
        base_model_id: input.manifest.base_model_id,
        expert_model_ids: input.manifest.expert_model_ids,
        expert_roles: input.manifest.expert_roles,
        expert_weights: input.manifest.expert_weights,
        auto_expert_count: input.manifest.auto_expert_count,
        logit_mode: input.manifest.logit_mode,
        logit_top_k: input.manifest.logit_top_k,
        selection_policy: input.manifest.selection_policy,
        ...input.modelMetadata,
    };
    return {
        manifest: input.manifest,
        manifest_json: manifestJson,
        manifest_hash: manifestHash,
        artifact_metadata: artifactMetadata,
        model_metadata: modelMetadata,
        actions: [
            {
                contract: aiContract,
                action: 'addartifact',
                data: {
                    owner: input.owner,
                    kind: 1,
                    storage_object_id: storageObjectId,
                    content_hash: contentHash,
                    metadata: JSON.stringify(artifactMetadata),
                },
            },
            {
                contract: aiContract,
                action: 'regmodel',
                data: {
                    owner: input.owner,
                    model_type: 2,
                    parent_model_id: input.manifest.base_model_id,
                    weights_artifact_id: weightsArtifactId,
                    eval_artifact_id: input.manifest.eval_artifact_id,
                    title: input.title,
                    metadata: JSON.stringify(modelMetadata),
                },
            },
        ],
    };
}
export function buildDistributedExpertPlan(input) {
    if (!Number.isInteger(input.base_model_id) || input.base_model_id <= 0) {
        throw new Error('base_model_id must be a positive integer');
    }
    if (!input.expert_role.trim()) {
        throw new Error('expert_role is required');
    }
    if (!Number.isInteger(input.shard_count) || input.shard_count <= 0) {
        throw new Error('shard_count must be a positive integer');
    }
    const participants = input.participants ?? [];
    if (participants.length > 0 && participants.length !== input.shard_count) {
        throw new Error('participant count must match shard_count');
    }
    const aggregationSeed = {
        base_model_id: input.base_model_id,
        dataset_artifact_id: input.dataset_artifact_id ?? 0,
        expert_role: input.expert_role,
        model: input.model ?? '',
        shard_count: input.shard_count,
    };
    const aggregationGroupId = input.aggregation_group_id ??
        sha256Bytes(Buffer.from(canonicalJson(aggregationSeed))).slice(0, 16);
    const shards = Array.from({ length: input.shard_count }, (_, shardIndex) => {
        const metadata = {
            ...(input.metadata ?? {}),
            training_kind: 'expert',
            distributed_training: true,
            aggregation_group_id: aggregationGroupId,
            expert_role: input.expert_role,
            fusion_parent_model_id: input.base_model_id,
            base_model_id: input.base_model_id,
            dataset_artifact_id: input.dataset_artifact_id ?? 0,
            model: input.model,
            shard_index: shardIndex,
            shard_count: input.shard_count,
        };
        return {
            shard_index: shardIndex,
            shard_count: input.shard_count,
            participant: participants[shardIndex],
            metadata,
        };
    });
    return {
        format: 'harbor.distributed_expert_plan.v1',
        base_model_id: input.base_model_id,
        expert_role: input.expert_role,
        shard_count: input.shard_count,
        aggregation_group_id: aggregationGroupId,
        shards,
    };
}
export function parseDistributedShardSpec(value) {
    const [indexRaw, hashRaw, weightRaw, artifactRaw, trainerRaw] = value.split(':');
    const shardIndex = Number(indexRaw);
    if (!Number.isInteger(shardIndex) || shardIndex < 0) {
        throw new Error(`invalid shard index in ${value}`);
    }
    if (!/^[0-9a-fA-F]{64}$/.test(hashRaw ?? '')) {
        throw new Error(`invalid shard weights hash in ${value}`);
    }
    const weight = Number(weightRaw ?? 1);
    if (!Number.isFinite(weight) || weight <= 0) {
        throw new Error(`invalid shard weight in ${value}`);
    }
    const artifactId = artifactRaw && artifactRaw.trim() !== '' ? Number(artifactRaw) : undefined;
    if (artifactId !== undefined && (!Number.isInteger(artifactId) || artifactId <= 0)) {
        throw new Error(`invalid shard artifact id in ${value}`);
    }
    return {
        shard_index: shardIndex,
        weights_hash: hashRaw.toLowerCase(),
        weight,
        artifact_id: artifactId,
        trainer: trainerRaw && trainerRaw.trim() !== '' ? trainerRaw : undefined,
    };
}
export function buildDistributedAggregateManifest(input) {
    if (!Number.isInteger(input.base_model_id) || input.base_model_id <= 0) {
        throw new Error('base_model_id must be a positive integer');
    }
    if (!input.expert_role.trim()) {
        throw new Error('expert_role is required');
    }
    if (!input.aggregation_group_id.trim()) {
        throw new Error('aggregation_group_id is required');
    }
    if (input.shard_artifacts.length < 2) {
        throw new Error('at least two shard artifacts are required');
    }
    const sorted = [...input.shard_artifacts].sort((left, right) => left.shard_index - right.shard_index);
    const seen = new Set();
    for (const shard of sorted) {
        if (seen.has(shard.shard_index)) {
            throw new Error(`duplicate shard index: ${shard.shard_index}`);
        }
        seen.add(shard.shard_index);
    }
    return {
        format: 'harbor.gemma.mlx.aggregate-manifest.v1',
        base_model_id: input.base_model_id,
        expert_role: input.expert_role,
        aggregation_group_id: input.aggregation_group_id,
        aggregation_strategy: 'weighted_lora_average',
        shard_artifacts: sorted,
    };
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
async function writeFusionManifestFile(output, manifestJson, force) {
    const file = path.resolve(output);
    if (!force) {
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
    await fs.writeFile(file, manifestJson, 'utf8');
    return file;
}
async function writeOutputFile(output, contents, force) {
    const file = path.resolve(output);
    if (!force) {
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
    await fs.writeFile(file, contents, 'utf8');
    return file;
}
async function readFusionManifest(file) {
    const raw = await fs.readFile(path.resolve(file), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.format !== 'harbor.fusion.v1') {
        throw new Error(`not a Harbor fusion manifest: ${file}`);
    }
    const experts = (parsed.expert_model_ids ?? []).map((modelId, index) => ({
        model_id: Number(modelId),
        role: String(parsed.expert_roles?.[index] ?? ''),
        weight: Number(parsed.expert_weights?.[index] ?? 1),
    }));
    return buildFusionManifest({
        base_model_id: Number(parsed.base_model_id),
        experts,
        logit_mode: parseLogitMode(parsed.logit_mode),
        logit_top_k: Number(parsed.logit_top_k ?? 0),
        selection_policy: isPlainObject(parsed.selection_policy) ? parsed.selection_policy : undefined,
        eval_artifact_id: Number(parsed.eval_artifact_id ?? 0),
        auto_expert_count: Number(parsed.auto_expert_count ?? 0),
    });
}
async function resolveArtifactId(contract, owner, kind, storageObjectId, contentHash, options) {
    const rows = await getTableRows(contract, 'artifacts', { url: options.url, scope: contract, limit: 1000 });
    const matches = rows.rows
        .filter((row) => row.owner === owner &&
        Number(row.kind) === kind &&
        Number(row.storage_object_id) === storageObjectId &&
        row.content_hash === contentHash)
        .sort((left, right) => Number(right.id) - Number(left.id));
    const artifact = matches[0];
    if (!artifact) {
        throw new Error(`AI artifact kind ${kind} was not found for storage object ${storageObjectId}`);
    }
    return Number(artifact.id);
}
async function resolveModelId(contract, owner, weightsArtifactId, manifestHash, options) {
    const rows = await getTableRows(contract, 'models', { url: options.url, scope: contract, limit: 1000 });
    const matches = rows.rows
        .filter((row) => row.owner === owner && Number(row.weights_artifact_id) === weightsArtifactId)
        .filter((row) => parseMetadata(row.metadata).fusion_manifest_hash === manifestHash)
        .sort((left, right) => Number(right.id) - Number(left.id));
    return matches[0] ? Number(matches[0].id) : undefined;
}
function collectOption(value, previous) {
    previous.push(value);
    return previous;
}
async function readTraceLines(input, allTraces) {
    let traceFile = path.resolve(input);
    const stat = await fs.stat(traceFile);
    if (stat.isDirectory()) {
        traceFile = path.join(traceFile, allTraces ? 'traces.jsonl' : 'candidates.jsonl');
    }
    const raw = await fs.readFile(traceFile, 'utf8');
    return { trace_file: traceFile, lines: raw.split(/\r?\n/) };
}
export function validateQueryDatasetManifest(parsed, label = 'manifest') {
    if (!isPlainObject(parsed) || parsed.format !== 'harbor.ai.query-dataset.v2') {
        throw new Error(`not a Harbor query dataset manifest: ${label}`);
    }
    const hashArray = (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => Boolean(hash256(entry)));
    const campaignIds = parsed.campaign_ids;
    const privacy = parsed.privacy_policy;
    const scopes = isPlainObject(privacy) ? privacy.required_scopes : undefined;
    if (!hash256(parsed.dataset_hash) ||
        parsed.dataset_format !== 'chat_messages_jsonl' ||
        parsed.source !== 'harbor-ai-query-traces' ||
        !positiveInteger(parsed.example_count) ||
        !hashArray(parsed.example_hashes) ||
        parsed.example_hashes.length !== Number(parsed.example_count) ||
        !hashArray(parsed.trace_hashes) ||
        parsed.trace_hashes.length !== Number(parsed.example_count) ||
        !hashArray(parsed.prompt_hashes) ||
        !Array.isArray(campaignIds) ||
        campaignIds.length === 0 ||
        !campaignIds.every((entry) => Boolean(positiveInteger(entry))) ||
        !hashArray(parsed.consent_policy_hashes) ||
        !hashArray(parsed.consent_receipt_hashes) ||
        !isPlainObject(privacy) ||
        privacy.requires_active_versioned_consent !== true ||
        privacy.requires_pii_review !== true ||
        privacy.encrypted_at_rest_required !== true ||
        !Array.isArray(scopes) ||
        !['training', 'prompt', 'response'].every((scope) => scopes.includes(scope))) {
        throw new Error(`incomplete consent-aware query dataset manifest: ${label}`);
    }
    return parsed;
}
async function readQueryDatasetManifest(file) {
    if (!file) {
        return undefined;
    }
    const raw = await fs.readFile(path.resolve(file), 'utf8');
    const parsed = JSON.parse(raw);
    return validateQueryDatasetManifest(parsed, file);
}
function queryDatasetArtifactMetadata(input) {
    return {
        kind: 'dataset',
        format: 'harbor.ai.query-dataset.v2',
        dataset_format: 'chat_messages_jsonl',
        dataset_hash: input.datasetHash,
        manifest_hash: input.manifestHash,
        source: 'harbor-ai-query-data',
        example_count: input.manifest?.example_count,
        task: input.manifest?.task,
        base_model_id: input.manifest?.base_model_id,
        expert_role: input.manifest?.expert_role,
        fusion_parent_model_id: input.manifest?.fusion_parent_model_id,
        campaign_ids: input.manifest?.campaign_ids,
        consent_policy_hashes: input.manifest?.consent_policy_hashes,
        consent_receipt_count: input.manifest?.consent_receipt_hashes?.length,
        encrypted_at_rest_required: true,
        ...input.metadata,
    };
}
function defaultQueryDatasetManifestPath(output) {
    return /\.jsonl$/i.test(output) ? output.replace(/\.jsonl$/i, '.manifest.json') : `${output}.manifest.json`;
}
function addDataCommand(ai) {
    const data = new Command('data');
    data.description('Package inference traces into decentralized training datasets');
    data
        .command('pack <trace_path>')
        .description('Convert local AI trace candidates into a canonical trainable JSONL dataset')
        .option('--all-traces', 'read traces.jsonl instead of candidates.jsonl when trace_path is a directory')
        .option('--include-all', 'include traces even when training_candidate is false')
        .option('--include-low-score', 'allow captured low-score outputs without corrections')
        .option('--include-unscored', 'allow captured unscored outputs without corrections')
        .option('--min-useful-bps <bps>', 'minimum score for captured outputs without explicit correction', '8500')
        .option('--max-examples <count>', 'maximum examples to include', '0')
        .option('--contributor <account>', 'dataset contributor account for manifest attribution')
        .option('--task <task>', 'only include traces for one task')
        .option('--user <account>', 'only include traces for one user/account')
        .option('--model-id <id>', 'only include traces for one model id')
        .option('--base-model-id <id>', 'base model id for downstream training metadata')
        .option('--expert-role <role>', 'expert role for downstream distributed expert training')
        .option('--fusion-parent-model-id <id>', 'fusion parent model id for expert metadata')
        .option('-o, --output <path>', 'dataset JSONL output path', 'query-dataset.jsonl')
        .option('--manifest-output <path>', 'manifest JSON output path')
        .option('--force', 'overwrite output files')
        .option('--json', 'print JSON')
        .action(async (tracePath, options) => {
        const { trace_file, lines } = await readTraceLines(tracePath, options.allTraces);
        const pack = buildQueryDatasetFromTraces(lines, {
            contributor: options.contributor,
            task: options.task,
            user: options.user,
            model_id: options.modelId ? Number(options.modelId) : undefined,
            base_model_id: options.baseModelId ? Number(options.baseModelId) : undefined,
            expert_role: options.expertRole,
            fusion_parent_model_id: options.fusionParentModelId ? Number(options.fusionParentModelId) : undefined,
            min_useful_bps: Number(options.minUsefulBps ?? 8500),
            include_all: Boolean(options.includeAll),
            include_low_score: Boolean(options.includeLowScore),
            include_unscored: Boolean(options.includeUnscored),
            max_examples: Number(options.maxExamples ?? 0),
        });
        if (pack.examples.length === 0) {
            throw new Error(`no usable training examples found; skipped=${JSON.stringify(pack.skipped)}`);
        }
        const output = await writeOutputFile(options.output ?? 'query-dataset.jsonl', pack.dataset_jsonl, options.force);
        const manifestOutput = await writeOutputFile(options.manifestOutput ?? defaultQueryDatasetManifestPath(output), pack.manifest_json, options.force);
        printResult({
            ok: true,
            trace_file,
            output,
            manifest_output: manifestOutput,
            dataset_hash: pack.dataset_hash,
            manifest_hash: pack.manifest_hash,
            example_count: pack.examples.length,
            skipped: pack.skipped,
            manifest: pack.manifest,
        }, options.json);
    });
    addTxOptions(data
        .command('register <owner> <dataset_file>')
        .description('Store a query-derived dataset and register it as an existing harborai dataset artifact')
        .option('-c, --contract <account>', 'Harbor AI contract account', AI_CONTRACT)
        .option('--backend <backend>', 'storage backend: harbor or walrus', 'harbor')
        .option('--manifest <path>', 'query dataset manifest produced by harbor ai data pack')
        .option('--metadata <json>', 'additional artifact metadata JSON object')
        .option('--market-contract <account>', 'service market contract account', MARKET_CONTRACT)
        .option('--storage-contract <account>', 'storage registry contract account', process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore')
        .option('--router-url <url>', 'explicit storage router endpoint for Harbor-backed storage')
        .option('--private-key <key>', 'local dataset encryption key (or HARBOR_AI_DATA_KEY)')
        .option('--walrus-command <path>', 'Walrus CLI command', process.env.WALRUS_CLI ?? 'walrus')
        .option('--walrus-publisher-url <url>', 'Walrus publisher URL')
        .option('--walrus-aggregator-url <url>', 'Walrus aggregator URL to preserve in metadata')
        .option('--walrus-epochs <epochs>', 'Walrus storage epochs')
        .option('--dry-run', 'print the planned storage/action flow without broadcasting')).action(async (owner, datasetFile, options) => {
        const contract = options.contract ?? AI_CONTRACT;
        const file = path.resolve(datasetFile);
        const datasetBytes = await fs.readFile(file);
        const datasetHash = sha256Bytes(datasetBytes);
        const manifest = await readQueryDatasetManifest(options.manifest);
        if (!manifest) {
            throw new Error('a consent-aware harbor.ai.query-dataset.v2 manifest is required');
        }
        if (manifest && manifest.dataset_hash !== datasetHash) {
            throw new Error(`dataset hash mismatch: manifest has ${manifest.dataset_hash}, file has ${datasetHash}`);
        }
        const manifestHash = manifest ? sha256Bytes(Buffer.from(canonicalJson(manifest))) : undefined;
        const artifactMetadata = queryDatasetArtifactMetadata({
            datasetHash,
            manifestHash,
            manifest,
            metadata: options.metadata ? parseObjectJson(options.metadata, 'metadata') : undefined,
        });
        const storageMetadata = JSON.stringify(artifactMetadata);
        const privateKey = options.privateKey ?? process.env.HARBOR_AI_DATA_KEY;
        if (!options.dryRun && !privateKey) {
            throw new Error('consented AI datasets must be encrypted; pass --private-key or set HARBOR_AI_DATA_KEY');
        }
        const plannedAction = {
            contract,
            action: 'addartifact',
            data: {
                owner,
                kind: 2,
                storage_object_id: '<storage_object_id>',
                content_hash: datasetHash,
                metadata: JSON.stringify(artifactMetadata),
            },
        };
        if (options.dryRun) {
            printResult({
                dry_run: true,
                backend: options.backend ?? 'harbor',
                dataset_file: file,
                dataset_hash: datasetHash,
                manifest_hash: manifestHash,
                encrypted: true,
                artifact_metadata: artifactMetadata,
                actions: [plannedAction],
            }, options.json);
            return;
        }
        if (options.backend && options.backend !== 'harbor' && options.backend !== 'walrus') {
            throw new Error(`unknown storage backend: ${options.backend}`);
        }
        const stored = options.backend === 'walrus'
            ? await putWalrusObject({
                ...options,
                file,
                owner,
                metadata: storageMetadata,
                encrypt: true,
                privateKey,
                contentFormat: 'application/x-ndjson',
            })
            : await putReplicatedObject({
                ...options,
                file,
                owner,
                metadata: storageMetadata,
                encrypt: true,
                privateKey,
            });
        const actorOptions = { ...options, actor: options.actor ?? owner };
        const artifactTx = await pushAction({
            contract,
            action: 'addartifact',
            data: {
                owner,
                kind: 2,
                storage_object_id: stored.object_id,
                content_hash: stored.content_hash,
                metadata: JSON.stringify(artifactMetadata),
            },
            url: options.url,
            actor: actorOptions.actor,
            permission: actorOptions.permission,
            key: actorOptions.key,
            authorization: actorOptions.auth,
            expiration: actorOptions.expiration,
        });
        const artifactId = await resolveArtifactId(contract, owner, 2, Number(stored.object_id), stored.content_hash, { url: options.url });
        printResult({
            ok: true,
            owner,
            dataset_artifact_id: artifactId,
            storage_object_id: stored.object_id,
            content_hash: stored.content_hash,
            dataset_hash: datasetHash,
            manifest_hash: manifestHash,
            artifact_metadata: artifactMetadata,
            storage: stored,
            artifact_tx: artifactTx,
        }, options.json);
    });
    addTxOptions(data
        .command('contribute <contributor> <tune_id> <dataset_artifact_id>')
        .description('Attach a query-derived dataset artifact to an existing tune proposal')
        .option('-c, --contract <account>', 'Harbor AI contract account', AI_CONTRACT)
        .option('--reward-weight <bps>', 'relative data reward weight in basis points', '10000')
        .option('--manifest-hash <hash>', 'query dataset manifest hash to preserve in contribution metadata')
        .option('--metadata <json>', 'additional contribution metadata JSON object')
        .option('--dry-run', 'print the planned action without broadcasting')).action(async (contributor, tuneId, datasetArtifactId, options) => {
        const contract = options.contract ?? AI_CONTRACT;
        const metadata = {
            source: 'harbor-ai-query-data',
            format: 'harbor.ai.query-dataset.v2',
            manifest_hash: options.manifestHash,
            ...(options.metadata ? parseObjectJson(options.metadata, 'metadata') : {}),
        };
        const plannedAction = {
            contract,
            action: 'contribdata',
            data: {
                contributor,
                tune_id: Number(tuneId),
                dataset_artifact_id: Number(datasetArtifactId),
                reward_weight: Number(options.rewardWeight ?? 10000),
                metadata: JSON.stringify(metadata),
            },
        };
        if (options.dryRun) {
            printResult({ dry_run: true, actions: [plannedAction] }, options.json);
            return;
        }
        const action = await serializeAction({
            contract,
            action: 'contribdata',
            data: plannedAction.data,
            url: options.url,
            actor: options.actor ?? contributor,
            permission: options.permission,
            key: options.key,
            authorization: options.auth,
            expiration: options.expiration,
        });
        const result = await transactActions({ ...options, actor: options.actor ?? contributor }, [action]);
        printResult({ ok: true, action: plannedAction, result }, options.json);
    });
    ai.addCommand(data);
}
function addFusionCommand(ai) {
    const fusion = new Command('fusion');
    fusion.description('Create, register, and inspect Harbor AI fusion manifests');
    const manifest = new Command('manifest');
    manifest.description('Build Harbor AI fusion manifest artifacts');
    manifest
        .command('create <base_model_id>')
        .description('Create a canonical harbor.fusion.v1 JSON manifest')
        .option('--expert <model_id:role:weight>', 'expert model id, role, and fusion weight; repeat for each expert; role may be auto', collectOption, [])
        .option('--auto-experts <count>', 'let the router discover this many experts from capability profiles', '0')
        .option('--logit-mode <mode>', 'none, top_k, or full', 'none')
        .option('--logit-top-k <count>', 'top-k logprob entries per token when logit-mode is top_k', '0')
        .option('--selection-policy <json>', 'selection policy JSON object')
        .option('--eval-artifact-id <id>', 'evaluation artifact id for the registered fusion model', '0')
        .option('-o, --output <path>', 'write manifest to a file')
        .option('--force', 'overwrite output file')
        .option('--json', 'print JSON')
        .action(async (baseModelId, options) => {
        const manifestObject = buildFusionManifest({
            base_model_id: Number(baseModelId),
            experts: (options.expert ?? []).map(parseFusionExpertSpec),
            auto_expert_count: Number(options.autoExperts ?? 0),
            logit_mode: parseLogitMode(options.logitMode),
            logit_top_k: Number(options.logitTopK ?? 0),
            selection_policy: options.selectionPolicy ? parseObjectJson(options.selectionPolicy, 'selection policy') : undefined,
            eval_artifact_id: Number(options.evalArtifactId ?? 0),
        });
        const manifestJson = canonicalJson(manifestObject);
        const manifestHash = sha256Bytes(Buffer.from(manifestJson));
        const output = options.output ? await writeFusionManifestFile(options.output, manifestJson, options.force) : undefined;
        if (options.json) {
            printResult({ manifest: manifestObject, manifest_hash: manifestHash, output }, true);
            return;
        }
        if (output) {
            console.log(output);
            return;
        }
        process.stdout.write(manifestJson);
    });
    fusion.addCommand(manifest);
    addTxOptions(fusion
        .command('register <owner> <manifest_file>')
        .description('Store a fusion manifest as a weights artifact and register a normal Harbor AI model')
        .option('-c, --contract <account>', 'Harbor AI contract account', AI_CONTRACT)
        .option('--backend <backend>', 'storage backend: harbor or walrus', 'harbor')
        .option('--title <title>', 'registered model title', 'Fusion Model')
        .option('--metadata <json>', 'additional model metadata JSON object')
        .option('--artifact-metadata <json>', 'additional artifact metadata JSON object')
        .option('--market-contract <account>', 'service market contract account', MARKET_CONTRACT)
        .option('--storage-contract <account>', 'storage registry contract account', process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore')
        .option('--router-url <url>', 'explicit storage router endpoint for Harbor-backed storage')
        .option('--walrus-command <path>', 'Walrus CLI command', process.env.WALRUS_CLI ?? 'walrus')
        .option('--walrus-publisher-url <url>', 'Walrus publisher URL')
        .option('--walrus-aggregator-url <url>', 'Walrus aggregator URL to preserve in metadata')
        .option('--walrus-epochs <epochs>', 'Walrus storage epochs')
        .option('--dry-run', 'print the planned storage/action flow without broadcasting')).action(async (owner, manifestFile, options) => {
        const contract = options.contract ?? AI_CONTRACT;
        const manifestObject = await readFusionManifest(manifestFile);
        const basePlan = buildFusionRegisterPlan({
            manifest: manifestObject,
            owner,
            title: options.title ?? 'Fusion Model',
            aiContract: contract,
            manifestMetadata: options.artifactMetadata ? parseObjectJson(options.artifactMetadata, 'artifact metadata') : undefined,
            modelMetadata: options.metadata ? parseObjectJson(options.metadata, 'model metadata') : undefined,
        });
        if (options.dryRun) {
            printResult({
                dry_run: true,
                backend: options.backend ?? 'harbor',
                manifest_file: path.resolve(manifestFile),
                ...basePlan,
            }, options.json);
            return;
        }
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-fusion-'));
        const canonicalPath = path.join(tempDir, 'manifest.json');
        try {
            await fs.writeFile(canonicalPath, basePlan.manifest_json, 'utf8');
            if (options.backend && options.backend !== 'harbor' && options.backend !== 'walrus') {
                throw new Error(`unknown storage backend: ${options.backend}`);
            }
            const storageMetadata = JSON.stringify({
                format: 'harbor.fusion.v1',
                source: 'harbor-ai-fusion-register',
                manifest_hash: basePlan.manifest_hash,
            });
            const stored = options.backend === 'walrus'
                ? await putWalrusObject({
                    ...options,
                    file: canonicalPath,
                    owner,
                    metadata: storageMetadata,
                    contentFormat: 'application/harbor-fusion+json',
                })
                : await putReplicatedObject({
                    ...options,
                    file: canonicalPath,
                    owner,
                    metadata: storageMetadata,
                });
            const actionOptions = { ...options, actor: options.actor ?? owner };
            const artifactPlan = buildFusionRegisterPlan({
                manifest: manifestObject,
                owner,
                title: options.title ?? 'Fusion Model',
                aiContract: contract,
                storageObjectId: stored.object_id,
                contentHash: stored.content_hash,
                weightsArtifactId: '<pending>',
                manifestMetadata: options.artifactMetadata ? parseObjectJson(options.artifactMetadata, 'artifact metadata') : undefined,
                modelMetadata: options.metadata ? parseObjectJson(options.metadata, 'model metadata') : undefined,
            });
            const artifactAction = await serializeAction({
                contract,
                action: 'addartifact',
                data: artifactPlan.actions[0].data,
                url: options.url,
                actor: actionOptions.actor,
                permission: actionOptions.permission,
                key: actionOptions.key,
                authorization: actionOptions.auth,
                expiration: actionOptions.expiration,
            });
            const artifactTx = await transactActions(actionOptions, [artifactAction]);
            const artifactId = await resolveArtifactId(contract, owner, 1, Number(stored.object_id), stored.content_hash, { url: options.url });
            const finalPlan = buildFusionRegisterPlan({
                manifest: manifestObject,
                owner,
                title: options.title ?? 'Fusion Model',
                aiContract: contract,
                storageObjectId: stored.object_id,
                contentHash: stored.content_hash,
                weightsArtifactId: artifactId,
                manifestMetadata: options.artifactMetadata ? parseObjectJson(options.artifactMetadata, 'artifact metadata') : undefined,
                modelMetadata: options.metadata ? parseObjectJson(options.metadata, 'model metadata') : undefined,
            });
            const modelAction = await serializeAction({
                contract,
                action: 'regmodel',
                data: finalPlan.actions[1].data,
                url: options.url,
                actor: actionOptions.actor,
                permission: actionOptions.permission,
                key: actionOptions.key,
                authorization: actionOptions.auth,
                expiration: actionOptions.expiration,
            });
            const modelTx = await transactActions(actionOptions, [modelAction]);
            const modelId = await resolveModelId(contract, owner, artifactId, finalPlan.manifest_hash, { url: options.url });
            printResult({
                ok: true,
                owner,
                model_id: modelId,
                weights_artifact_id: artifactId,
                storage_object_id: stored.object_id,
                content_hash: stored.content_hash,
                manifest_hash: finalPlan.manifest_hash,
                artifact_tx: artifactTx,
                model_tx: modelTx,
                storage: stored,
            }, options.json);
        }
        finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });
    fusion
        .command('inspect <model_id>')
        .description('Inspect a fusion model and its route/subcall participation')
        .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
        .option('-c, --contract <account>', 'Harbor AI contract account', AI_CONTRACT)
        .option('--json', 'print JSON')
        .action(async (modelId, options) => {
        const contract = options.contract ?? AI_CONTRACT;
        const [models, artifacts, routes, subcalls] = await Promise.all([
            getTableRows(contract, 'models', { url: options.url, scope: contract, limit: 1000 }),
            getTableRows(contract, 'artifacts', { url: options.url, scope: contract, limit: 1000 }),
            getTableRows(contract, 'routelogs', { url: options.url, scope: contract, limit: 1000 }),
            getTableRows(contract, 'subcalls', { url: options.url, scope: contract, limit: 1000 }),
        ]);
        const numericModelId = Number(modelId);
        const model = models.rows.find((row) => Number(row.id) === numericModelId);
        if (!model) {
            throw new Error(`model not found: ${modelId}`);
        }
        const metadata = parseMetadata(model.metadata);
        const artifact = artifacts.rows.find((row) => Number(row.id) === Number(model.weights_artifact_id));
        const fusionRoutes = routes.rows.filter((row) => {
            const routeMetadata = parseMetadata(row.metadata);
            return Number(row.selected_model_id) === numericModelId || Number(routeMetadata.fusion_model_id) === numericModelId;
        });
        const inferIds = new Set(fusionRoutes.map((row) => Number(row.infer_id)).filter((id) => Number.isFinite(id) && id > 0));
        const fusionSubcalls = subcalls.rows.filter((row) => Number(row.from_model_id) === numericModelId ||
            inferIds.has(Number(row.parent_infer_id)));
        const expertParticipation = new Map();
        for (const route of fusionRoutes) {
            const routeMetadata = parseMetadata(route.metadata);
            const selected = Array.isArray(routeMetadata.selected_experts) ? routeMetadata.selected_experts : [];
            for (const expert of selected) {
                if (!isPlainObject(expert)) {
                    continue;
                }
                const key = String(expert.model_id ?? expert.provider ?? 'unknown');
                const entry = expertParticipation.get(key) ?? { calls: 0, roles: new Set(), providers: new Set() };
                entry.calls += 1;
                if (typeof expert.role === 'string') {
                    entry.roles.add(expert.role);
                }
                if (typeof expert.provider === 'string') {
                    entry.providers.add(expert.provider);
                }
                expertParticipation.set(key, entry);
            }
        }
        const summary = {
            model,
            metadata,
            weights_artifact: artifact,
            route_count: fusionRoutes.length,
            subcall_count: fusionSubcalls.length,
            expert_participation: [...expertParticipation.entries()].map(([expert, entry]) => ({
                expert,
                calls: entry.calls,
                roles: [...entry.roles],
                providers: [...entry.providers],
            })),
            recent_routes: fusionRoutes.slice(-10),
            recent_subcalls: fusionSubcalls.slice(-20),
        };
        printResult(summary, options.json);
    });
    const distributed = new Command('distributed');
    distributed.description('Plan and inspect distributed expert shard training');
    distributed
        .command('plan <expert_role> <base_model_id>')
        .description('Create deterministic shard assignments for one distributed expert')
        .option('--shards <count>', 'number of participant shards', '2')
        .option('--participant <account>', 'participant account for one shard; repeat shard_count times', collectOption, [])
        .option('--dataset-artifact-id <id>', 'dataset artifact id assigned to this expert', '0')
        .option('--model <name>', 'trainable local model/checkpoint name')
        .option('--aggregation-group-id <id>', 'explicit aggregation group id')
        .option('--metadata <json>', 'additional shard metadata JSON object')
        .option('--json', 'print JSON')
        .action((expertRole, baseModelId, options) => {
        const plan = buildDistributedExpertPlan({
            base_model_id: Number(baseModelId),
            expert_role: expertRole,
            shard_count: Number(options.shards ?? 2),
            participants: options.participant ?? [],
            dataset_artifact_id: Number(options.datasetArtifactId ?? 0),
            model: options.model,
            aggregation_group_id: options.aggregationGroupId,
            metadata: options.metadata ? parseObjectJson(options.metadata, 'metadata') : undefined,
        });
        printResult({
            plan,
            plan_hash: sha256Bytes(Buffer.from(canonicalJson(plan))),
            shard_metadata: plan.shards.map((shard) => ({
                shard_index: shard.shard_index,
                participant: shard.participant,
                metadata_json: JSON.stringify(shard.metadata),
            })),
        }, options.json);
    });
    const aggregation = new Command('aggregation');
    aggregation.description('Build distributed expert aggregation manifests');
    aggregation
        .command('manifest <expert_role> <base_model_id>')
        .description('Create a canonical weighted LoRA aggregate manifest from shard artifact hashes')
        .requiredOption('--aggregation-group-id <id>', 'aggregation group id shared by all shards')
        .option('--shard <index:weights_hash:weight:artifact_id:trainer>', 'shard artifact spec; repeat for each shard', collectOption, [])
        .option('-o, --output <path>', 'write manifest to a file')
        .option('--force', 'overwrite output file')
        .option('--json', 'print JSON')
        .action(async (expertRole, baseModelId, options) => {
        const manifest = buildDistributedAggregateManifest({
            base_model_id: Number(baseModelId),
            expert_role: expertRole,
            aggregation_group_id: options.aggregationGroupId,
            shard_artifacts: (options.shard ?? []).map(parseDistributedShardSpec),
        });
        const manifestJson = canonicalJson(manifest);
        const manifestHash = sha256Bytes(Buffer.from(manifestJson));
        const output = options.output ? await writeFusionManifestFile(options.output, manifestJson, options.force) : undefined;
        if (options.json) {
            printResult({ manifest, manifest_hash: manifestHash, output }, true);
            return;
        }
        if (output) {
            console.log(output);
            return;
        }
        process.stdout.write(manifestJson);
    });
    distributed.addCommand(aggregation);
    fusion.addCommand(distributed);
    fusion
        .command('expert-metadata <expert_role> <fusion_parent_model_id>')
        .description('Print metadata JSON for expert training jobs and submissions')
        .option('--metadata <json>', 'additional metadata JSON object')
        .option('--json', 'print JSON')
        .action((expertRole, fusionParentModelId, options) => {
        const metadata = {
            ...(options.metadata ? parseObjectJson(options.metadata, 'metadata') : {}),
            training_kind: 'expert',
            expert_role: expertRole,
            fusion_parent_model_id: Number(fusionParentModelId),
        };
        if (options.json) {
            printResult({ metadata, metadata_json: JSON.stringify(metadata) }, true);
            return;
        }
        console.log(JSON.stringify(metadata));
    });
    ai.addCommand(fusion);
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
    addDataCommand(ai);
    addFusionCommand(ai);
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
            ['tune_threshold_bps', 'number'],
            ['tune_quorum_bps', 'number'],
            ['min_train_scores', 'number'],
        ],
    });
    addAiAction(ai, {
        command: 'configure-selection',
        action: 'setaiparams',
        fields: [
            ['max_candidates', 'number'],
            ['max_ranked_choices', 'number'],
            ['min_qualification_reviews', 'number'],
            ['min_bakeoff_scores', 'number'],
            ['community_quorum_bps', 'number'],
            ['max_voice_weight', 'number'],
            ['voice_epoch_sec', 'number'],
            ['runoff_sec', 'number'],
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
            command: 'register-remote',
            action: 'regremote',
            fields: [
                'owner', ['model_type', 'number'], ['parent_model_id', 'number'],
                ['manifest_artifact_id', 'number'], 'revision_hash', ['terms_artifact_id', 'number'],
                ['output_distillation_allowed', 'boolean'], ['requires_session_affinity', 'boolean'],
                ['preserve_thinking_history', 'boolean'], ['eval_artifact_id', 'number'],
                'api_model_id', 'title', 'metadata',
            ],
            signerField: 'owner',
        },
        {
            command: 'set',
            action: 'setmodel',
            fields: ['owner', ['model_id', 'number'], ['weights_artifact_id', 'number'], ['eval_artifact_id', 'number'], ['status', 'number'], 'title', 'metadata'],
            signerField: 'owner',
        },
    ]));
    ai.addCommand(group('program', 'Manage specialized model programs and exact model specifications', [
        {
            command: 'add',
            action: 'addprogram',
            fields: ['owner', ['current_model_id', 'number'], ['current_compute_class', 'number'], ['eval_artifact_id', 'number'], 'title', 'metadata'],
            signerField: 'owner',
        },
        {
            command: 'set-model-spec',
            action: 'setmodelspec',
            fields: [
                'owner', ['model_id', 'number'], ['program_id', 'number'], 'revision_hash',
                ['license_artifact_id', 'number'], ['compute_class', 'number'], ['total_params_m', 'number'],
                ['active_params_m', 'number'], ['context_tokens', 'number'], ['required_vram_mb', 'number'],
                ['training_methods', 'number'], 'metadata',
            ],
            signerField: 'owner',
        },
    ]));
    ai.addCommand(group('provider', 'Subscribe AI providers and publish model deployment offers', [
        {
            command: 'subscribe',
            action: 'subscribe',
            fields: ['provider', ['program_id', 'number'], ['roles', 'number'], ['max_compute_class', 'number'], ['capacity_units', 'number'], 'bond', ['expires_sec', 'number'], 'metadata'],
            signerField: 'provider',
        },
        { command: 'unsubscribe', action: 'unsub', fields: ['provider', ['subscription_id', 'number']], signerField: 'provider' },
        {
            command: 'deploy',
            action: 'setdeploy',
            fields: [
                'provider', ['deployment_id', 'number'], ['model_id', 'number'], ['program_id', 'number'], ['active', 'boolean'],
                'input_price_million', 'output_price_million', 'min_fee', ['capacity_tokens_min', 'number'],
                ['p95_latency_ms', 'number'], 'metadata',
            ],
            signerField: 'provider',
        },
        {
            command: 'configure-deployment',
            action: 'setdepcfg',
            fields: [
                'provider', ['deployment_id', 'number'], ['execution_mode', 'number'],
                ['source_model_id', 'number'], ['topology_artifact_id', 'number'], ['node_count', 'number'],
                ['aggregate_memory_mb', 'number'], ['min_node_memory_mb', 'number'], ['interconnect', 'number'],
                'sharding_hash', 'runtime_hash', ['validated_context_tokens', 'number'], 'metadata',
            ],
            signerField: 'provider',
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
    ai.addCommand(group('promotion', 'Select and launch larger specialist model tiers', [
        {
            command: 'open',
            action: 'openround',
            fields: [
                'proposer', ['program_id', 'number'], ['target_compute_class', 'number'], 'min_demand',
                'training_budget', ['min_training_providers', 'number'], ['min_inference_providers', 'number'],
                ['min_quality_bps', 'number'], ['min_safety_bps', 'number'], ['nomination_sec', 'number'],
                ['voting_sec', 'number'], 'metadata',
            ],
            signerField: 'proposer',
        },
        {
            command: 'nominate',
            action: 'nominate',
            fields: [
                'proposer', ['round_id', 'number'], ['base_model_id', 'number'], ['dataset_artifact_id', 'number'],
                ['eval_artifact_id', 'number'], 'estimated_training_cost', 'estimated_input_price_million',
                'estimated_output_price_million', 'title', 'metadata',
            ],
            signerField: 'proposer',
        },
        {
            command: 'qualify',
            action: 'qualify',
            fields: ['validator', ['candidate_id', 'number'], ['approve', 'boolean'], ['license_ok', 'boolean'], ['reproducible', 'boolean'], ['serving_ok', 'boolean'], 'report_hash'],
            signerField: 'validator',
        },
        {
            command: 'score-bakeoff',
            action: 'scorebake',
            fields: ['validator', ['candidate_id', 'number'], ['quality_bps', 'number'], ['blind_preference_bps', 'number'], ['safety_bps', 'number'], ['cost_efficiency_bps', 'number'], ['transfer_bps', 'number'], 'report_hash'],
            signerField: 'validator',
        },
        {
            command: 'commit-provider',
            action: 'commitcand',
            fields: ['provider', ['candidate_id', 'number'], ['roles', 'number'], ['capacity_units', 'number'], 'quoted_cost', 'metadata'],
            signerField: 'provider',
        },
        { command: 'pledge-demand', action: 'pledgedemand', fields: ['supporter', ['candidate_id', 'number'], 'quantity'], signerField: 'supporter' },
        { command: 'start-vote', action: 'startround', fields: [['round_id', 'number']] },
        { command: 'vote-user', action: 'voteuser', fields: ['voter', ['round_id', 'number'], ['rankings', 'json']], signerField: 'voter' },
        { command: 'vote-community', action: 'votecomm', fields: ['voter', ['round_id', 'number'], ['rankings', 'json'], 'quantity'], signerField: 'voter' },
        { command: 'close', action: 'closeround', fields: [['round_id', 'number']] },
        { command: 'settle-demand', action: 'settledem', fields: ['supporter', ['round_id', 'number']], signerField: 'supporter' },
        { command: 'reclaim-vote', action: 'reclaimvote', fields: ['voter', ['round_id', 'number']], signerField: 'voter' },
        { command: 'claim-round', action: 'claimround', fields: ['proposer', ['round_id', 'number']], signerField: 'proposer' },
        {
            command: 'add-milestone',
            action: 'addmile',
            fields: ['proposer', ['candidate_id', 'number'], 'payee', 'amount', 'title', 'metadata'],
            signerField: 'proposer',
        },
        { command: 'approve-milestone', action: 'approvemile', fields: ['validator', ['milestone_id', 'number'], 'report_hash'], signerField: 'validator' },
        { command: 'release-milestone', action: 'releasemile', fields: [['milestone_id', 'number'], 'evidence_hash'] },
        { command: 'start-training', action: 'startpromo', fields: ['creator', ['round_id', 'number'], ['max_submissions', 'number'], 'metadata', ['expires_sec', 'number']], signerField: 'creator' },
    ]));
    ai.addCommand(group('train', 'Run Harbor AI training job lifecycle actions', [
        {
            command: 'start',
            action: 'starttrain',
            fields: ['creator', ['tune_id', 'number'], ['base_model_id', 'number'], ['dataset_artifact_id', 'number'], 'reward', ['max_submissions', 'number'], 'metadata', ['expires_sec', 'number']],
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
    ai.addCommand(group('distill', 'Run consented, batched specialist distillation campaigns', [
        {
            command: 'open',
            action: 'opendistill',
            fields: [
                'owner', ['program_id', 'number'], ['tune_id', 'number'], ['teacher_model_id', 'number'],
                ['required_scopes', 'number'], ['discount_bps', 'number'], 'max_discount_per_infer',
                'discount_fund', ['min_batch_samples', 'number'], ['max_batch_samples', 'number'],
                ['min_quality_bps', 'number'], ['min_safety_bps', 'number'], ['min_transfer_bps', 'number'],
                ['min_canary_requests', 'number'], ['min_canary_success_bps', 'number'],
                'title', 'metadata',
            ],
            signerField: 'owner',
        },
        { command: 'fund', action: 'funddistill', fields: ['payer', ['campaign_id', 'number'], 'quantity'], signerField: 'payer' },
        { command: 'close', action: 'closedistill', fields: ['owner', ['campaign_id', 'number']], signerField: 'owner' },
        { command: 'claim', action: 'claimdistill', fields: ['owner', ['campaign_id', 'number'], 'quantity'], signerField: 'owner' },
        { command: 'consent', action: 'setconsent', fields: ['user', ['campaign_id', 'number'], ['scopes', 'number'], ['expires_sec', 'number']], signerField: 'user' },
        { command: 'revoke-consent', action: 'revokecons', fields: ['user', ['program_id', 'number']], signerField: 'user' },
        { command: 'opt-in', action: 'optindata', fields: ['user', ['infer_id', 'number'], ['campaign_id', 'number']], signerField: 'user' },
        { command: 'open-batch', action: 'openbatch', fields: ['owner', ['campaign_id', 'number'], 'curator', 'metadata'], signerField: 'owner' },
        { command: 'add-sample', action: 'addsample', fields: ['curator', ['batch_id', 'number'], ['infer_id', 'number'], 'evidence_hash'], signerField: 'curator' },
        { command: 'cancel-batch', action: 'cancelbatch', fields: ['actor', ['batch_id', 'number']], signerField: 'actor' },
        { command: 'seal-batch', action: 'sealbatch', fields: ['curator', ['batch_id', 'number'], ['dataset_artifact_id', 'number']], signerField: 'curator' },
        {
            command: 'start-batch',
            action: 'startdistill',
            fields: ['creator', ['batch_id', 'number'], 'reward', ['max_submissions', 'number'], 'metadata', ['expires_sec', 'number']],
            signerField: 'creator',
        },
        {
            command: 'score-batch',
            action: 'scorebatch',
            fields: ['validator', ['batch_id', 'number'], ['quality_bps', 'number'], ['safety_bps', 'number'], ['transfer_bps', 'number'], 'report_hash'],
            signerField: 'validator',
        },
        {
            command: 'report-canary',
            action: 'reportcanary',
            fields: ['router', ['batch_id', 'number'], ['request_count', 'number'], ['success_count', 'number'], 'evidence_hash'],
            signerField: 'router',
        },
        { command: 'promote-batch', action: 'promotebatch', fields: ['owner', ['batch_id', 'number']], signerField: 'owner' },
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
    ai.addCommand(group('session', 'Create session-affine routed inference for preserved model history', [
        {
            command: 'open',
            action: 'opensess',
            fields: ['requester', ['program_id', 'number'], ['preserve_thinking_history', 'boolean'], ['expires_sec', 'number'], 'metadata'],
            signerField: 'requester',
        },
        { command: 'close', action: 'closesess', fields: ['requester', ['session_id', 'number']], signerField: 'requester' },
        {
            command: 'request',
            action: 'reqsession',
            fields: [
                'requester', ['session_id', 'number'], ['min_compute_class', 'number'], ['max_compute_class', 'number'],
                ['routing_policy', 'number'], 'prompt_hash', ['max_input_tokens', 'number'], ['max_output_tokens', 'number'],
                'max_fee', ['max_latency_ms', 'number'], ['allow_escalation', 'boolean'], 'metadata',
            ],
            signerField: 'requester',
        },
    ]));
    ai.addCommand(group('route', 'Configure and audit AI routing decisions', [
        {
            command: 'request',
            action: 'reqroute',
            fields: [
                'requester', ['program_id', 'number'], ['min_compute_class', 'number'], ['max_compute_class', 'number'],
                ['routing_policy', 'number'], 'prompt_hash', ['max_input_tokens', 'number'], ['max_output_tokens', 'number'],
                'max_fee', ['max_latency_ms', 'number'], ['allow_escalation', 'boolean'], 'metadata',
            ],
            signerField: 'requester',
        },
        {
            command: 'quote',
            action: 'quoteinfer',
            fields: ['router', ['infer_id', 'number'], ['deployment_id', 'number'], 'max_fee', ['expires_sec', 'number'], 'reason_hash', 'metadata'],
            signerField: 'router',
        },
        { command: 'assign', action: 'assigninfer', fields: ['router', ['infer_id', 'number'], ['quote_id', 'number']], signerField: 'router' },
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
