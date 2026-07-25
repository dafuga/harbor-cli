import {Command} from 'commander'
import crypto from 'node:crypto'
import {constants as fsConstants} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  decryptVaultBytes,
  encryptVaultBytes,
  generateVaultKeyPair,
  GovernedDataContext,
  parseVaultPrivateKey,
  parseVaultPublicKey,
  requireInitialCustodyEnvelope,
  rewrapVaultEnvelope,
  VaultEnvelope,
  vaultEnvelopeFromBytes,
  vaultEnvelopeCommitment,
  vaultEnvelopeToBytes,
  vaultPrivateKeyToJson,
  vaultPublicKeyToJson,
} from '../lib/vault-crypto.js'
import {addTxOptions, pushJsonAction} from './action.js'
import {addJsonActionCommand, Field} from './action-fields.js'
import {
  distributeStoredObject,
  resolveStorageObjectId,
  storageObjectsByHash,
  storageRegistrationAction,
} from '../lib/storage.js'
import type {RouterDistributionResult, StorageLifecycleRow, StorageObjectRow} from '../lib/storage.js'
import {canonicalUint64, getTableRows, pushAction, readContractNextId} from '../lib/tx.js'

const VAULT_CONTRACT = process.env.HARBOR_VAULT_CONTRACT ?? 'harborvault'
const STORAGE_CONTRACT = process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore'
const MARKET_CONTRACT = process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket'
const UINT64_MAX = (1n << 64n) - 1n

