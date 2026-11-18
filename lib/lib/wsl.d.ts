export interface WslDistribution {
    name: string;
    version: 1 | 2;
    default: boolean;
}
export declare function parseWslDistributions(output: Buffer): WslDistribution[];
export declare function wslDistributions(): Promise<WslDistribution[]>;
export declare function selectWslDistribution(distributions: WslDistribution[], name?: string | undefined): WslDistribution | undefined;
export declare function runInWsl(args: string[]): Promise<void>;
