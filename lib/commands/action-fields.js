import { addTxOptions, pushJsonAction } from './action.js';
import { canonicalUint64 } from '../lib/tx.js';
const commandSpecs = new WeakMap();
export function jsonActionSpec(command) {
    return commandSpecs.get(command);
}
export function collectJsonActionSpecs(root) {
    const result = [];
    const visit = (command) => {
        const spec = commandSpecs.get(command);
        if (spec)
            result.push(spec);
        command.commands.forEach(visit);
    };
    visit(root);
    return result;
}
export function fieldName(field) {
    return Array.isArray(field) ? field[0] : field;
}
export function fieldType(field) {
    return Array.isArray(field) ? field[1] : 'string';
}
export function parseField(value, type) {
    if (type === 'number') {
        return Number(value);
    }
    if (type === 'uint64') {
        return canonicalUint64(value);
    }
    if (type === 'uint64[]') {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
            throw new Error('uint64[] must be a JSON array');
        }
        return parsed.map((item, index) => canonicalUint64(item, `uint64[${index}]`));
    }
    if (type === 'boolean') {
        if (value === 'true' || value === '1')
            return true;
        if (value === 'false' || value === '0')
            return false;
        throw new Error('boolean must be one of true, 1, false, or 0');
    }
    if (type === 'json') {
        return JSON.parse(value);
    }
    return value;
}
export function buildActionData(fields, values) {
    return Object.fromEntries(fields.map((field, index) => [fieldName(field), parseField(values[index], fieldType(field))]));
}
export function actionOptions(args) {
    const last = args.at(-1);
    if (last && typeof last.optsWithGlobals === 'function') {
        return last.optsWithGlobals();
    }
    if (last && typeof last.opts === 'function') {
        return last.opts();
    }
    return last;
}
export function addJsonActionCommand(root, contractOption, spec) {
    let cmd = root.command(spec.command);
    commandSpecs.set(cmd, spec);
    cmd.description(spec.disabledReason
        ? `Compatibility-disabled ABI action ${spec.action}: ${spec.disabledReason}`
        : `Push ${spec.action}`);
    for (const field of spec.fields) {
        cmd = cmd.argument(`<${fieldName(field)}>`);
    }
    cmd.option('-c, --contract <account>', 'contract account', contractOption);
    addTxOptions(cmd).action(async (...args) => {
        if (spec.disabledReason) {
            throw new Error(`${spec.action} is compatibility-disabled: ${spec.disabledReason}`);
        }
        const options = actionOptions(args);
        const data = buildActionData(spec.fields, args.slice(0, -1));
        const signer = spec.signerField ? String(data[spec.signerField]) : undefined;
        await pushJsonAction(String(options.contract), spec.action, data, { ...options, actor: String(options.actor ?? signer) });
    });
}
