import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import {getTableRows, pushAction} from './tx.js'
import type {AuthOptions} from './tx.js'

export interface StorageManifestEntry {
  path: string
  bytes: number
  sha256: string
}

export interface StoreObjectOptions {
  root: string
  file: string
  encrypt?: boolean
  privateKey?: string
  metadata?: string
}

export interface PreparedStorageObject {
  sourcePath: string
  storedBytes: Buffer
  contentHash: string
  sourceHash: string
  bytes: number
  encrypted: boolean
  encryptionKeyHash: string
  metadata: string
}

export interface StoredObjectResult {
  sourcePath: string
  storedPath: string
  contentHash: string
  sourceHash: string
  bytes: number
  encrypted: boolean
  encryptionKeyHash: string
  metadata: string
  registerAction: {
    contract: string
    action: string
    data: [string, string, number, boolean, string, string]
  }
}

export interface MarketServiceRow {
  id: number | string
  provider: string
  service_type: number | string
  range_start?: number | string
  range_end?: number | string
  capacity_bytes?: number | string
  active: boolean | number | string
  last_heartbeat?: string
  endpoint: string
  metadata?: string
}

export interface StorageObjectRow {
  id: number | string
  owner: string
  content_hash: string
  bytes: number | string
  encrypted: boolean | number | string
  encryption_key_hash: string
  required_replicas?: number | string
  metadata?: string
}

export interface StorageReplicaRow {
  id: number | string
  object_id: number | string
  provider: string
  assigned_by?: string
  active: boolean | number | string
}

export interface StorageDownloadOptions {
  contentHash: string
  output?: string
  url?: string
  marketContract?: string
  storageContract?: string
  expectedSha256?: string
}

export interface StorageDownloadResult {
  content_hash: string
  bytes: number
  sha256: string
  output?: string
  provider: Pick<MarketServiceRow, 'provider' | 'endpoint'>
}

export interface RouterUploadInput {
  router: Pick<MarketServiceRow, 'id' | 'provider' | 'endpoint'>
  objectId: number
  owner: string
  contentHash: string
  bytes: Buffer
}

export interface RouterDistributionResult {
  ok?: boolean
  content_hash?: string
  object_id?: number
  router?: string
  selected_storage_providers?: string[]
  replica_count?: number
  assignment_tx?: string
  assignment_broadcast?: boolean
  [key: string]: unknown
}

export interface ReplicatedPutOptions extends AuthOptions {
  file: string
  owner: string
  metadata?: string
  encrypt?: boolean
  privateKey?: string
  marketContract?: string
  storageContract?: string
  routerUrl?: string
}

export interface ReplicatedPutResult {
  sourcePath: string
  content_hash: string
  source_hash: string
  bytes: number
  encrypted: boolean
  encryption_key_hash: string
  object_id: number
  put_tx?: string
  router: Pick<MarketServiceRow, 'id' | 'provider' | 'endpoint'>
  selected_storage_providers: string[]
  replica_count: number
  assignment_tx?: string
  distribution: RouterDistributionResult
}

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  const handle = await fs.open(filePath, 'r')
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk)
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

export function sha256Bytes(bytes: Buffer | string): string {
  return sha256(bytes)
}

function encryptBytes(bytes: Buffer, privateKey: string): Buffer {
  const key = crypto.createHash('sha256').update(privateKey).digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.from(JSON.stringify({
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }))
}

function objectPath(root: string, contentHash: string): string {
  return path.join(root, 'objects', contentHash.slice(0, 2), contentHash)
}

export async function prepareStoredObject(options: Omit<StoreObjectOptions, 'root'>): Promise<PreparedStorageObject> {
  if (options.encrypt && !options.privateKey) {
    throw new Error('--private-key is required when --encrypt is set')
  }

  const sourcePath = path.resolve(options.file)
  const source = await fs.readFile(sourcePath)
  const sourceHash = sha256(source)
  const encrypted = Boolean(options.encrypt)
  const storedBytes = encrypted ? encryptBytes(source, options.privateKey ?? '') : source
  const contentHash = sha256(storedBytes)
  const metadata = options.metadata ?? path.basename(sourcePath)
  const encryptionKeyHash = encrypted ? sha256(options.privateKey ?? '') : '0'.repeat(64)
  return {
    sourcePath,
    storedBytes,
    contentHash,
    sourceHash,
    bytes: storedBytes.length,
    encrypted,
    encryptionKeyHash,
    metadata,
  }
}