function epochSeconds(value: unknown, label: string): number {
  if ((typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && /^\d+$/.test(value))) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  }
  if (typeof value === 'string') {
    const normalized = /(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`
    const milliseconds = Date.parse(normalized)
    if (Number.isFinite(milliseconds) && milliseconds >= 0) return Math.floor(milliseconds / 1000)
  }
  throw new Error(`${label} is not a valid chain timestamp`)
}

export function randomGrantId(): string {
  let value = 0n
  while (value === 0n || value === UINT64_MAX) value = crypto.randomBytes(8).readBigUInt64LE()
  return value.toString()
}

export function canonicalGrantId(value: unknown): string {
  const grantId = canonicalUint64(value, 'grant id')
  if (grantId === '0' || BigInt(grantId) === UINT64_MAX) {
    throw new Error('grant id must be greater than 0 and less than UINT64_MAX')
  }
  return grantId
}

async function primaryRow(
  contract: string,
  table: string,
  id: string,
  url?: string,
): Promise<Record<string, unknown>> {
  const canonical = canonicalUint64(id, `${table} id`)
  const upperBound = BigInt(canonical) === UINT64_MAX ? undefined : (BigInt(canonical) + 1n).toString()
  const result = await getTableRows<Record<string, unknown>>(contract, table, {
    url,
    scope: contract,
    lowerBound: canonical,
    ...(upperBound ? {upperBound} : {}),
    limit: 2,
    indexPosition: '1',
    keyType: 'i64',
  })
  const matches = result.rows.filter((row) => canonicalUint64(row.id ?? row.object_id, `${table} row id`) === canonical)
  if (matches.length !== 1) {
    throw new Error(`${contract}::${table} row ${canonical} found ${matches.length} exact rows`)
  }
  return matches[0]
}

async function optionalPrimaryRow(
  contract: string,
  table: string,
  id: string,
  url?: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return await primaryRow(contract, table, id, url)
  } catch (error) {
    if ((error as Error).message.endsWith('found 0 exact rows')) return undefined
    throw error
  }
}

export interface GrantAuthorizationSnapshot {
  grant: Record<string, unknown>
  receipt: Record<string, unknown>
  consent: Record<string, unknown>
  uses: number
  maxUses: number
}

export async function verifyGrantedEnvelopeOnChain(input: {
  envelope: VaultEnvelope
  grantId: string
  processor: string
  vaultContract: string
  url?: string
  now: number
  mode?: 'available' | 'consumed'
}): Promise<GrantAuthorizationSnapshot> {
  const {envelope, grantId, processor, vaultContract, url, now} = input
  if (!Number.isSafeInteger(now) || now < envelope.context.created_at || now >= envelope.context.expires_at) {
    throw new Error('HGR1 envelope is not active at the authorization time')
  }
  if (envelope.recipient_grant_id !== canonicalUint64(grantId, 'grant id') ||
      envelope.recipient_processor !== processor) {
    throw new Error('HGR1 recipient does not match the requested grant and processor')
  }
  const grant = await primaryRow(vaultContract, 'grants', grantId, url)
  const uses = Number(grant.uses)
  const maxUses = Number(grant.max_uses)
  const status = Number(grant.status)
  const available = input.mode !== 'consumed'
  const statusMatches = available ? status === 1 : (status === 1 || status === 3)
  const useCountMatches = Number.isSafeInteger(uses) && Number.isSafeInteger(maxUses) &&
    maxUses > 0 && uses >= (available ? 0 : 1) && uses <= maxUses &&
    (!available || uses < maxUses)
  if (!statusMatches || !useCountMatches || String(grant.processor) !== processor ||
      canonicalUint64(grant.id, 'grant id') !== canonicalUint64(grantId, 'grant id') ||
      String(grant.wrapped_key_commitment) !== envelope.wrapped_dek_commitment ||
      now > epochSeconds(grant.expires_at, 'grant expiry')) {
    throw new Error('Vault grant is not live or does not bind this processor HGR1 wrap')
  }
  const receiptId = canonicalUint64(grant.receipt_id, 'grant receipt id')
  const consentId = canonicalUint64(grant.consent_id, 'grant consent id')
  if (canonicalUint64(envelope.context.policy_id, 'envelope policy id') !== canonicalUint64(grant.policy_id, 'grant policy id') ||
      canonicalUint64(envelope.context.consent_id, 'envelope consent id') !== consentId) {
    throw new Error('HGD1 policy or consent does not match the live Vault grant')
  }
  const expectedPurpose = crypto.createHash('sha256').update(envelope.context.purpose).digest('hex')
  if (String(grant.purpose_hash) !== expectedPurpose) {
    throw new Error('HGD1 purpose does not match the live Vault grant')
  }
  const [receipt, consent] = await Promise.all([
    primaryRow(vaultContract, 'receipts', receiptId, url),
    primaryRow(vaultContract, 'consents', consentId, url),
  ])
  if (Number(receipt.status) !== 1 || canonicalUint64(receipt.consent_id, 'receipt consent id') !== consentId ||
      canonicalUint64(receipt.policy_id, 'receipt policy id') !== canonicalUint64(grant.policy_id, 'grant policy id') ||
      now > epochSeconds(receipt.retention_until, 'receipt retention')) {
    throw new Error('Vault receipt is not accepted, live, or bound to the grant')
  }
  if (String(receipt.payload_ciphertext_commitment) !== envelope.ciphertext_commitment ||
      String(grant.source_storage_contract) !== String(receipt.storage_contract) ||
      canonicalUint64(grant.source_storage_object_id, 'grant source storage object id') !==
        canonicalUint64(receipt.storage_object_id, 'receipt storage object id') ||
      String(grant.source_storage_content_hash) !== String(receipt.ciphertext_hash) ||
      String(grant.source_ciphertext_commitment) !== envelope.ciphertext_commitment ||
      String(grant.access_envelope_commitment) !== vaultEnvelopeCommitment(envelope) ||
      !String(grant.rewrap_custodian ?? '')) {
    throw new Error('Vault grant does not bind this HGR1 to the admitted receipt ciphertext')
  }
  if (Number(consent.status) !== 1 || canonicalUint64(consent.policy_id, 'consent policy id') !== canonicalUint64(grant.policy_id, 'grant policy id') ||
      now > epochSeconds(consent.expires_at, 'consent expiry')) {
    throw new Error('Vault consent is not active or bound to the grant')
  }
  const storageContract = String(receipt.storage_contract)
  const storageObjectId = canonicalUint64(receipt.storage_object_id, 'receipt storage object id')
  const [object, lifecycle] = await Promise.all([
    primaryRow(storageContract, 'objects', storageObjectId, url),
    primaryRow(storageContract, 'lifecycles', storageObjectId, url),
  ])
  if (Number(object.status) !== 1 || String(object.owner) !== String(receipt.submitter) ||
      String(object.content_hash) !== String(receipt.ciphertext_hash) ||
      String(object.encryption_key_hash) !== String(receipt.wrapped_key_hash) ||
      epochSeconds(lifecycle.tombstoned_at, 'storage tombstone') !== 0 ||
      epochSeconds(lifecycle.completed_at, 'storage completion') !== 0 ||
      now >= epochSeconds(lifecycle.expires_at, 'storage expiry')) {
    throw new Error('Vault receipt storage object is not live or does not match its chain commitments')
  }
  return {grant, receipt, consent, uses, maxUses}
}

export interface VaultGrantUseRecord {
  format: 'harbor.vault-grant-use.v1'
  grant_id: string
  processor: string
  envelope_commitment: string
  nonce: string
  use_hash: string
}

function grantUseHash(record: Omit<VaultGrantUseRecord, 'use_hash'>): string {
  return crypto.createHash('sha256')
    .update('harbor.vault-grant-use.v1\0', 'utf8')
    .update(record.grant_id, 'utf8')
    .update('\0', 'utf8')
    .update(record.processor, 'utf8')
    .update('\0', 'utf8')
    .update(record.envelope_commitment, 'utf8')
    .update('\0', 'utf8')
    .update(record.nonce, 'utf8')
    .digest('hex')
}

export function parseGrantUseRecord(
  value: string,
  binding: {grantId: string; processor: string; envelopeCommitment: string},
): VaultGrantUseRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Vault grant-use recovery record is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Vault grant-use recovery record is invalid')
  }
  const record = parsed as Record<string, unknown>
  const normalized: VaultGrantUseRecord = {
    format: record.format as VaultGrantUseRecord['format'],
    grant_id: canonicalGrantId(record.grant_id),
    processor: String(record.processor ?? ''),
    envelope_commitment: String(record.envelope_commitment ?? ''),
    nonce: String(record.nonce ?? ''),
    use_hash: String(record.use_hash ?? ''),
  }
  if (normalized.format !== 'harbor.vault-grant-use.v1' ||
      normalized.grant_id !== canonicalGrantId(binding.grantId) ||
      normalized.processor !== binding.processor ||
      normalized.envelope_commitment !== binding.envelopeCommitment ||
      !/^[0-9a-f]{64}$/.test(normalized.nonce) ||
      !/^[0-9a-f]{64}$/.test(normalized.use_hash) ||
      grantUseHash(normalized) !== normalized.use_hash) {
    throw new Error('Vault grant-use recovery record does not match this exact authorization')
  }
  const canonical = `${JSON.stringify(normalized)}\n`
  if (canonical !== value) {
    throw new Error('Vault grant-use recovery record is not canonical')
  }
  return normalized
}

export function createGrantUseRecord(binding: {
  grantId: string
  processor: string
  envelopeCommitment: string
}): VaultGrantUseRecord {
  const record: Omit<VaultGrantUseRecord, 'use_hash'> = {
    format: 'harbor.vault-grant-use.v1',
    grant_id: canonicalGrantId(binding.grantId),
    processor: binding.processor,
    envelope_commitment: binding.envelopeCommitment,
    nonce: crypto.randomBytes(32).toString('hex'),
  }
  return {...record, use_hash: grantUseHash(record)}
}

async function findGrantUseByHash(
  vaultContract: string,
  useHash: string,
  url?: string,
): Promise<Record<string, unknown> | undefined> {
  if (!/^[0-9a-f]{64}$/.test(useHash)) throw new Error('grant use hash must be lowercase SHA-256 hex')
  const result = await getTableRows<Record<string, unknown>>(vaultContract, 'grantuses', {
    url,
    scope: vaultContract,
    lowerBound: useHash,
    limit: 2,
    indexPosition: '5',
    keyType: 'sha256',
  })
  const matches = result.rows.filter((row) => String(row.use_hash) === useHash)
  if (matches.length > 1) throw new Error(`Vault grant use ${useHash} is not unique`)
  return matches[0]
}

export async function verifyConsumedGrantUseOnChain(input: {
  envelope: VaultEnvelope
  grantId: string
  processor: string
  useHash: string
  vaultContract: string
  url?: string
  now: number
  expectedPreviousUses?: number
}): Promise<{use: Record<string, unknown>; authorization: GrantAuthorizationSnapshot}> {
  const use = await findGrantUseByHash(input.vaultContract, input.useHash, input.url)
  if (!use || canonicalUint64(use.grant_id, 'use grant id') !== canonicalGrantId(input.grantId) ||
      String(use.processor) !== input.processor || String(use.use_hash) !== input.useHash) {
    throw new Error('exact Vault grant use was not recorded on chain')
  }
  const authorization = await verifyGrantedEnvelopeOnChain({...input, mode: 'consumed'})
  if (canonicalUint64(use.receipt_id, 'use receipt id') !==
        canonicalUint64(authorization.grant.receipt_id, 'grant receipt id') ||
      String(use.purpose_hash) !== String(authorization.grant.purpose_hash)) {
    throw new Error('Vault grant use does not reconcile with the authorized receipt and purpose')
  }
  if (input.expectedPreviousUses !== undefined && authorization.uses !== input.expectedPreviousUses + 1) {
    throw new Error('Vault grant use counter did not advance exactly once')
  }
  const expectedStatus = authorization.uses === authorization.maxUses ? 3 : 1
  if (Number(authorization.grant.status) !== expectedStatus) {
    throw new Error('Vault grant status does not match its reconciled use counter')
  }
  return {use, authorization}
}

export async function consumeGrantUseOnChain(input: {
  envelope: VaultEnvelope
  grantId: string
  processor: string
  useHash: string
  vaultContract: string
  url?: string
  now: number
  actor?: string
  permission?: string
  key?: string
  expiration?: string
  pushUse?: () => Promise<unknown>
  verifyAuthorization?: (authorization: GrantAuthorizationSnapshot) => Promise<void>
}): Promise<{resumed: boolean; transaction?: unknown; use: Record<string, unknown>}> {
  const existing = await findGrantUseByHash(input.vaultContract, input.useHash, input.url)
  if (existing) {
    const verified = await verifyConsumedGrantUseOnChain(input)
    await input.verifyAuthorization?.(verified.authorization)
    return {resumed: true, use: verified.use}
  }

  const before = await verifyGrantedEnvelopeOnChain(input)
  await input.verifyAuthorization?.(before)
  let transaction: unknown
  try {
    transaction = input.pushUse
      ? await input.pushUse()
      : await pushAction({
        contract: input.vaultContract,
        action: 'usegrant',
        data: {processor: input.processor, grant_id: canonicalGrantId(input.grantId), use_hash: input.useHash},
        url: input.url,
        actor: input.actor ?? input.processor,
        permission: input.permission,
        key: input.key,
        expiration: input.expiration,
      })
  } catch (error) {
    const reconciled = await findGrantUseByHash(input.vaultContract, input.useHash, input.url)
    if (!reconciled) throw error
  }
  const verified = await verifyConsumedGrantUseOnChain({...input, expectedPreviousUses: before.uses})
  await input.verifyAuthorization?.(verified.authorization)
  return {resumed: false, transaction, use: verified.use}
}

export async function verifyCustodySourceOnChain(input: {
  envelope: VaultEnvelope
  receiptId: string
  custodian: string
  vaultContract: string
  url?: string
  now: number
}): Promise<void> {
  const {envelope, receiptId, custodian, vaultContract, url, now} = input
  if (!Number.isSafeInteger(now) || now < envelope.context.created_at || now >= envelope.context.expires_at) {
    throw new Error('source HGD1 custody envelope is not active at the authorization time')
  }
  const receipt = await primaryRow(vaultContract, 'receipts', receiptId, url)
  const consentId = canonicalUint64(receipt.consent_id, 'receipt consent id')
  const exactEnvelopeHash = crypto.createHash('sha256').update(vaultEnvelopeToBytes(envelope)).digest('hex')
  if (Number(receipt.status) !== 1 ||
      canonicalUint64(envelope.context.policy_id, 'envelope policy id') !== canonicalUint64(receipt.policy_id, 'receipt policy id') ||
      canonicalUint64(envelope.context.consent_id, 'envelope consent id') !== consentId ||
      String(receipt.ciphertext_hash) !== exactEnvelopeHash ||
      String(receipt.payload_ciphertext_commitment) !== envelope.ciphertext_commitment ||
      now > epochSeconds(receipt.retention_until, 'receipt retention')) {
    throw new Error('source Vault receipt is not accepted, live, or bound to the custody envelope')
  }
  const consent = await primaryRow(vaultContract, 'consents', consentId, url)
  const purposeHash = crypto.createHash('sha256').update(envelope.context.purpose).digest('hex')
  if (Number(consent.status) !== 1 ||
      canonicalUint64(consent.policy_id, 'consent policy id') !== canonicalUint64(receipt.policy_id, 'receipt policy id') ||
      String(consent.purpose_hash) !== purposeHash ||
      now > epochSeconds(consent.expires_at, 'consent expiry')) {
    throw new Error('source Vault consent is not active or does not cover the HGD1 purpose')
  }
  const storageContract = String(receipt.storage_contract)
  const storageObjectId = canonicalUint64(receipt.storage_object_id, 'receipt storage object id')
  const [object, lifecycle, custodians] = await Promise.all([
    primaryRow(storageContract, 'objects', storageObjectId, url),
    primaryRow(storageContract, 'lifecycles', storageObjectId, url),
    getTableRows<Record<string, unknown>>(storageContract, 'keycusts', {
      url,
      scope: storageObjectId,
      lowerBound: custodian,
      indexPosition: '1',
      keyType: 'name',
      limit: 1,
    }),
  ])
  if (Number(object.status) !== 1 || String(object.owner) !== String(receipt.submitter) ||
      String(object.content_hash) !== String(receipt.ciphertext_hash) ||
      String(object.encryption_key_hash) !== String(receipt.wrapped_key_hash) ||
      String(object.encryption_key_hash) !== envelope.recipient_key_commitment ||
      epochSeconds(lifecycle.tombstoned_at, 'storage tombstone') !== 0 ||
      epochSeconds(lifecycle.completed_at, 'storage completion') !== 0 ||
      now >= epochSeconds(lifecycle.expires_at, 'storage expiry')) {
    throw new Error('source custody storage object is not live or does not match HGD1 and receipt commitments')
  }
  if (!custodians.rows.some((row) => String(row.custodian) === custodian)) {
    throw new Error('current source key holder is not an immutable custodian of the storage object')
  }
}

export function verifyRetainedRewrap(input: {
  source: VaultEnvelope
  retained: VaultEnvelope
  grantId: string
  processor: string
  nextKeyId: string
  nextKeyHash: string
}): void {
  const {source, retained} = input
  const sameContext = JSON.stringify(retained.context) === JSON.stringify(source.context)
  if (!sameContext || retained.cipher_suite !== source.cipher_suite ||
      retained.associated_data_commitment !== source.associated_data_commitment ||
      retained.ciphertext_commitment !== source.ciphertext_commitment ||
      !retained.nonce.equals(source.nonce) || !retained.ciphertext.equals(source.ciphertext) ||
      retained.recipient_grant_id !== canonicalGrantId(input.grantId) ||
      retained.recipient_processor !== input.processor ||
      retained.recipient_key_id !== input.nextKeyId ||
      retained.recipient_key_commitment !== input.nextKeyHash) {
    throw new Error('retained HGR1 does not match the exact source, grant, processor, and access key')
  }
}

export function verifyRewrapAttestationRow(input: {
  row: Record<string, unknown>
  receiptId: string
  grantId: string
  custodian: string
  processor: string
  sourceCiphertextCommitment: string
  wrappedKeyCommitment: string
  accessEnvelopeCommitment: string
  expiresAt: number
}): void {
  const row = input.row
  if (canonicalUint64(row.grant_id, 'attestation grant id') !== canonicalGrantId(input.grantId) ||
      canonicalUint64(row.receipt_id, 'attestation receipt id') !== canonicalUint64(input.receiptId, 'receipt id') ||
      String(row.custodian) !== input.custodian || String(row.processor) !== input.processor ||
      String(row.source_ciphertext_commitment) !== input.sourceCiphertextCommitment ||
      String(row.wrapped_key_commitment) !== input.wrappedKeyCommitment ||
      String(row.access_envelope_commitment) !== input.accessEnvelopeCommitment ||
      epochSeconds(row.expires_at, 'attestation expiry') !== input.expiresAt) {
    throw new Error('existing rewrap attestation does not match the retained HGR1 workflow')
  }
}

export function verifyRegisteredGrantRow(input: {
  row: Record<string, unknown>
  receiptId: string
  grantId: string
  grantor: string
  custodian: string
  processor: string
  purposeHash: string
  sourceCiphertextCommitment: string
  wrappedKeyCommitment: string
  accessEnvelopeCommitment: string
  expiresAt: number
  maxUses: number
  requiredTransformHash: string
  derivativeMode: number
  derivativePolicyId: string
  derivativePolicyHash: string
}): void {
  const row = input.row
  if (canonicalUint64(row.id, 'grant id') !== canonicalGrantId(input.grantId) ||
      canonicalUint64(row.receipt_id, 'grant receipt id') !== canonicalUint64(input.receiptId, 'receipt id') ||
      String(row.grantor) !== input.grantor || String(row.rewrap_custodian) !== input.custodian ||
      String(row.processor) !== input.processor || String(row.purpose_hash) !== input.purposeHash ||
      String(row.source_ciphertext_commitment) !== input.sourceCiphertextCommitment ||
      String(row.wrapped_key_commitment) !== input.wrappedKeyCommitment ||
      String(row.access_envelope_commitment) !== input.accessEnvelopeCommitment ||
      epochSeconds(row.expires_at, 'grant expiry') !== input.expiresAt ||
      Number(row.max_uses) !== input.maxUses ||
      String(row.required_transform_hash) !== input.requiredTransformHash ||
      Number(row.derivative_mode) !== input.derivativeMode ||
      canonicalUint64(row.derivative_policy_id, 'grant derivative policy id') !== input.derivativePolicyId ||
      String(row.derivative_policy_hash) !== input.derivativePolicyHash) {
    throw new Error('existing Vault grant does not match the retained HGR1 workflow')
  }
}

export interface AccessEnvelopeStorageBinding {
  vaultContract: string
  receiptId: string
  grantId: string
  processor: string
  accessEnvelopeCommitment: string
  sourceCiphertextCommitment: string
}

export function accessEnvelopeStorageMetadata(input: AccessEnvelopeStorageBinding): string {
  const receiptId = canonicalUint64(input.receiptId, 'receipt id')
  const grantId = canonicalGrantId(input.grantId)
  const bindingHash = crypto.createHash('sha256').update(JSON.stringify({
    format: 'harbor.hgr1-store-binding.v1',
    vault_contract: input.vaultContract,
    receipt_id: receiptId,
    grant_id: grantId,
    processor: input.processor,
    access_envelope_commitment: input.accessEnvelopeCommitment,
    source_ciphertext_commitment: input.sourceCiphertextCommitment,
  })).digest('hex')
  return JSON.stringify({
    format: 'harbor.hgr1-store.v1',
    vault_contract: input.vaultContract,
    receipt_id: receiptId,
    grant_id: grantId,
    processor: input.processor,
    binding_hash: bindingHash,
  })
}

function chainFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

export function verifyAccessEnvelopeStorageObject(input: {
  object: StorageObjectRow
  lifecycle: StorageLifecycleRow
  keyCustodians: Array<Record<string, unknown>>
  objectId: string
  processor: string
  contentHash: string
  bytes: number
  encryptionKeyHash: string
  expiresAt: number
  metadata: string
}): void {
  const objectId = canonicalUint64(input.objectId, 'access envelope storage object id')
  const object = input.object
  const lifecycle = input.lifecycle
  if (canonicalUint64(object.id, 'access envelope storage object row id') !== objectId ||
      object.owner !== input.processor || object.content_hash !== input.contentHash ||
      canonicalUint64(object.bytes, 'access envelope storage bytes') !== String(input.bytes) ||
      !chainFlag(object.encrypted) || object.encryption_key_hash !== input.encryptionKeyHash ||
      Number(object.status) !== 1 || String(object.metadata ?? '') !== input.metadata ||
      canonicalUint64(lifecycle.object_id, 'access envelope lifecycle object id') !== objectId ||
      epochSeconds(lifecycle.expires_at, 'access envelope storage expiry') !== input.expiresAt ||
      epochSeconds(lifecycle.tombstoned_at, 'access envelope storage tombstone') !== 0 ||
      epochSeconds(lifecycle.completed_at, 'access envelope storage completion') !== 0 ||
      !input.keyCustodians.some((row) => String(row.custodian) === input.processor)) {
    throw new Error(`HarborStore object ${objectId} does not exactly govern this HGR1 access envelope`)
  }
}

async function findReusableAccessEnvelopeObject(input: {
  url?: string
  storageContract: string
  processor: string
  contentHash: string
  bytes: number
  encryptionKeyHash: string
  expiresAt: number
  metadata: string
}): Promise<string | undefined> {
  const candidates = (await storageObjectsByHash({
    url: input.url,
    storageContract: input.storageContract,
    contentHash: input.contentHash,
  }))
    .filter((row) => row.owner === input.processor)
    .sort((left, right) => {
      const lhs = BigInt(canonicalUint64(left.id, 'access envelope storage object id'))
      const rhs = BigInt(canonicalUint64(right.id, 'access envelope storage object id'))
      return lhs < rhs ? -1 : lhs > rhs ? 1 : 0
    })

  for (const object of candidates) {
    const objectId = canonicalUint64(object.id, 'access envelope storage object id')
    try {
      const [lifecycle, keyCustodians] = await Promise.all([
        primaryRow(input.storageContract, 'lifecycles', objectId, input.url),
        getTableRows<Record<string, unknown>>(input.storageContract, 'keycusts', {
          url: input.url,
          scope: objectId,
          lowerBound: input.processor,
          indexPosition: '1',
          keyType: 'name',
          limit: 2,
        }),
      ])
      verifyAccessEnvelopeStorageObject({
        ...input,
        object,
        lifecycle: lifecycle as unknown as StorageLifecycleRow,
        keyCustodians: keyCustodians.rows,
        objectId,
      })
      return objectId
    } catch {
      // Continue through exact-hash rows so a stale/tombstoned retry cannot
      // hide a later live object for the same retained HGR1.
    }
  }
  if (candidates.length > 0) {
    throw new Error('an existing processor-owned HGR1 object has the same hash but an incompatible lifecycle or custody binding')
  }
  return undefined
}

export interface PersistedAccessEnvelopeResult {
  object_id: string
  content_hash: string
  metadata: string
  registration_resumed: boolean
  put_tx?: string
  distribution: RouterDistributionResult
}

export async function persistAccessEnvelopeObject(input: AccessEnvelopeStorageBinding & {
  file: string
  bytes: Buffer
  encryptionKeyHash: string
  expiresAt: number
  storageContract: string
  marketContract: string
  processorSigningKey: string
  routerUrl?: string
  url?: string
  permission?: string
  expiration?: string
  json?: boolean
}): Promise<PersistedAccessEnvelopeResult> {
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > 0xffff_ffff) {
    throw new Error('HGR1 HarborStore expiry must be a future time_point_sec')
  }
  if (input.bytes.length === 0 ||
      !/^[0-9a-f]{64}$/.test(input.encryptionKeyHash) ||
      !/^[0-9a-f]{64}$/.test(input.accessEnvelopeCommitment) ||
      !/^[0-9a-f]{64}$/.test(input.sourceCiphertextCommitment)) {
    throw new Error('HGR1 HarborStore bytes or cryptographic commitments are invalid')
  }
  const contentHash = crypto.createHash('sha256').update(input.bytes).digest('hex')
  const metadata = accessEnvelopeStorageMetadata(input)
  const expected = {
    url: input.url,
    storageContract: input.storageContract,
    processor: input.processor,
    contentHash,
    bytes: input.bytes.length,
    encryptionKeyHash: input.encryptionKeyHash,
    expiresAt: input.expiresAt,
    metadata,
  }
  let objectId = await findReusableAccessEnvelopeObject(expected)
  let registrationResumed = Boolean(objectId)
  let putTransaction: unknown

  if (!objectId) {
    const registration = storageRegistrationAction(input.processor, {
      sourcePath: path.resolve(input.file),
      sourceHash: contentHash,
      contentHash,
      bytes: input.bytes.length,
      encrypted: true,
      encryptionKeyHash: input.encryptionKeyHash,
      temporary: true,
      ttlSec: input.expiresAt - now,
      expiresAt: input.expiresAt,
      keyCustodians: [input.processor],
      envelopeCommitment: input.accessEnvelopeCommitment,
      metadata,
    })
    const minimumObjectId = await readContractNextId(input.storageContract, 'next_object_id', {url: input.url})
    try {
      putTransaction = await pushAction({
        contract: input.storageContract,
        action: registration.action,
        data: registration.data,
        url: input.url,
        actor: input.processor,
        permission: input.permission,
        key: input.processorSigningKey,
        expiration: input.expiration,
        json: input.json,
      })
      objectId = await resolveStorageObjectId({
        url: input.url,
        storageContract: input.storageContract,
        owner: input.processor,
        contentHash,
        minimumIdInclusive: minimumObjectId,
        transactionResult: putTransaction,
        action: registration.action,
      })
    } catch (error) {
      objectId = await findReusableAccessEnvelopeObject(expected)
      if (!objectId) throw error
      registrationResumed = true
    }
  }

  const verifiedObjectId = await findReusableAccessEnvelopeObject(expected)
  if (!verifiedObjectId || verifiedObjectId !== objectId) {
    throw new Error('new HGR1 HarborStore registration did not reconcile to its exact lifecycle')
  }
  const distribution = await distributeStoredObject({
    file: input.file,
    owner: input.processor,
    objectId,
    contentHash,
    metadata,
    url: input.url,
    actor: input.processor,
    permission: input.permission,
    key: input.processorSigningKey,
    expiration: input.expiration,
    json: input.json,
    storageContract: input.storageContract,
    marketContract: input.marketContract,
    routerUrl: input.routerUrl,
  })
  return {
    object_id: objectId,
    content_hash: contentHash,
    metadata,
    registration_resumed: registrationResumed,
    put_tx: (putTransaction as {transaction_id?: string} | undefined)?.transaction_id,
    distribution,
  }
}

export async function verifyAccessEnvelopeObjectOnChain(input: {
  envelope: VaultEnvelope
  authorization: GrantAuthorizationSnapshot
  grantId: string
  processor: string
  vaultContract: string
  storageContract: string
  objectId: string
  url?: string
}): Promise<void> {
  const bytes = vaultEnvelopeToBytes(input.envelope)
  const objectId = canonicalUint64(input.objectId, 'HGR1 access storage object id')
  const receiptId = canonicalUint64(input.authorization.grant.receipt_id, 'grant receipt id')
  const expiresAt = epochSeconds(input.authorization.grant.expires_at, 'grant expiry')
  const contentHash = crypto.createHash('sha256').update(bytes).digest('hex')
  const metadata = accessEnvelopeStorageMetadata({
    vaultContract: input.vaultContract,
    receiptId,
    grantId: input.grantId,
    processor: input.processor,
    accessEnvelopeCommitment: vaultEnvelopeCommitment(input.envelope),
    sourceCiphertextCommitment: String(input.authorization.grant.source_ciphertext_commitment),
  })
  const [object, lifecycle, keyCustodians] = await Promise.all([
    primaryRow(input.storageContract, 'objects', objectId, input.url),
    primaryRow(input.storageContract, 'lifecycles', objectId, input.url),
    getTableRows<Record<string, unknown>>(input.storageContract, 'keycusts', {
      url: input.url,
      scope: objectId,
      lowerBound: input.processor,
      indexPosition: '1',
      keyType: 'name',
      limit: 2,
    }),
  ])
  verifyAccessEnvelopeStorageObject({
    object: object as unknown as StorageObjectRow,
    lifecycle: lifecycle as unknown as StorageLifecycleRow,
    keyCustodians: keyCustodians.rows,
    objectId,
    processor: input.processor,
    contentHash,
    bytes: bytes.length,
    encryptionKeyHash: input.envelope.recipient_key_commitment,
    expiresAt,
    metadata,
  })
}

async function readEnvelope(file: string): Promise<VaultEnvelope> {
  return vaultEnvelopeFromBytes(await fs.readFile(file))
}

async function writeExclusive(file: string, bytes: string | Buffer, mode?: number): Promise<void> {
  const target = path.resolve(file)
  const directory = path.dirname(target)
  await fs.mkdir(directory, {recursive: true})
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  )
  try {
    const handle = await fs.open(temporary, 'wx', mode)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.link(temporary, target)
  } finally {
    await fs.rm(temporary, {force: true})
  }
}

export async function readVaultPrivateKeyFile(file: string): Promise<Buffer> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const handle = await fs.open(file, fsConstants.O_RDONLY | noFollow)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error('governed-data private key must be a regular file with one link')
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('governed-data private key must be owned by the current user')
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error('governed-data private key permissions must be 0600 or stricter')
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function loadOrCreateGrantUseRecord(
  file: string,
  binding: {grantId: string; processor: string; envelopeCommitment: string},
): Promise<VaultGrantUseRecord> {
  try {
    return parseGrantUseRecord(await fs.readFile(file, 'utf8'), binding)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const record = createGrantUseRecord(binding)
  const serialized = `${JSON.stringify(record)}\n`
  try {
    await writeExclusive(file, serialized, 0o600)
    return record
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return parseGrantUseRecord(await fs.readFile(file, 'utf8'), binding)
  }
}

function addLocalCryptoCommands(vault: Command): void {
  const timestamp = (value: string, label: string): number => {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${label} must be a positive Unix timestamp`)
    }
    return parsed
  }

  vault
    .command('keygen <directory>')
    .description('Generate one erasable Curve25519 key pair for one governed object or access grant')
    .option('--name <name>', 'key filename prefix', 'vault')
    .option('--key-id <id>', 'unique object or access-key identifier; defaults to --name')
    .action(async (directory: string, options: {name: string; keyId?: string}) => {
      const pair = generateVaultKeyPair()
      const keyId = options.keyId ?? options.name
      const publicKey = path.join(directory, `${options.name}-public.json`)
      const privateKey = path.join(directory, `${options.name}-private.json`)
      try {
        await fs.mkdir(directory, {recursive: true})
        await writeExclusive(privateKey, vaultPrivateKeyToJson(pair, keyId), 0o600)
        try {
          await writeExclusive(publicKey, vaultPublicKeyToJson(pair, keyId), 0o644)
        } catch (error) {
          await fs.rm(privateKey, {force: true})
          throw error
        }
        console.log(JSON.stringify({
          algorithm: pair.algorithm,
          key_id: keyId,
          public_key: path.resolve(publicKey),
          private_key: path.resolve(privateKey),
          public_key_hash: pair.publicKeyHash,
        }, null, 2))
      } finally {
        pair.privateKey.fill(0)
      }
    })

  vault
    .command('encrypt <input> <output>')
    .description('Envelope-encrypt bytes into initial custody before storage and receipt ids exist')
    .requiredOption('--recipient-public-key <file>', 'unique per-object public key JSON; never use a private or reusable campaign key')
    .requiredOption('--policy-id <id>', 'Vault policy id')
    .requiredOption('--consent-id <id>', 'Vault consent id')
    .requiredOption('--purpose <purpose>', 'purpose bound into authenticated associated data')
    .requiredOption('--expires-at <unix>', 'envelope expiry as Unix seconds')
    .option('--created-at <unix>', 'envelope creation time as Unix seconds', String(Math.floor(Date.now() / 1000)))
    .action(async (input: string, output: string, options: {
      recipientPublicKey: string
      policyId: string
      consentId: string
      purpose: string
      createdAt: string
      expiresAt: string
    }) => {
      const [plaintext, publicKey] = await Promise.all([
        fs.readFile(input),
        fs.readFile(options.recipientPublicKey, 'utf8'),
      ])
      try {
        const recipient = parseVaultPublicKey(publicKey)
        const context: GovernedDataContext = {
          policy_id: options.policyId,
          consent_id: options.consentId,
          receipt_id: '',
          object_id: '',
          purpose: options.purpose,
          created_at: timestamp(options.createdAt, 'created_at'),
          expires_at: timestamp(options.expiresAt, 'expires_at'),
        }
        const envelope = encryptVaultBytes(plaintext, recipient.publicKey, context, {
          grant_id: '',
          processor: '',
          key_id: recipient.keyId,
        })
        const envelopeBytes = vaultEnvelopeToBytes(envelope)
        await writeExclusive(output, envelopeBytes, 0o600)
        console.log(JSON.stringify({
          output: path.resolve(output),
          bytes: plaintext.length,
          storage_content_hash: crypto.createHash('sha256').update(envelopeBytes).digest('hex'),
          recipient_key_hash: envelope.recipient_key_commitment,
          erasable_key_hash: envelope.recipient_key_commitment,
          associated_data_hash: envelope.associated_data_commitment,
          wrapped_dek_hash: envelope.wrapped_dek_commitment,
          ciphertext_commitment: envelope.ciphertext_commitment,
          envelope_hash: vaultEnvelopeCommitment(envelope),
        }, null, 2))
      } finally {
        plaintext.fill(0)
      }
    })

  addTxOptions(vault
    .command('decrypt <input> <output>')
    .description('Decrypt an authorized vault envelope with its recipient private key')
    .requiredOption('--recipient-private-key <file>', 'recipient governed-data private key JSON')
    .option('--grant-id <id>', 'expected live Vault grant id for a granted HGR1 wrap')
    .option('--processor <account>', 'expected processor account for a granted HGR1 wrap')
    .requiredOption('--access-object-id <id>', 'processor-owned live HarborStore object containing these exact HGR1 bytes')
    .option('--vault-contract <account>', 'Vault contract used for live authorization', VAULT_CONTRACT)
    .option('--access-storage-contract <account>', 'HarborStore contract containing the governed HGR1 object', STORAGE_CONTRACT)
    .option('--use-record <file>', 'durable authorization recovery record; defaults beside the output')
    .option('--now <unix>', 'authorization time for TTL validation; defaults to current Unix seconds')
  )
    .action(async (input: string, output: string, options: {
      recipientPrivateKey: string
      grantId?: string
      processor?: string
      accessObjectId: string
      vaultContract: string
      accessStorageContract: string
      useRecord?: string
      url?: string
      now?: string
      actor?: string
      permission?: string
      key?: string
      expiration?: string
    }) => {
      const envelope = await readEnvelope(input)
      if (envelope.recipient_grant_id === '') {
        throw new Error('initial custody envelopes cannot be decrypted as processor data; create and register an authorized HGR1 rewrap first')
      }
      if (!options.grantId || !options.processor) {
        throw new Error('granted envelope decryption requires --grant-id and --processor')
      }
      const grantId = canonicalGrantId(options.grantId)
      if (grantId !== canonicalGrantId(envelope.recipient_grant_id) ||
          options.processor !== envelope.recipient_processor) {
        throw new Error('grant or processor does not match the envelope recipient')
      }
      const authorizationTime = options.now ? timestamp(options.now, 'now') : Math.floor(Date.now() / 1000)
      const privateKey = await readVaultPrivateKeyFile(options.recipientPrivateKey)
      const recipient = (() => {
        try {
          return parseVaultPrivateKey(privateKey)
        } finally {
          privateKey.fill(0)
        }
      })()
      try {
        if (recipient.keyId !== envelope.recipient_key_id ||
            recipient.publicKeyHash !== envelope.recipient_key_commitment) {
          throw new Error('private key does not match the envelope recipient')
        }
        const envelopeCommitment = vaultEnvelopeCommitment(envelope)
        const useRecordPath = path.resolve(options.useRecord ?? `${output}.harbor-use.json`)
        const useRecord = await loadOrCreateGrantUseRecord(useRecordPath, {
          grantId,
          processor: options.processor,
          envelopeCommitment,
        })
        const authorization = await consumeGrantUseOnChain({
          envelope,
          grantId,
          processor: options.processor,
          useHash: useRecord.use_hash,
          vaultContract: options.vaultContract,
          url: options.url,
          now: authorizationTime,
          actor: options.actor ?? options.processor,
          permission: options.permission,
          key: options.key,
          expiration: options.expiration,
          verifyAuthorization: (snapshot) => verifyAccessEnvelopeObjectOnChain({
            envelope,
            authorization: snapshot,
            grantId,
            processor: options.processor as string,
            vaultContract: options.vaultContract,
            storageContract: options.accessStorageContract,
            objectId: options.accessObjectId,
            url: options.url,
          }),
        })
        const plaintext = decryptVaultBytes(
          envelope,
          recipient.publicKey,
          recipient.privateKey,
          authorizationTime,
        )
        try {
          await writeExclusive(output, plaintext, 0o600)
        } finally {
          plaintext.fill(0)
        }
        console.log(JSON.stringify({
          output: path.resolve(output),
          envelope_hash: envelopeCommitment,
          grant_id: grantId,
          access_storage_contract: options.accessStorageContract,
          access_storage_object_id: canonicalUint64(options.accessObjectId, 'HGR1 access storage object id'),
          grant_use_id: canonicalUint64(authorization.use.id, 'grant use id'),
          grant_use_hash: useRecord.use_hash,
          use_record: useRecordPath,
          authorization_resumed: authorization.resumed,
          use_tx: (authorization.transaction as {transaction_id?: string} | undefined)?.transaction_id,
        }, null, 2))
      } finally {
        recipient.privateKey.fill(0)
      }
    })

  addTxOptions(vault
    .command('rewrap <input> <output>')
    .description('Authorize custody, govern and distribute HGR1 in HarborStore, then register its exact grant')
    .requiredOption('--current-private-key <file>', 'current object or access private key JSON')
    .requiredOption('--next-public-key <file>', 'unique, expiring authorized processor access public key JSON')
    .option('--grant-id <id>', 'caller-chosen nonzero uint64 grant id; defaults to a random 64-bit id')
    .requiredOption('--grantor <account>', 'receipt subject or delegated policy controller registering the grant')
    .requiredOption('--processor <account>', 'new processor account bound to the grant')
    .requiredOption('--receipt-id <id>', 'accepted source Vault receipt id supplied to the custody authorizer')
    .requiredOption('--custodian <account>', 'current immutable HarborStore key custodian')
    .requiredOption('--custodian-signing-key <key>', 'chain signing key or wallet key for the custodian attestation')
    .requiredOption('--grantor-signing-key <key>', 'chain signing key or wallet key for final grant registration')
    .requiredOption('--processor-signing-key <key>', 'chain signing key or wallet key for processor-owned HGR1 storage')
    .requiredOption('--expires-at <unix>', 'grant expiry as Unix seconds')
    .option('--max-uses <count>', 'maximum authorized processor uses', '1')
    .option('--required-transform-hash <hash>', 'required transform recipe hash', '0'.repeat(64))
    .option('--derivative-mode <mode>', 'derivative mode enum', '0')
    .option('--derivative-policy-id <id>', 'derivative policy id', '0')
    .option('--derivative-policy-hash <hash>', 'derivative policy manifest hash', '0'.repeat(64))
    .option('--vault-contract <account>', 'Vault contract used for source authorization', VAULT_CONTRACT)
    .option('--storage-contract <account>', 'HarborStore contract for the governed HGR1 object', STORAGE_CONTRACT)
    .option('--market-contract <account>', 'service market used to discover an authenticated router', MARKET_CONTRACT)
    .option('--router-url <url>', 'explicit active on-chain router endpoint')
    .option('--now <unix>', 'authorization time for local validation; defaults to current Unix seconds'))
    .action(async (input: string, output: string, options: {
      currentPrivateKey: string
      nextPublicKey: string
      grantId?: string
      grantor: string
      processor: string
      receiptId: string
      custodian: string
      custodianSigningKey: string
      grantorSigningKey: string
      processorSigningKey: string
      expiresAt: string
      maxUses: string
      requiredTransformHash: string
      derivativeMode: string
      derivativePolicyId: string
      derivativePolicyHash: string
      vaultContract: string
      storageContract: string
      marketContract: string
      routerUrl?: string
      url?: string
      actor?: string
      permission?: string
      key?: string
      auth?: string
      json?: boolean
      expiration?: string
      now?: string
    }) => {
      const [envelope, publicKey] = await Promise.all([
        readEnvelope(input),
        fs.readFile(options.nextPublicKey, 'utf8'),
      ])
      requireInitialCustodyEnvelope(envelope)
      const authorizationTime = options.now ? timestamp(options.now, 'now') : Math.floor(Date.now() / 1000)
      const grantExpiresAt = timestamp(options.expiresAt, 'expires_at')
      if (grantExpiresAt <= authorizationTime || grantExpiresAt > envelope.context.expires_at) {
        throw new Error('grant expiry must be in the future and no later than the HGD1 expiry')
      }
      let retained: VaultEnvelope | undefined
      try {
        retained = await readEnvelope(output)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const grantId = canonicalGrantId(options.grantId ?? retained?.recipient_grant_id ?? randomGrantId())
      const maxUses = Number(options.maxUses)
      const derivativeMode = Number(options.derivativeMode)
      const derivativePolicyId = canonicalUint64(options.derivativePolicyId, 'derivative policy id')
      if (!Number.isSafeInteger(maxUses) || maxUses <= 0 ||
          !Number.isSafeInteger(derivativeMode) || derivativeMode < 0 || derivativeMode > 3) {
        throw new Error('max uses or derivative mode is invalid')
      }
      await verifyCustodySourceOnChain({
        envelope,
        receiptId: options.receiptId,
        custodian: options.custodian,
        vaultContract: options.vaultContract,
        url: options.url,
        now: authorizationTime,
      })
      const next = parseVaultPublicKey(publicKey)
      let rewrapped: VaultEnvelope
      let envelopeResumed = false
      if (retained) {
        verifyRetainedRewrap({
          source: envelope,
          retained,
          grantId,
          processor: options.processor,
          nextKeyId: next.keyId,
          nextKeyHash: next.publicKeyHash,
        })
        rewrapped = retained
        envelopeResumed = true
      } else {
        const privateKey = await readVaultPrivateKeyFile(options.currentPrivateKey)
        const current = (() => {
          try {
            return parseVaultPrivateKey(privateKey)
          } finally {
            privateKey.fill(0)
          }
        })()
        try {
          if (current.keyId !== envelope.recipient_key_id ||
              current.publicKeyHash !== envelope.recipient_key_commitment) {
            throw new Error('current private key does not match the envelope recipient')
          }
          rewrapped = rewrapVaultEnvelope(
            envelope,
            current.publicKey,
            current.privateKey,
            next.publicKey,
            {grant_id: grantId, processor: options.processor, key_id: next.keyId},
            authorizationTime,
          )
        } finally {
          current.privateKey.fill(0)
        }
        const serialized = vaultEnvelopeToBytes(rewrapped)
        await writeExclusive(output, serialized, 0o600)
      }

      const previousBytes = vaultEnvelopeToBytes(envelope)
      const rewrappedBytes = vaultEnvelopeToBytes(rewrapped)
      const accessEnvelopeCommitment = vaultEnvelopeCommitment(rewrapped)
      const purposeHash = crypto.createHash('sha256').update(envelope.context.purpose).digest('hex')
      const workflow = {
        receiptId: options.receiptId,
        grantId,
        grantor: options.grantor,
        custodian: options.custodian,
        processor: options.processor,
        purposeHash,
        sourceCiphertextCommitment: envelope.ciphertext_commitment,
        wrappedKeyCommitment: rewrapped.wrapped_dek_commitment,
        accessEnvelopeCommitment,
        expiresAt: grantExpiresAt,
        maxUses,
        requiredTransformHash: options.requiredTransformHash,
        derivativeMode,
        derivativePolicyId,
        derivativePolicyHash: options.derivativePolicyHash,
      }
      let accessStorage: PersistedAccessEnvelopeResult
      try {
        accessStorage = await persistAccessEnvelopeObject({
          file: output,
          bytes: rewrappedBytes,
          vaultContract: options.vaultContract,
          storageContract: options.storageContract,
          marketContract: options.marketContract,
          receiptId: options.receiptId,
          grantId,
          processor: options.processor,
          accessEnvelopeCommitment,
          sourceCiphertextCommitment: envelope.ciphertext_commitment,
          encryptionKeyHash: rewrapped.recipient_key_commitment,
          expiresAt: grantExpiresAt,
          processorSigningKey: options.processorSigningKey,
          routerUrl: options.routerUrl,
          url: options.url,
          permission: options.permission,
          expiration: options.expiration,
          json: options.json,
        })
      } catch (error) {
        throw new Error(
          `HGR1 preparation retained at ${path.resolve(output)} with grant id ${grantId}; ` +
          `temporary HarborStore registration or distribution failed: ${(error as Error).message}`,
          {cause: error},
        )
      }
      let attestationTx: unknown
      let grantTx: unknown
      let attestationResumed = false
      let grantResumed = false
      try {
        const existingGrant = await optionalPrimaryRow(options.vaultContract, 'grants', grantId, options.url)
        if (existingGrant) {
          verifyRegisteredGrantRow({row: existingGrant, ...workflow})
          grantResumed = true
          attestationResumed = true
        } else {
          const attestationWorkflow = {
            row: {} as Record<string, unknown>,
            receiptId: options.receiptId,
            grantId,
            custodian: options.custodian,
            processor: options.processor,
            sourceCiphertextCommitment: envelope.ciphertext_commitment,
            wrappedKeyCommitment: rewrapped.wrapped_dek_commitment,
            accessEnvelopeCommitment,
            expiresAt: grantExpiresAt,
          }
          let attestation = await optionalPrimaryRow(options.vaultContract, 'rewrapattest', grantId, options.url)
          if (attestation) {
            verifyRewrapAttestationRow({...attestationWorkflow, row: attestation})
            attestationResumed = true
          } else {
            try {
              attestationTx = await pushAction({
                contract: options.vaultContract,
                action: 'attestrewrap',
                data: {
                  custodian: options.custodian,
                  receipt_id: options.receiptId,
                  grant_id: grantId,
                  processor: options.processor,
                  source_ciphertext_commitment: envelope.ciphertext_commitment,
                  wrapped_key_commitment: rewrapped.wrapped_dek_commitment,
                  access_envelope_commitment: accessEnvelopeCommitment,
                  expires_at: new Date(grantExpiresAt * 1000).toISOString().replace(/\.000Z$/, ''),
                },
                url: options.url,
                actor: options.custodian,
                permission: options.permission,
                key: options.custodianSigningKey,
                expiration: options.expiration,
              })
            } catch (error) {
              attestation = await optionalPrimaryRow(options.vaultContract, 'rewrapattest', grantId, options.url)
              if (!attestation) throw error
            }
            attestation = attestation ?? await primaryRow(options.vaultContract, 'rewrapattest', grantId, options.url)
            verifyRewrapAttestationRow({...attestationWorkflow, row: attestation})
          }

          try {
            grantTx = await pushAction({
              contract: options.vaultContract,
              action: 'grantaccess',
              data: {
                grantor: options.grantor,
                receipt_id: options.receiptId,
                grant_id: grantId,
                processor: options.processor,
                purpose_hash: purposeHash,
                expires_at: new Date(grantExpiresAt * 1000).toISOString().replace(/\.000Z$/, ''),
                max_uses: maxUses,
                required_transform_hash: options.requiredTransformHash,
                derivative_mode: derivativeMode,
                derivative_policy_id: derivativePolicyId,
                derivative_policy_hash: options.derivativePolicyHash,
                wrapped_key_commitment: rewrapped.wrapped_dek_commitment,
                source_ciphertext_commitment: envelope.ciphertext_commitment,
                access_envelope_commitment: accessEnvelopeCommitment,
              },
              url: options.url,
              actor: options.grantor,
              permission: options.permission,
              key: options.grantorSigningKey,
              expiration: options.expiration,
            })
          } catch (error) {
            const reconciled = await optionalPrimaryRow(options.vaultContract, 'grants', grantId, options.url)
            if (!reconciled) throw error
          }
          const registered = await primaryRow(options.vaultContract, 'grants', grantId, options.url)
          verifyRegisteredGrantRow({row: registered, ...workflow})
        }
      } catch (error) {
        throw new Error(
          `HGR1 preparation retained at ${path.resolve(output)} with grant id ${grantId}; custodian attestation or grant registration failed: ${(error as Error).message}`,
          {cause: error},
        )
      }

      console.log(JSON.stringify({
        output: path.resolve(output),
        previous_storage_content_hash: crypto.createHash('sha256').update(previousBytes).digest('hex'),
        storage_content_hash: accessStorage.content_hash,
        storage_object_id: accessStorage.object_id,
        storage_registration_resumed: accessStorage.registration_resumed,
        storage_put_tx: accessStorage.put_tx,
        storage_route_authorization_tx: accessStorage.distribution.route_authorization_tx,
        storage_replica_count: accessStorage.distribution.replica_count,
        previous_envelope_hash: vaultEnvelopeCommitment(envelope),
        envelope_hash: accessEnvelopeCommitment,
        access_key_hash: rewrapped.recipient_key_commitment,
        wrapped_dek_hash: rewrapped.wrapped_dek_commitment,
        source_receipt_id: options.receiptId,
        grant_id: grantId,
        envelope_resumed: envelopeResumed,
        custodian_attestation_resumed: attestationResumed,
        custodian_attestation_tx: (attestationTx as {transaction_id?: string} | undefined)?.transaction_id,
        grant_registered: true,
        grant_registration_resumed: grantResumed,
        grant_tx: (grantTx as {transaction_id?: string} | undefined)?.transaction_id,
      }, null, 2))
    })
}

