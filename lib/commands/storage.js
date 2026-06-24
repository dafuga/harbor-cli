import { Command } from 'commander';
import { defaultStorageDir } from '../lib/config.js';
import { buildStorageManifest, distributeStoredObject, downloadStoredObject, putReplicatedObject, putWalrusObject, serveStorageManifest, storeObject } from '../lib/storage.js';
import { addTxOptions } from './action.js';
import { addJsonActionCommand } from './action-fields.js';
const STORAGE_CONTRACT = process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore';
function addLocalStorageCommands(storage) {
    addTxOptions(storage
        .command('put <file>')
        .description('Register a Harbor storage object and distribute it through the best active router')
        .requiredOption('--owner <account>', 'Harbor account that owns the storage object')
        .option('--backend <backend>', 'storage backend: harbor or walrus', 'harbor')
        .option('--metadata <metadata>', 'object metadata to register on-chain')
        .option('--encrypt', 'encrypt the stored bytes with a key derived from --private-key')
        .option('--private-key <key>', 'private key material used for local encryption')
        .option('--market-contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
        .option('--storage-contract <account>', 'storage registry contract account', STORAGE_CONTRACT)
        .option('--router-url <url>', 'explicit router endpoint; skips market router discovery')
        .option('--walrus-command <path>', 'Walrus CLI command', process.env.WALRUS_CLI ?? 'walrus')
        .option('--walrus-publisher-url <url>', 'Walrus publisher URL')
        .option('--walrus-aggregator-url <url>', 'Walrus aggregator URL to preserve in metadata')
        .option('--walrus-epochs <epochs>', 'Walrus storage epochs')
        .option('--content-format <format>', 'content format preserved in Walrus metadata')).action(async (file, options) => {
        if (options.backend === 'walrus') {
            console.log(JSON.stringify(await putWalrusObject({ ...options, file }), null, 2));
            return;
        }
        if (options.backend && options.backend !== 'harbor') {
            throw new Error(`unknown storage backend: ${options.backend}`);
        }
        console.log(JSON.stringify(await putReplicatedObject({ ...options, file }), null, 2));
    });
    storage
        .command('put-local <file>')
        .description('Store a file in a local provider storage root without chain registration or router distribution')
        .option('--root <path>', 'storage root', defaultStorageDir())
        .option('--encrypt', 'encrypt the stored bytes with a key derived from --private-key')
        .option('--private-key <key>', 'private key material used for local encryption')
        .option('--metadata <metadata>', 'object metadata to register on-chain')
        .action(async (file, options) => {
        console.log(JSON.stringify(await storeObject({
            root: options.root,
            file,
            encrypt: options.encrypt,
            privateKey: options.privateKey,
            metadata: options.metadata,
        }), null, 2));
    });
    addTxOptions(storage
        .command('distribute <file>')
        .description('Retry router distribution for an already registered storage object')
        .requiredOption('--owner <account>', 'Harbor account that owns the storage object')
        .requiredOption('--object-id <id>', 'harborstore object id')
        .requiredOption('--content-hash <hash>', 'registered content hash')
        .option('--encrypt', 'encrypt the stored bytes with a key derived from --private-key')
        .option('--private-key <key>', 'private key material used for local encryption')
        .option('--market-contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
        .option('--router-url <url>', 'explicit router endpoint; skips market router discovery')).action(async (file, options) => {
        console.log(JSON.stringify(await distributeStoredObject({
            ...options,
            file,
            objectId: Number(options.objectId),
            contentHash: options.contentHash,
        }), null, 2));
    });
    storage
        .command('get')
        .description('Download a Harbor storage object from active replicas')
        .requiredOption('--content-hash <hash>', 'content hash to download')
        .requiredOption('-o, --output <path>', 'output path')
        .option('--expected-sha256 <hash>', 'expected SHA-256 checksum; defaults to content hash')
        .option('--market-contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
        .option('--storage-contract <account>', 'storage registry contract account', STORAGE_CONTRACT)
        .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
        .action(async (options) => {
        console.log(JSON.stringify(await downloadStoredObject({
            contentHash: options.contentHash,
            output: options.output,
            expectedSha256: options.expectedSha256 ?? options.contentHash,
            marketContract: options.marketContract,
            storageContract: options.storageContract,
            url: options.url,
        }), null, 2));
    });
    storage
        .command('manifest')
        .description('Print a storage manifest')
        .option('--root <path>', 'storage root', defaultStorageDir())
        .action(async (options) => {
        console.log(JSON.stringify(await buildStorageManifest(options.root), null, 2));
    });
    storage
        .command('serve')
        .description('Serve /health, /manifest, and /files/* from a storage root')
        .option('--root <path>', 'storage root', defaultStorageDir())
        .option('--port <port>', 'listen port', '9090')
        .action((options) => {
        const port = Number(options.port);
        serveStorageManifest(options.root, port);
        console.log(`Harbor storage manifest server listening on http://127.0.0.1:${port}`);
    });
}
function addStorageAction(storage, spec) {
    addJsonActionCommand(storage, STORAGE_CONTRACT, spec);
}
function addStorageContractCommands(storage) {
    addStorageAction(storage, { command: 'configure', action: 'setparams', fields: [['required_replicas', 'number'], ['max_metadata_size', 'number']] });
    addStorageAction(storage, { command: 'set-market', action: 'setmarket', fields: ['svcmarket_contract'] });
    addStorageAction(storage, {
        command: 'put-object',
        action: 'putobject',
        fields: ['owner', 'content_hash', ['bytes', 'number'], ['encrypted', 'boolean'], 'encryption_key_hash', 'metadata'],
        signerField: 'owner',
    });
    addStorageAction(storage, { command: 'assign', action: 'assign', fields: [['object_id', 'number'], ['providers', 'json']] });
    addStorageAction(storage, { command: 'route-assign', action: 'routeassign', fields: ['router', ['object_id', 'number'], ['providers', 'json']], signerField: 'router' });
    addStorageAction(storage, { command: 'offline-replica', action: 'offreplica', fields: [['replica_id', 'number']] });
    addStorageAction(storage, { command: 'reassign', action: 'reassign', fields: [['replica_id', 'number'], 'new_provider'] });
    addStorageAction(storage, { command: 'report', action: 'report', fields: [['object_id', 'number'], 'verifier', ['healthy', 'boolean'], 'report_hash'], signerField: 'verifier' });
}
export function createStorageCommand() {
    const storage = new Command('storage');
    storage.description('Serve and inspect Harbor storage manifests');
    addLocalStorageCommands(storage);
    addStorageContractCommands(storage);
    return storage;
}
