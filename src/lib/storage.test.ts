import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {buildRouterUploadHeaders, buildWalrusMetadata, discoverRouterAtEndpoint, distributeStoredObject, downloadStoredObjectBytes, filterEligibleMarketServices, parseWalrusStoreResponse, persistPreparedStorageObject, prepareObjectForUpload, prepareStoredObject, putReplicatedObject, requireDownloadableStorageObject, resolveStorageObjectByHash, resolveStorageObjectId, selectBestRouter, storageProvidersForReplicas, storageRegistrationAction, storeObject, uploadToRouter} from './storage.js'
import {generateVaultKeyPair, MAX_GOVERNED_PLAINTEXT_BYTES, vaultEnvelopeFromJson} from './vault-crypto.js'

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harbor-storage-'))
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

test('storeObject stores plaintext bytes and returns harborstore action data', async () => {
  const root = await makeTempDir()
  const sourcePath = path.join(root, 'sample.txt')
  await fs.writeFile(sourcePath, 'hello harbor')

  const result = await storeObject({root, file: sourcePath, metadata: 'sample'})
  const stored = await fs.readFile(result.storedPath)
  const expectedHash = crypto.createHash('sha256').update('hello harbor').digest('hex')

  assert.equal(stored.toString(), 'hello harbor')
  assert.equal(result.contentHash, expectedHash)
  assert.equal(result.sourceHash, expectedHash)
  assert.equal(result.encrypted, false)
  assert.equal(result.encryptionKeyHash, '0'.repeat(64))
  assert.deepEqual(result.registerAction.data, [
    '<owner>',
    expectedHash,
    stored.length,
    false,
    '0'.repeat(64),
    'sample',
  ])
})

test('selectBestRouter filters inactive and non-router services, then prefers lower load', () => {
  const router = selectBestRouter([
    {id: 1, provider: 'storage', service_type: 3, active: true, endpoint: 'http://storage', metadata: '{"load":0}'},
    {id: 2, provider: 'inactive', service_type: 14, active: false, endpoint: 'http://inactive', metadata: '{"load":0}'},
    {id: 3, provider: 'busy', service_type: 14, active: true, endpoint: 'http://busy', metadata: '{"load":7}'},
    {id: 4, provider: 'best', service_type: 14, active: '1', endpoint: 'http://best', metadata: '{"queue_depth":2}'},
    {id: 5, provider: 'bad-endpoint', service_type: 14, active: true, endpoint: 'unix:///tmp/router.sock', metadata: '{"load":0}'},
  ])

  assert.equal(router.provider, 'best')
})

test('explicit router URLs must resolve to an active on-chain router identity', async () => {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {table: string}
      const tables: Record<string, unknown[]> = {
        services: [
          {id: 1, provider: 'storage', service_type: 3, active: true, endpoint: 'http://router.example'},
          {id: 2, provider: 'routera', service_type: 14, active: true, endpoint: 'http://router.example/'},
          {id: 3, provider: 'routerb', service_type: 14, active: false, endpoint: 'http://inactive.example'},
          {id: 4, provider: 'routera', service_type: 14, active: true, endpoint: 'http://router.example/', metadata: '{"load":2}'},
          {id: 5, provider: 'routerx', service_type: 14, active: true, endpoint: 'http://ambiguous.example'},
          {id: 6, provider: 'routery', service_type: 14, active: true, endpoint: 'http://ambiguous.example/'},
          {id: 7, provider: 'routerdead', service_type: 14, active: true, endpoint: 'http://stale.example/'},
        ],
        providers: ['storage', 'routera', 'routerb', 'routerx', 'routery'].map((owner) => ({
          owner, stake: '10.0000 SYS', active: true,
        })).concat([{owner: 'routerdead', stake: '10.0000 SYS', active: false}]),
        svctypes: [
          {id: 3, enabled: true, min_provider_stake: '1.0000 SYS'},
          {id: 14, enabled: true, min_provider_stake: '5.0000 SYS'},
        ],
      }
      response.writeHead(200, {'content-type': 'application/json'})
      response.end(JSON.stringify({rows: tables[body.table] ?? [], more: false}))
    })
  })
  try {
    const chainUrl = await listen(server)
    const router = await discoverRouterAtEndpoint({
      url: chainUrl,
      marketContract: 'svcmarket',
      endpoint: 'http://router.example',
    })
    assert.equal(router.provider, 'routera')
    await assert.rejects(
      () => discoverRouterAtEndpoint({
        url: chainUrl,
        marketContract: 'svcmarket',
        endpoint: 'http://unregistered.example',
      }),
      /not an active on-chain router service/,
    )
    await assert.rejects(
      () => discoverRouterAtEndpoint({
        url: chainUrl,
        marketContract: 'svcmarket',
        endpoint: 'http://ambiguous.example',
      }),
      /multiple active on-chain router identities/,
    )
    await assert.rejects(
      () => discoverRouterAtEndpoint({
        url: chainUrl,
        marketContract: 'svcmarket',
        endpoint: 'http://stale.example',
      }),
      /not an active on-chain router service/,
    )
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})

