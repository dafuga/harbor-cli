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
