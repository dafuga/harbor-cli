import {createECDH, createPrivateKey, sign} from 'node:crypto'
import {Bytes, Checksum256, PublicKey, Signature} from '@wharfkit/antelope'

type AntelopeKeyType = 'K1' | 'R1'
const CURVES = {
  K1: {
    name: 'secp256k1',
    order: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
    parameters: Buffer.from('a00706052b8104000a', 'hex'),
  },
  R1: {
    name: 'prime256v1',
    order: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
    parameters: Buffer.from('a00a06082a8648ce3d030107', 'hex'),
  },
} as const

export function generateAntelopeSecret(type: AntelopeKeyType): Buffer {
  const curve = createECDH(CURVES[type].name)
  curve.generateKeys()
  const scalar = curve.getPrivateKey()
  const bytes = Buffer.alloc(32)
  scalar.copy(bytes, bytes.length - scalar.length)
  scalar.fill(0)
  return bytes
}

export function antelopePublicKey(type: AntelopeKeyType, secret: Buffer): PublicKey {
  const curve = createECDH(CURVES[type].name)
  curve.setPrivateKey(secret)
  return PublicKey.from({type, compressed: curve.getPublicKey(undefined, 'compressed')})
}

function isCanonicalK1Scalar(scalar: Buffer): boolean {
  return (scalar[0] & 0x80) === 0 && (scalar[0] !== 0 || (scalar[1] & 0x80) !== 0)
}

function compactSignature(raw: Buffer, message: Bytes, key: PublicKey): Signature | undefined {
  if (raw.length !== 64 || (key.type !== 'K1' && key.type !== 'R1')) throw new Error('invalid ECDSA signature')
  const order = CURVES[key.type].order
  const r = raw.subarray(0, 32)
  let s = raw.subarray(32)
  const scalar = BigInt('0x' + s.toString('hex'))
  // Normalize to low S before recovering the signature header byte.
  if (scalar > order / 2n && scalar < order) {
    s = Buffer.from((order - scalar).toString(16).padStart(64, '0'), 'hex')
  }
  if (key.type === 'K1' && (!isCanonicalK1Scalar(r) || !isCanonicalK1Scalar(s))) return undefined
  const digest = Checksum256.hash(message)
  for (let recid = 0; recid < 4; recid++) {
    const signature = Signature.from({type: key.type, r, s, recid})
    try {
      if (signature.recoverDigest(digest).equals(key) && signature.verifyDigest(digest, key)) return signature
    } catch {
      // Some recovery identifiers have no point for this signature.
    }
  }
  throw new Error('signature did not match the stored public key')
}

export function recoverableR1Signature(raw: Buffer, message: Bytes, key: PublicKey): Signature {
  if (key.type !== 'R1') throw new Error('invalid Secure Enclave signature key')
  return compactSignature(raw, message, key)!
}

export function signAntelopeMessage(type: AntelopeKeyType, secret: Buffer, message: Bytes, key: PublicKey): Signature {
  const parameters = CURVES[type].parameters
  // RFC 5915 ECPrivateKey, with the named curve and a 32-byte private scalar.
  // Signing uses OpenSSL. WharfKit only encodes and recovers public signature data.
  const prefix = Buffer.from([0x30, 37 + parameters.length, 0x02, 0x01, 0x01, 0x04, 0x20])
  const der = Buffer.concat([prefix, secret, parameters])
  let privateKey
  try {
    privateKey = createPrivateKey({key: der, format: 'der', type: 'sec1'})
  } finally {
    der.fill(0)
  }
  for (let attempt = 0; attempt < 128; attempt++) {
    const raw = sign('sha256', message.array, {key: privateKey, dsaEncoding: 'ieee-p1363'})
    const signature = compactSignature(raw, message, key)
    if (signature) return signature
  }
  throw new Error('unable to create a canonical Antelope signature')
}
