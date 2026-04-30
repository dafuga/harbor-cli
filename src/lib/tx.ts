import {ABI, APIClient, Action, FetchProvider} from '@wharfkit/antelope'
import {Session} from '@wharfkit/session'
import {walletPluginFor} from './private-key-wallet.js'
import {HarborTerminalUI} from './terminal-ui.js'

export interface AuthOptions {
  url?: string
  actor?: string
  permission?: string
  key?: string
  json?: boolean
  expiration?: string
}

export interface PushActionInput extends AuthOptions {
  contract: string
  action: string
  data: unknown
  authorization?: string
}

const abiCache = new Map<string, ABI>()

export function apiUrl(url?: string): string {
  return url ?? process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888'
}

export function permissionLevel(options: AuthOptions, fallbackActor?: string): {actor: string; permission: string} {
  const actor = options.actor ?? fallbackActor ?? process.env.HARBOR_ACTOR
  if (!actor) {
    throw new Error('missing signer actor; pass --actor or set HARBOR_ACTOR')
  }
  return {actor, permission: options.permission ?? process.env.HARBOR_PERMISSION ?? 'active'}
}

export function parseAuthorization(auth: string): {actor: string; permission: string} {
  const [actor, permission = 'active'] = auth.split('@')
  if (!actor) {
    throw new Error(`invalid authorization: ${auth}`)
  }
  return {actor, permission}
}

export function parseAuthorizations(auth: string): Array<{actor: string; permission: string}> {
  return auth.split(',').map((item) => parseAuthorization(item.trim()))
}

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`invalid JSON: ${(error as Error).message}`)
  }
}

export function printResult(result: unknown, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (typeof result === 'object' && result && 'transaction_id' in result) {
    const tx = result as {transaction_id?: string; status?: string}
    console.log(`transaction_id: ${tx.transaction_id}`)
    if (tx.status) {
      console.log(`status: ${tx.status}`)
    }
    return
  }
  console.log(JSON.stringify(result, null, 2))
}

export function clientFor(url?: string): APIClient {
  return new APIClient({provider: new FetchProvider(apiUrl(url), {fetch: globalThis.fetch})})
}

async function getAbi(client: APIClient, account: string): Promise<ABI> {
  const cached = abiCache.get(account)
  if (cached) {
    return cached
  }
  const response = await client.v1.chain.get_abi(account)
  if (!response.abi) {
    throw new Error(`unable to retrieve account abi: ${account}`)
  }
  const abi = ABI.from(response.abi)
  abiCache.set(account, abi)
  return abi
}

function actionDataFromArray(abi: ABI, actionName: string, data: unknown[]): Record<string, unknown> {
  const action = abi.actions.find((item) => String(item.name) === actionName)
  if (!action) {
    throw new Error(`action ${actionName} not found in ABI`)
  }
  const struct = abi.structs.find((item) => String(item.name) === String(action.type))
  if (!struct) {
    throw new Error(`action struct ${action.type} not found in ABI`)
  }
  if (data.length !== struct.fields.length) {
    throw new Error(`action ${actionName} expects ${struct.fields.length} fields, got ${data.length}`)
  }
  return Object.fromEntries(struct.fields.map((field, index) => [String(field.name), data[index]]))
}

export async function serializeAction(input: PushActionInput): Promise<Action> {
  const client = clientFor(input.url)
  const abi = await getAbi(client, input.contract)
  const auth = input.authorization ? parseAuthorizations(input.authorization) : [permissionLevel(input)]
  const data = Array.isArray(input.data) ? actionDataFromArray(abi, input.action, input.data) : input.data
  return Action.from(
    {
      account: input.contract,
      name: input.action,
      authorization: auth,
      data: data as Record<string, unknown>,
    },
    abi
  )
}

export async function transactActions(options: AuthOptions, actions: Action[] | Array<Record<string, unknown>>) {
  const url = apiUrl(options.url)
  const client = clientFor(url)
  const info = await client.v1.chain.get_info()
  const auth = permissionLevel(options)
  const walletPlugin = await walletPluginFor(options.key, auth.actor)
  const session = new Session({
    chain: {id: info.chain_id, url},
    actor: auth.actor,
    permission: auth.permission,
    walletPlugin,
  }, {
    ui: new HarborTerminalUI(),
  })
  const result = await session.transact(
    {actions: actions as any},
    {broadcast: true, expireSeconds: Number(options.expiration ?? 300)}
  )
  const response = result.response as {transaction_id?: string; processed?: {receipt?: {status?: string}}} | undefined
  return {
    transaction_id: response?.transaction_id ?? result.resolved?.transaction.id?.toString(),
    status: response?.processed?.receipt?.status,
    response,
  }
}

export async function pushAction(input: PushActionInput) {
  const action = await serializeAction(input)
  return transactActions(input, [action])
}

export async function getTableRows<T = unknown>(
  contract: string,
  table: string,
  options: {url?: string; scope?: string; limit?: number; lowerBound?: string; upperBound?: string} = {}
) {
  const client = clientFor(options.url)
  const request: Record<string, unknown> = {
    json: true,
    code: contract,
    scope: options.scope ?? contract,
    table,
    limit: options.limit ?? 100,
  }
  if (options.lowerBound !== undefined) {
    request.lower_bound = options.lowerBound
  }
  if (options.upperBound !== undefined) {
    request.upper_bound = options.upperBound
  }
  return client.v1.chain.get_table_rows(request as any) as Promise<{rows: T[]; more: boolean | string; next_key?: string}>
}
