import { Checksum256, Transaction } from '@wharfkit/antelope';
import { AbstractWalletPlugin, LoginContext, TransactContext, WalletPluginMetadata } from '@wharfkit/session';
import type { AntelopeSigner } from './wallet.js';
export declare function antelopeSigners(keyOption?: string, actor?: string): Promise<AntelopeSigner[]>;
declare class HarborSigningWallet extends AbstractWalletPlugin {
    private readonly signers;
    private readonly url?;
    id: string;
    config: {
        requiresChainSelect: boolean;
        requiresPermissionSelect: boolean;
        requiresPermissionEntry: boolean;
    };
    metadata: WalletPluginMetadata;
    constructor(signers: AntelopeSigner[], url?: string | undefined);
    login(context: LoginContext): Promise<{
        chain: Checksum256;
        permissionLevel: import("@wharfkit/antelope").PermissionLevel;
    }>;
    private requiredSigners;
    sign(resolved: {
        transaction: Transaction;
    }, context: TransactContext): Promise<{
        signatures: import("@wharfkit/antelope").Signature[];
    }>;
}
export declare function walletPluginFor(keyOption: string | undefined, actor: string, url?: string): Promise<HarborSigningWallet>;
export {};