test('router eligibility rejects disabled service types, insufficient stakes, and symbol mismatches', () => {
  const services = [
    {id: 1, provider: 'good', service_type: 14, active: true, endpoint: 'http://good'},
    {id: 2, provider: 'low', service_type: 14, active: true, endpoint: 'http://low'},
    {id: 3, provider: 'wrong', service_type: 14, active: true, endpoint: 'http://wrong'},
  ]
  const providers = [
    {owner: 'good', stake: '5.0000 SYS', active: true},
    {owner: 'low', stake: '4.9999 SYS', active: true},
    {owner: 'wrong', stake: '10.0000 USD', active: true},
  ]
  assert.deepEqual(
    filterEligibleMarketServices(services, providers, [{id: 14, enabled: true, min_provider_stake: '5.0000 SYS'}])
      .map((service) => service.provider),
    ['good'],
  )
  assert.deepEqual(
    filterEligibleMarketServices(services, providers, [{id: 14, enabled: false, min_provider_stake: '0.0000 SYS'}]),
    [],
  )
})

test('storageProvidersForReplicas returns active HTTP storage providers assigned to object', () => {
  const providers = storageProvidersForReplicas(
    [
      {id: 1, object_id: 42, provider: 'storea', active: true},
      {id: 2, object_id: 42, provider: 'storeb', active: '1'},
      {id: 3, object_id: 7, provider: 'other', active: true},
      {id: 4, object_id: 42, provider: 'inactive-replica', active: false},
    ],
    [
      {id: 10, provider: 'storea', service_type: 3, active: true, endpoint: 'http://storea'},
      {id: 11, provider: 'storeb', service_type: 3, active: true, endpoint: 'https://storeb'},
      {id: 12, provider: 'inactive-replica', service_type: 3, active: true, endpoint: 'http://bad'},
      {id: 13, provider: 'storea', service_type: 14, active: true, endpoint: 'http://router'},
      {id: 14, provider: 'storec', service_type: 3, active: true, endpoint: 'unix:///tmp/storec'},
    ],
    42,
    [
      {owner: 'storea', stake: '2.0000 SYS', active: true},
      {owner: 'storeb', stake: '2.0000 SYS', active: true},
      {owner: 'inactive-replica', stake: '2.0000 SYS', active: false},
    ],
    [{id: 3, enabled: true, min_provider_stake: '1.0000 SYS'}],
  )

  assert.deepEqual(providers, [
    {provider: 'storea', endpoint: 'http://storea'},
    {provider: 'storeb', endpoint: 'https://storeb'},
  ])
})

