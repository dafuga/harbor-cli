import { Command } from 'commander';
import { MarketOptions as OpportunityMarketOptions } from '@harbor/opportunities/market';
import type { Field } from './action-fields.js';
export interface MarketOptions extends OpportunityMarketOptions {
    url: string;
    contract: string;
    json?: boolean;
    best?: boolean;
}
export type { Field } from './action-fields.js';
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
export declare function createMarketCommand(): Command;
