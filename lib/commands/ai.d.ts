import { Command } from 'commander';
export interface RouteLogRow {
    id: number | string;
    infer_id?: number | string;
    request_hash?: string;
    selected_model_id: number | string;
    confidence_bps: number | string;
    metadata?: string;
}
export interface SubcallRow {
    id: number | string;
    parent_infer_id: number | string;
    from_model_id: number | string;
    to_model_id: number | string;
    metadata?: string;
}
export interface TuneNeed {
    base_model_id: number;
    title: string;
    route_count: number;
    low_confidence_count: number;
    subcall_count: number;
    avg_confidence_bps: number;
    infer_ids: number[];
    request_hashes: string[];
    metadata: Record<string, unknown>;
    request_template: string;
}
export interface TuneRequestRow {
    id: number | string;
    proposer?: string;
    base_model_id: number | string;
    dataset_artifact_id?: number | string;
    eval_artifact_id?: number | string;
    status: number | string;
    title?: string;
    metadata?: string;
}
export interface TuneAutoVotePlan {
    tune_id: number;
    approve: boolean;
    quantity: string;
    reason: string;
    need: TuneNeed;
    tune: TuneRequestRow;
}
export interface TrustedAiDecision {
    approve?: boolean;
    useful?: boolean;
    needs_tune?: boolean;
    score_bps?: number;
    useful_bps?: number;
    trust_score_bps?: number;
    task?: string;
    reason?: string;
    raw?: unknown;
}
export interface TrustedAiAdapterOptions {
    adapterCommand?: string;
    adapterUrl?: string;
    timeoutMs?: number;
}
export interface AegisConfigOptions {
    reviewer?: string;
    command?: string;
}
export type FusionLogitMode = 'none' | 'top_k' | 'full';
export interface FusionExpertSpec {
    model_id: number;
    role: string;
    weight: number;
}
export interface FusionManifestInput {
    base_model_id: number;
    experts: FusionExpertSpec[];
    logit_mode?: FusionLogitMode;
    logit_top_k?: number;
    selection_policy?: Record<string, unknown>;
    eval_artifact_id?: number;
    auto_expert_count?: number;
}
export interface FusionManifest {
    format: 'harbor.fusion.v1';
    base_model_id: number;
    expert_model_ids: number[];
    expert_roles: string[];
    expert_weights: number[];
    fusion_strategy: 'routed_expert';
    logit_mode: FusionLogitMode;
    logit_top_k: number;
    selection_policy: Record<string, unknown>;
    eval_artifact_id: number;
    auto_expert_count?: number;
}
export interface FusionRegisterPlan {
    manifest: FusionManifest;
    manifest_json: string;
    manifest_hash: string;
    artifact_metadata: Record<string, unknown>;
    model_metadata: Record<string, unknown>;
    actions: Array<{
        contract: string;
        action: string;
        data: Record<string, unknown>;
    }>;
}
export interface DistributedExpertPlanInput {
    base_model_id: number;
    expert_role: string;
    shard_count: number;
    participants?: string[];
    dataset_artifact_id?: number;
    model?: string;
    aggregation_group_id?: string;
    metadata?: Record<string, unknown>;
}
export interface DistributedExpertShard {
    shard_index: number;
    shard_count: number;
    participant?: string;
    metadata: Record<string, unknown>;
}
export interface DistributedExpertPlan {
    format: 'harbor.distributed_expert_plan.v1';
    base_model_id: number;
    expert_role: string;
    shard_count: number;
    aggregation_group_id: string;
    shards: DistributedExpertShard[];
}
export interface DistributedShardArtifactSpec {
    shard_index: number;
    weights_hash: string;
    weight: number;
    artifact_id?: number;
    trainer?: string;
}
export interface DistributedAggregateManifest {
    format: 'harbor.gemma.mlx.aggregate-manifest.v1';
    base_model_id: number;
    expert_role: string;
    aggregation_group_id: string;
    aggregation_strategy: 'weighted_lora_average';
    shard_artifacts: DistributedShardArtifactSpec[];
}
export interface QueryDatasetExample {
    messages: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>;
    metadata: Record<string, unknown>;
    rejected_completion?: string;
}
export interface QueryDatasetManifest {
    format: 'harbor.ai.query-dataset.v1';
    dataset_format: 'chat_messages_jsonl';
    dataset_hash: string;
    source: 'harbor-ai-query-traces';
    contributor?: string;
    base_model_id?: number;
    model_id?: number;
    expert_role?: string;
    fusion_parent_model_id?: number;
    task?: string;
    example_count: number;
    example_hashes: string[];
    prompt_hashes: string[];
    trace_hashes: string[];
    quality_policy: Record<string, unknown>;
    privacy_policy: Record<string, unknown>;
    training_metadata?: Record<string, unknown>;
}
export interface QueryDatasetPack {
    examples: QueryDatasetExample[];
    dataset_jsonl: string;
    dataset_hash: string;
    manifest: QueryDatasetManifest;
    manifest_json: string;
    manifest_hash: string;
    skipped: Record<string, number>;
}
export interface QueryDatasetPackOptions {
    contributor?: string;
    task?: string;
    user?: string;
    model_id?: number;
    base_model_id?: number;
    expert_role?: string;
    fusion_parent_model_id?: number;
    min_useful_bps?: number;
    include_all?: boolean;
    include_low_score?: boolean;
    include_unscored?: boolean;
    max_examples?: number;
}
export declare function canonicalJson(value: unknown): string;
export declare function buildQueryDatasetFromTraces(lines: string[], options?: QueryDatasetPackOptions): QueryDatasetPack;
export declare function parseFusionExpertSpec(value: string): FusionExpertSpec;
export declare function buildFusionManifest(input: FusionManifestInput): FusionManifest;
export declare function buildFusionRegisterPlan(input: {
    manifest: FusionManifest;
    manifestMetadata?: Record<string, unknown>;
    owner: string;
    title: string;
    storageObjectId?: number | string;
    contentHash?: string;
    weightsArtifactId?: number | string;
    aiContract?: string;
    modelMetadata?: Record<string, unknown>;
}): FusionRegisterPlan;
export declare function buildDistributedExpertPlan(input: DistributedExpertPlanInput): DistributedExpertPlan;
export declare function parseDistributedShardSpec(value: string): DistributedShardArtifactSpec;
export declare function buildDistributedAggregateManifest(input: {
    base_model_id: number;
    expert_role: string;
    aggregation_group_id: string;
    shard_artifacts: DistributedShardArtifactSpec[];
}): DistributedAggregateManifest;
export declare function renderAegisConfig(options?: AegisConfigOptions): string;
export declare function aegisHarborCheckCommand(configPath: string, options?: {
    aegisCommand?: string;
}): string;
export declare function buildTuneNeeds(routes: RouteLogRow[], subcalls: SubcallRow[], options?: {
    confidenceThreshold?: number;
    minCount?: number;
    proposer?: string;
    datasetArtifactId?: string;
    evalArtifactId?: string;
    expiresSec?: string;
    user?: string;
    trustedOnly?: boolean;
}): TuneNeed[];
export declare function buildTuneAutoVotePlan(needs: TuneNeed[], tunes: TuneRequestRow[], options: {
    quantity: string;
}): TuneAutoVotePlan[];
export declare function runTrustedAiAdapter(input: unknown, options: TrustedAiAdapterOptions): Promise<TrustedAiDecision>;
export declare function createAiCommand(): Command;
