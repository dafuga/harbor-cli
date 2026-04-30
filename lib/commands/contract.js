import { Command } from 'commander';
import { addTxOptions } from './action.js';
import { deployContract } from '../lib/deploy.js';
import { printResult } from '../lib/tx.js';
export function createContractCommand() {
    const contract = new Command('contract');
    contract.description('Deploy and validate contracts');
    addTxOptions(contract
        .command('deploy')
        .requiredOption('--account <account>', 'contract account')
        .requiredOption('--wasm <path>', 'WASM file')
        .requiredOption('--abi <path>', 'ABI file')
        .option('--validate', 'only validate ABI/table safety')).action(async (options) => {
        const result = await deployContract({
            account: options.account,
            wasm: options.wasm,
            abi: options.abi,
            validate: options.validate,
            url: options.url,
            actor: options.actor ?? options.account,
            permission: options.permission,
            key: options.key,
            json: options.json,
            expiration: options.expiration,
        });
        printResult(result, options.json);
    });
    return contract;
}
