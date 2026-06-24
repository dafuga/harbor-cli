import {Checksum256, PrivateKey, Transaction} from '@wharfkit/antelope'
import {AbstractWalletPlugin, LoginContext, TransactContext, WalletPluginMetadata} from '@wharfkit/session'
import {WalletPluginPrivateKey} from '@wharfkit/wallet-plugin-privatekey'
import {resolvePrivateKey} from './wallet.js'

function publicKeyStrings(privateKey: PrivateKey): string[] {
  const publicKey = privateKey.toPublic()
  const legacy = (publicKey as unknown as {toLegacyString?: () => string}).toLegacyString?.()
  return [publicKey.toString(), legacy].filter((key): key is string => Boolean(key))
}

class MultiPrivateKeyWalletPlugin extends AbstractWalletPlugin {
  id = 'harbor-multi-privatekey'
  config = {
    requiresChainSelect: false,
    requiresPermissionSelect: false,
    requiresPermissionEntry: false,
  }
  metadata = WalletPluginMetadata.from({
    name: 'Harbor Private Key Signer',
    description: 'Signs non-interactive Harbor transactions with one or more private keys.',
  })

  constructor(private readonly privateKeys: PrivateKey[], private readonly url?: string) {
    super()
    if (privateKeys.length === 1) {
      this.metadata.publicKey = String(privateKeys[0].toPublic())
    }
  }

  async login(context: LoginContext) {
    if (!context.permissionLevel) {
      throw new Error('missing permission level for private key login')
    }
    return {
      chain: context.chain ? context.chain.id : context.chains[0].id,
      permissionLevel: context.permissionLevel,
    }
  }

  async sign(resolved: {transaction: unknown}, context: TransactContext) {
    const transaction = Transaction.from(resolved.transaction as any)
    const availableKeys = [...new Set(this.privateKeys.flatMap(publicKeyStrings))]
    const response = await context.fetch(new URL('/v1/chain/get_required_keys', this.url ?? context.chain.url), {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        transaction: transaction.toJSON(),
        available_keys: availableKeys,
      }),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`failed to resolve required signing keys: ${response.status} ${text}`)
    }
    const requiredKeys = new Set((JSON.parse(text) as {required_keys?: string[]}).required_keys ?? [])
    const signingKeys = this.privateKeys.filter((privateKey) => publicKeyStrings(privateKey).some((publicKey) => requiredKeys.has(publicKey)))
    if (signingKeys.length === 0) {
      throw new Error(`none of the provided private keys satisfy required keys: ${[...requiredKeys].join(', ')}`)
    }
    const digest = transaction.signingDigest(Checksum256.from(context.chain.id))
    return {
      signatures: signingKeys.map((privateKey) => privateKey.signDigest(digest)),
    }
  }
}

async function resolvePrivateKeys(keyOption: string | undefined, actor: string): Promise<PrivateKey[]> {
  const rawKeys = keyOption ?? process.env.HARBOR_PRIVATE_KEY
  if (!rawKeys || !rawKeys.includes(',')) {
    return [PrivateKey.from(await resolvePrivateKey(keyOption, actor))]
  }
  return Promise.all(
    rawKeys.split(',').filter(Boolean).map(async (key) => PrivateKey.from(await resolvePrivateKey(key.trim(), actor)))
  )
}

export async function walletPluginFor(keyOption: string | undefined, actor: string, url?: string) {
  const privateKeys = await resolvePrivateKeys(keyOption, actor)
  const walletPlugin = privateKeys.length === 1
    ? new WalletPluginPrivateKey(privateKeys[0])
    : new MultiPrivateKeyWalletPlugin(privateKeys, url)
  walletPlugin.config.requiresChainSelect = false
  walletPlugin.config.requiresPermissionSelect = false
  walletPlugin.config.requiresPermissionEntry = false
  return walletPlugin
}
