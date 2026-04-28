import { Command } from 'commander';
import { MarketOptions as OpportunityMarketOptions } from '@harbor/opportunities/market';
export interface MarketOptions extends OpportunityMarketOptions {
    url: string;
    contract: string;
    json?: boolean;
    best?: boolean;
}
export declare function createMarketCommand(): Command;
