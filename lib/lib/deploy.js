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
export async function deployContract(options) {
    const wasm = await fs.readFile(options.wasm);
    const abiJson = JSON.parse(await fs.readFile(options.abi, 'utf8'));
    if (options.validate) {
        await validateTables(options, abiJson);
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
