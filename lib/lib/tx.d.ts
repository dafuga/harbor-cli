import { ABI, APIClient, Action, SignedTransaction } from '@wharfkit/antelope';
export interface AuthOptions {
    url?: string;
    actor?: string;
    permission?: string;
    key?: string;
    json?: boolean;
    expiration?: string;
}
export interface PushActionInput extends AuthOptions {
    contract: string;
    action: string;
    data: unknown;
    authorization?: string;
}
export declare function apiUrl(url?: string): string;
export declare function permissionLevel(options: AuthOptions, fallbackActor?: string): {
    actor: string;
    permission: string;
};
export declare function parseAuthorization(auth: string): {
    actor: string;
    permission: string;
};
export declare function parseAuthorizations(auth: string): Array<{
    actor: string;
    permission: string;
}>;
export declare function parseJson(value: string): unknown;
export declare function printResult(result: unknown, json?: boolean): void;
export declare function clientFor(url?: string): APIClient;
export declare function getAbi(account: string, url?: string): Promise<ABI>;
export declare function serializeAction(input: PushActionInput): Promise<Action>;
export declare function transactActions(options: AuthOptions, actions: Action[] | Array<Record<string, unknown>>): Promise<{
    transaction_id: string | undefined;
    status: string | undefined;
    response: {
        transaction_id?: string;
        processed?: {
            receipt?: {
                status?: string;
            };
        };
    } | undefined;
}>;
export declare function signAction(input: PushActionInput): Promise<{
    chain_id: import("@wharfkit/antelope").Checksum256;
    transaction: SignedTransaction;
}>;
export declare function pushAction(input: PushActionInput): Promise<{
    transaction_id: string | undefined;
    status: string | undefined;
    response: {
        transaction_id?: string;
        processed?: {
            receipt?: {
                status?: string;
            };
        };
    } | undefined;
}>;
export declare function getTableRows<T = unknown>(contract: string, table: string, options?: {
    url?: string;
    scope?: string;
    limit?: number;
    lowerBound?: string;
    upperBound?: string;
    indexPosition?: string;
    keyType?: string;
}): Promise<{
    rows: T[];
    more: boolean | string;
    next_key?: string;
}>;
export declare function canonicalUint64(value: unknown, label?: string): string;
export declare function displayUint64(value: unknown, label?: string): number | string;
export declare function getAllTableRows<T = unknown>(contract: string, table: string, options?: Parameters<typeof getTableRows<T>>[2]): Promise<T[]>;
export declare function readContractNextId(contract: string, field: string, options?: {
    url?: string;
}): Promise<string>;
/** Best-effort extraction for contracts that expose a uint64 action return value. */
export declare function actionUint64Return(result: unknown, contract: string, action: string): string | undefined;