test('storage downloads reject disabled, expired, tombstoned, and completed objects', () => {
  const object = {
    id: 42,
    owner: 'alice',
    content_hash: 'a'.repeat(64),
    bytes: 5,
    encrypted: false,
    encryption_key_hash: '0'.repeat(64),
    status: 1,
  }
  const live = {
    object_id: 42,
    expires_at: '2033-05-18T03:33:21',
    tombstoned_at: '1970-01-01T00:00:00',
    completed_at: '1970-01-01T00:00:00',
  }

  assert.doesNotThrow(() => requireDownloadableStorageObject(object, live, 2_000_000_000))
  assert.throws(
    () => requireDownloadableStorageObject({...object, status: 2}, live, 2_000_000_000),
    /not active/,
  )
  assert.throws(
    () => requireDownloadableStorageObject(object, live, 2_000_000_001),
    /expired/,
  )
  assert.throws(
    () => requireDownloadableStorageObject(object, {...live, tombstoned_at: 1_999_999_999}, 2_000_000_000),
    /tombstoned/,
  )
  assert.throws(
    () => requireDownloadableStorageObject(object, {...live, completed_at: 1_999_999_999}, 2_000_000_000),
    /deletion is complete/,
  )
})

test('buildRouterUploadHeaders includes the complete registered object identity', () => {
  assert.deepEqual(buildRouterUploadHeaders({
    objectId: 42,
    owner: 'alice',
    contentHash: 'a'.repeat(64),
    requiredReplicas: 3,
    encrypted: true,
    encryptionKeyHash: 'c'.repeat(64),
    bytes: Buffer.from('hello'),
  }), {
    'content-type': 'application/octet-stream',
    'content-length': '5',
    'x-harbor-object-id': '42',
    'x-harbor-content-hash': 'a'.repeat(64),
    'x-harbor-owner': 'alice',
    'x-harbor-bytes': '5',
    'x-harbor-required-replicas': '3',
    'x-harbor-encrypted': 'true',
    'x-harbor-encryption-key-hash': 'c'.repeat(64),
  })
})

test('uploadToRouter posts bytes with Harbor storage headers', async () => {
  const seen: {headers?: http.IncomingHttpHeaders; body?: Buffer; url?: string} = {}
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      seen.headers = request.headers
      seen.body = Buffer.concat(chunks)
      seen.url = request.url
      response.writeHead(202, {'content-type': 'application/json'})
      response.end(JSON.stringify({
        ok: true,
        object_id: '9007199254740993',
        selected_storage_providers: ['storea'],
        replica_count: 1,
        assignment_tx: 'local-test',
      }))
    })
  })

  try {
    const endpoint = await listen(server)
    const result = await uploadToRouter({
      router: {id: 14, provider: 'routera', endpoint},
      objectId: 7,
      owner: 'alice',
      contentHash: 'b'.repeat(64),
      requiredReplicas: 2,
      encrypted: false,
      encryptionKeyHash: '0'.repeat(64),
      bytes: Buffer.from('replicate me'),
    })

    assert.equal(seen.url, '/storage/objects')
    assert.equal(seen.headers?.['x-harbor-object-id'], '7')
    assert.equal(seen.headers?.['content-length'], '12')
    assert.equal(seen.headers?.['x-harbor-content-hash'], 'b'.repeat(64))
    assert.equal(seen.headers?.['x-harbor-owner'], 'alice')
    assert.equal(seen.headers?.['x-harbor-bytes'], '12')
    assert.equal(seen.headers?.['x-harbor-required-replicas'], '2')
    assert.equal(seen.headers?.['x-harbor-encrypted'], 'false')
    assert.equal(seen.headers?.['x-harbor-encryption-key-hash'], '0'.repeat(64))
    assert.equal(seen.body?.toString(), 'replicate me')
    assert.deepEqual(result.selected_storage_providers, ['storea'])
    assert.equal(result.object_id, '9007199254740993')
    assert.equal(result.replica_count, 1)
    assert.equal(result.assignment_tx, 'local-test')
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})

