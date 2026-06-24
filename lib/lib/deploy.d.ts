import { AuthOptions } from './tx.js';
export interface DeployOptions extends AuthOptions {
    account: string;
    wasm: string;
    abi: string;
    validate?: boolean;
}
export interface DeployContractBytesOptions extends AuthOptions {
    account: string;
    wasmBytes: Buffer;
    abiJson: unknown;
    validate?: boolean;
}
export interface CreateContractAccountOptions extends AuthOptions {
    creator: string;
    account: string;
    ownerKey: string;
    activeKey: string;
    ramBytes: number;
    stakeNet?: string;
    stakeCpu?: string;
}
export declare function publicKeyAuthority(key: string): {
    threshold: number;
    keys: {
        key: string;
        weight: number;
    }[];
    accounts: never[];
    waits: never[];
};
export declare function createContractAccountActions(options: CreateContractAccountOptions): Array<Record<string, unknown>>;
export declare function createContractAccount(options: CreateContractAccountOptions): Promise<{
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
export declare function accountExists(url: string, account: string): Promise<boolean>;
export declare function deployContractActions(options: Pick<DeployContractBytesOptions, 'account' | 'wasmBytes' | 'abiJson' | 'permission'>): ({
    account: string;
    name: string;
    authorization: {
        actor: string;
        permission: string;
    }[];
    data: {
        account: string;
        vmtype: number;
        vmversion: number;
        code: string;
        abi?: undefined;
    };
} | {
    account: string;
    name: string;
    authorization: {
        actor: string;
        permission: string;
    }[];
    data: {
        account: string;
        abi: string;
        vmtype?: undefined;
        vmversion?: undefined;
        code?: undefined;
    };
})[];
export declare function deployContractBytes(options: DeployContractBytesOptions): Promise<{
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
export declare function deployContract(options: DeployOptions): Promise<{
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
