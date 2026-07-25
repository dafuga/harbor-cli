import { ReplicatedPutResult } from './storage.js';
import { AuthOptions } from './tx.js';
import { ContractDependency, ContractManifest, PlacementCandidate } from './sidechain-placement.js';
export interface ContractUploadOptions extends AuthOptions {
    account: string;
    owner: string;
    title: string;
    wasm: string;
    abi: string;
    metadata?: unknown;
    dependencies?: unknown;
    marketContract?: string;
    storageContract?: string;
    routerUrl?: string;
}
export interface ContractUploadResult {
    manifest_hash: string;
    manifest_object_id: number | string;
    manifest: ContractManifest;
    wasm: Pick<ReplicatedPutResult, 'content_hash' | 'source_hash' | 'bytes' | 'object_id' | 'put_tx' | 'router' | 'replica_count'>;
    abi: Pick<ReplicatedPutResult, 'content_hash' | 'source_hash' | 'bytes' | 'object_id' | 'put_tx' | 'router' | 'replica_count'>;
    manifest_upload: Pick<ReplicatedPutResult, 'content_hash' | 'source_hash' | 'bytes' | 'object_id' | 'put_tx' | 'router' | 'replica_count'>;
}
export interface ContractPlaceOptions extends AuthOptions {
    manifestHash: string;
    marketContract?: string;
    storageContract?: string;
    dappContract?: string;
    creator?: string;
    ownerKey?: string;
    activeKey?: string;
    ramBytes?: number;
    stakeNet?: string;
    stakeCpu?: string;
    targetChain?: string;
    validate?: boolean;
}
export interface DappRow {
    dapp: string;
    owner: string;
    active: boolean | number | string;
    title: string;
    metadata: string;
}
export interface ContractPlacementResult {
    manifest_hash: string;
    selected_chain_uid: string;
    endpoint: string;
    ram_bytes: number;
    ram_quote: PlacementCandidate['ram_quote'] & {
        last_free_bytes: number;
        last_size_bytes: number;
    };
    account_created: boolean;
    account_creation_tx?: string;
    deploy_tx?: string;
    registry_tx?: string;
}
export declare function parseJsonOption(value: string | undefined, fallback: unknown): unknown;
export declare function buildPlacementMetadata(chainUid: string, manifestHash: string): string;
export declare function uploadContractManifest(options: ContractUploadOptions): Promise<ContractUploadResult>;
export declare function placeContractManifest(options: ContractPlaceOptions): Promise<ContractPlacementResult>;
export type { ContractDependency };
