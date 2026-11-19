import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentWorker } from './worker.js';
export declare function workerServer(worker: AgentWorker, token: string): import("http").Server<typeof IncomingMessage, typeof ServerResponse>;
