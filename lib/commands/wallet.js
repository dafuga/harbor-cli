/*
 * Key generation and wallet command layout adapted from greymass/antelope-cli.
 * Copyright (c) Greymass Inc. and antelope-cli contributors.
 * BSD-3-Clause. See NOTICE.
 */
import { Command, Option } from 'commander';
import { readPrivateKeyInput } from '../lib/key-prompt.js';
import { createWalletKey, importWalletKey, listWalletKeys } from '../lib/wallet.js';
function addList(command) {
    command
        .description('List public keys and their storage types')
        .option('--json', 'print JSON')
        .action(async (options) => {
        const keys = await listWalletKeys();
        if (options.json)
            console.log(JSON.stringify(keys, null, 2));
        else
            console.table(keys);
    });
}
function addCreate(command) {
    command
        .description('Generate a key in the Secure Enclave or encrypted keystore')
        .addOption(new Option('--type <type>', 'key type').choices(['R1', 'K1', 'ed25519']).default('R1'))
        .addOption(new Option('--storage <backend>', 'override automatic storage selection').choices(['enclave', 'encrypted']))
        .option('--json', 'print public key metadata as JSON')
        .action(async (name = 'default', options) => {
        const key = await createWalletKey(name, options.type, options.storage);
        console.log(options.json ? JSON.stringify(key, null, 2) : key.publicKey);
    });
}
function addImport(command) {
    command
        .description('Import a key from a hidden terminal prompt into the encrypted keystore')
        .option('--solana', 'read a Solana JSON seed or keypair')
        .option('--json', 'print public key metadata as JSON')
        .action(async (name, options) => {
        const input = await readPrivateKeyInput();
        try {
            const key = await importWalletKey(name, input, Boolean(options.solana));
            console.log(options.json ? JSON.stringify(key, null, 2) : key.publicKey);
        }
        finally {
            input.fill(0);
        }
    });
}
export function createKeysCommand() {
    const keys = new Command('keys').description('Manage secure signing keys');
    addList(keys.command('list'));
    addCreate(keys.command('create [name]'));
    addImport(keys.command('import <name>'));
    return keys;
}
export function createWalletCommand() {
    const wallet = new Command('wallet').description('Manage Harbor CLI signing keys');
    addList(wallet.command('keys'));
    const create = wallet.command('keys:create [name]');
    addCreate(create);
    create.setOptionValue('type', 'K1');
    addImport(wallet.command('keys:add <name>').alias('import'));
    return wallet;
}