function addVaultAction(
  vault: Command,
  spec: {command: string; action: string; fields: Field[]; signerField?: string},
): void {
  addJsonActionCommand(vault, VAULT_CONTRACT, spec)
}

function addVaultContractCommands(vault: Command): void {
  addVaultAction(vault, {
    command: 'configure',
    action: 'setparams',
    fields: [
      'token_symbol', 'token_contract', 'storage_contract',
      ['max_metadata_size', 'number'], ['max_grant_uses', 'number'],
      ['max_retention_sec', 'number'],
    ],
  })
  addVaultAction(vault, {
    command: 'create-policy',
    action: 'newpolicy',
    fields: [
      'controller', 'manifest_hash', 'keyset_hash', ['max_retention_sec', 'number'],
      ['delete_quorum', 'number'], ['key_quorum', 'number'], ['review_quorum', 'number'], 'metadata',
    ],
    signerField: 'controller',
  })
  addVaultAction(vault, {
    command: 'add-policy-version',
    action: 'addpolver',
    fields: [
      'controller', ['policy_id', 'uint64'], 'manifest_hash', 'keyset_hash',
      ['max_retention_sec', 'number'], ['delete_quorum', 'number'],
      ['key_quorum', 'number'], ['review_quorum', 'number'], 'metadata',
    ],
    signerField: 'controller',
  })
  addVaultAction(vault, {
    command: 'set-policy-status',
    action: 'setpolstat',
    fields: ['controller', ['policy_id', 'uint64'], ['status', 'number']],
    signerField: 'controller',
  })
  addVaultAction(vault, {
    command: 'set-operator',
    action: 'setoperator',
    fields: ['controller', ['policy_id', 'uint64'], 'account', ['roles', 'number'], ['active', 'boolean']],
    signerField: 'controller',
  })
  addVaultAction(vault, {
    command: 'consent',
    action: 'setconsent',
    fields: [
      'subject', ['policy_id', 'uint64'], 'collector', 'purpose_hash', 'scope_hash',
      ['max_derivative_mode', 'number'], ['delegated_access', 'boolean'], 'expires_at',
    ],
    signerField: 'subject',
  })
  addVaultAction(vault, {
    command: 'revoke-consent',
    action: 'revokecons',
    fields: ['subject', ['consent_id', 'uint64'], 'reason_hash'],
    signerField: 'subject',
  })
  addVaultAction(vault, {
    command: 'put-receipt',
    action: 'putreceipt',
    fields: [
      'subject', 'collector', ['consent_id', 'uint64'], 'storage_contract',
      ['storage_object_id', 'uint64'], 'ciphertext_hash', 'wrapped_key_hash',
      'payload_ciphertext_commitment', ['bytes', 'uint64'], 'retention_until', 'metadata_hash',
    ],
    signerField: 'collector',
  })
  addVaultAction(vault, {
    command: 'review-receipt',
    action: 'reviewrcpt',
    fields: ['reviewer', ['receipt_id', 'uint64'], ['accepted', 'boolean'], 'evidence_hash'],
    signerField: 'reviewer',
  })
  addVaultAction(vault, {
    command: 'attest-rewrap',
    action: 'attestrewrap',
    fields: [
      'custodian', ['receipt_id', 'uint64'], ['grant_id', 'uint64'], 'processor',
      'source_ciphertext_commitment', 'wrapped_key_commitment',
      'access_envelope_commitment', 'expires_at',
    ],
    signerField: 'custodian',
  })
  addVaultAction(vault, {
    command: 'expire-rewrap',
    action: 'expirerewrap',
    fields: ['actor', ['grant_id', 'uint64']],
    signerField: 'actor',
  })
  addVaultAction(vault, {
    command: 'grant-access',
    action: 'grantaccess',
    fields: [
      'grantor', ['receipt_id', 'uint64'], ['grant_id', 'uint64'], 'processor', 'purpose_hash', 'expires_at',
      ['max_uses', 'number'], 'required_transform_hash', ['derivative_mode', 'number'],
      ['derivative_policy_id', 'uint64'], 'derivative_policy_hash', 'wrapped_key_commitment',
      'source_ciphertext_commitment', 'access_envelope_commitment',
    ],
    signerField: 'grantor',
  })
  addVaultAction(vault, {
    command: 'revoke-grant',
    action: 'revokegrant',
    fields: ['actor', ['grant_id', 'uint64'], 'reason_hash'],
    signerField: 'actor',
  })
  addVaultAction(vault, {
    command: 'use-grant',
    action: 'usegrant',
    fields: ['processor', ['grant_id', 'uint64'], 'use_hash'],
    signerField: 'processor',
  })
  addVaultAction(vault, {
    command: 'put-derived',
    action: 'putderived',
    fields: [
      'processor', ['use_id', 'uint64'], ['output_consent_id', 'uint64'], 'storage_contract',
      ['storage_object_id', 'uint64'], 'ciphertext_hash', 'wrapped_key_hash',
      'payload_ciphertext_commitment', ['bytes', 'uint64'], 'retention_until', 'recipe_hash', 'attestation_hash',
      'metadata_hash',
    ],
    signerField: 'processor',
  })
  addVaultAction(vault, {
    command: 'add-lineage',
    action: 'addlineage',
    fields: [
      'processor', ['output_receipt_id', 'uint64'], ['use_id', 'uint64'],
      'attestation_hash',
    ],
    signerField: 'processor',
  })
  addVaultAction(vault, {
    command: 'tombstone',
    action: 'tombstone',
    fields: ['actor', ['receipt_id', 'uint64'], 'reason_hash'],
    signerField: 'actor',
  })
  addVaultAction(vault, {
    command: 'attest-delete',
    action: 'attestdelete',
    fields: ['attestor', ['receipt_id', 'uint64'], ['attestation_type', 'number'], 'evidence_hash'],
    signerField: 'attestor',
  })
  addVaultAction(vault, {
    command: 'finalize-delete',
    action: 'finalizedel',
    fields: ['actor', ['receipt_id', 'uint64'], 'deletion_hash'],
    signerField: 'actor',
  })
  addVaultAction(vault, {
    command: 'add-reward',
    action: 'addreward',
    fields: [
      'controller', ['policy_id', 'uint64'], 'beneficiary', ['stage', 'number'],
      ['reference_id', 'uint64'], 'quantity', 'evidence_hash',
    ],
    signerField: 'controller',
  })
  addVaultAction(vault, {
    command: 'claim-reward',
    action: 'claimreward',
    fields: ['beneficiary', ['reward_id', 'uint64']],
    signerField: 'beneficiary',
  })
  addVaultAction(vault, {
    command: 'withdraw',
    action: 'withdraw',
    fields: ['controller', ['policy_id', 'uint64'], 'quantity'],
    signerField: 'controller',
  })

  addTxOptions(
    vault
      .command('fund <from> <policy_id> <quantity>')
      .description('Fund a vault policy reward treasury')
      .option('--token-contract <account>', 'token contract account', process.env.HARBOR_TOKEN_CONTRACT ?? 'eosio.token')
      .option('--vault-contract <account>', 'vault contract account', VAULT_CONTRACT),
  ).action(async (from: string, policyId: string, quantity: string, options: {
    tokenContract: string
    vaultContract: string
    url?: string
    actor?: string
    permission?: string
    key?: string
    json?: boolean
    expiration?: string
  }) => {
    const parsedPolicyId = canonicalUint64(policyId, 'policy_id')
    if (parsedPolicyId === '0') throw new Error('policy_id must be positive')
    await pushJsonAction(options.tokenContract, 'transfer', {
      from,
      to: options.vaultContract,
      quantity,
      memo: `vault:${parsedPolicyId}`,
    }, {...options, actor: options.actor ?? from})
  })
}

export function createVaultCommand(): Command {
  const vault = new Command('vault')
  vault.description('Manage purpose-bound encrypted data, consent, access, and key envelopes')
  addLocalCryptoCommands(vault)
  addVaultContractCommands(vault)
  return vault
}
