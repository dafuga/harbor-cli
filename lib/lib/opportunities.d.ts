export interface TableRowsResponse<T> {
    rows: T[];
    more: boolean | string;
    next_key?: string;
}
export interface HarborServiceType {
    id: number;
    service_name: string;
    enabled: boolean | number;
    reward_weight: number | string;
    epoch_budget: string;
    base_provider_reward: string;
    provider_fail_penalty: string;
    oracle_agree_reward: string;
    oracle_disagree_penalty: string;
    oracle_miss_penalty: string;
    min_provider_stake: string;
    min_oracle_stake: string;
    min_oracle_reports: number;
    min_check_window_sec: number;
}
export interface HarborService {
    id: number;
    provider: string;
    service_type: number;
    segment_kind: number;
    range_start: number;
    range_end: number;
    capacity_bytes: number | string;
    active: boolean | number;
    last_heartbeat?: string;
    last_status_hash?: string;
    endpoint: string;
    metadata: string;
}
export interface HarborState {
    reward_pool: string;
}
export interface MarketOptions {
    url: string;
    contract: string;
}
export interface MarketSnapshot {
    types: HarborServiceType[];
    services: HarborService[];
    state?: HarborState;
}
export interface Opportunity {
    id: number;
    name: string;
    duties: string;
    mustNot: string;
    oracleChecks: string;
    activeProviders: number;
    epochBudget: string;
    estimatedProviderReward: string;
    estimatedProviderRewardAmount: number;
    baseProviderReward: string;
    status: string;
}
export interface OpportunityReport {
    rewardPool?: string;
    best: PrintableOpportunity | null;
    opportunities: PrintableOpportunity[];
}
export type PrintableOpportunity = Omit<Opportunity, 'estimatedProviderRewardAmount'>;
export declare function normalizeUrl(url: string): string;
export declare function getTableRows<T>(url: string, contract: string, table: string, options?: {
    scope?: string;
    limit?: number;
}): Promise<TableRowsResponse<T>>;
export declare function parseAssetAmount(asset: string): number;
export declare function assetSymbol(asset: string): string;
export declare function isActive(value: boolean | number): boolean;
export declare function loadMarket(options: MarketOptions): Promise<MarketSnapshot>;
export declare function buildOpportunities(types: HarborServiceType[], services: HarborService[]): Opportunity[];
export declare function bestOpportunity(opportunities: Opportunity[]): Opportunity | undefined;
export declare function printableOpportunity(opportunity: Opportunity): PrintableOpportunity;
export declare function printableOpportunities(opportunities: Opportunity[]): PrintableOpportunity[];
export declare function buildOpportunityReport(snapshot: MarketSnapshot): OpportunityReport;
export declare function recommendation(opportunity: PrintableOpportunity): string;
