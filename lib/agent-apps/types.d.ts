export interface SpecialtyManifest {
    id: string;
    version: number;
    name: string;
    description: string;
    skills: readonly string[];
    tools: readonly string[];
    instructions: string;
    systemPrompt: string;
    routine: {
        name: string;
        prompt: string;
        intervalMinutes: number;
    };
    evaluationSuite: string;
    expertProgram: string;
}
export declare const FEEDBACK_POLICY = "harbor.agent-feedback.v1";
export interface RunFeedback {
    id: string;
    runId: string;
    agentId: string;
    specialty: string;
    specialtyVersion: number;
    kind: 'answer' | 'task';
    rating: 'up' | 'down';
    policy: typeof FEEDBACK_POLICY;
    recordedAt: number;
    outcome: {
        status: RunStatus;
        scheduled: boolean;
    };
    model: string;
    modelRevision?: string;
    reason?: string;
    correction?: string;
}
export type AgentStatus = 'active' | 'paused' | 'killed';
export type RunStatus = 'queued' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled' | 'needs_attention';
export interface AgentInput {
    name: string;
    instructions: string;
    model: string;
    perRun: number;
    total: number;
    files: string[];
    specialty?: string;
    managedAgents?: string[];
    secrets: string[];
}
export interface Agent extends AgentInput {
    id: string;
    status: AgentStatus;
    specialtyVersion?: number;
    revision: number;
}
export interface RoutineInput {
    name: string;
    prompt: string;
    kind: 'interval' | 'trigger';
    intervalMinutes?: number;
    maxCost: number;
}
export interface Routine extends RoutineInput {
    id: string;
    agentId: string;
    enabled: boolean;
    nextAt: number | null;
}
export interface Model {
    id: string;
    label: string;
    revision?: string;
}
export interface Price {
    maxCost: number;
    deployment: string;
}
export interface Quote extends Price {
    id: string;
    agentId: string;
    revision: number;
    requestId: string;
    prompt: string;
    model?: string;
    modelRevision?: string;
    expiresAt: number;
}
export interface Run {
    id: string;
    agentId: string;
    revision: number;
    routineId: string | null;
    specialty?: string;
    specialtyVersion?: number;
    model?: string;
    modelRevision?: string;
    prompt: string;
    limit: number;
    status: RunStatus;
    reserved: number;
    paid: number;
    createdAt: number;
    startedAt?: number;
    price?: Price;
    promptHash?: string;
    inferId?: string;
    result?: string;
    tools?: ToolReceipt[];
    detail?: string;
}
export interface ToolCall {
    name: 'read_file' | 'use_secret';
    resource: string;
    message?: string;
}
export interface ToolReceipt {
    name: ToolCall['name'];
    resource: string;
    result: string;
    verification: string;
}
export interface AuditEntry {
    at: number;
    event: string;
    agentId?: string;
    runId?: string;
    routineId?: string;
    detail?: string;
}
export interface Delivery {
    text: string;
    calls: ToolCall[];
    paid: number | null;
}
export interface Network {
    identity?: string;
    models: Model[];
    baseModel?: string;
    specialtyModel?(id: string, version: number): string | undefined;
    currency: {
        symbol: string;
        precision: number;
    };
    quote(agent: Agent, prompt: string, ceiling: number, signal?: AbortSignal): Promise<Price>;
    execute(input: {
        agent: Agent;
        prompt: string;
        price: Price;
        signal: AbortSignal;
        starting(): void;
        submitted(inferId: string): void;
        assertActive(): void;
    }): Promise<Delivery>;
    reconcile(run: Run, agent: Agent, signal?: AbortSignal): Promise<number | null>;
    verify(call: ToolCall, context: {
        runId: string;
        inferId: string;
        prompt: string;
        response: string;
    }, signal: AbortSignal): Promise<string>;
    readFile(hash: string, signal: AbortSignal): Promise<string>;
    useSecret(alias: string, message: string, context: {
        runId: string;
        assertActive(): void;
    }, signal: AbortSignal): Promise<string>;
}
