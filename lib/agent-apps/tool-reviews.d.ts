import type { AgentToolReview } from '@dafuga01/harness-agent-safety';
type VisibleToolReview = AgentToolReview & {
    agentId: string;
    runId: string;
    content: string;
};
export declare class ToolReviews {
    private readonly pending;
    forAgent(agentId: string, now: number): VisibleToolReview[];
    decide(id: string, approved: boolean, now: number): {
        accepted: boolean;
    };
    wait(visible: VisibleToolReview, signal: AbortSignal, now: number): Promise<boolean>;
}
export {};
