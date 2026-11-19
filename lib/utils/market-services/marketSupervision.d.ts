import type { MarketSupervisor, MarketSupervisionOptions } from './marketSupervision.types.js';
/** Example: when storage overtakes relay, drain relay before starting storage. */
export declare function marketSupervision<Plan>(supervisor: MarketSupervisor<Plan>, options: MarketSupervisionOptions): Promise<void>;
