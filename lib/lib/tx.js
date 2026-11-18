import { ABI, APIClient, Action, FetchProvider, SignedTransaction } from '@wharfkit/antelope';
import { Session } from '@wharfkit/session';
import { walletPluginFor } from './private-key-wallet.js';
import { HarborTerminalUI } from './terminal-ui.js';
const abiCache = new Map();
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
export async function getAbi(account, url) {
    const endpoint = apiUrl(url);
    const key = JSON.stringify([endpoint, account]);
    let request = abiCache.get(key);
    if (!request) {
        request = clientFor(endpoint).v1.chain.get_abi(account).then(({ abi }) => {
            if (!abi)
                throw new Error(`unable to retrieve account ABI: ${account}`);
            return ABI.from(abi);
        });
        abiCache.set(key, request);
        void request.catch(() => abiCache.delete(key));
    }
    return request;
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
    const abi = await getAbi(input.contract, input.url);
    const auth = input.authorization ? parseAuthorizations(input.authorization) : [permissionLevel(input)];
    const data = Array.isArray(input.data) ? actionDataFromArray(abi, input.action, input.data) : input.data;
    return Action.from({
        account: input.contract,
        name: input.action,
        authorization: auth,
        data: data,
    }, abi);
}
export function summarizeAntelopeTransaction({ expiration, actions }) {
    return {
        expiry_utc: String(expiration),
        actions: actions.map(({ account, name, authorization, data }) => ({
            action: `${account}::${name}`, authorization: authorization.map(String), data,
        })),
    };
}
export async function transactActions(options, actions, review) {
    const { result } = await signAndTransact(options, actions, true, review);
    const response = result.response;
    return {
        transaction_id: response?.transaction_id ?? result.resolved?.transaction.id?.toString(),
        status: response?.processed?.receipt?.status,
        response,
    };
}
async function signAndTransact(options, actions, broadcast, review) {
    const url = apiUrl(options.url);
    const client = clientFor(url);
    const info = await client.v1.chain.get_info();
    if (options.expectChainId !== undefined) {
        if (!/^[0-9a-fA-F]{64}$/.test(options.expectChainId)) {
            throw new Error('expected chain ID must be a 64-digit hexadecimal string');
        }
        if (String(info.chain_id) !== options.expectChainId.toLowerCase()) {
            throw new Error('RPC endpoint does not match the expected chain ID');
        }
    }
    const auth = permissionLevel(options);
    const walletPlugin = await walletPluginFor(options.key, auth.actor, url, review);
    const session = new Session({
        chain: { id: info.chain_id, url },
        actor: auth.actor,
        permission: auth.permission,
        walletPlugin,
    }, {
        ui: new HarborTerminalUI(),
    });
    const result = await session.transact({ actions: actions }, { broadcast, expireSeconds: Number(options.expiration ?? 300) });
    return { result, chainId: info.chain_id };
}
export async function signAction(input, review) {
    const action = await serializeAction(input);
    const { chainId, result } = await signAndTransact(input, [action], false, review);
    if (!result.resolved)
        throw new Error('unable to resolve the action transaction');
    const transaction = SignedTransaction.from({ ...result.resolved.transaction, signatures: result.signatures });
    return { chain_id: chainId, transaction };
}
export async function pushAction(input, review) {
    const action = await serializeAction(input);
    return transactActions(input, [action], review);
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
    if (options.indexPosition !== undefined) {
        request.index_position = options.indexPosition;
    }
    if (options.keyType !== undefined) {
        request.key_type = options.keyType;
    }
    return client.v1.chain.get_table_rows(request);
}
const UINT64_MAX = (1n << 64n) - 1n;
export function canonicalUint64(value, label = 'uint64') {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error(`${label} must be an unsigned 64-bit integer`);
        }
        value = String(value);
    }
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        throw new Error(`${label} must be an unsigned 64-bit integer`);
    }
    const parsed = BigInt(value);
    if (parsed > UINT64_MAX) {
        throw new Error(`${label} exceeds uint64`);
    }
    return parsed.toString();
}
export function displayUint64(value, label = 'uint64') {
    const canonical = canonicalUint64(value, label);
    const parsed = BigInt(canonical);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : canonical;
}
export async function getAllTableRows(contract, table, options = {}) {
    const rows = [];
    let lowerBound = options.lowerBound;
    const cursors = new Set();
    for (let page = 0; page < 10_000; page += 1) {
        const result = await getTableRows(contract, table, { ...options, lowerBound });
        rows.push(...result.rows);
        if (!result.more)
            return rows;
        const cursor = result.next_key ?? (typeof result.more === 'string' ? result.more : undefined);
        if (!cursor || cursors.has(cursor) || cursor === lowerBound) {
            throw new Error(`unable to paginate ${contract}::${table}: invalid next_key`);
        }
        cursors.add(cursor);
        lowerBound = cursor;
    }
    throw new Error(`unable to paginate ${contract}::${table}: page limit exceeded`);
}
export async function readContractNextId(contract, field, options = {}) {
    const result = await getTableRows(contract, 'params', {
        url: options.url,
        scope: contract,
        limit: 2,
    });
    // eosio::singleton stores its only row under the table-name value, not
    // under an `id` member serialized inside the payload. A [0, 1) primary-key
    // bound therefore hides singleton-backed params tables even when their
    // decoded value contains `id: 0`. Reading the unbounded table also remains
    // compatible with legacy one-row multi_index params tables.
    const matches = result.rows.filter((candidate) => Object.prototype.hasOwnProperty.call(candidate, field));
    if (matches.length !== 1) {
        throw new Error(`${contract} params do not expose ${field}`);
    }
    return canonicalUint64(matches[0][field], `${contract} ${field}`);
}
function actionTraces(result) {
    if (!result || typeof result !== 'object')
        return [];
    const root = result;
    const response = root.response && typeof root.response === 'object'
        ? root.response
        : root;
    const processed = response.processed && typeof response.processed === 'object'
        ? response.processed
        : response;
    return Array.isArray(processed.action_traces)
        ? processed.action_traces.filter((trace) => Boolean(trace) && typeof trace === 'object')
        : [];
}
/** Best-effort extraction for contracts that expose a uint64 action return value. */
export function actionUint64Return(result, contract, action) {
    for (const trace of actionTraces(result)) {
        const act = trace.act && typeof trace.act === 'object' ? trace.act : undefined;
        if (!act || String(act.account) !== contract || String(act.name) !== action)
            continue;
        for (const field of ['return_value_data', 'return_value']) {
            const value = trace[field];
            if ((typeof value === 'string' && /^\d+$/.test(value)) || typeof value === 'number') {
                return canonicalUint64(value, `${contract}::${action} return value`);
            }
        }
        for (const field of ['return_value_hex_data', 'return_value_hex']) {
            const value = trace[field];
            if (typeof value === 'string' && /^[0-9a-fA-F]{16}$/.test(value)) {
                const bytes = Buffer.from(value, 'hex');
                return bytes.readBigUInt64LE().toString();
            }
        }
    }
    return undefined;
}
