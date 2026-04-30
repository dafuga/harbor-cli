import {Command} from 'commander'
import {addTxOptions, pushJsonAction} from './action.js'

export type FieldType = 'string' | 'number' | 'boolean' | 'json'
export type Field = string | [string, FieldType]

export interface JsonActionSpec {
  command: string
  action: string
  fields: Field[]
  signerField?: string
}

export function fieldName(field: Field): string {
  return Array.isArray(field) ? field[0] : field
}

function fieldType(field: Field): FieldType {
  return Array.isArray(field) ? field[1] : 'string'
}

function parseField(value: string, type: FieldType): unknown {
  if (type === 'number') {
    return Number(value)
  }
  if (type === 'boolean') {
    return value === 'true' || value === '1'
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
  cmd.description(`Push ${spec.action}`)
  for (const field of spec.fields) {
    cmd = cmd.argument(`<${fieldName(field)}>`)
  }
  cmd.option('-c, --contract <account>', 'contract account', contractOption)
  addTxOptions(cmd).action(async (...args: unknown[]) => {
    const options = actionOptions(args)
    const data = buildActionData(spec.fields, args.slice(0, -1) as string[])
    const signer = spec.signerField ? String(data[spec.signerField]) : undefined
    await pushJsonAction(String(options.contract), spec.action, data, {...options, actor: String(options.actor ?? signer)})
  })
}
