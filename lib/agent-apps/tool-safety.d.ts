import type { AgentToolJournal } from '@dafuga01/harness-agent-safety';
import type { ToolReviews } from './tool-reviews.js';
import type { Agent, Network, ToolReceipt } from './types.js';
interface ToolContext {
    network: Network;
    runId: string;
    inferId: string;
    prompt: string;
    response: string;
    signal: AbortSignal;
    agent: () => Agent;
    assertActive: () => void;
    journal: AgentToolJournal;
    reviews: ToolReviews;
    declined: () => void;
    now: () => number;
}
export declare function workerToolDispatch(context: ToolContext): (raw: unknown) => Promise<ToolReceipt>;
export {};
