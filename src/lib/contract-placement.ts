import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {accountExists, createContractAccount, deployContractBytes} from './deploy.js'
import {downloadStoredObjectBytes, putReplicatedObject, ReplicatedPutResult, sha256Bytes} from './storage.js'
import {AuthOptions, getTableRows, pushAction} from './tx.js'
import {
  ContractDependency,
  ContractManifest,
  PlacementCandidate,
  buildContractManifest,
  defaultContractRamBytes,
  parseContractDependencies,
  parseContractManifest,
  parseContractMetadata,
  selectPlacementChain,
} from './sidechain-placement.js'

export interface ContractUploadOptions extends AuthOptions {
  account: string
  owner: string
  title: string
  wasm: string
  abi: string
  metadata?: unknown
  dependencies?: unknown
  marketContract?: string
  storageContract?: string
  routerUrl?: string
}

export interface ContractUploadResult {
  manifest_hash: string
  manifest_object_id: number | string
  manifest: ContractManifest
  wasm: Pick<ReplicatedPutResult, 'content_hash' | 'source_hash' | 'bytes' | 'object_id' | 'put_tx' | 'router' | 'replica_count'>
  abi: Pick<ReplicatedPutResult, 'content_hash' | 'source_hash' | 'bytes' | 'object_id' | 'put_tx' | 'router' | 'replica_count'>
  manifest_upload: Pick<ReplicatedPutResult, 'content_hash' | 'source_hash' | 'bytes' | 'object_id' | 'put_tx' | 'router' | 'replica_count'>
}

export interface ContractPlaceOptions extends AuthOptions {
  manifestHash: string
  marketContract?: string
  storageContract?: string
  dappContract?: string
  creator?: string
  ownerKey?: string
  activeKey?: string
  ramBytes?: number
  stakeNet?: string
  stakeCpu?: string
  targetChain?: string
  validate?: boolean
}

export interface DappRow {
  dapp: string
  owner: string
  active: boolean | number | string
  title: string
  metadata: string
}

export interface ContractPlacementResult {
  manifest_hash: string
  selected_chain_uid: string
  endpoint: string
  ram_bytes: number
  ram_quote: PlacementCandidate['ram_quote'] & {
    last_free_bytes: number
    last_size_bytes: number
  }
  account_created: boolean
  account_creation_tx?: string
  deploy_tx?: string
  registry_tx?: string
}

const DEFAULT_MARKET_CONTRACT = process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket'
const DEFAULT_STORAGE_CONTRACT = process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore'
const DEFAULT_DAPP_CONTRACT = process.env.HARBOR_DAPP_CONTRACT ?? 'dappreg'

function compactUpload(result: ReplicatedPutResult): Pick<ReplicatedPutResult, 'content_hash' | 'source_hash' | 'bytes' | 'object_id' | 'put_tx' | 'router' | 'replica_count'> {
  return {
    content_hash: result.content_hash,
    source_hash: result.source_hash,
    bytes: result.bytes,
    object_id: result.object_id,
    put_tx: result.put_tx,
    router: result.router,
    replica_count: result.replica_count,
  }
}

export function parseJsonOption(value: string | undefined, fallback: unknown): unknown {
  if (value === undefined) {
    return fallback
  }
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new Error(`invalid JSON option: ${(error as Error).message}`)
  }
}

export function buildPlacementMetadata(chainUid: string, manifestHash: string): string {
  return JSON.stringify({placement: {chain_uid: chainUid, manifest_hash: manifestHash}})
}

function boolValue(value: boolean | number | string | undefined): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

async function writeTemporaryManifest(manifest: ContractManifest): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-contract-manifest-'))
  const file = path.join(dir, 'manifest.json')
  await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return file
}

