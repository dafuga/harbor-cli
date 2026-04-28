import { Command } from 'commander';
import { PrivateKey } from '@wharfkit/antelope';
import { addWalletKey, listWalletKeys } from '../lib/wallet.js';
export function createWalletCommand() {
    const wallet = new Command('wallet');
    wallet.description('Manage Harbor CLI signing keys');
    wallet
        .command('keys')
        .description('List wallet keys')
        .option('--json', 'print JSON')
        .action(async (options) => {
        const keys = (await listWalletKeys()).map(({ name, publicKey }) => ({ name, publicKey }));
        if (options.json) {
            console.log(JSON.stringify(keys, null, 2));
        }
        else {
            console.table(keys);
        }
    });
    wallet
        .command('keys:add <name> <private-key>')
        .alias('import')
        .description('Add or replace a named private key')
        .option('--json', 'print JSON')
        .action(async (name, privateKey, options) => {
        const key = await addWalletKey(name, privateKey);
        const result = { name: key.name, publicKey: key.publicKey };
        if (options.json) {
            console.log(JSON.stringify(result, null, 2));
        }
        else {
            console.log(`added ${key.name}: ${key.publicKey}`);
        }
    });
    wallet
        .command('keys:create [name]')
        .description('Generate and store a new key')
        .option('--json', 'print JSON')
        .action(async (name = 'default', options) => {
        const privateKey = PrivateKey.generate('K1');
        const key = await addWalletKey(name, privateKey.toString());
        const result = { name: key.name, publicKey: key.publicKey, privateKey: key.privateKey };
        if (options.json) {
            console.log(JSON.stringify(result, null, 2));
        }
        else {
            console.log(`created ${key.name}: ${key.publicKey}`);
        }
    });
    return wallet;
}
