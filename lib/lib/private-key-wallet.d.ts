import { Checksum256, PrivateKey } from '@wharfkit/antelope';
import { AbstractWalletPlugin, LoginContext, TransactContext, WalletPluginMetadata } from '@wharfkit/session';
import { WalletPluginPrivateKey } from '@wharfkit/wallet-plugin-privatekey';
declare class MultiPrivateKeyWalletPlugin extends AbstractWalletPlugin {
    private readonly privateKeys;
    private readonly url?;
    id: string;
    config: {
        requiresChainSelect: boolean;
        requiresPermissionSelect: boolean;
        requiresPermissionEntry: boolean;
    };
    metadata: WalletPluginMetadata;
    constructor(privateKeys: PrivateKey[], url?: string | undefined);
    login(context: LoginContext): Promise<{
        chain: Checksum256;
        permissionLevel: import("@wharfkit/antelope").PermissionLevel;
    }>;
    sign(resolved: {
        transaction: unknown;
    }, context: TransactContext): Promise<{
        signatures: import("@wharfkit/antelope").Signature[];
    }>;
}
export declare function walletPluginFor(keyOption: string | undefined, actor: string, url?: string): Promise<MultiPrivateKeyWalletPlugin | WalletPluginPrivateKey>;
export {};
