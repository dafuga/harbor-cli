import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {buildRouterUploadHeaders, distributeStoredObject, selectBestRouter, storageProvidersForReplicas, storeObject, uploadToRouter} from './storage.js'

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
  )

  assert.deepEqual(providers, [
    {provider: 'storea', endpoint: 'http://storea'},
    {provider: 'storeb', endpoint: 'https://storeb'},
  ])
})

test('buildRouterUploadHeaders includes object identity and byte count', () => {
  assert.deepEqual(buildRouterUploadHeaders({
    objectId: 42,
    owner: 'alice',
    contentHash: 'a'.repeat(64),
    bytes: Buffer.from('hello'),
  }), {
    'content-type': 'application/octet-stream',
    'x-harbor-object-id': '42',
    'x-harbor-content-hash': 'a'.repeat(64),
    'x-harbor-owner': 'alice',
    'x-harbor-bytes': '5',
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
      bytes: Buffer.from('replicate me'),
    })

    assert.equal(seen.url, '/storage/objects')
    assert.equal(seen.headers?.['x-harbor-object-id'], '7')
    assert.equal(seen.headers?.['x-harbor-content-hash'], 'b'.repeat(64))
    assert.equal(seen.headers?.['x-harbor-owner'], 'alice')
    assert.equal(seen.headers?.['x-harbor-bytes'], '12')
    assert.equal(seen.body?.toString(), 'replicate me')
    assert.deepEqual(result.selected_storage_providers, ['storea'])
    assert.equal(result.replica_count, 1)
    assert.equal(result.assignment_tx, 'local-test')
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
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

test('storeObject encrypts bytes when requested', async () => {
  const root = await makeTempDir()
  const sourcePath = path.join(root, 'secret.txt')
  await fs.writeFile(sourcePath, 'secret harbor')

  const result = await storeObject({
    root,
    file: sourcePath,
    encrypt: true,
    privateKey: 'local-private-key',
  })
  const stored = JSON.parse(await fs.readFile(result.storedPath, 'utf8'))

  assert.equal(result.encrypted, true)
  assert.equal(stored.algorithm, 'aes-256-gcm')
  assert.notEqual(result.contentHash, result.sourceHash)
  assert.notEqual(result.encryptionKeyHash, '0'.repeat(64))
})

test('storeObject requires a private key for encryption', async () => {
  const root = await makeTempDir()
  const sourcePath = path.join(root, 'secret.txt')
  await fs.writeFile(sourcePath, 'secret harbor')

  await assert.rejects(
    () => storeObject({root, file: sourcePath, encrypt: true}),
    /--private-key is required/
  )
})
