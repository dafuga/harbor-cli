import {Command} from 'commander'
import {parseJson, printResult, pushAction, signAction} from '../lib/tx.js'

export interface ActionOptions {
  url?: string
  actor?: string
  permission?: string
  key?: string
  auth?: string
  json?: boolean
  expiration?: string
}

export function addTxOptions<T extends Command>(command: T): T {
  return command
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('-a, --actor <actor>', 'signing actor', process.env.HARBOR_ACTOR)
    .option('-p, --permission <permission>', 'signing permission', process.env.HARBOR_PERMISSION ?? 'active')
    .option('-k, --key <key>', 'wallet key name, public key, or comma-separated names', process.env.HARBOR_PRIVATE_KEY)
    .option('--auth <actor@permission>', 'action authorization; defaults to actor@permission')
    .option('--expiration <seconds>', 'transaction expiration seconds', '300')
    .option('--json', 'print JSON') as T
}

export async function pushJsonAction(contract: string, action: string, data: unknown, options: ActionOptions) {
  const result = await pushAction({
    contract,
    action,
    data,
    url: options.url,
    actor: options.actor,
    permission: options.permission,
    key: options.key,
    authorization: options.auth,
    json: options.json,
    expiration: options.expiration,
  })
  printResult(result, options.json)
}

export function createActionCommand(): Command {
  const action = new Command('action')
  action.description('Push ABI-aware contract actions')

  addTxOptions(
    action
      .command('push <contract> <action> <data-json>')
      .description('Push any action with JSON object or JSON array data')
  ).action(async (contract: string, actionName: string, dataJson: string, options: ActionOptions) => {
    await pushJsonAction(contract, actionName, parseJson(dataJson), options)
  })

  addTxOptions(action.command('sign <contract> <action> <data-json>'))
    .description('Sign an action and print its transaction without broadcasting')
    .action(async (contract: string, actionName: string, dataJson: string, options: ActionOptions) => {
      const result = await signAction({
        ...options, contract, action: actionName, data: parseJson(dataJson), authorization: options.auth,
      })
      printResult(result, true)
    })

  return action
}
