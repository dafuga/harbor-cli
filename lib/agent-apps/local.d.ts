import type { LocalAgentConfig } from './network.types.js';
import type { Network } from './types.js';
export declare class LocalAgentNetwork implements Network {
    private readonly config;
    readonly localOnly = true;
    readonly identity: string;
    readonly baseModel = "qwen3:8b-q4_K_M";
    readonly models: {
        id: string;
        label: string;
        revision: string;
    }[];
    readonly currency: {
        symbol: string;
        precision: number;
    };
    constructor(config: LocalAgentConfig);
    verifyModel(signal?: AbortSignal): Promise<void>;
    quote(_agent: unknown, _prompt: string, _ceiling: number, signal?: AbortSignal): Promise<{
        maxCost: number;
        deployment: string;
    }>;
    execute(input: Parameters<Network['execute']>[0]): Promise<{
        text: string;
        paid: number;
        calls: never[];
    }>;
    reconcile(): Promise<number>;
    verify(): Promise<never>;
    readFile(): Promise<never>;
    useSecret(): Promise<never>;
}
