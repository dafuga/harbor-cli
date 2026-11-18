import { Checksum256 } from '@wharfkit/antelope';
import { AbstractWalletPlugin, LoginContext, TransactContext, WalletPluginMetadata } from '@wharfkit/session';
import type { ResolvedSigningRequest } from '@wharfkit/signing-request';
import type { AntelopeSigner } from './wallet.js';
export type TransactionReview = (transaction: ResolvedSigningRequest) => Promise<void>;
export declare function antelopeSigners(keyOption?: string, actor?: string): Promise<AntelopeSigner[]>;
declare class HarborSigningWallet extends AbstractWalletPlugin {
    private readonly signers;
    private readonly url?;
    private readonly review?;
    id: string;
    config: {
        requiresChainSelect: boolean;
        requiresPermissionSelect: boolean;
        requiresPermissionEntry: boolean;
    };
    metadata: WalletPluginMetadata;
    constructor(signers: AntelopeSigner[], url?: string | undefined, review?: TransactionReview | undefined);
    login(context: LoginContext): Promise<{
        chain: Checksum256;
        permissionLevel: import("@wharfkit/antelope").PermissionLevel;
    }>;
    private requiredSigners;
    sign(resolved: ResolvedSigningRequest, context: TransactContext): Promise<{
        signatures: import("@wharfkit/antelope").Signature[];
    }>;
}
export declare function walletPluginFor(keyOption: string | undefined, actor: string, url?: string, review?: TransactionReview): Promise<HarborSigningWallet>;
export {};
