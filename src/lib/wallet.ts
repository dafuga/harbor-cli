import fs from 'node:fs/promises'
import path from 'node:path'
import {PrivateKey} from '@wharfkit/antelope'
import {harborHome} from './config.js'

export interface WalletKey {
  name: string
  privateKey: string
  publicKey: string
}

interface WalletFile {
  keys: WalletKey[]
}

export function walletPath(): string {
  return path.join(harborHome(), 'wallet.json')
}

async function loadWallet(): Promise<WalletFile> {
  try {
    return JSON.parse(await fs.readFile(walletPath(), 'utf8')) as WalletFile
  } catch {
    return {keys: []}
  }
}

async function saveWallet(wallet: WalletFile): Promise<void> {
  await fs.mkdir(harborHome(), {recursive: true})
  await fs.writeFile(walletPath(), `${JSON.stringify(wallet, null, 2)}\n`, {mode: 0o600})
}

export function looksLikePrivateKey(value: string): boolean {
  return value.startsWith('PVT_') || value.startsWith('5') || /^[A-Za-z0-9]{51}$/.test(value)
}

export async function addWalletKey(name: string, privateKeyValue: string): Promise<WalletKey> {
  const privateKey = PrivateKey.from(privateKeyValue)
  const key = {
    name,
    privateKey: privateKey.toString(),
    publicKey: privateKey.toPublic().toString(),
  }
  const wallet = await loadWallet()
  const existing = wallet.keys.findIndex((item) => item.name === name || item.publicKey === key.publicKey)
  if (existing >= 0) {
    wallet.keys[existing] = key
  } else {
    wallet.keys.push(key)
  }
  await saveWallet(wallet)
  return key
}

export async function listWalletKeys(): Promise<WalletKey[]> {
  return (await loadWallet()).keys
}

export async function resolvePrivateKey(keyNameOrValue?: string, actor?: string): Promise<PrivateKey> {
  const candidate = keyNameOrValue ?? process.env.HARBOR_PRIVATE_KEY ?? process.env.WHARFKIT_DEPLOY_KEY
  if (candidate && looksLikePrivateKey(candidate)) {
    return PrivateKey.from(candidate)
  }

  const keys = await listWalletKeys()
  if (candidate) {
    const key = keys.find((item) => item.name === candidate || item.publicKey === candidate)
    if (!key) {
      throw new Error(`wallet key not found: ${candidate}`)
    }
    return PrivateKey.from(key.privateKey)
  }

  if (actor) {
    const byActor = keys.find((item) => item.name === actor)
    if (byActor) {
      return PrivateKey.from(byActor.privateKey)
    }
  }

  const fallback = keys.find((item) => item.name === 'default') ?? keys[0]
  if (!fallback) {
    throw new Error('no signing key available; use --key, HARBOR_PRIVATE_KEY, or harbor wallet keys add')
  }
  return PrivateKey.from(fallback.privateKey)
}
