import {Command} from 'commander'
import {Transaction} from '@wharfkit/antelope'
import {addTxOptions, pushJsonAction} from './action.js'
import {clientFor, getTableRows, permissionLevel, printResult, serializeAction, transactActions} from '../lib/tx.js'

export interface BankBalance {
  asset_id: number
  token_contract: string
  token_symbol: string
  spending: string
  savings: string
  daily_limit: string
  msig_threshold: string
  spent_today: string
  spent_day: number
  unlock_delay_sec: number
  high_value_actor?: string
  high_value_permission?: string
}

export interface BankOptions {
  url?: string
  contract?: string
  token?: string
  symbol?: string
  json?: boolean
  actor?: string
  permission?: string
  key?: string
  auth?: string
  expiration?: string
}

export interface WithdrawProposalInput {
  owner: string
  to: string
  tokenContract: string
  quantity: string
  memo: string
  bankContract: string
  msigContract: string
  proposer: string
  proposalName: string
  highValueAuth: string
  requestedApprovals?: Array<{actor: string; permission: string}>
  expirationSeconds: number
  url?: string
}

const DEFAULT_BANK_CONTRACT = process.env.HARBOR_BANK_CONTRACT ?? 'harborbank'
const DEFAULT_TOKEN_CONTRACT = process.env.HARBOR_BANK_TOKEN_CONTRACT ?? 'eosio.token'
const DEFAULT_SYMBOL = process.env.HARBOR_BANK_SYMBOL ?? '4,SYS'
const DEFAULT_MSIG_CONTRACT = process.env.HARBOR_MSIG_CONTRACT ?? 'eosio.msig'
const NAME_CHARS = '.12345abcdefghijklmnopqrstuvwxyz'

function symbolCode(symbol: string): string {
  return symbol.includes(',') ? symbol.split(',')[1] : symbol
}

export function parseBucket(value: string): number {
  if (value === 'spending' || value === 'spend' || value === '0') return 0
  if (value === 'savings' || value === 'saving' || value === 'stake' || value === 'staking' || value === '1') return 1
  throw new Error(`unknown bank bucket: ${value}`)
}

export function depositMemo(bucket: number): string {
  return bucket === 1 ? 'harborbank:savings' : 'harborbank:spending'
}

export function parsePermission(value: string): {actor: string; permission: string} {
  const [actor, permission = 'active'] = value.split('@')
  if (!actor || !permission) {
    throw new Error(`invalid permission level: ${value}`)
  }
  return {actor, permission}
}

export function parsePermissionList(value: string): Array<{actor: string; permission: string}> {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parsePermission)
}

export function generatedProposalName(prefix = 'bankwd', now = Date.now()): string {
  let value = Math.floor(now / 1000)
  let suffix = ''
  while (value > 0 && suffix.length < 13 - prefix.length) {
    suffix = NAME_CHARS[value % NAME_CHARS.length] + suffix
    value = Math.floor(value / 32)
  }
  return `${prefix}${suffix}`.slice(0, 13)
}