test('public upload preparation hashes and uploads directly from a file without retaining its bytes', async () => {
  const root = await makeTempDir()
  const sourcePath = path.join(root, 'model-shard.bin')
  const source = Buffer.alloc(2 * 1024 * 1024, 0x5a)
  await fs.writeFile(sourcePath, source)
  const seen: {body?: Buffer; length?: string; contentLength?: string} = {}
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      seen.body = Buffer.concat(chunks)
      seen.length = request.headers['x-harbor-bytes'] as string
      seen.contentLength = request.headers['content-length']
      response.writeHead(202, {'content-type': 'application/json'})
      response.end('{"ok":true}')
    })
  })
  try {
    const {prepared, preparedPath} = await prepareObjectForUpload({file: sourcePath})
    assert.equal(prepared.storedBytes, undefined)
    assert.equal(prepared.uploadPath, sourcePath)
    assert.equal(preparedPath, undefined)
    assert.equal(prepared.contentHash, crypto.createHash('sha256').update(source).digest('hex'))
    const endpoint = await listen(server)
    await uploadToRouter({
      router: {id: 1, provider: 'router', endpoint},
      objectId: '42',
      owner: 'alice',
      contentHash: prepared.contentHash,
      requiredReplicas: 1,
      encrypted: false,
      encryptionKeyHash: '0'.repeat(64),
      file: prepared.uploadPath,
      byteLength: prepared.bytes,
    })
    assert.equal(seen.length, String(source.length))
    assert.equal(seen.contentLength, String(source.length))
    assert.deepEqual(seen.body, source)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    source.fill(0)
    await fs.rm(root, {recursive: true, force: true})
  }
})

test('governed encryption is no longer capped at the old 512 MiB architecture limit', () => {
  assert.ok(MAX_GOVERNED_PLAINTEXT_BYTES > 512 * 1024 * 1024)
})

test('resolveStorageObjectByHash uses the checksum256 exclusive successor', async () => {
  const contentHash = '7'.repeat(64)
  const exclusiveUpper = (BigInt(`0x${contentHash}`) + 1n).toString(16).padStart(64, '0')
  let requests = 0
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      requests += 1
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      assert.equal(body.table, 'objects')
      assert.equal(body.index_position, '3')
      assert.equal(body.key_type, 'sha256')
      assert.equal(body.lower_bound, contentHash)
      assert.equal(body.upper_bound, exclusiveUpper)
      response.writeHead(200, {'content-type': 'application/json'})
      response.end(JSON.stringify({
        rows: [{
          id: '42', owner: 'alice', content_hash: contentHash, bytes: '5',
          encrypted: false, encryption_key_hash: '0'.repeat(64), required_replicas: 2, status: 1,
        }],
        more: false,
      }))
    })
  })
  try {
    const url = await listen(server)
    const object = await resolveStorageObjectByHash({
      url,
      storageContract: 'harborstore',
      contentHash,
    })
    assert.equal(object.id, '42')
    assert.equal(requests, 1)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('downloadStoredObjectBytes preserves uint64 object and replica ranges beyond MAX_SAFE_INTEGER', async () => {
  const storedBytes = Buffer.from('downloadable harbor object')
  const contentHash = crypto.createHash('sha256').update(storedBytes).digest('hex')
  const checksumUpper = (BigInt(`0x${contentHash}`) + 1n).toString(16).padStart(64, '0')
  const objectId = '9007199254740993'
  const objectUpper = '9007199254740994'
  const queriedTables: string[] = []
  const provider = http.createServer((request, response) => {
    assert.equal(request.url, `/objects/${contentHash}`)
    response.writeHead(200, {'content-type': 'application/octet-stream'})
    response.end(storedBytes)
  })
  let chain: http.Server | undefined
  try {
    const providerEndpoint = await listen(provider)
    chain = http.createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
        const table = String(body.table)
        queriedTables.push(table)
        let rows: unknown[]
        if (table === 'objects') {
          assert.equal(body.lower_bound, contentHash)
          assert.equal(body.upper_bound, checksumUpper)
          rows = [{
            id: objectId, owner: 'alice', content_hash: contentHash, bytes: String(storedBytes.length),
            encrypted: false, encryption_key_hash: '0'.repeat(64), required_replicas: 1, status: 1,
          }]
        } else if (table === 'lifecycles') {
          assert.equal(body.lower_bound, objectId)
          assert.equal(body.upper_bound, objectUpper)
          rows = [{object_id: objectId, expires_at: 4_102_444_800, tombstoned_at: 0, completed_at: 0}]
        } else if (table === 'replicas') {
          assert.equal(body.index_position, '2')
          assert.equal(body.key_type, 'i64')
          assert.equal(body.lower_bound, objectId)
          assert.equal(body.upper_bound, objectUpper)
          rows = [{id: '9007199254740995', object_id: objectId, provider: 'storea', assigned_by: 'routera', active: true}]
        } else if (table === 'services') {
          rows = [{
            id: '3', provider: 'storea', service_type: 3, active: true,
            endpoint: providerEndpoint, range_start: '1', range_end: '100',
          }]
        } else if (table === 'providers') {
          rows = [{owner: 'storea', stake: '10.0000 SYS', active: true}]
        } else if (table === 'svctypes') {
          rows = [{id: 3, enabled: true, min_provider_stake: '1.0000 SYS'}]
        } else {
          throw new Error(`unexpected table ${table}`)
        }
        response.writeHead(200, {'content-type': 'application/json'})
        response.end(JSON.stringify({rows, more: false}))
      })
    })
    const url = await listen(chain)
    const downloaded = await downloadStoredObjectBytes({
      url,
      storageContract: 'harborstore',
      marketContract: 'svcmarket',
      contentHash,
    })
    assert.deepEqual(downloaded.bytes, storedBytes)
    assert.equal(downloaded.provider.provider, 'storea')
    assert.deepEqual(new Set(queriedTables), new Set([
      'objects', 'lifecycles', 'replicas', 'services', 'providers', 'svctypes',
    ]))
  } finally {
    if (chain) {
      await new Promise<void>((resolve, reject) => chain?.close((error) => error ? reject(error) : resolve()))
    }
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
  }
})

