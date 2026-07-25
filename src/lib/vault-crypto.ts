import crypto from 'node:crypto'
import {constants as bufferConstants} from 'node:buffer'
import sodium from 'sodium-native'

const ENVELOPE_FORMAT = 'harbor.governed-data-envelope.v1' as const
const ENVELOPE_JSON_FORMAT = 'harbor.governed-data-envelope-json.v1' as const
const CIPHER_SUITE = 'xchacha20poly1305-ietf+curve25519-sealedbox' as const
const PUBLIC_KEY_FORMAT = 'harbor.governed-data-public-key.v1' as const
const PRIVATE_KEY_FORMAT = 'harbor.governed-data-private-key.v1' as const
const KEY_ALGORITHM = 'curve25519-sealedbox' as const
const MAX_TEXT_BYTES = 4096
// Leave room for the largest valid HGD1 header when the canonical envelope is
// assembled into one Node Buffer. The cryptographic protocol limit is much
// larger than Node's platform Buffer limit, so the smaller platform limit is
// the effective bound for this non-streaming HGD1 implementation.
const MAX_CANONICAL_ENVELOPE_OVERHEAD_BYTES = 64 * 1024
export const MAX_GOVERNED_CIPHERTEXT_BYTES = Math.min(
  sodium.crypto_aead_xchacha20poly1305_ietf_MESSAGEBYTES_MAX,
  bufferConstants.MAX_LENGTH - MAX_CANONICAL_ENVELOPE_OVERHEAD_BYTES,
)
export const MAX_GOVERNED_PLAINTEXT_BYTES =
  MAX_GOVERNED_CIPHERTEXT_BYTES - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES
// HGD1's original JSON wrapper hex-encodes the canonical bytes. Above this
// threshold Node cannot create that one string, so storage/CLI files use the
// exact canonical HGD1 bytes instead. The envelope commitment is identical.
export const MAX_GOVERNED_JSON_CANONICAL_BYTES = Math.floor(
  (bufferConstants.MAX_STRING_LENGTH - 1024) / 2,
)
const SHA256_HEX = /^[0-9a-f]{64}$/
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export interface VaultKeyPair {
  algorithm: typeof KEY_ALGORITHM
  publicKey: Buffer
  privateKey: Buffer
  publicKeyHash: string
}

export interface VaultPublicKeyFile {
  format: typeof PUBLIC_KEY_FORMAT
  algorithm: typeof KEY_ALGORITHM
  key_id: string
  public_key: string
  public_key_commitment: string
}

export interface VaultPrivateKeyFile {
  format: typeof PRIVATE_KEY_FORMAT
  algorithm: typeof KEY_ALGORITHM
  key_id: string
  public_key: string
  public_key_commitment: string
  private_key: string
}

export interface GovernedDataContext {
  policy_id: string
  consent_id: string
  receipt_id: string
  object_id: string
  purpose: string
  created_at: number
  expires_at: number
}

export interface VaultRecipient {
  grant_id: string
  processor: string
  key_id: string
}

export interface VaultEnvelope {
  format: typeof ENVELOPE_FORMAT
  cipher_suite: typeof CIPHER_SUITE
  context: GovernedDataContext
  recipient_grant_id: string
  recipient_processor: string
  recipient_key_id: string
  recipient_key_commitment: string
  associated_data_commitment: string
  wrapped_dek_commitment: string
  ciphertext_commitment: string
  nonce: Buffer
  wrapped_dek: Buffer
  ciphertext: Buffer
}

