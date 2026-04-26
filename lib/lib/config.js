import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export function harborHome() {
    return process.env.HARBOR_HOME ?? path.join(os.homedir(), '.harbor');
}
export function defaultConfigPath() {
    return path.join(harborHome(), 'config.json');
}
export function defaultStorageDir() {
    return path.join(harborHome(), 'storage');
}
export function createDefaultConfig(account) {
    return {
        account,
        apiUrl: process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888',
        marketContract: process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket',
        storageDir: defaultStorageDir(),
        services: {
            blockProducer: { enabled: false, command: 'nodeos' },
            chainApi: { enabled: true, port: 8888, command: 'nodeos' },
            traceApi: { enabled: false, port: 8889, command: 'nodeos' },
            roboCore: { enabled: false },
            roboActions: { enabled: false, port: 8081 },
            roboTx: { enabled: false, port: 8082 },
            roboApi: { enabled: false, port: 8080 },
            roboStream: { enabled: false, port: 8083 },
            storageManifest: { enabled: true, port: 9090 },
        },
    };
}
export async function ensureHarborDirs(config) {
    await fs.mkdir(harborHome(), { recursive: true });
    await fs.mkdir(config.storageDir, { recursive: true });
    await fs.mkdir(path.join(harborHome(), 'logs'), { recursive: true });
    await fs.mkdir(path.join(harborHome(), 'launchd'), { recursive: true });
}
export async function loadConfig(configPath = defaultConfigPath()) {
    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw);
    const legacyServices = config.services;
    config.services.blockProducer ??= { enabled: false, command: 'nodeos' };
    config.services.traceApi ??= { enabled: false, port: 8889, command: 'nodeos' };
    config.services.roboCore ??= { enabled: false };
    config.services.roboActions ??= { enabled: false, port: 8081 };
    config.services.roboTx ??= { enabled: false, port: 8082 };
    config.services.roboApi ??= legacyServices.roboHistory ?? { enabled: false, port: 8080 };
    config.services.roboStream ??= { enabled: false, port: 8083 };
    return config;
}
export async function saveConfig(config, configPath = defaultConfigPath()) {
    await ensureHarborDirs(config);
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