export async function uploadContractManifest(options: ContractUploadOptions): Promise<ContractUploadResult> {
  const owner = options.owner
  const marketContract = options.marketContract ?? DEFAULT_MARKET_CONTRACT
  const storageContract = options.storageContract ?? DEFAULT_STORAGE_CONTRACT
  const auth = {...options, actor: options.actor ?? owner, marketContract, storageContract}

  const [wasmUpload, abiUpload] = await Promise.all([
    putReplicatedObject({
      ...auth,
      file: options.wasm,
      owner,
      metadata: JSON.stringify({kind: 'harbor-contract-wasm', account: options.account}),
      routerUrl: options.routerUrl,
    }),
    putReplicatedObject({
      ...auth,
      file: options.abi,
      owner,
      metadata: JSON.stringify({kind: 'harbor-contract-abi', account: options.account}),
      routerUrl: options.routerUrl,
    }),
  ])

  const manifest = buildContractManifest({
    account: options.account,
    owner,
    title: options.title,
    wasm_object_hash: wasmUpload.content_hash,
    abi_object_hash: abiUpload.content_hash,
    wasm_sha256: wasmUpload.source_hash,
    abi_sha256: abiUpload.source_hash,
    wasm_bytes: wasmUpload.bytes,
    abi_bytes: abiUpload.bytes,
    metadata: parseContractMetadata(options.metadata),
    dependencies: parseContractDependencies(options.dependencies),
  })

  const manifestFile = await writeTemporaryManifest(manifest)
  try {
    const manifestUpload = await putReplicatedObject({
      ...auth,
      file: manifestFile,
      owner,
      metadata: JSON.stringify({kind: 'harbor-contract-manifest', account: options.account}),
      routerUrl: options.routerUrl,
    })
    return {
      manifest_hash: manifestUpload.content_hash,
      manifest_object_id: manifestUpload.object_id,
      manifest,
      wasm: compactUpload(wasmUpload),
      abi: compactUpload(abiUpload),
      manifest_upload: compactUpload(manifestUpload),
    }
  } finally {
    await fs.rm(path.dirname(manifestFile), {recursive: true, force: true})
  }
}

async function downloadManifest(options: Pick<ContractPlaceOptions, 'url' | 'manifestHash' | 'marketContract' | 'storageContract'>): Promise<ContractManifest> {
  const manifestBytes = await downloadStoredObjectBytes({
    url: options.url,
    marketContract: options.marketContract ?? DEFAULT_MARKET_CONTRACT,
    storageContract: options.storageContract ?? DEFAULT_STORAGE_CONTRACT,
    contentHash: options.manifestHash,
    expectedSha256: options.manifestHash,
  })
  const actual = sha256Bytes(manifestBytes.bytes)
  if (actual !== options.manifestHash) {
    throw new Error(`contract manifest checksum mismatch: expected ${options.manifestHash}, got ${actual}`)
  }
  return parseContractManifest(manifestBytes.bytes)
}

async function downloadContractBytes(options: Pick<ContractPlaceOptions, 'url' | 'marketContract' | 'storageContract'> & {manifest: ContractManifest}) {
  const storageOptions = {
    url: options.url,
    marketContract: options.marketContract ?? DEFAULT_MARKET_CONTRACT,
    storageContract: options.storageContract ?? DEFAULT_STORAGE_CONTRACT,
  }
  const [wasm, abi] = await Promise.all([
    downloadStoredObjectBytes({
      ...storageOptions,
      contentHash: options.manifest.wasm_object_hash,
      expectedSha256: options.manifest.wasm_sha256,
    }),
    downloadStoredObjectBytes({
      ...storageOptions,
      contentHash: options.manifest.abi_object_hash,
      expectedSha256: options.manifest.abi_sha256,
    }),
  ])
  return {wasm: wasm.bytes, abi: abi.bytes}
}

async function findDappRow(url: string | undefined, dappContract: string, dapp: string): Promise<DappRow | undefined> {
  const byPrimary = await getTableRows<DappRow>(dappContract, 'dapps', {
    url,
    scope: dappContract,
    lowerBound: dapp,
    upperBound: dapp,
    limit: 1,
  })
  const exact = byPrimary.rows.find((row) => row.dapp === dapp)
  if (exact) {
    return exact
  }

  const scan = await getTableRows<DappRow>(dappContract, 'dapps', {
    url,
    scope: dappContract,
    limit: 1000,
  })
  return scan.rows.find((row) => row.dapp === dapp)
}

