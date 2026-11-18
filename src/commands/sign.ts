/*
 * Transaction signing flow adapted from greymass/antelope-cli.
 * Copyright (c) Greymass Inc. and antelope-cli contributors.
 * BSD-3-Clause. See NOTICE.
 */
import fs from 'node:fs/promises'
import {Checksum256, SignedTransaction, Transaction} from '@wharfkit/antelope'
import {Command} from 'commander'
import qrcode from 'qrcode-terminal'
import {SigningRequest} from '@wharfkit/signing-request'
import zlib from 'pako'
import {addTxOptions} from './action.js'
import {antelopeSigners} from '../lib/private-key-wallet.js'
import {clientFor, parseJson, serializeAction} from '../lib/tx.js'

export function createSignCommand(): Command {
  const sign = new Command('sign')
  sign.description('Create and inspect signing requests')

  const request = sign.command('request <contract> <action> <data-json>')
  request.description('Create an ESR signing request for one action')
  request.option('--callback <url>', 'callback URL for wallets')
  request.option('--no-broadcast', 'request a signature without wallet broadcast')
  request.option('--qr', 'render a terminal QR code')
  addTxOptions(request).action(async (contract: string, actionName: string, dataJson: string, options) => {
    const client = clientFor(options.url)
    const info = await client.v1.chain.get_info()
    const action = await serializeAction({
      contract,
      action: actionName,
      data: parseJson(dataJson),
      authorization: options.auth,
      actor: options.actor,
      permission: options.permission,
      url: options.url,
    })
    const req = await SigningRequest.create(
      {
        chainId: info.chain_id,
        action,
        broadcast: options.broadcast,
        callback: options.callback,
      },
      {zlib},
    )
    const uri = req.encode(true, false, 'esr:')
    if (options.qr && !options.json) {
      qrcode.generate(uri, {small: true})
    }
    if (options.json) {
      console.log(JSON.stringify({uri}, null, 2))
      return
    }
    console.log(uri)
  })

  sign
    .command('transaction <file>')
    .description('Add local signatures to an ABI-packed transaction without broadcasting')
    .requiredOption('--chain-id <id>', 'chain ID to bind into the signing digest')
    .requiredOption('-k, --key <name>', 'wallet key name or comma-separated key names')
    .action(async (file: string, options: {chainId: string; key: string}) => {
      const input = JSON.parse(await fs.readFile(file, 'utf8'))
      const chainId = Checksum256.from(options.chainId)
      if (input.chain_id !== undefined && !chainId.equals(input.chain_id)) {
        throw new Error('chain ID does not match the transaction file')
      }
      const previous = SignedTransaction.from(input.transaction ?? input)
      if (previous.context_free_data.length) throw new Error('transactions with context-free data are unsupported')
      const transaction = Transaction.from({...previous})
      const message = transaction.signingData(chainId)
      const signatures = new Map(previous.signatures.map((signature) => [
        signature.recoverMessage(message).toString(), signature,
      ]))
      for (const signer of await antelopeSigners(options.key)) {
        const key = signer.publicKey.toString()
        if (!signatures.has(key)) signatures.set(key, await signer.sign(message))
      }
      console.log(JSON.stringify({
        chain_id: chainId,
        transaction: SignedTransaction.from({...transaction, signatures: [...signatures.values()]}),
      }, null, 2))
    })

  return sign
}
