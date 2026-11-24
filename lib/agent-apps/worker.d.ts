import type { Agent, AgentStatus, AuditEntry, Network, Quote, Routine, Run, RunFeedback } from './types.js';
export declare const MAX_PROMPT_BYTES = 7400;
export declare class AgentWorker {
    readonly host: string;
    private readonly network;
    private readonly now;
    private readonly store;
    private readonly toolReviews;
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
        feedback: RunFeedback[];
        agents: {
            paid: number;
            reserved: number;
            id: string;
            status: AgentStatus;
            specialtyVersion?: number;
            revision: number;
            name: string;
            instructions: string;
            model: string;
            perRun: number;
            total: number;
            files: string[];
            specialty?: string;
            managedAgents?: string[];
            secrets: string[];
        }[];
        routines: Routine[];
        runs: Run[];
        audit: AuditEntry[];
        toolReviews?: (import("@dafuga01/harness-agent-safety").AgentToolReview & {
            agentId: string;
            runId: string;
            content: string;
        })[] | undefined;
        identity: string | undefined;
        currency: {
            symbol: string;
            precision: number;
        };
        models: import("./types.js").Model[];
        specialties: readonly import("./types.js").SpecialtyManifest[];
        feedbackPolicy: string;
        execution?: string | undefined;
        host: string;
    };
    pendingToolReviews(agentId: string): (import("@dafuga01/harness-agent-safety").AgentToolReview & {
        agentId: string;
        runId: string;
        content: string;
    })[];
    decideToolReview(id: string, approved: boolean): {
        accepted: boolean;
    };
    private executionAgent;
    private taskPrompt;
    private modelRevision;
    createAgent(input: unknown): Agent;
    saveAgent(id: string | undefined, input: unknown): Agent;
    setFeedback(id: string, input: unknown): RunFeedback | {
        deleted: boolean;
    };
    private reserveFeedbackSlot;
    clearFeedback(agentId: string): {
        deleted: boolean;
    };
    setStatus(id: string, status: unknown): Agent;
    private cancelQueued;
    refreshModels(): Promise<void>;
    quote(id: string, message: unknown): Promise<Quote>;
    confirm(id: string): Run;
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
