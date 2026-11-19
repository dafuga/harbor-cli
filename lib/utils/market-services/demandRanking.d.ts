import type { MarketSnapshot, Opportunity } from '../../lib/opportunities.js';
import type { OpportunitySelection } from './demandRanking.types.js';
export declare function liveProviderRows(snapshot: MarketSnapshot, now: number): MarketSnapshot['services'];
/** Example: 12 units/hour at 1.2500 HRBR shared with one live provider yields 7.5000 HRBR/hour. */
export declare function demandRanking(opportunities: Opportunity[], snapshot: MarketSnapshot, selection: OpportunitySelection): Opportunity[];
