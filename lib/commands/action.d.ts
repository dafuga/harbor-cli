import { Command } from 'commander';
export interface ActionOptions {
    url?: string;
    actor?: string;
    permission?: string;
    key?: string;
    auth?: string;
    json?: boolean;
    expiration?: string;
}
export declare function addTxOptions<T extends Command>(command: T): T;
export declare function pushJsonAction(contract: string, action: string, data: unknown, options: ActionOptions): Promise<void>;
export declare function createActionCommand(): Command;