export interface VaultEnvelopeJson {
  format: typeof ENVELOPE_JSON_FORMAT
  canonical_hex: string
  envelope_commitment: string
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function equalHex(left: string, right: string): boolean {
  if (!SHA256_HEX.test(left) || !SHA256_HEX.test(right)) return false
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function decodeCanonicalBase64(value: string, label: string): Buffer {
  if (!value || !CANONICAL_BASE64.test(value)) {
    throw new Error(`${label} must be canonical base64`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) {
    decoded.fill(0)
    throw new Error(`${label} must be canonical base64`)
  }
  return decoded
}

function requireText(value: string, label: string): Buffer {
  if (!value) throw new Error(`${label} is required`)
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > MAX_TEXT_BYTES) throw new Error(`${label} exceeds ${MAX_TEXT_BYTES} bytes`)
  return bytes
}

function requireTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
}

function requireKey(key: Buffer, expected: number, label: string): void {
  if (!Buffer.isBuffer(key) || key.length !== expected) {
    throw new Error(`${label} must be exactly ${expected} bytes`)
  }
}

class CanonicalWriter {
  private readonly chunks: Buffer[] = []

  magic(value: 'HGA1' | 'HGR1' | 'HGD1'): this {
    this.chunks.push(Buffer.from(value, 'ascii'))
    return this
  }

  u32(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error('canonical u32 is out of range')
    }
    const bytes = Buffer.alloc(4)
    bytes.writeUInt32BE(value)
    this.chunks.push(bytes)
    return this
  }

  u64(value: number): this {
    requireTimestamp(value, 'canonical u64')
    const bytes = Buffer.alloc(8)
    bytes.writeBigUInt64BE(BigInt(value))
    this.chunks.push(bytes)
    return this
  }

  string(value: string, label = 'canonical text field'): this {
    const bytes = requireText(value, label)
    return this.u32(bytes.length).raw(bytes)
  }

  optionalString(value: string, label = 'canonical optional text field'): this {
    const bytes = Buffer.from(value, 'utf8')
    if (bytes.length > MAX_TEXT_BYTES) throw new Error(`${label} exceeds ${MAX_TEXT_BYTES} bytes`)
    return this.u32(bytes.length).raw(bytes)
  }

  blob32(value: Buffer): this {
    return this.u32(value.length).raw(value)
  }

  ciphertext(value: Buffer): this {
    if (value.length > MAX_GOVERNED_CIPHERTEXT_BYTES) throw new Error('governed-data ciphertext exceeds limit')
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(value.length))
    this.chunks.push(length, value)
    return this
  }

  raw(value: Buffer): this {
    this.chunks.push(value)
    return this
  }

  finish(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

class CanonicalReader {
  private offset = 0

  constructor(private readonly bytes: Buffer) {}

  private take(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.length - this.offset) {
      throw new Error('truncated governed-data canonical envelope')
    }
    const result = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return result
  }

  magic(expected: 'HGA1' | 'HGD1'): void {
    if (!this.take(4).equals(Buffer.from(expected, 'ascii'))) {
      throw new Error('invalid governed-data canonical magic')
    }
  }

  u32(): number {
    return this.take(4).readUInt32BE()
  }

  u64(): number {
    const value = this.take(8).readBigUInt64BE()
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('canonical u64 exceeds safe integer range')
    return Number(value)
  }

  string(): string {
    const length = this.u32()
    if (length > MAX_TEXT_BYTES) throw new Error('governed-data text field exceeds limit')
    return new TextDecoder('utf-8', {fatal: true}).decode(this.take(length))
  }

  blob32(exactLength?: number): Buffer {
    const length = this.u32()
    if (exactLength !== undefined && length !== exactLength) {
      throw new Error('governed-data blob length mismatch')
    }
    return Buffer.from(this.take(length))
  }

  ciphertext(): Buffer {
    const length = this.u64()
    if (length > MAX_GOVERNED_CIPHERTEXT_BYTES) throw new Error('governed-data ciphertext exceeds limit')
    return Buffer.from(this.take(length))
  }

  done(): boolean {
    return this.offset === this.bytes.length
  }
}

