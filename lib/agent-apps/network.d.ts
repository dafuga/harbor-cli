import { pushAction } from '../lib/tx.js';
import type { AntelopeSigner } from '../lib/wallet.js';
import type { HarborConfig } from './network.types.js';
import type { Agent, Network, Price, Run, ToolCall } from './types.js';
export declare function routerSignature(secret: string, audience: string, subject: string, route: string, at: number, nonce: string, body: string): string;
export declare class HarborNetwork implements Network {
    private readonly config;
    private readonly signer;
    private readonly transact;
    readonly models: {
        id: string;
        label: string;
        kind: "flagship" | "lora";
    }[];
    readonly currency: {
        symbol: string;
        precision: number;
    };
    readonly identity: string;
    constructor(config: HarborConfig, signer: AntelopeSigner, transact?: typeof pushAction);
    private chain;
    private assertChain;
    ready(): Promise<void>;
    private permissionUsesWorkerKey;
    private push;
    private harborModel;
    private asset;
    private fee;
    private body;
    private router;
    private assertRoute;
    quote(agent: Agent, prompt: string, ceiling: number, signal?: AbortSignal): Promise<Price>;
    private findRequest;
    private row;
    execute(input: Parameters<Network['execute']>[0]): Promise<{
        paid: number | null;
        text: string;
        calls: ToolCall[];
    }>;
    reconcile(run: Run, _agent: Agent, signal?: AbortSignal): Promise<number | null>;
    verify(call: ToolCall, context: Parameters<Network['verify']>[1], signal: AbortSignal): Promise<string>;
    private storageBytes;
    readFile(contentHash: string, signal: AbortSignal): Promise<string>;
    useSecret(alias: string, message: string, context: Parameters<Network['useSecret']>[2], signal: AbortSignal): Promise<string>;
}
