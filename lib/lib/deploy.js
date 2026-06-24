import fs from 'node:fs/promises';
import { ABI, Serializer } from '@wharfkit/antelope';
import { clientFor, permissionLevel, transactActions } from './tx.js';
async function validateTables(options, abiJson) {
    const client = clientFor(options.url);
    try {
        const existing = await client.v1.chain.get_abi(options.account);
        if (!existing.abi) {
            return;
        }
        const oldTables = new Set(existing.abi.tables.map((table) => String(table.name)));
        const newTables = new Set(ABI.from(abiJson).tables.map((table) => String(table.name)));
        const removed = [...oldTables].filter((table) => !newTables.has(table));
        if (removed.length) {
            throw new Error(`deployment removes ABI tables: ${removed.join(', ')}`);
        }
    }
    catch (error) {
        if (error.message.includes('deployment removes')) {
            throw error;
        }
    }
}
export function publicKeyAuthority(key) {
    return { threshold: 1, keys: [{ key, weight: 1 }], accounts: [], waits: [] };
}
export function createContractAccountActions(options) {
    const auth = [permissionLevel({ actor: options.creator, permission: options.permission })];
    const actions = [{
            account: 'eosio',
            name: 'newaccount',
            authorization: auth,
            data: {
                creator: options.creator,
                name: options.account,
                owner: publicKeyAuthority(options.ownerKey),
                active: publicKeyAuthority(options.activeKey),
            },
        }];
    if (options.ramBytes > 0) {
        actions.push({
            account: 'eosio',
            name: 'buyrambytes',
            authorization: auth,
            data: { payer: options.creator, receiver: options.account, bytes: options.ramBytes },
        });
    }
    if (options.stakeNet && options.stakeCpu) {
        actions.push({
            account: 'eosio',
            name: 'delegatebw',
            authorization: auth,
            data: {
                from: options.creator,
                receiver: options.account,
                stake_net_quantity: options.stakeNet,
                stake_cpu_quantity: options.stakeCpu,
                transfer: false,
            },
        });
    }
    return actions;
}
export async function createContractAccount(options) {
    return transactActions({ ...options, actor: options.creator }, createContractAccountActions(options));
}
export async function accountExists(url, account) {
    try {
        await clientFor(url).v1.chain.get_account(account);
        return true;
    }
    catch {
        return false;
    }
}
export function deployContractActions(options) {
    return [
        {
            account: 'eosio',
            name: 'setcode',
            authorization: [permissionLevel({ actor: options.account, permission: options.permission })],
            data: { account: options.account, vmtype: 0, vmversion: 0, code: options.wasmBytes.toString('hex') },
        },
        {
            account: 'eosio',
            name: 'setabi',
            authorization: [permissionLevel({ actor: options.account, permission: options.permission })],
            data: { account: options.account, abi: Serializer.encode({ object: ABI.from(options.abiJson), type: ABI }).hexString },
        },
    ];
}
export async function deployContractBytes(options) {
    if (options.validate) {
        await validateTables(options, options.abiJson);
    }
    return transactActions({ ...options, actor: options.account }, deployContractActions({
        account: options.account,
        wasmBytes: options.wasmBytes,
        abiJson: options.abiJson,
        permission: options.permission,
    }));
}
export async function deployContract(options) {
    const wasmBytes = await fs.readFile(options.wasm);
    const abiJson = JSON.parse(await fs.readFile(options.abi, 'utf8'));
    return deployContractBytes({ ...options, wasmBytes, abiJson });
}
