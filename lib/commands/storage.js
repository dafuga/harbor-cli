import { Command } from 'commander';
import { defaultStorageDir } from '../lib/config.js';
import { buildStorageManifest, serveStorageManifest, storeObject } from '../lib/storage.js';
import { addJsonActionCommand } from './action-fields.js';
const STORAGE_CONTRACT = process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore';
function addLocalStorageCommands(storage) {
    storage
        .command('put <file>')
        .description('Store a file for Harbor storage replication')
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
    addStorageAction(storage, {
        command: 'put-object',
        action: 'putobject',
        fields: ['owner', 'content_hash', ['bytes', 'number'], ['encrypted', 'boolean'], 'encryption_key_hash', 'metadata'],
        signerField: 'owner',
    });
    addStorageAction(storage, { command: 'assign', action: 'assign', fields: [['object_id', 'number'], ['providers', 'json']] });
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
