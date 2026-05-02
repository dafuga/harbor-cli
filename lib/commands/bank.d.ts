import { Command } from 'commander';
import { Transaction } from '@wharfkit/antelope';
export interface BankBalance {
    asset_id: number;
    token_contract: string;
    token_symbol: string;
    spending: string;
    savings: string;
    daily_limit: string;
    msig_threshold: string;
    spent_today: string;
    spent_day: number;
    unlock_delay_sec: number;
    high_value_actor?: string;
    high_value_permission?: string;
}
export interface BankOptions {
    url?: string;
    contract?: string;
    token?: string;
    symbol?: string;
    json?: boolean;
    actor?: string;
    permission?: string;
    key?: string;
    auth?: string;
    expiration?: string;
}
export interface WithdrawProposalInput {
    owner: string;
    to: string;
    tokenContract: string;
    quantity: string;
    memo: string;
    bankContract: string;
    msigContract: string;
    proposer: string;
    proposalName: string;
    highValueAuth: string;
    requestedApprovals?: Array<{
        actor: string;
        permission: string;
    }>;
    expirationSeconds: number;
    url?: string;
}
export declare function parseBucket(value: string): number;
export declare function depositMemo(bucket: number): string;
export declare function parsePermission(value: string): {
    actor: string;
    permission: string;
};
export declare function parsePermissionList(value: string): Array<{
    actor: string;
    permission: string;
}>;
export declare function generatedProposalName(prefix?: string, now?: number): string;
export declare function requestedWithdrawApprovals(_owner: string, highValueAuth: string, highValueApprovers?: Array<{
    actor: string;
    permission: string;
}>): Array<{
    actor: string;
    permission: string;
}>;
export declare function buildWithdrawProposal(input: WithdrawProposalInput): Promise<{
    proposalName: string;
    requested: {
        actor: string;
        permission: string;
    }[];
    transaction: Transaction;
    action: import("@wharfkit/antelope").Action;
}>;
export declare function createBankCommand(): Command;
