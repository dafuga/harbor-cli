export declare class AgentError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
export declare function record(value: unknown): Record<string, unknown>;
export declare function text(value: unknown, label: string, max: number): string;
export declare function amount(value: unknown, label: string): number;
export declare function hash(value: string): boolean;
export declare function alias(value: string): boolean;
export declare function permissions(value: unknown, validate: (item: string) => boolean, label: string): string[];
