import {afterEach, expect, test, vi} from 'vitest'
import {PrivateKey} from '@wharfkit/antelope'
import {relayPayment} from '../../../src/utils/market-services/relayPayment.js'
import {relayReceipt} from '../../../src/utils/market-services/relayReceipt.js'
import type {RelayPaymentOptions} from '../../../src/utils/market-services/relayPayment.types.js'
import * as tx from '../../../src/lib/tx.js'

vi.mock('../../../src/lib/tx.js', async importOriginal => ({
  ...await importOriginal<typeof tx>(),
  serializeAction: vi.fn(async action => action),
  transactActions: vi.fn(async () => ({transaction_id: 'test-payment', status: 'executed'})),
}))
afterEach(() => vi.clearAllMocks())

function fixture() {
  const key = PrivateKey.generate('K1')
  const receipt = {
    chain_id: 'ab'.repeat(32), contract: 'harborrelay', payer: 'sender', provider: 'relayprov',
    receipt_id: 'cd'.repeat(32), ciphertext_hash: 'ef'.repeat(32), bytes: 528,
    charge: '0.1000 HRBR', expires_at: Math.floor(Date.now() / 1000) + 60,
  }
  const recipientKey = String(key.toPublic())
  const options: RelayPaymentOptions = {actor: 'sender', expectChainId: receipt.chain_id, recipientKey, relayContract: 'harborrelay'}
  return {receipt: {...receipt, receipt_key: recipientKey, signed_receipt: String(key.signMessage(relayReceipt(receipt)))}, options}
}

test('relay payment serializes the record and exact token transfer in one transaction', async () => {
  const {receipt, options} = fixture()
  expect(await relayPayment(receipt, options)).toMatchObject({transaction_id: 'test-payment'})
  const actions = vi.mocked(tx.transactActions).mock.calls[0][1]
  expect(actions).toMatchObject([
    {contract: 'harborrelay', action: 'record', data: {payer: 'sender', receipt_id: receipt.receipt_id}},
    {contract: 'eosio.token', action: 'transfer', data: {
      from: 'sender', to: 'harborrelay', quantity: '0.1000 HRBR', memo: 'relay:' + receipt.receipt_id,
    }},
  ])
  expect(tx.transactActions).toHaveBeenCalledTimes(1)
})

test('mismatched chain and payer stop before encoding or submitting payment', async () => {
  const {receipt, options} = fixture()
  await expect(relayPayment(receipt, {...options, expectChainId: 'ee'.repeat(32)})).rejects.toThrow(/chain-id/)
  await expect(relayPayment(receipt, {...options, actor: 'other'})).rejects.toThrow(/signing payer/)
  expect(tx.serializeAction).not.toHaveBeenCalled()
  expect(tx.transactActions).not.toHaveBeenCalled()
})
