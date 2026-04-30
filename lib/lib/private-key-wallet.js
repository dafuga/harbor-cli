import { Checksum256, PrivateKey, Transaction } from '@wharfkit/antelope';
import { AbstractWalletPlugin, WalletPluginMetadata } from '@wharfkit/session';
import { WalletPluginPrivateKey } from '@wharfkit/wallet-plugin-privatekey';
import { resolvePrivateKey } from './wallet.js';
class MultiPrivateKeyWalletPlugin extends AbstractWalletPlugin {
    privateKeys;
    id = 'harbor-multi-privatekey';
    config = {
        requiresChainSelect: false,
        requiresPermissionSelect: false,
        requiresPermissionEntry: false,
    };
    metadata = WalletPluginMetadata.from({
        name: 'Harbor Private Key Signer',
        description: 'Signs non-interactive Harbor transactions with one or more private keys.',
    });
    constructor(privateKeys) {
        super();
        this.privateKeys = privateKeys;
        if (privateKeys.length === 1) {
            this.metadata.publicKey = String(privateKeys[0].toPublic());
        }
    }
    async login(context) {
        if (!context.permissionLevel) {
            throw new Error('missing permission level for private key login');
        }
        return {
            chain: context.chain ? context.chain.id : context.chains[0].id,
            permissionLevel: context.permissionLevel,
        };
    }
    async sign(resolved, context) {
        const transaction = Transaction.from(resolved.transaction);
        const digest = transaction.signingDigest(Checksum256.from(context.chain.id));
        return {
            signatures: this.privateKeys.map((privateKey) => privateKey.signDigest(digest)),
        };
    }
}
async function resolvePrivateKeys(keyOption, actor) {
    const rawKeys = keyOption ?? process.env.HARBOR_PRIVATE_KEY;
    if (!rawKeys || !rawKeys.includes(',')) {
        return [PrivateKey.from(await resolvePrivateKey(keyOption, actor))];
    }
    return Promise.all(rawKeys.split(',').filter(Boolean).map(async (key) => PrivateKey.from(await resolvePrivateKey(key.trim(), actor))));
}
export async function walletPluginFor(keyOption, actor) {
    const privateKeys = await resolvePrivateKeys(keyOption, actor);
    const walletPlugin = privateKeys.length === 1
        ? new WalletPluginPrivateKey(privateKeys[0])
        : new MultiPrivateKeyWalletPlugin(privateKeys);
    walletPlugin.config.requiresChainSelect = false;
    walletPlugin.config.requiresPermissionSelect = false;
    walletPlugin.config.requiresPermissionEntry = false;
    return walletPlugin;
}
