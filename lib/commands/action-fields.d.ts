import { Command } from 'commander';
export type FieldType = 'string' | 'number' | 'boolean' | 'json';
export type Field = string | [string, FieldType];
export interface JsonActionSpec {
    command: string;
    action: string;
    fields: Field[];
    signerField?: string;
}
export declare function fieldName(field: Field): string;
export declare function buildActionData(fields: Field[], values: string[]): Record<string, unknown>;
export declare function actionOptions(args: unknown[]): Record<string, string | boolean | undefined>;
export declare function addJsonActionCommand(root: Command, contractOption: string, spec: JsonActionSpec): void;