test('distributeStoredObject rejects retry when local bytes hash differently', async () => {
  const root = await makeTempDir()
  const sourcePath = path.join(root, 'sample.txt')
  await fs.writeFile(sourcePath, 'different bytes')

  await assert.rejects(
    () => distributeStoredObject({
      file: sourcePath,
      owner: 'alice',
      objectId: 7,
      contentHash: 'c'.repeat(64),
      routerUrl: 'http://127.0.0.1:1',
    }),
    /content hash mismatch/
  )
})

test('storeObject uses the canonical envelope and temporary registration for governed encryption', async () => {
  const root = await makeTempDir()
  const sourcePath = path.join(root, 'secret.txt')
  await fs.writeFile(sourcePath, 'secret harbor')
  const recipient = generateVaultKeyPair()

  const result = await storeObject({
    root,
    file: sourcePath,
    encrypt: true,
    governed: {
      recipientPublicKey: recipient.publicKey,
      context: {
        policy_id: '7',
        consent_id: '8',
        receipt_id: '',
        object_id: '',
        purpose: 'review',
        created_at: 1_000,
        expires_at: 2_000,
      },
      recipient: {grant_id: '', processor: '', key_id: 'review-key-1'},
      keyCustodians: ['trustee'],
      now: 1_000,
    },
  })
  const envelope = vaultEnvelopeFromJson(await fs.readFile(result.storedPath, 'utf8'))

  assert.equal(result.encrypted, true)
  assert.equal(result.temporary, true)
  assert.equal(result.ttlSec, 1_000)
  assert.deepEqual(result.keyCustodians, ['trustee'])
  assert.equal(result.registerAction.action, 'puttempat')
  assert.equal(envelope.context.object_id, '')
  assert.equal(envelope.context.receipt_id, '')
  assert.equal(envelope.recipient_grant_id, '')
  assert.equal(envelope.recipient_processor, '')
  assert.equal(result.encryptionKeyHash, envelope.recipient_key_commitment)
  assert.notEqual(result.encryptionKeyHash, envelope.wrapped_dek_commitment)
  assert.notEqual(result.contentHash, envelope.ciphertext_commitment)
  assert.notEqual(result.contentHash, result.envelopeCommitment)
  assert.equal(result.envelopeCommitment?.length, 64)
  assert.notEqual(result.contentHash, result.sourceHash)
  assert.notEqual(result.encryptionKeyHash, '0'.repeat(64))
  recipient.privateKey.fill(0)
})

