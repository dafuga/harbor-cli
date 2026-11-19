import { Command } from 'commander';
import { MarketOptions as OpportunityMarketOptions, MarketSnapshot, Opportunity, type OpportunitySelection } from '../lib/opportunities.js';
import type { Field } from './action-fields.js';
import { type ServiceHostOptions } from '../lib/host-policy.js';
import { type LimitOptions } from '../lib/resource-limits.js';
export interface MarketOptions extends OpportunityMarketOptions, ServiceHostOptions, LimitOptions {
    url: string;
    contract: string;
    json?: boolean;
    best?: boolean;
    agent?: string;
    exclude?: string[];
    dataDir?: string;
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
export type PrintableOpportunityWithUnable = Omit<OpportunityWithUnable, 'estimatedProviderRewardAmount' | 'hourlyRewardAmount'>;
export interface AgentOpportunityReport {
    rewardPool?: string;
    agent?: string;
    unable: UnableOpportunity[];
    best: PrintableOpportunityWithUnable | null;
    opportunities: PrintableOpportunityWithUnable[];
    hardwareSource?: 'detected' | 'simulated';
}
export interface ReferralStats {
    account: string;
    direct_invites: number;
    total_rewards: string;
}
export interface ReferralReport {
    note: string;
    stats: ReferralStats[];
}
export declare function buildMarketActionData(fields: Field[], values: string[]): Record<string, unknown>;
export declare function buildAgentOpportunityReportFromSnapshot(snapshot: MarketSnapshot, unableRows?: UnableOpportunity[], agent?: string, selection?: OpportunitySelection): AgentOpportunityReport;
export declare function addMarketSelectionOptions(command: Command): Command;
export declare function buildAgentOpportunityReport(options: MarketOptions): Promise<AgentOpportunityReport>;
export declare function createMarketCommand(): Command;
