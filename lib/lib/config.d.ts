export interface HarborAgentServiceConfig {
    enabled: boolean;
    port?: number;
    command?: string;
    args?: string[];
    workingDirectory?: string;
}
export interface HarborAgentConfig {
    account: string;
    apiUrl: string;
    marketContract: string;
    storageDir: string;
    services: {
        blockProducer: HarborAgentServiceConfig;
        chainApi: HarborAgentServiceConfig;
        traceApi: HarborAgentServiceConfig;
        historyCore: HarborAgentServiceConfig;
        historyActions: HarborAgentServiceConfig;
        historyTx: HarborAgentServiceConfig;
        historyApi: HarborAgentServiceConfig;
        historyStream: HarborAgentServiceConfig;
        storageManifest: HarborAgentServiceConfig;
    };
}
export declare function harborHome(): string;
export declare function defaultConfigPath(): string;
export declare function defaultStorageDir(): string;
export declare function createDefaultConfig(account: string): HarborAgentConfig;
export declare function ensureHarborDirs(config: HarborAgentConfig): Promise<void>;
export declare function loadConfig(configPath?: string): Promise<HarborAgentConfig>;
export declare function saveConfig(config: HarborAgentConfig, configPath?: string): Promise<void>;
