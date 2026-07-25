import {Command} from 'commander'
import {addTxOptions, pushJsonAction} from './action.js'
import {canonicalUint64} from '../lib/tx.js'

export type FieldType = 'string' | 'number' | 'uint64' | 'uint64[]' | 'boolean' | 'json'
export type Field = string | [string, FieldType]

export interface JsonActionSpec {
  command: string
  action: string
  fields: Field[]
  signerField?: string
  disabledReason?: string
}

const commandSpecs = new WeakMap<Command, JsonActionSpec>()

export function jsonActionSpec(command: Command): JsonActionSpec | undefined {
  return commandSpecs.get(command)
}

export function collectJsonActionSpecs(root: Command): JsonActionSpec[] {
  const result: JsonActionSpec[] = []
  const visit = (command: Command): void => {
    const spec = commandSpecs.get(command)
    if (spec) result.push(spec)
    command.commands.forEach(visit)
  }
  visit(root)
  return result
}

export function fieldName(field: Field): string {
  return Array.isArray(field) ? field[0] : field
}

export function fieldType(field: Field): FieldType {
  return Array.isArray(field) ? field[1] : 'string'
}

export function parseField(value: string, type: FieldType): unknown {
  if (type === 'number') {
    return Number(value)
  }
  if (type === 'uint64') {
    return canonicalUint64(value)
  }
  if (type === 'uint64[]') {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) {
      throw new Error('uint64[] must be a JSON array')
    }
    return parsed.map((item, index) => canonicalUint64(item, `uint64[${index}]`))
  }
  if (type === 'boolean') {
    if (value === 'true' || value === '1') return true
    if (value === 'false' || value === '0') return false
    throw new Error('boolean must be one of true, 1, false, or 0')
  }
  if (type === 'json') {
    return JSON.parse(value)
  }
  return value
}

export function buildActionData(fields: Field[], values: string[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((field, index) => [fieldName(field), parseField(values[index], fieldType(field))])
  )
}

export function actionOptions(args: unknown[]): Record<string, string | boolean | undefined> {
  const last = args.at(-1) as
    | {
        opts?: () => Record<string, string | boolean | undefined>
        optsWithGlobals?: () => Record<string, string | boolean | undefined>
      }
    | Record<string, string | boolean | undefined>
  if (last && typeof (last as {optsWithGlobals?: unknown}).optsWithGlobals === 'function') {
    return (last as {optsWithGlobals: () => Record<string, string | boolean | undefined>}).optsWithGlobals()
  }
  if (last && typeof (last as {opts?: unknown}).opts === 'function') {
    return (last as {opts: () => Record<string, string | boolean | undefined>}).opts()
  }
  return last as Record<string, string | boolean | undefined>
}

export function addJsonActionCommand(root: Command, contractOption: string, spec: JsonActionSpec): void {
  let cmd = root.command(spec.command)
  commandSpecs.set(cmd, spec)
  cmd.description(
    spec.disabledReason
      ? `Compatibility-disabled ABI action ${spec.action}: ${spec.disabledReason}`
      : `Push ${spec.action}`
  )
  for (const field of spec.fields) {
    cmd = cmd.argument(`<${fieldName(field)}>`)
  }
  cmd.option('-c, --contract <account>', 'contract account', contractOption)
  addTxOptions(cmd).action(async (...args: unknown[]) => {
    if (spec.disabledReason) {
      throw new Error(`${spec.action} is compatibility-disabled: ${spec.disabledReason}`)
    }
    const options = actionOptions(args)
    const data = buildActionData(spec.fields, args.slice(0, -1) as string[])
    const signer = spec.signerField ? String(data[spec.signerField]) : undefined
    await pushJsonAction(String(options.contract), spec.action, data, {...options, actor: String(options.actor ?? signer)})
  })
}
