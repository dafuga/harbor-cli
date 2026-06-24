import fs from 'node:fs/promises'
import {ABI, Serializer} from '@wharfkit/antelope'
import {AuthOptions, clientFor, permissionLevel, transactActions} from './tx.js'

export interface DeployOptions extends AuthOptions {
  account: string
  wasm: string
  abi: string
  validate?: boolean
}

export interface DeployContractBytesOptions extends AuthOptions {
  account: string
  wasmBytes: Buffer
  abiJson: unknown
  validate?: boolean
}

export interface CreateContractAccountOptions extends AuthOptions {
  creator: string
  account: string
  ownerKey: string
  activeKey: string
  ramBytes: number
  stakeNet?: string
  stakeCpu?: string
}

async function validateTables(options: AuthOptions & {account: string}, abiJson: unknown): Promise<void> {
  const client = clientFor(options.url)
  try {
    const existing = await client.v1.chain.get_abi(options.account)
    if (!existing.abi) {
      return
    }
    const oldTables = new Set(existing.abi.tables.map((table) => String(table.name)))
    const newTables = new Set(ABI.from(abiJson as any).tables.map((table) => String(table.name)))
    const removed = [...oldTables].filter((table) => !newTables.has(table))
    if (removed.length) {
      throw new Error(`deployment removes ABI tables: ${removed.join(', ')}`)
    }
  } catch (error) {
    if ((error as Error).message.includes('deployment removes')) {
      throw error
    }
  }
}

export function publicKeyAuthority(key: string) {
  return {threshold: 1, keys: [{key, weight: 1}], accounts: [], waits: []}
}

export function createContractAccountActions(options: CreateContractAccountOptions): Array<Record<string, unknown>> {
  const auth = [permissionLevel({actor: options.creator, permission: options.permission})]
  const actions: Array<Record<string, unknown>> = [{
    account: 'eosio',
    name: 'newaccount',
    authorization: auth,
    data: {
      creator: options.creator,
      name: options.account,
      owner: publicKeyAuthority(options.ownerKey),
      active: publicKeyAuthority(options.activeKey),
    },
  }]
  if (options.ramBytes > 0) {
    actions.push({
      account: 'eosio',
      name: 'buyrambytes',
      authorization: auth,
      data: {payer: options.creator, receiver: options.account, bytes: options.ramBytes},
    })
  }
  if (options.stakeNet && options.stakeCpu) {
    actions.push({
      account: 'eosio',
      name: 'delegatebw',
      authorization: auth,
      data: {
        from: options.creator,
        receiver: options.account,
        stake_net_quantity: options.stakeNet,
        stake_cpu_quantity: options.stakeCpu,
        transfer: false,
      },
    })
  }
  return actions
}

export async function createContractAccount(options: CreateContractAccountOptions) {
  return transactActions({...options, actor: options.creator}, createContractAccountActions(options))
}

export async function accountExists(url: string, account: string): Promise<boolean> {
  try {
    await clientFor(url).v1.chain.get_account(account)
    return true
  } catch {
    return false
  }
}

export function deployContractActions(options: Pick<DeployContractBytesOptions, 'account' | 'wasmBytes' | 'abiJson' | 'permission'>) {
  return [
    {
      account: 'eosio',
      name: 'setcode',
      authorization: [permissionLevel({actor: options.account, permission: options.permission})],
      data: {account: options.account, vmtype: 0, vmversion: 0, code: options.wasmBytes.toString('hex')},
    },
    {
      account: 'eosio',
      name: 'setabi',
      authorization: [permissionLevel({actor: options.account, permission: options.permission})],
      data: {account: options.account, abi: Serializer.encode({object: ABI.from(options.abiJson as any), type: ABI}).hexString},
    },
  ]
}

export async function deployContractBytes(options: DeployContractBytesOptions) {
  if (options.validate) {
    await validateTables(options, options.abiJson)
  }

  return transactActions(
    {...options, actor: options.account},
    deployContractActions({
      account: options.account,
      wasmBytes: options.wasmBytes,
      abiJson: options.abiJson,
      permission: options.permission,
    })
  )
}

export async function deployContract(options: DeployOptions) {
  const wasmBytes = await fs.readFile(options.wasm)
  const abiJson = JSON.parse(await fs.readFile(options.abi, 'utf8'))
  return deployContractBytes({...options, wasmBytes, abiJson})
}
