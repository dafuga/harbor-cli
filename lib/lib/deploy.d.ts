import { AuthOptions } from './tx.js';
interface DeployOptions extends AuthOptions {
    account: string;
    wasm: string;
    abi: string;
    validate?: boolean;
}
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
export {};
