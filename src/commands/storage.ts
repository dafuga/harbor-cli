import {Command} from 'commander'
import fs from 'node:fs/promises'
import {defaultStorageDir} from '../lib/config.js'
import {buildStorageManifest, distributeStoredObject, downloadStoredObject, GovernedStorageEncryption, putReplicatedObject, putWalrusObject, serveStorageManifest, storeObject} from '../lib/storage.js'
import {parseVaultPublicKey} from '../lib/vault-crypto.js'
import {addTxOptions} from './action.js'
import {addJsonActionCommand, Field} from './action-fields.js'

const STORAGE_CONTRACT = process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore'

interface GovernedStorageCliOptions {
  encrypt?: boolean
  privateKey?: string
  recipientPublicKey?: string
  vaultPolicyId?: string
  vaultConsentId?: string
  purpose?: string
  ttlSec?: string
  createdAt?: string
  keyCustodians?: string
}

function addGovernedEncryptionOptions(command: Command): Command {
  return command
    .option('--encrypt', 'use the interoperable governed-data envelope and temporary storage')
    .option('--recipient-public-key <file>', 'unique per-object governed-data public key JSON')
    .option('--vault-policy-id <id>', 'Vault policy id bound into authenticated context')
    .option('--vault-consent-id <id>', 'Vault consent id bound into authenticated context')
    .option('--purpose <purpose>', 'authorized processing purpose')
    .option('--ttl-sec <seconds>', 'envelope and temporary-object lifetime', '86400')
    .option('--created-at <unix>', 'envelope creation time; defaults to current Unix seconds')
    .option('--key-custodians <json>', 'JSON array of accounts required to attest key erasure')
    .option('--private-key <key>', 'removed legacy option; password-derived encryption is rejected')
}

async function governedEncryption(options: GovernedStorageCliOptions): Promise<GovernedStorageEncryption | undefined> {
  const governedValues = [
    options.recipientPublicKey, options.vaultPolicyId,
    options.vaultConsentId, options.purpose,
    options.keyCustodians,
  ]
  if (!options.encrypt) {
    if (options.privateKey) {
      throw new Error('password-derived storage encryption was removed; use --encrypt with a recipient public key')
    }
    if (governedValues.some(Boolean)) {
      throw new Error('--encrypt is required when governed-data options are supplied')
    }
    return undefined
  }
  if (options.privateKey) {
    throw new Error('--private-key cannot be used for governed encryption; collectors receive only a public key')
  }
  const missing = [
    ['--recipient-public-key', options.recipientPublicKey],
    ['--vault-policy-id', options.vaultPolicyId],
    ['--vault-consent-id', options.vaultConsentId],
    ['--purpose', options.purpose],
    ['--key-custodians', options.keyCustodians],
  ].filter(([, value]) => !value).map(([flag]) => flag)
  if (missing.length > 0) throw new Error(`missing governed encryption options: ${missing.join(', ')}`)

  const ttlSec = Number(options.ttlSec ?? 86400)
  const createdAt = options.createdAt === undefined ? Math.floor(Date.now() / 1000) : Number(options.createdAt)
  if (!Number.isSafeInteger(ttlSec) || ttlSec <= 0 ||
      !Number.isSafeInteger(createdAt) || createdAt <= 0 ||
      createdAt > Number.MAX_SAFE_INTEGER - ttlSec) {
    throw new Error('--ttl-sec and --created-at must define a valid positive lifetime')
  }
  let keyCustodians: unknown
  try {
    keyCustodians = JSON.parse(options.keyCustodians ?? '')
  } catch {
    throw new Error('--key-custodians must be a JSON array')
  }
  if (!Array.isArray(keyCustodians) || keyCustodians.length === 0 ||
      keyCustodians.some((value) => typeof value !== 'string' || !value)) {
    throw new Error('--key-custodians must be a non-empty JSON array of accounts')
  }
  const key = parseVaultPublicKey(await fs.readFile(options.recipientPublicKey as string, 'utf8'))
  return {
    recipientPublicKey: key.publicKey,
    context: {
      policy_id: options.vaultPolicyId as string,
      consent_id: options.vaultConsentId as string,
      receipt_id: '',
      object_id: '',
      purpose: options.purpose as string,
      created_at: createdAt,
      expires_at: createdAt + ttlSec,
    },
    recipient: {
      grant_id: '',
      processor: '',
      key_id: key.keyId,
    },
    keyCustodians: keyCustodians as string[],
  }
}

