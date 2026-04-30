import { Command } from 'commander';
export declare function parseCodeAccounts(value?: string): Array<{
    permission: {
        actor: string;
        permission: string;
    };
    weight: number;
}>;
export declare function createChainCommand(): Command;
