import { Command } from 'commander';
import { HarborService, HarborServiceType, HarborState } from '../lib/chain.js';
export interface MarketOptions {
    url: string;
    contract: string;
    json?: boolean;
    best?: boolean;
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
export declare function loadMarket(options: MarketOptions): Promise<{
    types: HarborServiceType[];
    services: HarborService[];
    state: HarborState;
}>;
export declare function buildOpportunities(types: HarborServiceType[], services: HarborService[]): Opportunity[];
export declare function bestOpportunity(opportunities: Opportunity[]): Opportunity | undefined;
export declare function createMarketCommand(): Command;