function uniquePermissions(levels: Array<{actor: string; permission: string}>): Array<{actor: string; permission: string}> {
  const seen = new Set<string>()
  return levels.filter((level) => {
    const key = `${level.actor}@${level.permission}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function requestedWithdrawApprovals(
  _owner: string,
  highValueAuth: string,
  highValueApprovers?: Array<{actor: string; permission: string}>
): Array<{actor: string; permission: string}> {
  const highValue = highValueApprovers?.length ? highValueApprovers : [parsePermission(highValueAuth)]
  return uniquePermissions(highValue)
}

async function loadBalances(owner: string, options: BankOptions): Promise<BankBalance[]> {
  const result = await getTableRows<BankBalance>(options.contract ?? DEFAULT_BANK_CONTRACT, 'balances', {
    url: options.url,
    scope: owner,
    limit: 1000,
  })
  return result.rows
}

async function resolveHighValueAuth(owner: string, tokenContract: string, symbol: string, options: BankOptions): Promise<string> {
  const balances = await loadBalances(owner, options)
  const balance = balances.find((row) => row.token_contract === tokenContract && symbolCode(row.token_symbol) === symbolCode(symbol))
  if (!balance?.high_value_actor || !balance.high_value_permission) {
    throw new Error('high-value auth is not configured for this bank balance; pass --high-value-auth or run bank setup-msig')
  }
  return `${balance.high_value_actor}@${balance.high_value_permission}`
}

export async function buildWithdrawProposal(input: WithdrawProposalInput) {
  const actionAuth = requestedWithdrawApprovals(input.owner, input.highValueAuth, input.requestedApprovals)
  const highValueAuth = parsePermission(input.highValueAuth)
  const approveAction = await serializeAction({
    contract: input.bankContract,
    action: 'approvewd',
    data: {
      owner: input.owner,
      to: input.to,
      token_contract: input.tokenContract,
      quantity: input.quantity,
      memo: input.memo,
    },
    authorization: `${highValueAuth.actor}@${highValueAuth.permission}`,
    actor: input.owner,
    permission: 'active',
    url: input.url,
  })

  const client = clientFor(input.url)
  const info = await client.v1.chain.get_info()
  const header = info.getTransactionHeader(input.expirationSeconds)
  const trx = Transaction.from({
    expiration: header.expiration,
    ref_block_num: header.ref_block_num,
    ref_block_prefix: header.ref_block_prefix,
    max_net_usage_words: header.max_net_usage_words,
    max_cpu_usage_ms: header.max_cpu_usage_ms,
    delay_sec: header.delay_sec,
    context_free_actions: [],
    actions: [approveAction],
    transaction_extensions: [],
  })

  const proposeAction = await serializeAction({
    contract: input.msigContract,
    action: 'propose',
    data: {
      proposer: input.proposer,
      proposal_name: input.proposalName,
      requested: actionAuth,
      trx,
    },
    authorization: `${input.proposer}@active`,
    actor: input.proposer,
    permission: 'active',
    url: input.url,
  })

  return {proposalName: input.proposalName, requested: actionAuth, transaction: trx, action: proposeAction}
}

function addReadCommands(bank: Command): void {
  bank
    .command('assets')
    .description('List Harbor Bank allowlisted assets')
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('-c, --contract <account>', 'bank contract account', DEFAULT_BANK_CONTRACT)
    .option('--json', 'print JSON')
    .action(async (options) => {
      const rows = await getTableRows(options.contract, 'assets', {url: options.url, scope: options.contract, limit: 1000})
      if (options.json) {
        console.log(JSON.stringify(rows.rows, null, 2))
      } else {
        console.table(rows.rows)
      }
    })

  bank
    .command('balances <owner>')
    .description('List owner bank balances')
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('-c, --contract <account>', 'bank contract account', DEFAULT_BANK_CONTRACT)
    .option('--json', 'print JSON')
    .action(async (owner: string, options) => {
      const rows = await loadBalances(owner, options)
      if (options.json) {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        console.table(rows)
      }
    })

  bank
    .command('unlocks <owner>')
    .description('List pending savings unlocks')
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('-c, --contract <account>', 'bank contract account', DEFAULT_BANK_CONTRACT)
    .option('--json', 'print JSON')
    .action(async (owner: string, options) => {
      const rows = await getTableRows(options.contract, 'unlocks', {url: options.url, scope: owner, limit: 1000})
      if (options.json) {
        console.log(JSON.stringify(rows.rows, null, 2))
      } else {
        console.table(rows.rows)
      }
    })
}

function addActionCommands(bank: Command): void {
  addTxOptions(
    bank
      .command('open <owner> <daily_limit> <msig_threshold> [unlock_delay_sec]')
      .description('Open or update a bank policy for an allowlisted asset')
      .option('-c, --contract <account>', 'bank contract account', DEFAULT_BANK_CONTRACT)
      .option('--token <account>', 'token contract account', DEFAULT_TOKEN_CONTRACT)
      .option('--symbol <symbol>', 'asset symbol, e.g. 4,SYS', DEFAULT_SYMBOL)
  ).action(async (owner: string, dailyLimit: string, msigThreshold: string, unlockDelaySec: string | undefined, options) => {
    await pushJsonAction(options.contract, 'open', {
      owner,
      token_contract: options.token,
      token_symbol: options.symbol,
      daily_limit: dailyLimit,
      msig_threshold: msigThreshold,
      unlock_delay_sec: Number(unlockDelaySec ?? 86400),
    }, {...options, actor: options.actor ?? owner})
  })

  addTxOptions(
    bank
      .command('deposit <owner> <quantity>')
      .description('Deposit tokens into spending or protected savings')
      .option('-c, --contract <account>', 'bank contract account', DEFAULT_BANK_CONTRACT)
      .option('--token <account>', 'token contract account', DEFAULT_TOKEN_CONTRACT)
      .option('--bucket <bucket>', 'spending or savings', 'spending')
  ).action(async (owner: string, quantity: string, options) => {
    const bucket = parseBucket(options.bucket)
    const signedOptions = {...options, actor: owner, permission: 'active'}
    const depositAction = await serializeAction({
      ...signedOptions,
      contract: options.contract,
      action: 'deposit',
      data: {
        owner,
        token_contract: options.token,
        quantity,
        bucket,
      },
      authorization: `${owner}@active`,
    })
    const transferAction = await serializeAction({
      ...signedOptions,
      contract: options.token,
      action: 'transfer',
      data: {
        from: owner,
        to: options.contract,
        quantity,
        memo: depositMemo(bucket),
      },
      authorization: `${owner}@active`,
    })
    const result = await transactActions(signedOptions, [depositAction, transferAction])
    printResult(result, options.json)
  })

  addTxOptions(
    bank
      .command('prepare-deposit <owner> <quantity>')
      .description('Create a deposit intent without transferring tokens')
      .option('-c, --contract <account>', 'bank contract account', DEFAULT_BANK_CONTRACT)
      .option('--token <account>', 'token contract account', DEFAULT_TOKEN_CONTRACT)
      .option('--bucket <bucket>', 'spending or savings', 'spending')
  ).action(async (owner: string, quantity: string, options) => {
    await pushJsonAction(options.contract, 'deposit', {
      owner,
      token_contract: options.token,
      quantity,
      bucket: parseBucket(options.bucket),
    }, {...options, actor: options.actor ?? owner})
  })

  addTxOptions(
    bank
      .command('withdraw <owner> <to> <quantity> [memo]')
      .description('Withdraw from spending balance')
      .option('-c, --contract <account>', 'bank contract account', DEFAULT_BANK_CONTRACT)
      .option('--token <account>', 'token contract account', DEFAULT_TOKEN_CONTRACT)
      .option('--high-value-auth <actor@permission>', 'include a high-value approval action before the withdrawal')
  ).action(async (owner: string, to: string, quantity: string, memo: string | undefined, options) => {
    if (!options.highValueAuth) {
      await pushJsonAction(options.contract, 'withdraw', {
        owner,
        to,
        token_contract: options.token,
        quantity,
        memo: memo ?? '',
      }, {...options, actor: options.actor ?? owner})
      return
    }

    const activeAuth = parsePermission(`${owner}@active`)
    const highValueAuth = parsePermission(options.highValueAuth)
    const signedOptions = {...options, actor: options.actor ?? owner, permission: options.permission ?? 'active'}
    const approveAction = await serializeAction({
      ...signedOptions,
      contract: options.contract,
      action: 'approvewd',
      data: {owner, to, token_contract: options.token, quantity, memo: memo ?? ''},
      authorization: `${highValueAuth.actor}@${highValueAuth.permission}`,
    })
    const withdrawAction = await serializeAction({
      ...signedOptions,
      contract: options.contract,
      action: 'withdraw',
      data: {owner, to, token_contract: options.token, quantity, memo: memo ?? ''},
      authorization: `${activeAuth.actor}@${activeAuth.permission}`,
    })
    printResult(await transactActions(signedOptions, [approveAction, withdrawAction]), options.json)
  })

  addTxOptions(
    bank
      .command('move-to-savings <owner> <quantity>')
      .description('Move spending funds into protected savings')
      .option('-c, --contract <account>', 'bank contract account', DEFAULT_BANK_CONTRACT)
      .option('--token <account>', 'token contract account', DEFAULT_TOKEN_CONTRACT)
  ).action(async (owner: string, quantity: string, options) => {
    await pushJsonAction(options.contract, 'movetosave', {owner, token_contract: options.token, quantity}, {...options, actor: options.actor ?? owner})
  })

  addTxOptions(
    bank
      .command('request-unlock <owner> <quantity>')
      .description('Start a delayed savings unlock')
      .option('-c, --contract <account>', 'bank contract account', DEFAULT_BANK_CONTRACT)
      .option('--token <account>', 'token contract account', DEFAULT_TOKEN_CONTRACT)
  ).action(async (owner: string, quantity: string, options) => {
    await pushJsonAction(options.contract, 'requnlock', {owner, token_contract: options.token, quantity}, {...options, actor: options.actor ?? owner})
  })

  addTxOptions(
    bank
      .command('finish-unlock <owner> <unlock_id>')
      .description('Move a ready savings unlock back to spending')
      .option('-c, --contract <account>', 'bank contract account', DEFAULT_BANK_CONTRACT)
  ).action(async (owner: string, unlockId: string, options) => {
    await pushJsonAction(options.contract, 'finishunlock', {owner, unlock_id: Number(unlockId)}, {...options, actor: options.actor ?? owner})
  })

  addTxOptions(
    bank
      .command('set-policy <owner> <daily_limit> <msig_threshold> <unlock_delay_sec>')
      .description('Update spending policy; weakening protection may require high-value auth')
      .option('-c, --contract <account>', 'bank contract account', DEFAULT_BANK_CONTRACT)
      .option('--token <account>', 'token contract account', DEFAULT_TOKEN_CONTRACT)
      .option('--symbol <symbol>', 'asset symbol, e.g. 4,SYS', DEFAULT_SYMBOL)
  ).action(async (owner: string, dailyLimit: string, msigThreshold: string, unlockDelaySec: string, options) => {
    await pushJsonAction(options.contract, 'setpolicy', {
      owner,
      token_contract: options.token,
      token_symbol: options.symbol,
      daily_limit: dailyLimit,
      msig_threshold: msigThreshold,
      unlock_delay_sec: Number(unlockDelaySec),
    }, {...options, actor: options.actor ?? owner})
  })

  addTxOptions(
    bank
      .command('set-high-value-auth <owner> <actor_permission>')
      .description('Set the additional permission required for high-value withdrawals')
      .option('-c, --contract <account>', 'bank contract account', DEFAULT_BANK_CONTRACT)
      .option('--token <account>', 'token contract account', DEFAULT_TOKEN_CONTRACT)
      .option('--symbol <symbol>', 'asset symbol, e.g. 4,SYS', DEFAULT_SYMBOL)
  ).action(async (owner: string, actorPermission: string, options) => {
    const highValue = parsePermission(actorPermission)
    await pushJsonAction(options.contract, 'sethvauth', {
      owner,
      token_contract: options.token,
      token_symbol: options.symbol,
      actor: highValue.actor,
      permission: highValue.permission,
    }, {...options, actor: options.actor ?? owner})
  })
}

function addMsigCommands(bank: Command): void {
  addTxOptions(
    bank
      .command('setup-msig <owner>')
      .description('Create a high-value permission and optionally connect it to Harbor Bank')
      .requiredOption('--approvers <levels>', 'comma-separated actor@permission approvers')
      .option('--key-auth <keys>', 'comma-separated public keys allowed to satisfy the high-value permission')
      .option('--threshold <number>', 'approval threshold', '1')
      .option('--permission-name <name>', 'high-value permission name', 'bankhigh')
      .option('--parent <name>', 'parent permission', 'owner')
      .option('-c, --contract <account>', 'bank contract account', DEFAULT_BANK_CONTRACT)
      .option('--token <account>', 'token contract account', DEFAULT_TOKEN_CONTRACT)
      .option('--symbol <symbol>', 'asset symbol, e.g. 4,SYS', DEFAULT_SYMBOL)
      .option('--msig-contract <account>', 'msig contract account to link for approval execution', DEFAULT_MSIG_CONTRACT)
      .option('--no-link-msig-exec', 'do not link eosio.msig::exec to the high-value permission')
      .option('--no-set-bank-auth', 'only create the permission; do not call harborbank::sethvauth')
  ).action(async (owner: string, options) => {
    const approvers = parsePermissionList(options.approvers)
    const keyAuths = String(options.keyAuth ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean)
    const setupAuth = permissionLevel({actor: owner, permission: options.parent === 'owner' ? 'owner' : options.permission ?? 'active'})
    const bankAuth = permissionLevel({actor: owner, permission: 'active'})
    const actions: Array<Record<string, unknown>> = [{
      account: 'eosio',
      name: 'updateauth',
      authorization: [setupAuth],
      data: {
        account: owner,
        permission: options.permissionName,
        parent: options.parent,
        auth: {
          threshold: Number(options.threshold),
          keys: keyAuths.map((key) => ({key, weight: 1})),
          accounts: approvers.map((level) => ({permission: level, weight: 1})),
          waits: [],
        },
      },
    }]

    for (const actionName of ['approvewd', 'approvepol', 'approvehv']) {
      actions.push({
        account: 'eosio',
        name: 'linkauth',
        authorization: [bankAuth],
        data: {
          account: owner,
          code: options.contract,
          type: actionName,
          requirement: options.permissionName,
        },
      })
    }

    if (options.linkMsigExec) {
      actions.push({
        account: 'eosio',
        name: 'linkauth',
        authorization: [bankAuth],
        data: {
          account: owner,
          code: options.msigContract,
          type: 'exec',
          requirement: options.permissionName,
        },
      })
    }

    if (options.setBankAuth) {
      actions.push({
        account: options.contract,
        name: 'sethvauth',
        authorization: [bankAuth],
        data: {
          owner,
          token_contract: options.token,
          token_symbol: options.symbol,
          actor: owner,
          permission: options.permissionName,
        },
      })
    }

    printResult(await transactActions({...options, actor: options.actor ?? owner, permission: options.permission ?? setupAuth.permission}, actions), options.json)
  })

  addTxOptions(
    bank
      .command('propose-withdraw <owner> <to> <quantity> [memo]')
      .description('Create an eosio.msig proposal for a high-value withdrawal approval')
      .option('-c, --contract <account>', 'bank contract account', DEFAULT_BANK_CONTRACT)
      .option('--token <account>', 'token contract account', DEFAULT_TOKEN_CONTRACT)
      .option('--symbol <symbol>', 'asset symbol, e.g. 4,SYS', DEFAULT_SYMBOL)
      .option('--msig-contract <account>', 'msig contract account', DEFAULT_MSIG_CONTRACT)
      .option('--proposer <account>', 'proposal owner; defaults to bank owner')
      .option('--proposal <name>', 'proposal name')
      .option('--high-value-auth <actor@permission>', 'override high-value auth instead of reading balance policy')
      .option('--approvers <levels>', 'comma-separated permission levels requested to approve the high-value permission')
  ).action(async (owner: string, to: string, quantity: string, memo: string | undefined, options) => {
    const proposer = options.proposer ?? owner
    const highValueAuth = options.highValueAuth ?? (await resolveHighValueAuth(owner, options.token, options.symbol, options))
    const proposal = await buildWithdrawProposal({
      owner,
      to,
      tokenContract: options.token,
      quantity,
      memo: memo ?? '',
      bankContract: options.contract,
      msigContract: options.msigContract,
      proposer,
      proposalName: options.proposal ?? generatedProposalName(),
      highValueAuth,
      requestedApprovals: options.approvers ? parsePermissionList(options.approvers) : undefined,
      expirationSeconds: Number(options.expiration ?? 300),
      url: options.url,
    })
    const result = await transactActions({...options, actor: options.actor ?? proposer}, [proposal.action])
    if (options.json) {
      console.log(JSON.stringify({proposal_name: proposal.proposalName, requested: proposal.requested, result}, null, 2))
      return
    }
    console.log(`proposal_name: ${proposal.proposalName}`)
    console.table(proposal.requested)
    printResult(result, false)
  })

  addTxOptions(
    bank
      .command('approve <proposer> <proposal> <level>')
      .description('Approve a bank withdrawal msig proposal')
      .option('--msig-contract <account>', 'msig contract account', DEFAULT_MSIG_CONTRACT)
  ).action(async (proposer: string, proposal: string, levelValue: string, options) => {
    const level = parsePermission(levelValue)
    await pushJsonAction(options.msigContract, 'approve', {
      proposer,
      proposal_name: proposal,
      level,
      proposal_hash: null,
    }, {...options, actor: options.actor ?? level.actor, permission: level.permission})
  })

  addTxOptions(
    bank
      .command('exec <proposer> <proposal> [executer]')
      .description('Execute an approved bank withdrawal approval msig proposal')
      .option('--msig-contract <account>', 'msig contract account', DEFAULT_MSIG_CONTRACT)
  ).action(async (proposer: string, proposal: string, executer: string | undefined, options) => {
    const execActor = executer ?? proposer
    await pushJsonAction(options.msigContract, 'exec', {
      proposer,
      proposal_name: proposal,
      executer: execActor,
    }, {...options, actor: options.actor ?? execActor})
  })
}

export function createBankCommand(): Command {
  const bank = new Command('bank')
  bank.description('Manage Harbor Bank vaults, savings, limits, and high-value approvals')
  addReadCommands(bank)
  addActionCommands(bank)
  addMsigCommands(bank)
  return bank
}
