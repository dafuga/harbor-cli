import fs from 'node:fs/promises';
import { ABI, APIClient, Action, Checksum256, FetchProvider, PrivateKey, Serializer, Transaction } from '@wharfkit/antelope';
import { AbstractWalletPlugin, Session, WalletPluginMetadata } from '@wharfkit/session';
import { WalletPluginPrivateKey } from '@wharfkit/wallet-plugin-privatekey';
import { HarborTerminalUI } from './terminal-ui.js';
import { resolvePrivateKey } from './wallet.js';
const abiCache = new Map();
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
export function apiUrl(url) {
    return url ?? process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888';
}
export function permissionLevel(options, fallbackActor) {
    const actor = options.actor ?? fallbackActor ?? process.env.HARBOR_ACTOR;
    if (!actor) {
        throw new Error('missing signer actor; pass --actor or set HARBOR_ACTOR');
    }
    return { actor, permission: options.permission ?? process.env.HARBOR_PERMISSION ?? 'active' };
}
export function parseAuthorization(auth) {
    const [actor, permission = 'active'] = auth.split('@');
    if (!actor) {
        throw new Error(`invalid authorization: ${auth}`);
    }
    return { actor, permission };
}
export function parseAuthorizations(auth) {
    return auth.split(',').map((item) => parseAuthorization(item.trim()));
}
export function parseJson(value) {
    try {
        return JSON.parse(value);
    }
    catch (error) {
        throw new Error(`invalid JSON: ${error.message}`);
    }
}
export function printResult(result, json) {
    if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    if (typeof result === 'object' && result && 'transaction_id' in result) {
        const tx = result;
        console.log(`transaction_id: ${tx.transaction_id}`);
        if (tx.status) {
            console.log(`status: ${tx.status}`);
        }
        return;
    }
    console.log(JSON.stringify(result, null, 2));
}
export function clientFor(url) {
    return new APIClient({ provider: new FetchProvider(apiUrl(url), { fetch: globalThis.fetch }) });
}
async function getAbi(client, account) {
    const cached = abiCache.get(account);
    if (cached) {
        return cached;
    }
    const response = await client.v1.chain.get_abi(account);
    if (!response.abi) {
        throw new Error(`unable to retrieve account abi: ${account}`);
    }
    const abi = ABI.from(response.abi);
    abiCache.set(account, abi);
    return abi;
}
function actionDataFromArray(abi, actionName, data) {
    const action = abi.actions.find((item) => String(item.name) === actionName);
    if (!action) {
        throw new Error(`action ${actionName} not found in ABI`);
    }
    const struct = abi.structs.find((item) => String(item.name) === String(action.type));
    if (!struct) {
        throw new Error(`action struct ${action.type} not found in ABI`);
    }
    if (data.length !== struct.fields.length) {
        throw new Error(`action ${actionName} expects ${struct.fields.length} fields, got ${data.length}`);
    }
    return Object.fromEntries(struct.fields.map((field, index) => [String(field.name), data[index]]));
}
export async function serializeAction(input) {
    const client = clientFor(input.url);
    const abi = await getAbi(client, input.contract);
    const auth = input.authorization ? parseAuthorizations(input.authorization) : [permissionLevel(input)];
    const data = Array.isArray(input.data) ? actionDataFromArray(abi, input.action, input.data) : input.data;
    return Action.from({
        account: input.contract,
        name: input.action,
        authorization: auth,
        data: data,
    }, abi);
}
async function resolvePrivateKeys(keyOption, actor) {
    const rawKeys = keyOption ?? process.env.HARBOR_PRIVATE_KEY;
    if (!rawKeys || !rawKeys.includes(',')) {
        return [PrivateKey.from(await resolvePrivateKey(keyOption, actor))];
    }
    return Promise.all(rawKeys.split(',').filter(Boolean).map(async (key) => PrivateKey.from(await resolvePrivateKey(key.trim(), actor))));
}
export async function transactActions(options, actions) {
    const url = apiUrl(options.url);
    const client = clientFor(url);
    const info = await client.v1.chain.get_info();
    const auth = permissionLevel(options);
    const privateKeys = await resolvePrivateKeys(options.key, auth.actor);
    const walletPlugin = privateKeys.length === 1
        ? new WalletPluginPrivateKey(privateKeys[0])
        : new MultiPrivateKeyWalletPlugin(privateKeys);
    walletPlugin.config.requiresChainSelect = false;
    walletPlugin.config.requiresPermissionSelect = false;
    walletPlugin.config.requiresPermissionEntry = false;
    const session = new Session({
        chain: { id: info.chain_id, url },
        actor: auth.actor,
        permission: auth.permission,
        walletPlugin,
    }, {
        ui: new HarborTerminalUI(),
    });
    const result = await session.transact({ actions: actions }, { broadcast: true, expireSeconds: Number(options.expiration ?? 300) });
    const response = result.response;
    return {
        transaction_id: response?.transaction_id ?? result.resolved?.transaction.id?.toString(),
        status: response?.processed?.receipt?.status,
        response,
    };
}
export async function pushAction(input) {
    const action = await serializeAction(input);
    return transactActions(input, [action]);
}
export async function getTableRows(contract, table, options = {}) {
    const client = clientFor(options.url);
    const request = {
        json: true,
        code: contract,
        scope: options.scope ?? contract,
        table,
        limit: options.limit ?? 100,
    };
    if (options.lowerBound !== undefined) {
        request.lower_bound = options.lowerBound;
    }
    if (options.upperBound !== undefined) {
        request.upper_bound = options.upperBound;
    }
    return client.v1.chain.get_table_rows(request);
}
export async function deployContract(options) {
    const client = clientFor(options.url);
    const wasm = await fs.readFile(options.wasm);
    const abiJson = JSON.parse(await fs.readFile(options.abi, 'utf8'));
    if (options.validate) {
        try {
            const existing = await client.v1.chain.get_abi(options.account);
            if (existing.abi) {
                const oldTables = new Set(existing.abi.tables.map((table) => String(table.name)));
                const newTables = new Set(ABI.from(abiJson).tables.map((table) => String(table.name)));
                const removed = [...oldTables].filter((table) => !newTables.has(table));
                if (removed.length) {
                    throw new Error(`deployment removes ABI tables: ${removed.join(', ')}`);
                }
            }
        }
        catch (error) {
            if (error.message.includes('deployment removes')) {
                throw error;
            }
        }
    }
    const actions = [
        {
            account: 'eosio',
            name: 'setcode',
            authorization: [permissionLevel(options, options.account)],
            data: { account: options.account, vmtype: 0, vmversion: 0, code: wasm.toString('hex') },
        },
        {
            account: 'eosio',
            name: 'setabi',
            authorization: [permissionLevel(options, options.account)],
            data: { account: options.account, abi: Serializer.encode({ object: ABI.from(abiJson), type: ABI }).hexString },
        },
    ];
    return transactActions({ ...options, actor: options.actor ?? options.account }, actions);
}
