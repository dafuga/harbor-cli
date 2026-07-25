import { Command } from 'commander';
export type FieldType = 'string' | 'number' | 'uint64' | 'uint64[]' | 'boolean' | 'json';
export type Field = string | [string, FieldType];
export interface JsonActionSpec {
    command: string;
    action: string;
    fields: Field[];
    signerField?: string;
    disabledReason?: string;
}
export declare function jsonActionSpec(command: Command): JsonActionSpec | undefined;
export declare function collectJsonActionSpecs(root: Command): JsonActionSpec[];
export declare function fieldName(field: Field): string;
export declare function fieldType(field: Field): FieldType;
export declare function parseField(value: string, type: FieldType): unknown;
export declare function buildActionData(fields: Field[], values: string[]): Record<string, unknown>;
export declare function actionOptions(args: unknown[]): Record<string, string | boolean | undefined>;
export declare function addJsonActionCommand(root: Command, contractOption: string, spec: JsonActionSpec): void;
