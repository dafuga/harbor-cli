interface CachePolicy {
    directory: string;
    parallel: number;
    idleMs?: number;
    engineKey?: string;
}
/** Manage disk-backed slots only for chat IDs explicitly supplied by a local client. */
export declare function createKvGateway(front: URL, engine: URL, settings: CachePolicy): Promise<{
    stats: () => {
        saved: number;
        restored: number;
    };
    resume: () => void;
    pause: () => Promise<void>;
    close: () => Promise<void>;
}>;
export {};