test('governed preparation persists exact randomized bytes before registration and is idempotent', async () => {
  const root = await makeTempDir()
  const sourcePath = path.join(root, 'customer-case-name.txt')
  const preparedPath = path.join(root, 'recovery', 'sample.hgd1.json')
  await fs.writeFile(sourcePath, 'sensitive case bytes')
  const recipient = generateVaultKeyPair()
  const prepared = await prepareStoredObject({
    file: sourcePath,
    encrypt: true,
    governed: {
      recipientPublicKey: recipient.publicKey,
      context: {
        policy_id: '7', consent_id: '8', receipt_id: '', object_id: '',
        purpose: 'review', created_at: 1_000, expires_at: 1_500,
      },
      recipient: {grant_id: '', processor: '', key_id: 'review-key-1'},
      keyCustodians: ['trustee'],
      now: 1_100,
    },
  })

  assert.equal(prepared.ttlSec, 400)
  assert.equal(prepared.expiresAt, 1_500)
  assert.equal(prepared.metadata, '{"kind":"governed-data"}')
  assert.deepEqual(storageRegistrationAction('collector', prepared), {
    action: 'puttempat',
    data: {
      owner: 'collector',
      content_hash: prepared.contentHash,
      bytes: prepared.bytes,
      encrypted: true,
      encryption_key_hash: prepared.encryptionKeyHash,
      expires_at: '1970-01-01T00:25:00',
      key_custodians: ['trustee'],
      metadata: '{"kind":"governed-data"}',
    },
  })
  assert.equal(await persistPreparedStorageObject(prepared, preparedPath), preparedPath)
  assert.equal(await persistPreparedStorageObject(prepared, preparedPath), preparedPath)
  assert.deepEqual(await fs.readFile(preparedPath), prepared.storedBytes)
  assert.equal((await fs.stat(preparedPath)).mode & 0o077, 0)

  await fs.writeFile(preparedPath, 'different', {mode: 0o600})
  await assert.rejects(
    () => persistPreparedStorageObject(prepared, preparedPath),
    /already contains different bytes/,
  )
  recipient.privateKey.fill(0)
})

test('storeObject rejects legacy password encryption and incomplete governed encryption', async () => {
  const root = await makeTempDir()
  const sourcePath = path.join(root, 'secret.txt')
  await fs.writeFile(sourcePath, 'secret harbor')

  await assert.rejects(
    () => storeObject({root, file: sourcePath, encrypt: true}),
    /governed encryption options are required/
  )
  await assert.rejects(
    () => storeObject({root, file: sourcePath, encrypt: true, privateKey: 'password'}),
    /password-derived storage encryption was removed/
  )

  const recipient = generateVaultKeyPair()
  await assert.rejects(
    () => storeObject({
      root,
      file: sourcePath,
      encrypt: true,
      governed: {
        recipientPublicKey: recipient.publicKey,
        context: {
          policy_id: '7', consent_id: '8', receipt_id: 'predicted', object_id: 'predicted',
          purpose: 'review', created_at: 1_000, expires_at: 2_000,
        },
        recipient: {grant_id: 'predicted', processor: 'trustee', key_id: 'object-key'},
        keyCustodians: ['trustee'],
        now: 1_000,
      },
    }),
    /initial custody envelope must not contain receipt, object, grant, or processor ids/,
  )
  recipient.privateKey.fill(0)
})

