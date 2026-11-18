/*
 * Contract deployment flow adapted from greymass/antelope-cli.
 * Copyright (c) Greymass Inc. and antelope-cli contributors.
 * BSD-3-Clause. See NOTICE.
 */
import { Command } from 'commander';
import { addTxOptions } from './action.js';
import { deployContract } from '../lib/deploy.js';
import { parseJsonOption, placeContractManifest, uploadContractManifest } from '../lib/contract-placement.js';
import { printResult } from '../lib/tx.js';
function printContractResult(result, json) {
    if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    const record = result;
    if (typeof record.manifest_hash === 'string') {
        console.log(`manifest_hash: ${record.manifest_hash}`);
    }
    if (typeof record.selected_chain_uid === 'string') {
        console.log(`selected_chain_uid: ${record.selected_chain_uid}`);
    }
    if (typeof record.endpoint === 'string') {
        console.log(`endpoint: ${record.endpoint}`);
    }
    if (typeof record.deploy_tx === 'string') {
        console.log(`deploy_tx: ${record.deploy_tx}`);
    }
    if (typeof record.registry_tx === 'string') {
        console.log(`registry_tx: ${record.registry_tx}`);
    }
}
export function createContractCommand() {
    const contract = new Command('contract');
    contract.description('Deploy and validate contracts');
    addTxOptions(contract
        .command('deploy')
        .requiredOption('--account <account>', 'contract account')
        .requiredOption('--wasm <path>', 'WASM file')
        .requiredOption('--abi <path>', 'ABI file')
        .option('--validate', 'check ABI/table safety before signing and deploying')).action(async (options) => {
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
    addTxOptions(contract
        .command('upload')
        .description('Upload a contract WASM/ABI bundle as a Harbor contract manifest')
        .requiredOption('--account <account>', 'contract account')
        .requiredOption('--owner <account>', 'dApp owner account')
        .requiredOption('--title <title>', 'dApp title')
        .requiredOption('--wasm <path>', 'WASM file')
        .requiredOption('--abi <path>', 'ABI file')
        .option('--metadata <json>', 'contract metadata JSON object', '{}')
        .option('--dependencies <json>', 'contract dependency JSON array', '[]')
        .option('--market-contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
        .option('--storage-contract <account>', 'storage registry contract account', process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore')
        .option('--router-url <url>', 'explicit router endpoint; skips market router discovery')).action(async (options) => {
        const result = await uploadContractManifest({
            account: options.account,
            owner: options.owner,
            title: options.title,
            wasm: options.wasm,
            abi: options.abi,
            metadata: parseJsonOption(options.metadata, {}),
            dependencies: parseJsonOption(options.dependencies, []),
            marketContract: options.marketContract,
            storageContract: options.storageContract,
            routerUrl: options.routerUrl,
            url: options.url,
            actor: options.actor ?? options.owner,
            permission: options.permission,
            key: options.key,
            json: options.json,
            expiration: options.expiration,
        });
        printContractResult(result, options.json);
    });
    addTxOptions(contract
        .command('place')
        .description('Deploy an uploaded contract manifest to the cheapest eligible sidechain')
        .requiredOption('--manifest-hash <hash>', 'Harbor contract manifest content hash')
        .option('--market-contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
        .option('--storage-contract <account>', 'storage registry contract account', process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore')
        .option('--dapp-contract <account>', 'dApp registry contract account', process.env.HARBOR_DAPP_CONTRACT ?? 'dappreg')
        .option('--creator <account>', 'sidechain account creator', 'eosio')
        .option('--owner-key <key>', 'owner public key for auto-created contract account')
        .option('--active-key <key>', 'active public key for auto-created contract account')
        .option('--ram-bytes <bytes>', 'RAM bytes to buy when auto-creating the contract account')
        .option('--stake-net <quantity>', 'NET stake quantity when auto-creating the contract account')
        .option('--stake-cpu <quantity>', 'CPU stake quantity when auto-creating the contract account')
        .option('--target-chain <chain_uid>', 'explicit sidechain target; must match dependency-pinned chain')
        .option('--validate', 'validate ABI/table safety before deployment')).action(async (options) => {
        const result = await placeContractManifest({
            manifestHash: options.manifestHash,
            marketContract: options.marketContract,
            storageContract: options.storageContract,
            dappContract: options.dappContract,
            creator: options.creator,
            ownerKey: options.ownerKey,
            activeKey: options.activeKey,
            ramBytes: options.ramBytes === undefined ? undefined : Number(options.ramBytes),
            stakeNet: options.stakeNet,
            stakeCpu: options.stakeCpu,
            targetChain: options.targetChain,
            validate: options.validate,
            url: options.url,
            permission: options.permission,
            key: options.key,
            json: options.json,
            expiration: options.expiration,
        });
        printContractResult(result, options.json);
    });
    return contract;
}