export async function storeObject(options: StoreObjectOptions): Promise<StoredObjectResult> {
  const prepared = await prepareStoredObject(options)
  const storedPath = objectPath(options.root, prepared.contentHash)
  await fs.mkdir(path.dirname(storedPath), {recursive: true})
  await fs.writeFile(storedPath, prepared.storedBytes)

  return {
    sourcePath: prepared.sourcePath,
    storedPath,
    contentHash: prepared.contentHash,
    sourceHash: prepared.sourceHash,
    bytes: prepared.bytes,
    encrypted: prepared.encrypted,
    encryptionKeyHash: prepared.encryptionKeyHash,
    metadata: prepared.metadata,
    registerAction: {
      contract: 'harborstore',
      action: 'putobject',
      data: [
        '<owner>',
        prepared.contentHash,
        prepared.bytes,
        prepared.encrypted,
        prepared.encryptionKeyHash,
        prepared.metadata,
      ],
    },
  }
}

function isActive(value: boolean | number | string): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

function routerLoad(service: MarketServiceRow): number {
  if (!service.metadata) {
    return 0
  }
  try {
    const metadata = JSON.parse(service.metadata) as Record<string, unknown>
    for (const key of ['load', 'load_percent', 'inflight', 'pending', 'queue_depth']) {
      const value = metadata[key]
      if (typeof value === 'number') {
        return value
      }
      if (typeof value === 'string' && value.trim() !== '') {
        return Number(value)
      }
    }
  } catch {
    return 0
  }
  return 0
}

function heartbeatFresh(service: MarketServiceRow): boolean {
  if (!service.last_heartbeat) {
    return true
  }
  const raw = String(service.last_heartbeat)
  const normalized = /(Z|[+-]\d\d:?\d\d)$/.test(raw) ? raw : `${raw}Z`
  const heartbeat = Date.parse(normalized)
  if (Number.isNaN(heartbeat)) {
    return true
  }
  const maxAgeSec = Number(process.env.HARBOR_ROUTER_HEARTBEAT_MAX_AGE_SEC ?? 300)
  return Date.now() - heartbeat <= maxAgeSec * 1000
}

export function selectBestRouter(services: MarketServiceRow[]): MarketServiceRow {
  const routers = services
    .filter((service) => Number(service.service_type) === 14)
    .filter((service) => isActive(service.active))
    .filter((service) => heartbeatFresh(service))
    .filter((service) => service.endpoint.startsWith('http://') || service.endpoint.startsWith('https://'))
    .sort((a, b) => routerLoad(a) - routerLoad(b) || Number(a.id) - Number(b.id))

  const router = routers[0]
  if (!router) {
    throw new Error('no active router services found')
  }
  return router
}

