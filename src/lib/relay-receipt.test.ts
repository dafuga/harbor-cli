import assert from 'node:assert/strict'
import test from 'node:test'
import {PrivateKey} from '@wharfkit/antelope'
import {relayReceiptBytes, verifyRelayReceipt} from './relay-receipt.js'

test('relay receipt binds one recipient key and every payment and ciphertext field', () => {
  const key = PrivateKey.generate('K1')
  const now = 1760000000000
  const receipt = {
    chain_id: 'ab'.repeat(32),
    contract: 'harborrelay',
    payer: 'sender',
    provider: 'relayprov',
    receipt_id: 'cd'.repeat(32),
    ciphertext_hash: 'ef'.repeat(32),
    bytes: 528,
    charge: '0.1000 HRBR',
    expires_at: now / 1000 + 60,
  }
  const recipientKey = key.toPublic().toString()
  const signed = {
    ...receipt,
    receipt_key: recipientKey,
    signed_receipt: String(key.signMessage(relayReceiptBytes(receipt))),
  }

  assert.doesNotThrow(() => verifyRelayReceipt(signed, recipientKey, now))
  assert.throws(() => verifyRelayReceipt(signed, String(PrivateKey.generate('K1').toPublic()), now), /key mismatch/)
  assert.throws(() => verifyRelayReceipt(signed, recipientKey, now + 61_000), /expired/)
  for (const change of [
    {chain_id: 'fe'.repeat(32)}, {contract: 'anotheracct'}, {payer: 'different'}, {provider: 'different'},
    {receipt_id: 'ba'.repeat(32)}, {ciphertext_hash: 'bc'.repeat(32)}, {bytes: 529}, {charge: '0.1001 HRBR'},
    {expires_at: receipt.expires_at + 1},
  ]) {
    assert.throws(() => verifyRelayReceipt({...signed, ...change}, recipientKey, now), /signature does not match/)
  }
})
