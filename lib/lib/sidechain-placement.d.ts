export declare const CONTRACT_MANIFEST_KIND = "harbor-contract-manifest";
export declare const CONTRACT_MANIFEST_VERSION = 1;
export declare const DEFAULT_CONTRACT_RAM_OVERHEAD_BYTES = 65536;
export interface ContractDependency {
    contract: string;
    chain_uid?: string;
}
export interface ContractManifest {
    kind: typeof CONTRACT_MANIFEST_KIND;
    version: typeof CONTRACT_MANIFEST_VERSION;
    account: string;
    owner: string;
    title: string;
    wasm_object_hash: string;
    abi_object_hash: string;
    wasm_sha256: string;
    abi_sha256: string;
    wasm_bytes: number;
    abi_bytes: number;
    metadata: Record<string, unknown>;
    dependencies: ContractDependency[];
}
export interface ChainRow {
    chain_uid: string;
    status: number | string;
    endpoint?: string;
    last_free_bytes?: number | string;
    last_used_bytes?: number | string;
    last_size_bytes?: number | string;
    [key: string]: unknown;
}
export interface RamMarketRow {
    base?: string | {
        balance?: string;
    };
    quote?: string | {
        balance?: string;
    };
    [key: string]: unknown;
}
export interface RamQuote {
    sys_per_kib: number;
    base_ram_bytes: number;
    quote_sys: number;
}
export interface PlacementCandidate {
    chain_uid: string;
    endpoint: string;
    status: number;
    last_free_bytes: number;
    last_used_bytes: number;
    last_size_bytes: number;
    ram_quote: RamQuote;
}
export interface SelectPlacementInput {
    url?: string;
    marketContract: string;
    manifest: ContractManifest;
    ramBytes: number;
    targetChain?: string;
    chains?: ChainRow[];
    ramMarketLoader?: (chain: ChainRow) => Promise<RamQuote>;
}
export declare function parseContractDependencies(value: unknown): ContractDependency[];
export declare function parseContractMetadata(value: unknown): Record<string, unknown>;
export declare function parseContractManifest(value: Buffer | string | unknown): ContractManifest;
export declare function buildContractManifest(input: Omit<ContractManifest, 'kind' | 'version'>): ContractManifest;
export declare function defaultContractRamBytes(manifest: Pick<ContractManifest, 'wasm_bytes' | 'abi_bytes'>): number;
export declare function dependencyPinnedChain(manifest: Pick<ContractManifest, 'dependencies'>): string | undefined;
export declare function resolveRequestedChain(manifest: ContractManifest, targetChain?: string): string | undefined;
export declare function estimateRamQuote(row: RamMarketRow): RamQuote;
export declare function selectPlacementChainFromRows(input: Omit<SelectPlacementInput, 'url' | 'marketContract' | 'chains'> & {
    chains: ChainRow[];
}): Promise<PlacementCandidate>;
export declare function selectPlacementChain(input: SelectPlacementInput): Promise<PlacementCandidate>;