async function isRouterHealthy(router: MarketServiceRow): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)
  try {
    const response = await fetch(new URL('/health', router.endpoint), {signal: controller.signal})
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

export async function discoverBestRouter(options: {url?: string; marketContract: string}): Promise<MarketServiceRow> {
  const services = await getTableRows<MarketServiceRow>(options.marketContract, 'services', {
    url: options.url,
    limit: 1000,
  })
  const candidates = services.rows
    .filter((service) => Number(service.service_type) === 14)
    .filter((service) => isActive(service.active))
    .filter((service) => service.endpoint.startsWith('http://') || service.endpoint.startsWith('https://'))

  const healthy: MarketServiceRow[] = []
  for (const router of candidates) {
    if (await isRouterHealthy(router)) {
      healthy.push(router)
    }
  }
  return selectBestRouter(healthy)
}

export function buildRouterUploadHeaders(input: Omit<RouterUploadInput, 'router'>): Record<string, string> {
  return {
    'content-type': 'application/octet-stream',
    'x-harbor-object-id': String(input.objectId),
    'x-harbor-content-hash': input.contentHash,
    'x-harbor-owner': input.owner,
    'x-harbor-bytes': String(input.bytes.length),
  }
}

export async function uploadToRouter(input: RouterUploadInput): Promise<RouterDistributionResult> {
  const body = input.bytes.buffer.slice(
    input.bytes.byteOffset,
    input.bytes.byteOffset + input.bytes.byteLength
  ) as ArrayBuffer
  const response = await fetch(new URL('/storage/objects', input.router.endpoint), {
    method: 'POST',
    headers: buildRouterUploadHeaders(input),
    body,
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) as RouterDistributionResult : {}
  if (!response.ok) {
    throw new Error(`router upload failed: ${response.status} ${text}`)
  }
  return payload
}

export async function resolveStorageObjectId(options: {
  url?: string
  storageContract: string
  owner: string
  contentHash: string
}): Promise<number> {
  const byHash = await getTableRows<StorageObjectRow>(options.storageContract, 'objects', {
    url: options.url,
    scope: options.storageContract,
    indexPosition: '3',
    keyType: 'sha256',
    lowerBound: options.contentHash,
    upperBound: options.contentHash,
    limit: 10,
  })
  const exact = byHash.rows.find((row) => row.content_hash === options.contentHash && row.owner === options.owner)
  if (exact) {
    return Number(exact.id)
  }

  const scan = await getTableRows<StorageObjectRow>(options.storageContract, 'objects', {
    url: options.url,
    scope: options.storageContract,
    limit: 1000,
  })
  const scanned = scan.rows.find((row) => row.content_hash === options.contentHash && row.owner === options.owner)
  if (!scanned) {
    throw new Error(`storage object not found for hash ${options.contentHash}`)
  }
  return Number(scanned.id)
}

export async function resolveStorageObjectByHash(options: {
  url?: string
  storageContract: string
  contentHash: string
}): Promise<StorageObjectRow> {
  const byHash = await getTableRows<StorageObjectRow>(options.storageContract, 'objects', {
    url: options.url,
    scope: options.storageContract,
    indexPosition: '3',
    keyType: 'sha256',
    lowerBound: options.contentHash,
    upperBound: options.contentHash,
    limit: 10,
  })
  const exact = byHash.rows.find((row) => row.content_hash === options.contentHash)
  if (exact) {
    return exact
  }

  const scan = await getTableRows<StorageObjectRow>(options.storageContract, 'objects', {
    url: options.url,
    scope: options.storageContract,
    limit: 1000,
  })
  const scanned = scan.rows.find((row) => row.content_hash === options.contentHash)
  if (!scanned) {
    throw new Error(`storage object not found for hash ${options.contentHash}`)
  }
  return scanned
}

export function storageProvidersForReplicas(
  replicas: StorageReplicaRow[],
  services: MarketServiceRow[],
  objectId: number,
): Array<Pick<MarketServiceRow, 'provider' | 'endpoint'>> {
  const replicaProviders = new Set(
    replicas
      .filter((replica) => Number(replica.object_id) === objectId)
      .filter((replica) => isActive(replica.active))
      .map((replica) => replica.provider)
  )
  return services
    .filter((service) => replicaProviders.has(service.provider))
    .filter((service) => Number(service.service_type) === 3)
    .filter((service) => isActive(service.active))
    .filter((service) => service.endpoint.startsWith('http://') || service.endpoint.startsWith('https://'))
    .map((service) => ({provider: service.provider, endpoint: service.endpoint}))
}

export async function downloadStoredObjectBytes(options: Omit<StorageDownloadOptions, 'output'>): Promise<{
  bytes: Buffer
  provider: Pick<MarketServiceRow, 'provider' | 'endpoint'>
}> {
  const storageContract = options.storageContract ?? process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore'
  const marketContract = options.marketContract ?? process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket'
  const object = await resolveStorageObjectByHash({
    url: options.url,
    storageContract,
    contentHash: options.contentHash,
  })
  const objectId = Number(object.id)
  const replicas = await getTableRows<StorageReplicaRow>(storageContract, 'replicas', {
    url: options.url,
    scope: storageContract,
    indexPosition: '2',
    keyType: 'i64',
    lowerBound: String(objectId),
    upperBound: String(objectId),
    limit: 1000,
  })
  const services = await getTableRows<MarketServiceRow>(marketContract, 'services', {
    url: options.url,
    scope: marketContract,
    limit: 1000,
  })
  const providers = storageProvidersForReplicas(replicas.rows, services.rows, objectId)
  if (providers.length === 0) {
    throw new Error(`no active storage replicas found for object ${objectId}`)
  }

  const failures: string[] = []
  for (const provider of providers) {
    try {
      const response = await fetch(new URL(`/objects/${options.contentHash}`, provider.endpoint))
      const body = Buffer.from(await response.arrayBuffer())
      const actual = sha256(body)
      if (!response.ok) {
        failures.push(`${provider.provider}: ${response.status}`)
        continue
      }
      if (actual !== options.contentHash) {
        failures.push(`${provider.provider}: hash mismatch ${actual}`)
        continue
      }
      if (options.expectedSha256 && actual !== options.expectedSha256) {
        failures.push(`${provider.provider}: checksum mismatch ${actual}`)
        continue
      }
      return {bytes: body, provider}
    } catch (error) {
      failures.push(`${provider.provider}: ${(error as Error).message}`)
    }
  }
  throw new Error(`failed to download object ${options.contentHash}: ${failures.join('; ')}`)
}

export async function downloadStoredObject(options: StorageDownloadOptions): Promise<StorageDownloadResult> {
  const {bytes, provider} = await downloadStoredObjectBytes(options)
  const actual = sha256(bytes)
  if (options.output) {
    await fs.mkdir(path.dirname(path.resolve(options.output)), {recursive: true})
    await fs.writeFile(options.output, bytes)
  }
  return {
    content_hash: options.contentHash,
    bytes: bytes.length,
    sha256: actual,
    output: options.output ? path.resolve(options.output) : undefined,
    provider,
  }
}

export async function putReplicatedObject(options: ReplicatedPutOptions): Promise<ReplicatedPutResult> {
  const marketContract = options.marketContract ?? process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket'
  const storageContract = options.storageContract ?? process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore'
  const prepared = await prepareStoredObject(options)

  const putResult = await pushAction({
    contract: storageContract,
    action: 'putobject',
    data: {
      owner: options.owner,
      content_hash: prepared.contentHash,
      bytes: prepared.bytes,
      encrypted: prepared.encrypted,
      encryption_key_hash: prepared.encryptionKeyHash,
      metadata: prepared.metadata,
    },
    url: options.url,
    actor: options.actor ?? options.owner,
    permission: options.permission,
    key: options.key,
    expiration: options.expiration,
    json: options.json,
  })
  const objectId = await resolveStorageObjectId({
    url: options.url,
    storageContract,
    owner: options.owner,
    contentHash: prepared.contentHash,
  })
  const router = options.routerUrl
    ? {id: 'override', provider: 'override', service_type: 14, active: true, endpoint: options.routerUrl}
    : await discoverBestRouter({url: options.url, marketContract})
  const distribution = await uploadToRouter({
    router,
    objectId,
    owner: options.owner,
    contentHash: prepared.contentHash,
    bytes: prepared.storedBytes,
  })

  return {
    sourcePath: prepared.sourcePath,
    content_hash: prepared.contentHash,
    source_hash: prepared.sourceHash,
    bytes: prepared.bytes,
    encrypted: prepared.encrypted,
    encryption_key_hash: prepared.encryptionKeyHash,
    object_id: objectId,
    put_tx: (putResult as {transaction_id?: string}).transaction_id,
    router: {id: router.id, provider: router.provider, endpoint: router.endpoint},
    selected_storage_providers: distribution.selected_storage_providers ?? [],
    replica_count: Number(distribution.replica_count ?? 0),
    assignment_tx: typeof distribution.assignment_tx === 'string' ? distribution.assignment_tx : undefined,
    distribution,
  }
}

export async function distributeStoredObject(options: Omit<ReplicatedPutOptions, 'storageContract'> & {objectId: number; contentHash: string}): Promise<RouterDistributionResult> {
  const marketContract = options.marketContract ?? process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket'
  const prepared = await prepareStoredObject(options)
  if (prepared.contentHash !== options.contentHash) {
    throw new Error(`content hash mismatch: expected ${options.contentHash}, got ${prepared.contentHash}`)
  }
  const router = options.routerUrl
    ? {id: 'override', provider: 'override', service_type: 14, active: true, endpoint: options.routerUrl}
    : await discoverBestRouter({url: options.url, marketContract})
  return uploadToRouter({
    router,
    objectId: options.objectId,
    owner: options.owner,
    contentHash: options.contentHash,
    bytes: prepared.storedBytes,
  })
}

async function walk(root: string, current = root): Promise<StorageManifestEntry[]> {
  const entries = await fs.readdir(current, {withFileTypes: true})
  const result: StorageManifestEntry[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue
    }
    const fullPath = path.join(current, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await walk(root, fullPath)))
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    const stat = await fs.stat(fullPath)
    result.push({
      path: path.relative(root, fullPath),
      bytes: stat.size,
      sha256: await hashFile(fullPath),
    })
  }

  return result.sort((a, b) => a.path.localeCompare(b.path))
}