test('storage registration resolves only the unique new duplicate-hash row and preserves uint64 strings', async () => {
  const contentHash = 'd'.repeat(64)
  let requestCount = 0
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      requestCount += 1
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      assert.equal(body.lower_bound, requestCount === 1 ? '9007199254740993' : '9007199254740994')
      response.writeHead(200, {'content-type': 'application/json'})
      response.end(JSON.stringify(requestCount === 1 ? {
        rows: [{
          id: '9007199254740993', owner: 'other', content_hash: contentHash, bytes: '1',
          encrypted: false, encryption_key_hash: '0'.repeat(64), status: 1,
        }],
        more: true,
        next_key: '9007199254740994',
      } : {
        rows: [{
          id: '9007199254740994', owner: 'alice', content_hash: contentHash, bytes: '1',
          encrypted: false, encryption_key_hash: '0'.repeat(64), status: 1,
        }],
        more: false,
      }))
    })
  })
  try {
    const url = await listen(server)
    assert.equal(await resolveStorageObjectId({
      url,
      storageContract: 'harborstore',
      owner: 'alice',
      contentHash,
      minimumIdInclusive: '9007199254740993',
      maximumIdExclusive: '9007199254740995',
      action: 'putobject',
    }), '9007199254740994')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('storage registration rejects two matching new rows instead of selecting an arbitrary duplicate', async () => {
  const contentHash = 'e'.repeat(64)
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {'content-type': 'application/json'})
    response.end(JSON.stringify({
      rows: [11, 12].map((id) => ({
        id: String(id), owner: 'alice', content_hash: contentHash, bytes: '1',
        encrypted: false, encryption_key_hash: '0'.repeat(64), status: 1,
      })),
      more: false,
    }))
  })
  try {
    const url = await listen(server)
    await assert.rejects(() => resolveStorageObjectId({
      url,
      storageContract: 'harborstore',
      owner: 'alice',
      contentHash,
      minimumIdInclusive: '11',
      maximumIdExclusive: '13',
      action: 'putobject',
    }), /resolved 2 newly created objects/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('failed governed registration reports the durable exact-envelope recovery path', async () => {
  const root = await makeTempDir()
  const sourcePath = path.join(root, 'secret.txt')
  const preparedPath = path.join(root, 'recover.hgd1.json')
  await fs.writeFile(sourcePath, 'recoverable secret')
  const recipient = generateVaultKeyPair()
  const now = Math.floor(Date.now() / 1000)
  await assert.rejects(
    () => putReplicatedObject({
      file: sourcePath,
      owner: 'collector',
      encrypt: true,
      governed: {
        recipientPublicKey: recipient.publicKey,
        context: {
          policy_id: '7', consent_id: '8', receipt_id: '', object_id: '',
          purpose: 'review', created_at: now, expires_at: now + 600,
        },
        recipient: {grant_id: '', processor: '', key_id: 'review-key-1'},
        keyCustodians: ['trustee'],
        now,
      },
      preparedOutput: preparedPath,
      url: 'http://127.0.0.1:1',
    }),
    new RegExp(`exact governed envelope retained at ${preparedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  )
  assert.equal((await fs.readFile(preparedPath, 'utf8')).includes('canonical_hex'), true)
  recipient.privateKey.fill(0)
})

test('parseWalrusStoreResponse extracts nested Walrus refs', () => {
  const refs = parseWalrusStoreResponse(JSON.stringify({
    newlyCreated: {
      blobObject: {
        blobId: 'walrus-blob-1',
        id: {id: '0xsuiobject'},
      },
    },
  }), {
    publisher_url: 'http://publisher',
    aggregator_url: 'http://aggregator',
    epochs: 2,
    content_format: 'application/octet-stream',
  })

  assert.equal(refs.blob_id, 'walrus-blob-1')
  assert.equal(refs.publisher_url, 'http://publisher')
  assert.equal(refs.aggregator_url, 'http://aggregator')
  assert.equal(refs.epochs, 2)
  assert.equal(refs.content_format, 'application/octet-stream')
})

test('buildWalrusMetadata preserves existing metadata and Walrus refs', () => {
  const metadata = JSON.parse(buildWalrusMetadata('{"kind":"weights"}', {
    blob_id: 'walrus-blob-2',
    sui_object_id: '0xobject',
    publisher_url: 'http://publisher',
    aggregator_url: 'http://aggregator',
    epochs: 3,
    content_format: 'application/octet-stream',
    response: {},
  }))

  assert.equal(metadata.kind, 'weights')
  assert.equal(metadata.storage_backend, 'walrus')
  assert.equal(metadata.walrus.blob_id, 'walrus-blob-2')
  assert.equal(metadata.walrus.sui_object_id, '0xobject')
  assert.equal(metadata.walrus.epochs, 3)
})