function canonicalContext(context: GovernedDataContext): Buffer {
  requireTimestamp(context.created_at, 'created_at')
  requireTimestamp(context.expires_at, 'expires_at')
  if (context.expires_at <= context.created_at) throw new Error('governed-data envelope lifetime is invalid')
  return new CanonicalWriter()
    .magic('HGA1')
    .string(context.policy_id, 'policy_id')
    .string(context.consent_id, 'consent_id')
    .optionalString(context.receipt_id, 'receipt_id')
    .optionalString(context.object_id, 'object_id')
    .string(context.purpose, 'purpose')
    .u64(context.created_at)
    .u64(context.expires_at)
    .finish()
}

function canonicalRecipientWrap(envelope: VaultEnvelope): Buffer {
  return new CanonicalWriter()
    .magic('HGR1')
    .optionalString(envelope.recipient_grant_id, 'recipient_grant_id')
    .optionalString(envelope.recipient_processor, 'recipient_processor')
    .string(envelope.recipient_key_id, 'recipient_key_id')
    .string(envelope.recipient_key_commitment, 'recipient_key_commitment')
    .blob32(envelope.wrapped_dek)
    .finish()
}

function recomputeCommitments(envelope: VaultEnvelope): Pick<VaultEnvelope,
  'recipient_key_commitment' | 'associated_data_commitment' | 'wrapped_dek_commitment' | 'ciphertext_commitment'> {
  return {
    recipient_key_commitment: envelope.recipient_key_commitment,
    associated_data_commitment: sha256(canonicalContext(envelope.context)),
    wrapped_dek_commitment: sha256(canonicalRecipientWrap(envelope)),
    ciphertext_commitment: sha256(Buffer.concat([envelope.nonce, envelope.ciphertext])),
  }
}

function validateEnvelope(envelope: VaultEnvelope, now?: number): void {
  if (envelope.format !== ENVELOPE_FORMAT || envelope.cipher_suite !== CIPHER_SUITE) {
    throw new Error('unsupported governed-data envelope format or cipher suite')
  }
  requireText(envelope.recipient_key_id, 'recipient_key_id')
  const hasReceipt = envelope.context.receipt_id.length > 0
  const hasObject = envelope.context.object_id.length > 0
  if (hasReceipt !== hasObject) {
    throw new Error('receipt_id and object_id must either both be empty custody placeholders or both be present')
  }
  const hasGrant = envelope.recipient_grant_id.length > 0
  const hasProcessor = envelope.recipient_processor.length > 0
  if (hasGrant !== hasProcessor) {
    throw new Error('recipient grant and processor must either both be empty for custody or both be present')
  }
  if (!hasGrant && (hasReceipt || hasObject)) {
    throw new Error('initial custody envelopes cannot predict receipt or object ids')
  }
  requireKey(envelope.nonce, sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES, 'nonce')
  requireKey(
    envelope.wrapped_dek,
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES + sodium.crypto_box_SEALBYTES,
    'wrapped DEK',
  )
  if (envelope.ciphertext.length < sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES ||
      envelope.ciphertext.length > MAX_GOVERNED_CIPHERTEXT_BYTES) {
    throw new Error('governed-data ciphertext has an invalid length')
  }
  for (const [label, value] of Object.entries({
    recipient_key_commitment: envelope.recipient_key_commitment,
    associated_data_commitment: envelope.associated_data_commitment,
    wrapped_dek_commitment: envelope.wrapped_dek_commitment,
    ciphertext_commitment: envelope.ciphertext_commitment,
  })) {
    if (!SHA256_HEX.test(value)) throw new Error(`${label} must be lowercase SHA-256 hex`)
  }
  const expected = recomputeCommitments(envelope)
  if (!equalHex(expected.associated_data_commitment, envelope.associated_data_commitment)) {
    throw new Error('associated-data commitment does not match the governed-data context')
  }
  if (!equalHex(expected.wrapped_dek_commitment, envelope.wrapped_dek_commitment)) {
    throw new Error('grant-bound wrapped DEK commitment does not match')
  }
  if (!equalHex(expected.ciphertext_commitment, envelope.ciphertext_commitment)) {
    throw new Error('ciphertext commitment does not match')
  }
  if (now !== undefined) {
    requireTimestamp(now, 'current time')
    if (now < envelope.context.created_at || now >= envelope.context.expires_at) {
      throw new Error('governed-data envelope is not active')
    }
  }
}

