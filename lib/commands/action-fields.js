import { addTxOptions, pushJsonAction } from './action.js';
export function fieldName(field) {
    return Array.isArray(field) ? field[0] : field;
}
function fieldType(field) {
    return Array.isArray(field) ? field[1] : 'string';
}
function parseField(value, type) {
    if (type === 'number') {
        return Number(value);
    }
    if (type === 'boolean') {
        return value === 'true' || value === '1';
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
    cmd.description(`Push ${spec.action}`);
    for (const field of spec.fields) {
        cmd = cmd.argument(`<${fieldName(field)}>`);
    }
    cmd.option('-c, --contract <account>', 'contract account', contractOption);
    addTxOptions(cmd).action(async (...args) => {
        const options = actionOptions(args);
        const data = buildActionData(spec.fields, args.slice(0, -1));
        const signer = spec.signerField ? String(data[spec.signerField]) : undefined;
        await pushJsonAction(String(options.contract), spec.action, data, { ...options, actor: String(options.actor ?? signer) });
    });
}
