import type { HarborConfig, LocalAgentConfig } from './network.types.js';
export declare const HARBOR_TESTNET = "d7e3ddbbf7e977f95d2f2d388926dd875e8a57c5a14259e8335b70b3b4bc498a";
export declare function positiveId(value: unknown, label: string): string;
export declare function harborConfig(value: unknown, env?: NodeJS.ProcessEnv): HarborConfig;
export declare function localAgentConfig(value: unknown, env?: NodeJS.ProcessEnv): LocalAgentConfig;