async function recordDappPlacement(options: ContractPlaceOptions & {
  manifest: ContractManifest
  selected: PlacementCandidate
}): Promise<string | undefined> {
  const dappContract = options.dappContract ?? DEFAULT_DAPP_CONTRACT
  const metadata = buildPlacementMetadata(options.selected.chain_uid, options.manifestHash)
  const existing = await findDappRow(options.url, dappContract, options.manifest.account)
  const result = existing
    ? await pushAction({
      contract: dappContract,
      action: 'setdapp',
      data: {
        dapp: options.manifest.account,
        owner: existing.owner,
        active: boolValue(existing.active),
        title: existing.title || options.manifest.title,
        metadata,
      },
      url: options.url,
      actor: existing.owner,
      permission: options.permission,
      key: options.key,
      expiration: options.expiration,
    })
    : await pushAction({
      contract: dappContract,
      action: 'regdapp',
      data: {
        dapp: options.manifest.account,
        owner: options.manifest.owner,
        title: options.manifest.title,
        metadata,
      },
      url: options.url,
      actor: options.manifest.owner,
      permission: options.permission,
      key: options.key,
      expiration: options.expiration,
    })
  return (result as {transaction_id?: string}).transaction_id
}

export async function placeContractManifest(options: ContractPlaceOptions): Promise<ContractPlacementResult> {
  const marketContract = options.marketContract ?? DEFAULT_MARKET_CONTRACT
  const storageContract = options.storageContract ?? DEFAULT_STORAGE_CONTRACT
  const manifest = await downloadManifest({...options, marketContract, storageContract})
  const ramBytes = options.ramBytes ?? defaultContractRamBytes(manifest)
  const selected = await selectPlacementChain({
    url: options.url,
    marketContract,
    manifest,
    ramBytes,
    targetChain: options.targetChain,
  })
  const contractBytes = await downloadContractBytes({...options, manifest, marketContract, storageContract})
  const exists = await accountExists(selected.endpoint, manifest.account)
  let accountCreationTx: string | undefined

  if (!exists) {
    if (!options.ownerKey || !options.activeKey) {
      throw new Error(`contract account ${manifest.account} does not exist on ${selected.chain_uid}; pass --owner-key and --active-key to create it`)
    }
    const accountCreation = await createContractAccount({
      ...options,
      url: selected.endpoint,
      creator: options.creator ?? 'eosio',
      account: manifest.account,
      ownerKey: options.ownerKey,
      activeKey: options.activeKey,
      ramBytes,
      stakeNet: options.stakeNet ?? '1.0000 SYS',
      stakeCpu: options.stakeCpu ?? '1.0000 SYS',
    })
    accountCreationTx = (accountCreation as {transaction_id?: string}).transaction_id
  }

  const abiJson = JSON.parse(contractBytes.abi.toString('utf8')) as unknown
  const deploy = await deployContractBytes({
    ...options,
    url: selected.endpoint,
    account: manifest.account,
    wasmBytes: contractBytes.wasm,
    abiJson,
    validate: options.validate,
  })
  const registryTx = await recordDappPlacement({...options, manifest, selected})

  return {
    manifest_hash: options.manifestHash,
    selected_chain_uid: selected.chain_uid,
    endpoint: selected.endpoint,
    ram_bytes: ramBytes,
    ram_quote: {
      ...selected.ram_quote,
      last_free_bytes: selected.last_free_bytes,
      last_size_bytes: selected.last_size_bytes,
    },
    account_created: !exists,
    account_creation_tx: accountCreationTx,
    deploy_tx: (deploy as {transaction_id?: string}).transaction_id,
    registry_tx: registryTx,
  }
}

export type {ContractDependency}
