import { Command } from 'commander';
import { MarketOptions as OpportunityMarketOptions, MarketSnapshot, Opportunity } from '@harbor/opportunities/market';
import type { Field } from './action-fields.js';
export interface MarketOptions extends OpportunityMarketOptions {
    url: string;
    contract: string;
    json?: boolean;
    best?: boolean;
    agent?: string;
}
export type { Field } from './action-fields.js';
export interface UnableOpportunity {
    service_type: number;
    service_name: string;
    reason: string;
    metadata: string;
    updated_at: string;
}
export type OpportunityWithUnable = Opportunity & {
    unableReason?: string;
    unableMetadata?: string;
    unableUpdatedAt?: string;
};
export type PrintableOpportunityWithUnable = Omit<OpportunityWithUnable, 'estimatedProviderRewardAmount'>;
export interface AgentOpportunityReport {
    rewardPool?: string;
    agent?: string;
    unable: UnableOpportunity[];
    best: PrintableOpportunityWithUnable | null;
    opportunities: PrintableOpportunityWithUnable[];
}
export interface ReferralConfig {
    id: number;
    enabled: boolean | number;
    first_level_bps: number;
    decay_bps: number;
    max_total_bps: number;
}
export interface ReferralLink {
    account: string;
    referrer: string;
    created_at: string;
}
export interface ReferralStats {
    account: string;
    direct_invites: number;
    total_rewards: string;
}
export interface ReferralReport {
    config: ReferralConfig | null;
    referrals: ReferralLink[];
    stats: ReferralStats[];
}
export declare function buildMarketActionData(fields: Field[], values: string[]): Record<string, unknown>;
export declare function buildAgentOpportunityReportFromSnapshot(snapshot: MarketSnapshot, unableRows?: UnableOpportunity[], agent?: string): AgentOpportunityReport;
export declare function createMarketCommand(): Command;
