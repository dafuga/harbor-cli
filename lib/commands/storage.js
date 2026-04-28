import { Command } from 'commander';
import { defaultStorageDir } from '../lib/config.js';
import { buildStorageManifest, serveStorageManifest, storeObject } from '../lib/storage.js';
import { addTxOptions, pushJsonAction } from './action.js';
function fieldName(field) {
    return Array.isArray(field) ? field[0] : field;
}
function fieldType(field) {
    return Array.isArray(field) ? field[1] : 'string';
}
function parseField(value, type) {
    if (type === 'number') {
        return Number(value);
    }
    if (type === 'boolean') {
        return value === 'true' || value === '1';
    }
    if (type === 'json') {
        return JSON.parse(value);
    }
    return value;
}
function actionOptions(args) {
    const last = args.at(-1);
    if (last && typeof last.optsWithGlobals === 'function') {
        return last.optsWithGlobals();
    }
    if (last && typeof last.opts === 'function') {
        return last.opts();
    }
    return last;
}
function addStorageAction(root, commandName, action, fields, signerField) {
    let cmd = root.command(commandName);
    cmd.description(`Push ${action}`);
    for (const field of fields) {
        cmd = cmd.argument(`<${fieldName(field)}>`);
    }
    cmd.option('-c, --contract <account>', 'storage contract account', process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore');
    addTxOptions(cmd).action(async (...args) => {
        const options = actionOptions(args);
        const values = args.slice(0, -1);
        const data = Object.fromEntries(fields.map((field, index) => [fieldName(field), parseField(values[index], fieldType(field))]));
        const signer = signerField ? String(data[signerField]) : undefined;
        await pushJsonAction(String(options.contract), action, data, { ...options, actor: String(options.actor ?? signer) });
    });
}
export function createStorageCommand() {
    const storage = new Command('storage');
    storage.description('Serve and inspect Harbor storage manifests');
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
    addStorageAction(storage, 'configure', 'setparams', [['required_replicas', 'number'], ['max_metadata_size', 'number']]);
    addStorageAction(storage, 'put-object', 'putobject', [
        'owner',
        'content_hash',
        ['bytes', 'number'],
        ['encrypted', 'boolean'],
        'encryption_key_hash',
        'metadata',
    ], 'owner');
    addStorageAction(storage, 'assign', 'assign', [['object_id', 'number'], ['providers', 'json']]);
    addStorageAction(storage, 'offline-replica', 'offreplica', [['replica_id', 'number']]);
    addStorageAction(storage, 'reassign', 'reassign', [['replica_id', 'number'], 'new_provider']);
    addStorageAction(storage, 'report', 'report', [['object_id', 'number'], 'verifier', ['healthy', 'boolean'], 'report_hash'], 'verifier');
    return storage;
}
