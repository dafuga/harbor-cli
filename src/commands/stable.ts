import {Command} from 'commander'
import {addTxOptions, pushJsonAction} from './action.js'
import {getTableRows, printResult, serializeAction, transactActions} from '../lib/tx.js'

const DEFAULT_STABLE_CONTRACT = process.env.HARBOR_STABLE_CONTRACT ?? 'harborstable'
const DEFAULT_MARKET_CONTRACT = process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket'
const DEFAULT_GOV_CONTRACT = process.env.HARBOR_GOV_CONTRACT ?? 'harborgov'
const DEFAULT_COLLATERAL_CONTRACT = process.env.HARBOR_STABLE_COLLATERAL_CONTRACT ?? 'eosio.token'
const DEFAULT_COLLATERAL_SYMBOL = process.env.HARBOR_STABLE_COLLATERAL_SYMBOL ?? '4,SYS'
const DEFAULT_STABLE_SYMBOL = process.env.HARBOR_STABLE_SYMBOL ?? '4,USDH'

export function stableMintMemo(minOut?: string): string {
  return minOut ? `usdh:mint:${minOut}` : 'usdh:mint'
}

function addReadOptions(command: Command): Command {
  return command
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('-c, --contract <account>', 'stable contract account', DEFAULT_STABLE_CONTRACT)
    .option('--market-contract <account>', 'service market contract account', DEFAULT_MARKET_CONTRACT)
    .option('--json', 'print JSON')
}

function addReadCommands(stable: Command): void {
  addReadOptions(
    stable
      .command('assets')
      .description('List approved Harbor stablecoins')
  ).action(async (options) => {
    const rows = await getTableRows(options.contract, 'stablecoins', {url: options.url, scope: options.contract, limit: 1000})
    if (options.json) {
      console.log(JSON.stringify(rows.rows, null, 2))
    } else {
      console.table(rows.rows)
    }
  })

  addReadOptions(
    stable
      .command('reserves')
      .description('List USDH reserve snapshots from the service market')
  ).action(async (options) => {
    const rows = await getTableRows(options.marketContract, 'reserves', {url: options.url, scope: options.marketContract, limit: 1000})
    if (options.json) {
      console.log(JSON.stringify(rows.rows, null, 2))
    } else {
      console.table(rows.rows)
    }
  })

  addReadOptions(
    stable
      .command('prices')
      .description('List service-market price aggregates')
  ).action(async (options) => {
    const rows = await getTableRows(options.marketContract, 'priceaggs', {url: options.url, scope: options.marketContract, limit: 1000})
    if (options.json) {
      console.log(JSON.stringify(rows.rows, null, 2))
    } else {
      console.table(rows.rows)
    }
  })

  addReadOptions(
    stable
      .command('price <pair_id>')
      .description('Show one service-market price aggregate')
  ).action(async (pairId: string, options) => {
    const rows = await getTableRows(options.marketContract, 'priceaggs', {
      url: options.url,
      scope: options.marketContract,
      limit: 1000,
    })
    const row = rows.rows.find((item: any) => String(item.pair_id) === String(pairId))
    printResult(row ?? null, options.json ?? true)
  })
}