function addLocalStorageCommands(storage: Command): void {
  addTxOptions(
    addGovernedEncryptionOptions(storage
      .command('put <file>')
      .description('Register a Harbor storage object and distribute it through the best active router')
      .requiredOption('--owner <account>', 'Harbor account that owns the storage object')
      .option('--backend <backend>', 'storage backend: harbor or walrus', 'harbor')
      .option('--metadata <metadata>', 'object metadata to register on-chain')
      .option('--market-contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
      .option('--storage-contract <account>', 'storage registry contract account', STORAGE_CONTRACT)
      .option('--router-url <url>', 'explicit endpoint of an active on-chain router service')
      .option('--walrus-command <path>', 'Walrus CLI command', process.env.WALRUS_CLI ?? 'walrus')
      .option('--walrus-publisher-url <url>', 'Walrus publisher URL')
      .option('--walrus-aggregator-url <url>', 'Walrus aggregator URL to preserve in metadata')
      .option('--walrus-epochs <epochs>', 'Walrus storage epochs')
      .option('--content-format <format>', 'content format preserved in Walrus metadata')
      .option('--prepared-output <path>', 'persist exact governed envelope bytes here before chain registration'))
  ).action(async (file: string, options: {
    owner: string
    backend?: string
    metadata?: string
    encrypt?: boolean
    privateKey?: string
    recipientPublicKey?: string
    vaultPolicyId?: string
    vaultConsentId?: string
    purpose?: string
    ttlSec?: string
    createdAt?: string
    keyCustodians?: string
    marketContract?: string
    storageContract?: string
    routerUrl?: string
    walrusCommand?: string
    walrusPublisherUrl?: string
    walrusAggregatorUrl?: string
    walrusEpochs?: string
    contentFormat?: string
    preparedOutput?: string
    url?: string
    actor?: string
    permission?: string
    key?: string
    json?: boolean
    expiration?: string
  }) => {
    const governed = await governedEncryption(options)
    if (options.backend === 'walrus') {
      console.log(JSON.stringify(await putWalrusObject({...options, file, governed}), null, 2))
      return
    }
    if (options.backend && options.backend !== 'harbor') {
      throw new Error(`unknown storage backend: ${options.backend}`)
    }
    console.log(JSON.stringify(await putReplicatedObject({...options, file, governed}), null, 2))
  })

  addGovernedEncryptionOptions(storage
    .command('put-local <file>')
    .description('Store a file in a local provider storage root without chain registration or router distribution')
    .option('--root <path>', 'storage root', defaultStorageDir())
    .option('--metadata <metadata>', 'object metadata to register on-chain'))
    .action(async (file: string, options: {root: string; metadata?: string} & GovernedStorageCliOptions) => {
      const governed = await governedEncryption(options)
      console.log(JSON.stringify(await storeObject({
        root: options.root,
        file,
        encrypt: options.encrypt,
        privateKey: options.privateKey,
        governed,
        metadata: options.metadata,
      }), null, 2))
    })

  addTxOptions(
    storage
      .command('distribute <file>')
      .description('Retry router distribution for an already registered storage object')
      .requiredOption('--owner <account>', 'Harbor account that owns the storage object')
      .requiredOption('--object-id <id>', 'harborstore object id')
      .requiredOption('--content-hash <hash>', 'registered content hash')
      .option('--market-contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
      .option('--storage-contract <account>', 'storage registry contract account', STORAGE_CONTRACT)
      .option('--router-url <url>', 'explicit endpoint of an active on-chain router service')
  ).action(async (file: string, options: {
    owner: string
    objectId: string
    contentHash: string
    marketContract?: string
    storageContract?: string
    routerUrl?: string
    url?: string
    actor?: string
    permission?: string
    key?: string
    json?: boolean
    expiration?: string
  }) => {
    console.log(JSON.stringify(await distributeStoredObject({
      ...options,
      file,
      objectId: options.objectId,
      contentHash: options.contentHash,
    }), null, 2))
  })

  storage
    .command('get')
    .description('Download a Harbor storage object from active replicas')
    .requiredOption('--content-hash <hash>', 'content hash to download')
    .requiredOption('-o, --output <path>', 'output path')
    .option('--expected-sha256 <hash>', 'expected SHA-256 checksum; defaults to content hash')
    .option('--market-contract <account>', 'service market contract account', process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket')
    .option('--storage-contract <account>', 'storage registry contract account', STORAGE_CONTRACT)
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .action(async (options: {
      contentHash: string
      output: string
      expectedSha256?: string
      marketContract?: string
      storageContract?: string
      url?: string
    }) => {
      console.log(JSON.stringify(await downloadStoredObject({
        contentHash: options.contentHash,
        output: options.output,
        expectedSha256: options.expectedSha256 ?? options.contentHash,
        marketContract: options.marketContract,
        storageContract: options.storageContract,
        url: options.url,
      }), null, 2))
    })

  storage
    .command('manifest')
    .description('Print a storage manifest')
    .option('--root <path>', 'storage root', defaultStorageDir())
    .action(async (options: {root: string}) => {
      console.log(JSON.stringify(await buildStorageManifest(options.root), null, 2))
    })

  storage
    .command('serve')
    .description('Serve /health, /manifest, and /files/* from a storage root')
    .option('--root <path>', 'storage root', defaultStorageDir())
    .option('--port <port>', 'listen port', '9090')
    .action((options: {root: string; port: string}) => {
      const port = Number(options.port)
      serveStorageManifest(options.root, port)
      console.log(`Harbor storage manifest server listening on http://127.0.0.1:${port}`)
    })
}

function addStorageAction(storage: Command, spec: {command: string; action: string; fields: Field[]; signerField?: string}): void {
  addJsonActionCommand(storage, STORAGE_CONTRACT, spec)
}

function addStorageContractCommands(storage: Command): void {
  addStorageAction(storage, {command: 'configure', action: 'setparams', fields: [['required_replicas', 'number'], ['max_metadata_size', 'number']]})
  addStorageAction(storage, {command: 'set-market', action: 'setmarket', fields: ['svcmarket_contract']})
  addStorageAction(storage, {command: 'set-retirement', action: 'setretire', fields: [['loss_timeout_sec', 'number']]})
  addStorageAction(storage, {
    command: 'set-lock-protocol',
    action: 'setlockprot',
    fields: ['protocol', ['active', 'boolean']],
  })
  addStorageAction(storage, {command: 'migrate-keys', action: 'migratekeys', fields: [['max_rows', 'number']]})
  addStorageAction(storage, {command: 'migrate-capacity', action: 'migcapacity', fields: [['max_rows', 'number']]})
  addStorageAction(storage, {
    command: 'put-object',
    action: 'putobject',
    fields: ['owner', 'content_hash', ['bytes', 'uint64'], ['encrypted', 'boolean'], 'encryption_key_hash', 'metadata'],
    signerField: 'owner',
  })
  addStorageAction(storage, {
    command: 'put-temporary',
    action: 'puttemp',
    fields: [
      'owner', 'content_hash', ['bytes', 'uint64'], ['encrypted', 'boolean'],
      'encryption_key_hash', ['ttl_sec', 'number'], ['key_custodians', 'json'], 'metadata',
    ],
    signerField: 'owner',
  })
  addStorageAction(storage, {
    command: 'put-temporary-at',
    action: 'puttempat',
    fields: [
      'owner', 'content_hash', ['bytes', 'uint64'], ['encrypted', 'boolean'],
      'encryption_key_hash', 'expires_at', ['key_custodians', 'json'], 'metadata',
    ],
    signerField: 'owner',
  })
  addStorageAction(storage, {
    command: 'authorize-custodian',
    action: 'authcust',
    fields: ['custodian', 'owner', ['active', 'boolean']],
    signerField: 'custodian',
  })
  addStorageAction(storage, {
    command: 'add-key-custodian',
    action: 'addkeycust',
    fields: ['owner', ['object_id', 'uint64'], 'custodian'],
    signerField: 'owner',
  })
  addStorageAction(storage, {
    command: 'set-expiry',
    action: 'setexpiry',
    fields: ['owner', ['object_id', 'uint64'], ['ttl_sec', 'number']],
    signerField: 'owner',
  })
  addStorageAction(storage, {
    command: 'lock-object',
    action: 'lockobject',
    fields: ['owner', ['object_id', 'uint64'], 'controller', 'reason_hash'],
    signerField: 'owner',
  })
  addStorageAction(storage, {
    command: 'lock-until',
    action: 'lockuntil',
    fields: [
      'owner', ['object_id', 'uint64'], 'controller', 'reason_hash',
      'retention_until',
    ],
    signerField: 'owner',
  })
  addStorageAction(storage, {
    command: 'protocol-lock',
    action: 'protolock',
    fields: [
      'controller', 'owner', ['object_id', 'uint64'], 'reason_hash',
      'retention_until',
    ],
    signerField: 'controller',
  })
  addStorageAction(storage, {
    command: 'unlock-object',
    action: 'unlockobj',
    fields: ['controller', ['object_id', 'uint64']],
    signerField: 'controller',
  })
  addStorageAction(storage, {
    command: 'tombstone',
    action: 'tombstone',
    fields: ['actor', ['object_id', 'uint64'], 'reason_hash'],
    signerField: 'actor',
  })
  addStorageAction(storage, {
    command: 'retire-chunk',
    action: 'retirechunk',
    fields: [['object_id', 'uint64'], ['max_rows', 'number']],
  })
  addStorageAction(storage, {
    command: 'attest-delete',
    action: 'attestdel',
    fields: ['provider', ['object_id', 'uint64'], ['replica_id', 'uint64'], 'evidence_hash'],
    signerField: 'provider',
  })
  addStorageAction(storage, {
    command: 'attest-lost',
    action: 'attestlost',
    fields: ['verifier', ['object_id', 'uint64'], ['replica_id', 'uint64'], 'evidence_hash'],
    signerField: 'verifier',
  })
  addStorageAction(storage, {
    command: 'attest-key-erasure',
    action: 'attestkey',
    fields: ['custodian', ['object_id', 'uint64'], 'evidence_hash'],
    signerField: 'custodian',
  })
  addStorageAction(storage, {
    command: 'authorize-router',
    action: 'authroute',
    fields: ['owner', ['object_id', 'uint64'], 'router', 'expires_at'],
    signerField: 'owner',
  })
  addStorageAction(storage, {command: 'assign', action: 'assign', fields: [['object_id', 'uint64'], ['providers', 'json']]})
  addStorageAction(storage, {command: 'route-assign', action: 'routeassign', fields: ['router', ['object_id', 'uint64'], ['providers', 'json']], signerField: 'router'})
  addStorageAction(storage, {command: 'offline-replica', action: 'offreplica', fields: [['replica_id', 'uint64']]})
  addStorageAction(storage, {command: 'reassign', action: 'reassign', fields: [['replica_id', 'uint64'], 'new_provider']})
  // Preserve the published object-report command. Per-replica reporting is a
  // new capability and must not silently reinterpret existing scripts.
  addStorageAction(storage, {command: 'report', action: 'report', fields: [['object_id', 'uint64'], 'verifier', ['healthy', 'boolean'], 'report_hash'], signerField: 'verifier'})
  addStorageAction(storage, {command: 'report-replica', action: 'repreport', fields: [['replica_id', 'uint64'], 'verifier', ['healthy', 'boolean'], 'report_hash'], signerField: 'verifier'})
}

export function createStorageCommand(): Command {
  const storage = new Command('storage')
  storage.description('Serve and inspect Harbor storage manifests')
  addLocalStorageCommands(storage)
  addStorageContractCommands(storage)

  return storage
}
