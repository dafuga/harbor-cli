import { Command } from 'commander';
interface SystemUiDefinition {
    dapp: string;
    title: string;
    surface: string;
    route: string;
}
export declare const SYSTEM_UIS: SystemUiDefinition[];
export declare function systemUiActionData(ui: SystemUiDefinition): Record<string, unknown>;
export declare function createSitesCommand(): Command;
export declare function createChatCommand(): Command;
export declare function createDappsCommand(): Command;
export declare function createAuditCommand(): Command;
export declare function createPowerupCommand(): Command;
export declare function createGovCommand(): Command;
export declare function createProjectsCommand(): Command;
export declare function createIbcCommand(): Command;
export {};
