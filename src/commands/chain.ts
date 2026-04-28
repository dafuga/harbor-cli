import {Command} from 'commander'
import {PrivateKey} from '@wharfkit/antelope'
import {addTxOptions, pushJsonAction} from './action.js'
import {clientFor, permissionLevel, printResult, transactActions} from '../lib/tx.js'

function authForKey(key: string) {
  return {threshold: 1, keys: [{key, weight: 1}], accounts: [], waits: []}
}

function parseCodeAccounts(value?: string): Array<{permission: {actor: string; permission: string}; weight: number}> {
  if (!value) {
    return []
  }
  return value.split(',').filter(Boolean).map((actor) => ({
    permission: {actor, permission: 'eosio.code'},
    weight: 1,
  }))
}

export function createChainCommand(): Command {
  const chain = new Command('chain')
  chain.description('Antelope-style chain administration helpers')

  chain
    .command('info')
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('--json', 'print JSON')
    .action(async (options) => {
      const info = await clientFor(options.url).v1.chain.get_info()
      printResult(info, options.json ?? true)
    })

  chain
    .command('keygen')
    .description('Generate a private/public key pair')
    .option('--json', 'print JSON')
    .action((options) => {
      const privateKey = PrivateKey.generate('K1')
      const result = {privateKey: privateKey.toString(), publicKey: privateKey.toPublic().toString()}
      printResult(result, options.json ?? true)
    })

  addTxOptions(
    chain
      .command('create-account <account>')
      .description('Create an account and optionally buy RAM/stake CPU/NET')
      .requiredOption('--owner-key <key>', 'owner public key')
      .requiredOption('--active-key <key>', 'active public key')
      .option('--creator <account>', 'creator account', 'eosio')
      .option('--ram-bytes <bytes>', 'RAM bytes to buy', '8192')
      .option('--buy-ram <quantity>', 'RAM quantity to buy with eosio::buyram')
      .option('--stake-net <quantity>', 'NET stake quantity')
      .option('--stake-cpu <quantity>', 'CPU stake quantity')
  ).action(async (account: string, options) => {
    const creator = options.creator
    const auth = [permissionLevel({...options, actor: options.actor ?? creator})]
    const actions: Array<Record<string, unknown>> = [{
      account: 'eosio',
      name: 'newaccount',
      authorization: auth,
      data: {
        creator,
        name: account,
        owner: authForKey(options.ownerKey),
        active: authForKey(options.activeKey),
      },
    }]
    if (options.buyRam) {
      actions.push({
        account: 'eosio',
        name: 'buyram',
        authorization: auth,
        data: {
          payer: creator,
          receiver: account,
          quant: options.buyRam,
        },
      })
    } else if (Number(options.ramBytes) > 0) {
      actions.push({
        account: 'eosio',
        name: 'buyrambytes',
        authorization: auth,
        data: {
          payer: creator,
          receiver: account,
          bytes: Number(options.ramBytes),
        },
      })
    }
    if (options.stakeNet && options.stakeCpu) {
      actions.push({
        account: 'eosio',
        name: 'delegatebw',
        authorization: auth,
        data: {
          from: creator,
          receiver: account,
          stake_net_quantity: options.stakeNet,
          stake_cpu_quantity: options.stakeCpu,
          transfer: false,
        },
      })
    }
    printResult(await transactActions({...options, actor: options.actor ?? creator}, actions), options.json)
  })

  addTxOptions(
    chain
      .command('transfer')
      .requiredOption('--from <account>')
      .requiredOption('--to <account>')
      .requiredOption('--quantity <asset>')
      .option('--memo <memo>', 'transfer memo', '')
      .option('--token <account>', 'token contract', 'eosio.token')
  ).action(async (options) => {
    await pushJsonAction(options.token, 'transfer', {
      from: options.from,
      to: options.to,
      quantity: options.quantity,
      memo: options.memo,
    }, {...options, actor: options.actor ?? options.from})
  })

  addTxOptions(
    chain
      .command('updateauth')
      .requiredOption('--account <account>')
      .requiredOption('--permission-name <name>')
      .requiredOption('--parent <name>')
      .option('--key-auth <public-key>', 'public key in authority')
      .option('--code-account <accounts>', 'comma-separated accounts to add as eosio.code')
  ).action(async (options) => {
    await pushJsonAction('eosio', 'updateauth', {
      account: options.account,
      permission: options.permissionName,
      parent: options.parent,
      auth: {
        threshold: 1,
        keys: options.keyAuth ? [{key: options.keyAuth, weight: 1}] : [],
        accounts: parseCodeAccounts(options.codeAccount),
        waits: [],
      },
    }, {...options, actor: options.actor ?? options.account})
  })

  addTxOptions(
    chain
      .command('linkauth')
      .requiredOption('--account-name <account>')
      .requiredOption('--contract <account>')
      .requiredOption('--action-name <action>')
      .requiredOption('--requirement <permission>')
  ).action(async (options) => {
    await pushJsonAction('eosio', 'linkauth', {
      account: options.accountName,
      code: options.contract,
      type: options.actionName,
      requirement: options.requirement,
    }, {...options, actor: options.actor ?? options.accountName})
  })

  return chain
}
