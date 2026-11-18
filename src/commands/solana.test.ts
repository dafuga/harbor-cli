import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import test from 'node:test'
import {Base58} from '@wharfkit/antelope'
import sodium from 'sodium-native'
import {signSolanaTransaction} from './solana.js'
import {signSolanaMessage} from '../lib/wallet.js'

test('Solana signing preserves the wire message and other signer slots', async () => {
  const seed = randomBytes(32)
  const publicKey = Buffer.alloc(32)
  const secretKey = Buffer.alloc(64)
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  secretKey.fill(0)
  const existingSignature = randomBytes(64)
  const otherPublicKey = randomBytes(32)
  const signer = {
    publicKey: Base58.encode(publicKey),
    sign: async (message: Buffer) => signSolanaMessage(seed, message),
  }
  try {
    for (const version of ['legacy', 0]) {
      const message = Buffer.concat([
        version === 0 ? Buffer.of(0x80) : Buffer.alloc(0),
        Buffer.of(2, 1, 0, 2), // two signers, second read-only, two static account keys
        otherPublicKey, publicKey, randomBytes(32), // account keys and recent blockhash
        version === 0 ? Buffer.of(0, 0) : Buffer.of(0), // instructions and v0 lookups
      ])
      const wire = Buffer.concat([Buffer.of(2), existingSignature, Buffer.alloc(64), message])
      const signed = await signSolanaTransaction(wire, signer)
      assert(signed.subarray(1, 65).equals(existingSignature))
      assert(signed.subarray(129).equals(message))
      assert(sodium.crypto_sign_verify_detached(signed.subarray(65, 129), message, publicKey))
      await assert.rejects(signSolanaTransaction(Buffer.concat([wire, Buffer.of(0)]), signer), /invalid serialized/)
      await assert.rejects(signSolanaTransaction(wire, {
        ...signer, publicKey: Base58.encode(randomBytes(32)),
      }), /not a required signer/)
    }
  } finally {
    seed.fill(0)
  }
})