function parseContext(bytes: Buffer): GovernedDataContext {
  const reader = new CanonicalReader(bytes)
  reader.magic('HGA1')
  const context = {
    policy_id: reader.string(),
    consent_id: reader.string(),
    receipt_id: reader.string(),
    object_id: reader.string(),
    purpose: reader.string(),
    created_at: reader.u64(),
    expires_at: reader.u64(),
  }
  if (!reader.done()) throw new Error('trailing bytes in governed-data associated data')
  canonicalContext(context)
  return context
}

export function canonicalVaultEnvelopeBytes(envelope: VaultEnvelope): Buffer {
  validateEnvelope(envelope)
  return new CanonicalWriter()
    .magic('HGD1')
    .string(envelope.format)
    .string(envelope.cipher_suite)
    .blob32(canonicalContext(envelope.context))
    .optionalString(envelope.recipient_grant_id, 'recipient_grant_id')
    .optionalString(envelope.recipient_processor, 'recipient_processor')
    .string(envelope.recipient_key_id)
    .string(envelope.recipient_key_commitment)
    .string(envelope.associated_data_commitment)
    .string(envelope.wrapped_dek_commitment)
    .string(envelope.ciphertext_commitment)
    .blob32(envelope.nonce)
    .blob32(envelope.wrapped_dek)
    .ciphertext(envelope.ciphertext)
    .finish()
}

export function vaultEnvelopeFromCanonicalBytes(bytes: Buffer): VaultEnvelope {
  const reader = new CanonicalReader(bytes)
  reader.magic('HGD1')
  const format = reader.string()
  const cipherSuite = reader.string()
  if (format !== ENVELOPE_FORMAT || cipherSuite !== CIPHER_SUITE) {
    throw new Error('unsupported governed-data envelope format or cipher suite')
  }
  const envelope: VaultEnvelope = {
    format,
    cipher_suite: cipherSuite,
    context: parseContext(reader.blob32()),
    recipient_grant_id: reader.string(),
    recipient_processor: reader.string(),
    recipient_key_id: reader.string(),
    recipient_key_commitment: reader.string(),
    associated_data_commitment: reader.string(),
    wrapped_dek_commitment: reader.string(),
    ciphertext_commitment: reader.string(),
    nonce: reader.blob32(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES),
    wrapped_dek: reader.blob32(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES + sodium.crypto_box_SEALBYTES),
    ciphertext: reader.ciphertext(),
  }
  if (!reader.done()) throw new Error('trailing bytes in governed-data canonical envelope')
  validateEnvelope(envelope)
  if (!canonicalVaultEnvelopeBytes(envelope).equals(bytes)) {
    throw new Error('non-canonical governed-data envelope encoding')
  }
  return envelope
}

export function vaultEnvelopeToJson(envelope: VaultEnvelope): string {
  const canonical = canonicalVaultEnvelopeBytes(envelope)
  return JSON.stringify({
    format: ENVELOPE_JSON_FORMAT,
    canonical_hex: canonical.toString('hex'),
    envelope_commitment: sha256(canonical),
  } satisfies VaultEnvelopeJson)
}

export function vaultEnvelopeFromJson(value: string): VaultEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('governed-data envelope is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('governed-data envelope JSON wrapper is invalid')
  }
  const wrapper = parsed as Record<string, unknown>
  if (wrapper.format !== ENVELOPE_JSON_FORMAT || typeof wrapper.canonical_hex !== 'string' ||
      typeof wrapper.envelope_commitment !== 'string' || Object.keys(wrapper).length !== 3 ||
      !/^(?:[0-9a-f]{2})+$/.test(wrapper.canonical_hex) || !SHA256_HEX.test(wrapper.envelope_commitment)) {
    throw new Error('governed-data envelope JSON wrapper is not canonical')
  }
  const canonical = Buffer.from(wrapper.canonical_hex, 'hex')
  if (!equalHex(sha256(canonical), wrapper.envelope_commitment)) {
    throw new Error('governed-data overall envelope commitment does not match')
  }
  const envelope = vaultEnvelopeFromCanonicalBytes(canonical)
  if (vaultEnvelopeToJson(envelope) !== value) {
    throw new Error('governed-data envelope JSON wrapper is not canonical')
  }
  return envelope
}

