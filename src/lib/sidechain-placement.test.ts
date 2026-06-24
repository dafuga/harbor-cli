import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ChainRow,
  ContractManifest,
  buildContractManifest,
  defaultContractRamBytes,
  estimateRamQuote,
  parseContractManifest,
  selectPlacementChainFromRows,
} from './sidechain-placement.js'
import {buildPlacementMetadata} from './contract-placement.js'

const baseManifest = buildContractManifest({
  account: 'cooldapp1111',
  owner: 'owner1111111',
  title: 'Cool dApp',
  wasm_object_hash: 'a'.repeat(64),
  abi_object_hash: 'b'.repeat(64),
  wasm_sha256: 'a'.repeat(64),
  abi_sha256: 'b'.repeat(64),
  wasm_bytes: 1000,
  abi_bytes: 2000,
  metadata: {category: 'game'},
  dependencies: [],
})

function chain(chain_uid: string, overrides: Partial<ChainRow> = {}): ChainRow {
  return {
    chain_uid,
    status: 2,
    endpoint: `http://${chain_uid}.example.test`,
    last_free_bytes: 1_000_000,
    last_used_bytes: 0,
    last_size_bytes: 2_000_000,
    ...overrides,
  }
}

function withDeps(dependencies: ContractManifest['dependencies']): ContractManifest {
  return {...baseManifest, dependencies}
}

function quote(sysPerKiB: number) {
  return {
    sys_per_kib: sysPerKiB,
    base_ram_bytes: 1024,
    quote_sys: sysPerKiB,
  }
}

test('contract manifest parsing validates shape and default RAM bytes', () => {
  const parsed = parseContractManifest(JSON.stringify(baseManifest))
  assert.equal(parsed.kind, 'harbor-contract-manifest')
  assert.equal(parsed.version, 1)
  assert.equal(parsed.account, 'cooldapp1111')
  assert.deepEqual(parsed.metadata, {category: 'game'})
  assert.equal(defaultContractRamBytes(parsed), 68536)
  assert.throws(() => parseContractManifest({kind: 'wrong'}), /kind must be/)
})

test('dependency-pinned chain overrides cheaper RAM candidates', async () => {
  const selected = await selectPlacementChainFromRows({
    manifest: withDeps([{contract: 'token1111111', chain_uid: 'game2'}]),
    ramBytes: 10_000,
    chains: [chain('game1'), chain('game2')],
    ramMarketLoader: async (row) => quote(row.chain_uid === 'game1' ? 0.1 : 5),
  })

  assert.equal(selected.chain_uid, 'game2')
})

test('conflicting dependency chains fail before placement', async () => {
  await assert.rejects(
    selectPlacementChainFromRows({
      manifest: withDeps([
        {contract: 'token1111111', chain_uid: 'game1'},
        {contract: 'oracle111111', chain_uid: 'game2'},
      ]),
      ramBytes: 10_000,
      chains: [chain('game1'), chain('game2')],
      ramMarketLoader: async () => quote(1),
    }),
    /conflicting chains/
  )
})

test('selection filters main, saturated, inactive, and low-headroom chains', async () => {
  const selected = await selectPlacementChainFromRows({
    manifest: baseManifest,
    ramBytes: 10_000,
    chains: [
      chain('main'),
      chain('game1', {status: 3}),
      chain('game2', {status: 0}),
      chain('game3', {last_free_bytes: 9999}),
      chain('game4'),
    ],
    ramMarketLoader: async () => quote(1),
  })

  assert.equal(selected.chain_uid, 'game4')
})

test('selection sorts by RAM price, free RAM, then chain uid', async () => {
  const selected = await selectPlacementChainFromRows({
    manifest: baseManifest,
    ramBytes: 10_000,
    chains: [
      chain('game3', {last_free_bytes: 500_000}),
      chain('game2', {last_free_bytes: 800_000}),
      chain('game1', {last_free_bytes: 800_000}),
    ],
    ramMarketLoader: async () => quote(1),
  })

  assert.equal(selected.chain_uid, 'game1')
})

test('explicit target chain must match dependency-pinned chain', async () => {
  await assert.rejects(
    selectPlacementChainFromRows({
      manifest: withDeps([{contract: 'token1111111', chain_uid: 'game2'}]),
      targetChain: 'game1',
      ramBytes: 10_000,
      chains: [chain('game1'), chain('game2')],
      ramMarketLoader: async () => quote(1),
    }),
    /conflicts with dependency-pinned chain/
  )
})

test('rammarket quote estimates SYS per KiB from connector balances', () => {
  const quoted = estimateRamQuote({
    base: {balance: '2048 RAM'},
    quote: {balance: '4.0000 SYS'},
  })
  assert.equal(quoted.sys_per_kib, 2)
})

test('placement metadata stays compact for dappreg', () => {
  const metadata = buildPlacementMetadata('game1', 'c'.repeat(64))
  assert.ok(metadata.length <= 256)
  assert.deepEqual(JSON.parse(metadata), {
    placement: {chain_uid: 'game1', manifest_hash: 'c'.repeat(64)},
  })
})
