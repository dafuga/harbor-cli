import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

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

export async function storeObject(options: StoreObjectOptions): Promise<StoredObjectResult> {
  if (options.encrypt && !options.privateKey) {
    throw new Error('--private-key is required when --encrypt is set')
  }

  const sourcePath = path.resolve(options.file)
  const source = await fs.readFile(sourcePath)
  const sourceHash = sha256(source)
  const encrypted = Boolean(options.encrypt)
  const storedBytes = encrypted ? encryptBytes(source, options.privateKey ?? '') : source
  const contentHash = sha256(storedBytes)
  const storedPath = objectPath(options.root, contentHash)
  await fs.mkdir(path.dirname(storedPath), {recursive: true})
  await fs.writeFile(storedPath, storedBytes)

  const metadata = options.metadata ?? path.basename(sourcePath)
  const encryptionKeyHash = encrypted ? sha256(options.privateKey ?? '') : '0'.repeat(64)
  return {
    sourcePath,
    storedPath,
    contentHash,
    sourceHash,
    bytes: storedBytes.length,
    encrypted,
    encryptionKeyHash,
    metadata,
    registerAction: {
      contract: 'harborstore',
      action: 'putobject',
      data: [
        '<owner>',
        contentHash,
        storedBytes.length,
        encrypted,
        encryptionKeyHash,
        metadata,
      ],
    },
  }
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