/**
 * Return the deterministic persisted HGD1 representation. Existing, smaller
 * envelopes retain the canonical JSON wrapper; larger envelopes use the same
 * canonical HGD1 bytes directly to avoid the JSON hex string ceiling.
 */
export function vaultEnvelopeToBytes(envelope: VaultEnvelope): Buffer {
  const canonical = canonicalVaultEnvelopeBytes(envelope)
  if (canonical.length > MAX_GOVERNED_JSON_CANONICAL_BYTES) return canonical
  return Buffer.from(JSON.stringify({
    format: ENVELOPE_JSON_FORMAT,
    canonical_hex: canonical.toString('hex'),
    envelope_commitment: sha256(canonical),
  } satisfies VaultEnvelopeJson), 'utf8')
}

/** Read either the original canonical JSON wrapper or canonical binary HGD1. */
export function vaultEnvelopeFromBytes(value: Buffer): VaultEnvelope {
  if (value.subarray(0, 4).equals(Buffer.from('HGD1', 'ascii'))) {
    return vaultEnvelopeFromCanonicalBytes(value)
  }
  return vaultEnvelopeFromJson(new TextDecoder('utf-8', {fatal: true}).decode(value))
}

function parsePublicKeyObject(value: string | Buffer, allowPrivate = false): VaultPublicKeyFile {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('governed-data public key file is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('governed-data public key file is invalid')
  }
  const key = parsed as Record<string, unknown>
  if ((key.format !== PUBLIC_KEY_FORMAT && (!allowPrivate || key.format !== PRIVATE_KEY_FORMAT)) ||
      key.algorithm !== KEY_ALGORITHM || typeof key.key_id !== 'string' || !key.key_id ||
      typeof key.public_key !== 'string' || typeof key.public_key_commitment !== 'string') {
    throw new Error('unsupported governed-data public key file')
  }
  const publicKey = decodeCanonicalBase64(key.public_key, 'recipient public key')
  requireKey(publicKey, sodium.crypto_box_PUBLICKEYBYTES, 'recipient public key')
  if (!equalHex(sha256(publicKey), key.public_key_commitment)) {
    throw new Error('governed-data public key commitment does not match')
  }
  return key as unknown as VaultPublicKeyFile
}

export function parseVaultPublicKey(value: string | Buffer): {keyId: string; publicKey: Buffer; publicKeyHash: string} {
  const parsed = parsePublicKeyObject(value)
  return {
    keyId: parsed.key_id,
    publicKey: decodeCanonicalBase64(parsed.public_key, 'recipient public key'),
    publicKeyHash: parsed.public_key_commitment,
  }
}

export function parseVaultPrivateKey(value: string | Buffer): {
  keyId: string
  publicKey: Buffer
  privateKey: Buffer
  publicKeyHash: string
} {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value
  const publicFields = parsePublicKeyObject(text, true)
  const parsed = JSON.parse(text) as Record<string, unknown>
  if (parsed.format !== PRIVATE_KEY_FORMAT || typeof parsed.private_key !== 'string') {
    throw new Error('governed-data private key file is invalid')
  }
  const privateKey = decodeCanonicalBase64(parsed.private_key, 'recipient private key')
  if (privateKey.length !== sodium.crypto_box_SECRETKEYBYTES) {
    sodium.sodium_memzero(privateKey)
    throw new Error(`recipient private key must be exactly ${sodium.crypto_box_SECRETKEYBYTES} bytes`)
  }
  const derivedPublicKey = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_scalarmult_base(derivedPublicKey, privateKey)
  const publicKey = decodeCanonicalBase64(publicFields.public_key, 'recipient public key')
  if (!crypto.timingSafeEqual(derivedPublicKey, publicKey)) {
    privateKey.fill(0)
    throw new Error('governed-data private key does not match its public key')
  }
  return {
    keyId: publicFields.key_id,
    publicKey,
    privateKey,
    publicKeyHash: publicFields.public_key_commitment,
  }
}