export async function buildStorageManifest(root: string) {
  await fs.mkdir(root, {recursive: true})
  const files = await walk(root)
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  const manifestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(files))
    .digest('hex')

  return {
    generatedAt: new Date().toISOString(),
    root,
    totalFiles: files.length,
    totalBytes,
    manifestHash,
    files,
  }
}

function resolveStoragePath(root: string, requestPath: string): string {
  const decoded = decodeURIComponent(requestPath)
  const fullPath = path.resolve(root, decoded.replace(/^\/+/, ''))
  const resolvedRoot = path.resolve(root)
  if (!fullPath.startsWith(`${resolvedRoot}${path.sep}`) && fullPath !== resolvedRoot) {
    throw new Error('path escapes storage root')
  }
  return fullPath
}

export function serveStorageManifest(root: string, port: number): http.Server {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
      if (url.pathname === '/health') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ok: true}))
        return
      }
      if (url.pathname === '/manifest') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(await buildStorageManifest(root), null, 2))
        return
      }
      if (url.pathname.startsWith('/files/')) {
        const fullPath = resolveStoragePath(root, url.pathname.slice('/files/'.length))
        const file = await fs.readFile(fullPath)
        response.end(file)
        return
      }

      response.statusCode = 404
      response.end('not found')
    } catch (error) {
      response.statusCode = 400
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({error: error instanceof Error ? error.message : String(error)}))
    }
  })

  server.listen(port, '127.0.0.1')
  return server
}
