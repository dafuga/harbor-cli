import type { Agent, AgentStatus, AuditEntry, Network, Quote, Routine, Run } from './types.js';
export declare const MAX_PROMPT_BYTES = 7400;
export declare class AgentWorker {
    readonly host: string;
    private readonly network;
    private readonly now;
    private readonly store;
    private readonly active;
    private sweeping;
    constructor(file: string, host: string, network: Network, now?: () => number);
    get identity(): string | undefined;
    stop(): void;
    close(): void;
    private agent;
    private run;
    private requireActive;
    private log;
    private saveRun;
    snapshot(id?: string): {
        host: string;
        identity: string | undefined;
        currency: {
            symbol: string;
            precision: number;
        };
        models: import("./types.js").Model[];
        agents: {
            paid: number;
            reserved: number;
            id: string;
            status: AgentStatus;
            revision: number;
            name: string;
            instructions: string;
            model: string;
            perRun: number;
            total: number;
            files: string[];
            secrets: string[];
        }[];
        quotes: {
            id: string;
            agentId: string;
            revision: number;
            requestId: string;
            prompt: string;
            expiresAt: number;
            maxCost: number;
            deployment: string;
        }[];
        routines: Routine[];
        runs: Run[];
        audit: AuditEntry[];
    };
    private openQuotes;
    createAgent(input: unknown): Agent;
    saveAgent(id: string | undefined, input: unknown): Agent;
    importAgent(input: unknown): Agent;
    private agentInput;
    setStatus(id: string, status: unknown): Agent;
    private cancelQueued;
    quote(id: string, message: unknown, replaceOpen?: unknown): Promise<Quote>;
    confirm(id: string): Run;
    cancelQuote(id: string): {
        agentId: string;
    };
    createRoutine(agentId: string, input: unknown): {
        routine: Routine;
        token: string | undefined;
    };
    setRoutine(id: string, enabled: unknown): Routine;
    trigger(id: string, credential: string, eventId: unknown): {
        id: string;
        status: import("./types.js").RunStatus;
    };
    private enqueue;
    private available;
    private getPrice;
    private claim;
    tick(): Promise<void>;
    private execute;
    private finish;
    reconcile(id: string): Promise<Run>;
}
