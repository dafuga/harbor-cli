import type { AgentToolJournal } from '@dafuga01/harness-agent-safety';
import type { AgentStore } from './store.js';
export declare function toolSafetyJournal(store: AgentStore, runId: string): AgentToolJournal;