export function vaultPublicKeyToJson(pair: VaultKeyPair, keyId: string): string {
  requireText(keyId, 'key_id')
  requireKey(pair.publicKey, sodium.crypto_box_PUBLICKEYBYTES, 'recipient public key')
  return `${JSON.stringify({
    format: PUBLIC_KEY_FORMAT,
    algorithm: KEY_ALGORITHM,
    key_id: keyId,
    public_key: pair.publicKey.toString('base64'),
    public_key_commitment: pair.publicKeyHash,
  } satisfies VaultPublicKeyFile)}\n`
}

export function vaultPrivateKeyToJson(pair: VaultKeyPair, keyId: string): string {
  requireText(keyId, 'key_id')
  requireKey(pair.privateKey, sodium.crypto_box_SECRETKEYBYTES, 'recipient private key')
  return `${JSON.stringify({
    format: PRIVATE_KEY_FORMAT,
    algorithm: KEY_ALGORITHM,
    key_id: keyId,
    public_key: pair.publicKey.toString('base64'),
    public_key_commitment: pair.publicKeyHash,
    private_key: pair.privateKey.toString('base64'),
  } satisfies VaultPrivateKeyFile)}\n`
}

export function generateVaultKeyPair(): VaultKeyPair {
  const publicKey = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const privateKey = sodium.sodium_malloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_keypair(publicKey, privateKey)
  return {
    algorithm: KEY_ALGORITHM,
    publicKey,
    privateKey,
    publicKeyHash: sha256(publicKey),
  }
}

