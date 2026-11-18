/*
 * Account commands adapted from greymass/antelope-cli.
 * Copyright (c) Greymass Inc. and antelope-cli contributors.
 * BSD-3-Clause. See NOTICE.
 */
import {Authority, PermissionLevel, PublicKey, Serializer} from '@wharfkit/antelope'
import type {AuthorityType} from '@wharfkit/antelope'
import {Command} from 'commander'
import {createContractAccount} from '../lib/deploy.js'
import {clientFor, parseJson, permissionLevel, printResult} from '../lib/tx.js'
import {addTxOptions, pushJsonAction} from './action.js'
import type {ActionOptions} from './action.js'

function publicKey(value: string): string {
  try {
    return PublicKey.from(value).toString()
  } catch {
    throw new Error('expected an Antelope public key')
  }
}

function permissionBytes(level: PermissionLevel): Buffer {
  const bytes = Buffer.alloc(16)
  bytes.writeBigUInt64BE(BigInt(level.actor.value.toString()), 0)
  bytes.writeBigUInt64BE(BigInt(level.permission.value.toString()), 8)
  return bytes
}

function orderedAuthority(input: Exclude<AuthorityType, Authority>): Authority {
  const authority = Authority.from({
    ...input,
    accounts: input.accounts?.map(({permission, weight}) => ({
      permission: PermissionLevel.from(permission), weight,
    })),
  })
  authority.keys.sort((a, b) => Buffer.compare(
    Serializer.encode({object: a.key}).array, Serializer.encode({object: b.key}).array,
  ))
  authority.accounts.sort((a, b) => Buffer.compare(
    permissionBytes(a.permission), permissionBytes(b.permission),
  ))
  authority.waits.sort((a, b) => a.wait_sec.toNumber() - b.wait_sec.toNumber())
  return authority
}

export function createAccountCommand(): Command {
  const account = new Command('account').description('Read and manage Antelope accounts')
  account
    .command('info <account>')
    .description('Read account permissions and resources')
    .option('-u, --url <url>', 'Harbor chain API URL')
    .option('--json', 'print JSON')
    .action(async (name: string, options: {url?: string; json?: boolean}) => {
      printResult(await clientFor(options.url).v1.chain.get_account(name), options.json)
    })

  addTxOptions(account.command('create <creator> <account>').description('Create an Antelope account'))
    .requiredOption('--owner-key <public-key>', 'new account owner key')
    .requiredOption('--active-key <public-key>', 'new account active key')
    .option('--ram-bytes <bytes>', 'bytes of RAM to buy, if required by this chain', '0')
    .option('--stake-net <asset>', 'network stake, if required by this chain')
    .option('--stake-cpu <asset>', 'CPU stake, if required by this chain')
    .action(async (creator: string, name: string, options: ActionOptions & {
      ownerKey: string; activeKey: string; ramBytes: string; stakeNet?: string; stakeCpu?: string
    }) => {
      const ramBytes = Number(options.ramBytes)
      if (!Number.isSafeInteger(ramBytes) || ramBytes < 0 || ramBytes > 0xffffffff) {
        throw new Error('RAM bytes must be an unsigned 32-bit integer')
      }
      if (Boolean(options.stakeNet) !== Boolean(options.stakeCpu)) {
        throw new Error('provide both --stake-net and --stake-cpu')
      }
      printResult(await createContractAccount({
        ...options, creator, account: name, ramBytes,
        ownerKey: publicKey(options.ownerKey), activeKey: publicKey(options.activeKey),
      }), options.json)
    })

  addTxOptions(account
    .command('set-permission <account> <name> <parent> <authority-json>')
    .description('Set an account authority using a threshold and weighted keys or permission levels')
  ).action(async (name: string, permission: string, parent: string, authorityJson: string, options: ActionOptions) => {
    const signer = permissionLevel(options, name)
    await pushJsonAction('eosio', 'updateauth', {
      account: name, permission, parent, auth: orderedAuthority(parseJson(authorityJson) as Exclude<AuthorityType, Authority>),
    }, {...options, ...signer})
  })

  return account
}