function addActionCommands(stable: Command): void {
  addTxOptions(
    stable
      .command('configure <governance_contract> <price_pair_id>')
      .description('Configure USDH collateral, oracle, reserve, and pause settings')
      .option('-c, --contract <account>', 'stable contract account', DEFAULT_STABLE_CONTRACT)
      .option('--collateral-token <account>', 'collateral token contract', DEFAULT_COLLATERAL_CONTRACT)
      .option('--collateral-symbol <symbol>', 'collateral symbol', DEFAULT_COLLATERAL_SYMBOL)
      .option('--market-contract <account>', 'service market contract account', DEFAULT_MARKET_CONTRACT)
      .option('--max-price-age-sec <seconds>', 'maximum accepted price age', '300')
      .option('--min-backing-bps <bps>', 'minimum backing ratio in bps', '15000')
      .option('--stake-haircut-bps <bps>', 'stake haircut in bps', '6000')
      .option('--mint-paused', 'pause minting')
      .option('--redeem-paused', 'pause redemptions')
      .option('--max-memo-size <bytes>', 'maximum memo/metadata size', '256')
  ).action(async (governanceContract: string, pricePairId: string, options) => {
    await pushJsonAction(options.contract, 'setconfig', {
      governance_contract: governanceContract,
      collateral_token_contract: options.collateralToken,
      collateral_symbol: options.collateralSymbol,
      market_contract: options.marketContract,
      price_pair_id: Number(pricePairId),
      max_price_age_sec: Number(options.maxPriceAgeSec),
      min_backing_bps: Number(options.minBackingBps),
      stake_haircut_bps: Number(options.stakeHaircutBps),
      mint_paused: Boolean(options.mintPaused),
      redeem_paused: Boolean(options.redeemPaused),
      max_memo_size: Number(options.maxMemoSize),
    }, options)
  })

  addTxOptions(
    stable
      .command('create [maximum_supply]')
      .description('Create native 4,USDH on the stable contract')
      .option('-c, --contract <account>', 'stable contract account', DEFAULT_STABLE_CONTRACT)
  ).action(async (maximumSupply: string | undefined, options) => {
    await pushJsonAction(options.contract, 'create', {
      issuer: options.contract,
      maximum_supply: maximumSupply ?? '1000000000.0000 USDH',
    }, options)
  })

  addTxOptions(
    stable
      .command('set-stable <token_contract> <token_symbol> <enabled> [metadata]')
      .description('Set a stablecoin registry entry directly')
      .option('-c, --contract <account>', 'stable contract account', DEFAULT_STABLE_CONTRACT)
  ).action(async (tokenContract: string, tokenSymbol: string, enabled: string, metadata: string | undefined, options) => {
    await pushJsonAction(options.contract, 'setstable', {
      token_contract: tokenContract,
      token_symbol: tokenSymbol,
      enabled: enabled === 'true' || enabled === '1',
      metadata: metadata ?? '',
    }, options)
  })

  addTxOptions(
    stable
      .command('mint <owner> <collateral_quantity> [min_usdh_out]')
      .description('Mint USDH by transferring SYS collateral to harborstable')
      .option('-c, --contract <account>', 'stable contract account', DEFAULT_STABLE_CONTRACT)
      .option('--collateral-token <account>', 'collateral token contract', DEFAULT_COLLATERAL_CONTRACT)
  ).action(async (owner: string, collateralQuantity: string, minUsdhOut: string | undefined, options) => {
    const transferAction = await serializeAction({
      ...options,
      contract: options.collateralToken,
      action: 'transfer',
      data: {
        from: owner,
        to: options.contract,
        quantity: collateralQuantity,
        memo: stableMintMemo(minUsdhOut),
      },
      authorization: `${owner}@active`,
    })
    printResult(await transactActions({...options, actor: options.actor ?? owner}, [transferAction]), options.json)
  })

  addTxOptions(
    stable
      .command('redeem <owner> <quantity> <min_collateral_out>')
      .description('Redeem USDH for liquid SYS collateral')
      .option('-c, --contract <account>', 'stable contract account', DEFAULT_STABLE_CONTRACT)
  ).action(async (owner: string, quantity: string, minCollateralOut: string, options) => {
    await pushJsonAction(options.contract, 'redeem', {
      owner,
      quantity,
      min_collateral_out: minCollateralOut,
    }, {...options, actor: options.actor ?? owner})
  })

  addTxOptions(
    stable
      .command('transfer <from> <to> <quantity> [memo]')
      .description('Transfer USDH like a standard token')
      .option('-c, --contract <account>', 'stable contract account', DEFAULT_STABLE_CONTRACT)
  ).action(async (from: string, to: string, quantity: string, memo: string | undefined, options) => {
    await pushJsonAction(options.contract, 'transfer', {
      from,
      to,
      quantity,
      memo: memo ?? '',
    }, {...options, actor: options.actor ?? from})
  })

  addTxOptions(
    stable
      .command('propose-stable <proposer> <title> <token_contract> <token_symbol> <enabled> [metadata]')
      .description('Create a governance proposal that executes harborstable::setstable')
      .option('--gov-contract <account>', 'governance contract account', DEFAULT_GOV_CONTRACT)
      .option('-c, --contract <account>', 'stable contract account', DEFAULT_STABLE_CONTRACT)
      .option('--expires-sec <seconds>', 'proposal expiry seconds', '604800')
  ).action(async (
    proposer: string,
    title: string,
    tokenContract: string,
    tokenSymbol: string,
    enabled: string,
    metadata: string | undefined,
    options
  ) => {
    await pushJsonAction(options.govContract, 'proposestable', {
      proposer,
      title,
      stable_contract: options.contract,
      token_contract: tokenContract,
      token_symbol: tokenSymbol,
      enabled: enabled === 'true' || enabled === '1',
      metadata: metadata ?? '',
      expires_sec: Number(options.expiresSec),
    }, {...options, actor: options.actor ?? proposer})
  })
}

export function createStableCommand(): Command {
  const stable = new Command('stable')
  stable.description('Manage Harbor USDH minting, redemptions, prices, reserves, and registry proposals')
  addReadCommands(stable)
  addActionCommands(stable)
  return stable
}