export function encryptVaultBytes(
  plaintext: Buffer,
  recipientPublicKey: Buffer,
  context: GovernedDataContext,
  recipient: VaultRecipient,
  now = Math.floor(Date.now() / 1000),
): VaultEnvelope {
  requireKey(recipientPublicKey, sodium.crypto_box_PUBLICKEYBYTES, 'recipient public key')
  requireTimestamp(now, 'current time')
  if (context.created_at > now || now >= context.expires_at) {
    throw new Error('governed-data envelope is not active at producer time')
  }
  if (plaintext.length > MAX_GOVERNED_PLAINTEXT_BYTES) {
    throw new Error('governed-data plaintext exceeds limit')
  }
  const associatedData = canonicalContext(context)
  const nonce = Buffer.alloc(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const dek = sodium.sodium_malloc(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  sodium.randombytes_buf(nonce)
  sodium.randombytes_buf(dek)
  try {
    const wrappedDek = Buffer.alloc(dek.length + sodium.crypto_box_SEALBYTES)
    sodium.crypto_box_seal(wrappedDek, dek, recipientPublicKey)
    const ciphertext = Buffer.alloc(plaintext.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES)
    sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ciphertext, plaintext, associatedData, null, nonce, dek)
    const envelope: VaultEnvelope = {
      format: ENVELOPE_FORMAT,
      cipher_suite: CIPHER_SUITE,
      context: {...context},
      recipient_grant_id: recipient.grant_id,
      recipient_processor: recipient.processor,
      recipient_key_id: recipient.key_id,
      recipient_key_commitment: sha256(recipientPublicKey),
      associated_data_commitment: sha256(associatedData),
      wrapped_dek_commitment: '',
      ciphertext_commitment: sha256(Buffer.concat([nonce, ciphertext])),
      nonce,
      wrapped_dek: wrappedDek,
      ciphertext,
    }
    envelope.wrapped_dek_commitment = sha256(canonicalRecipientWrap(envelope))
    validateEnvelope(envelope)
    return envelope
  } finally {
    sodium.sodium_memzero(dek)
  }
}

function unwrapDek(envelope: VaultEnvelope, publicKey: Buffer, privateKey: Buffer): Buffer {
  requireKey(publicKey, sodium.crypto_box_PUBLICKEYBYTES, 'recipient public key')
  requireKey(privateKey, sodium.crypto_box_SECRETKEYBYTES, 'recipient private key')
  if (!equalHex(sha256(publicKey), envelope.recipient_key_commitment)) {
    throw new Error('recipient public key does not match the envelope commitment')
  }
  const dek = sodium.sodium_malloc(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  if (!sodium.crypto_box_seal_open(dek, envelope.wrapped_dek, publicKey, privateKey)) {
    sodium.sodium_memzero(dek)
    throw new Error('unable to unwrap governed-data DEK')
  }
  return dek
}

export function decryptVaultBytes(
  envelope: VaultEnvelope,
  recipientPublicKey: Buffer,
  recipientPrivateKey: Buffer,
  now?: number,
): Buffer {
  validateEnvelope(envelope, now)
  const dek = unwrapDek(envelope, recipientPublicKey, recipientPrivateKey)
  const plaintext = Buffer.alloc(envelope.ciphertext.length - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES)
  try {
    try {
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        plaintext,
        null,
        envelope.ciphertext,
        canonicalContext(envelope.context),
        envelope.nonce,
        dek,
      )
      return plaintext
    } catch (error) {
      sodium.sodium_memzero(plaintext)
      throw error
    }
  } finally {
    sodium.sodium_memzero(dek)
  }
}

export function rewrapVaultEnvelope(
  envelope: VaultEnvelope,
  currentPublicKey: Buffer,
  currentPrivateKey: Buffer,
  nextPublicKey: Buffer,
  nextRecipient: VaultRecipient,
  now?: number,
): VaultEnvelope {
  validateEnvelope(envelope, now)
  requireKey(nextPublicKey, sodium.crypto_box_PUBLICKEYBYTES, 'new recipient public key')
  requireText(nextRecipient.grant_id, 'new recipient grant_id')
  requireText(nextRecipient.processor, 'new recipient processor')
  requireText(nextRecipient.key_id, 'new recipient key_id')
  const dek = unwrapDek(envelope, currentPublicKey, currentPrivateKey)
  try {
    const wrappedDek = Buffer.alloc(dek.length + sodium.crypto_box_SEALBYTES)
    sodium.crypto_box_seal(wrappedDek, dek, nextPublicKey)
    const result: VaultEnvelope = {
      ...envelope,
      context: {...envelope.context},
      recipient_grant_id: nextRecipient.grant_id,
      recipient_processor: nextRecipient.processor,
      recipient_key_id: nextRecipient.key_id,
      recipient_key_commitment: sha256(nextPublicKey),
      wrapped_dek: wrappedDek,
      wrapped_dek_commitment: '',
      nonce: Buffer.from(envelope.nonce),
      ciphertext: Buffer.from(envelope.ciphertext),
    }
    result.wrapped_dek_commitment = sha256(canonicalRecipientWrap(result))
    validateEnvelope(result, now)
    return result
  } finally {
    sodium.sodium_memzero(dek)
  }
}

export function vaultEnvelopeCommitment(envelope: VaultEnvelope): string {
  return sha256(canonicalVaultEnvelopeBytes(envelope))
}

export function vaultAssociatedDataCommitment(context: GovernedDataContext): string {
  return sha256(canonicalContext(context))
}

export function requireInitialCustodyEnvelope(envelope: VaultEnvelope): void {
  validateEnvelope(envelope)
  if (envelope.context.receipt_id || envelope.context.object_id ||
      envelope.recipient_grant_id || envelope.recipient_processor) {
    throw new Error('initial custody envelope must not contain receipt, object, grant, or processor ids')
  }
}
