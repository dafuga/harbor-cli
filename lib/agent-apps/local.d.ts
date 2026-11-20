import type { LocalAgentConfig } from './network.types.js';
import type { Agent, Model, Network } from './types.js';
export declare class LocalAgentNetwork implements Network {
    private readonly config;
    readonly localOnly = true;
    readonly identity: string;
    readonly baseModel: string;
    private readonly base;
    private expert?;
    private readonly deployment;
    readonly currency: {
        symbol: string;
        precision: number;
    };
    constructor(config: LocalAgentConfig);
    get models(): Model[];
    specialtyModel(id: string, version: number): string | undefined;
    private get headers();
    refreshModels(signal?: AbortSignal): Promise<void>;
    verifyModel(signal?: AbortSignal): Promise<void>;
    private selection;
    quote(agent: Agent, _prompt: string, _ceiling: number, signal?: AbortSignal): Promise<{
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
