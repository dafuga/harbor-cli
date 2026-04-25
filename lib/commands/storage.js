import { Command } from 'commander';
import { defaultStorageDir } from '../lib/config.js';
import { buildStorageManifest, serveStorageManifest } from '../lib/storage.js';
export function createStorageCommand() {
    const storage = new Command('storage');
    storage.description('Serve and inspect Harbor storage manifests');
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
    return storage;
}
