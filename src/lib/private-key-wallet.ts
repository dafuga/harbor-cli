import {Checksum256, PublicKey, Transaction} from '@wharfkit/antelope'
import {AbstractWalletPlugin, LoginContext, TransactContext, WalletPluginMetadata} from '@wharfkit/session'
import type {ResolvedSigningRequest} from '@wharfkit/signing-request'
import {isRawAntelopeKey} from './keystore.js'
import {resolveAntelopeSigner} from './wallet.js'
import type {AntelopeSigner} from './wallet.js'

export type TransactionReview = (transaction: ResolvedSigningRequest) => Promise<void>

export async function antelopeSigners(keyOption?: string, actor?: string): Promise<AntelopeSigner[]> {
  const source = keyOption !== undefined ? '--key'
    : process.env.HARBOR_PRIVATE_KEY !== undefined ? 'HARBOR_PRIVATE_KEY' : 'WHARFKIT_DEPLOY_KEY'
  const selection = keyOption ?? process.env.HARBOR_PRIVATE_KEY ?? process.env.WHARFKIT_DEPLOY_KEY
  const names = selection?.split(',').map((key) => key.trim()) ?? [undefined]
  if (names.some((key) => key === '')) throw new Error('provide a key for each entry in --key')
  if (names.some((key) => key !== undefined && isRawAntelopeKey(key))) {
    throw new Error(`raw private keys are not accepted from ${source}; import into the keystore with harbor keys import or create a Secure Enclave key, then select it by name`)
  }
  const signers = await Promise.all(names.map((name) => resolveAntelopeSigner(name, actor)))
  return [...new Map(signers.map((signer) => [signer.publicKey.toString(), signer])).values()]
}

class HarborSigningWallet extends AbstractWalletPlugin {
  id = 'harbor-signing-wallet'
  config = {
    requiresChainSelect: false,
    requiresPermissionSelect: false,
    requiresPermissionEntry: false,
  }
  metadata = WalletPluginMetadata.from({
    name: 'Harbor Signer',
    description: 'Signs Harbor transactions with local keys.',
  })

  constructor(
    private readonly signers: AntelopeSigner[],
    private readonly url?: string,
    private readonly review?: TransactionReview,
  ) {
    super()
    if (signers.length === 1) this.metadata.publicKey = signers[0].publicKey.toString()
  }

  async login(context: LoginContext) {
    if (!context.permissionLevel) throw new Error('missing permission level for wallet login')
    return {
      chain: context.chain ? context.chain.id : context.chains[0].id,
      permissionLevel: context.permissionLevel,
    }
  }

  private async requiredSigners(transaction: Transaction, context: TransactContext): Promise<AntelopeSigner[]> {
    if (this.signers.length === 1) return this.signers
    const availableKeys = this.signers.map(({publicKey}) => publicKey.toString())
    const response = await context.fetch(new URL('/v1/chain/get_required_keys', this.url ?? context.chain.url), {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({transaction: transaction.toJSON(), available_keys: availableKeys}),
    })
    if (!response.ok) throw new Error(`failed to resolve required signing keys (HTTP ${response.status})`)
    const {required_keys} = await response.json() as {required_keys: string[]}
    const required = new Set(required_keys.map((key) => PublicKey.from(key).toString()))
    const selected = this.signers.filter(({publicKey}) => required.has(publicKey.toString()))
    if (!selected.length || selected.length !== required.size) {
      throw new Error('the node returned required keys outside the selected wallet keys')
    }
    return selected
  }

  async sign(resolved: ResolvedSigningRequest, context: TransactContext) {
    await this.review?.(resolved)
    const transaction = Transaction.from(resolved.transaction)
    const message = transaction.signingData(Checksum256.from(context.chain.id))
    const signatures = []
    // Keep terminal and macOS authentication prompts sequential.
    for (const signer of await this.requiredSigners(transaction, context)) {
      signatures.push(await signer.sign(message))
    }
    return {signatures}
  }
}

export async function walletPluginFor(keyOption: string | undefined, actor: string, url?: string, review?: TransactionReview) {
  return new HarborSigningWallet(await antelopeSigners(keyOption, actor), url, review)
}
