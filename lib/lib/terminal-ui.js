import { createInterface } from 'node:readline';
import { AbstractUserInterface, cancelable, } from '@wharfkit/session';
import qrcode from 'qrcode-terminal';
export async function reviewTransaction(summary, yes) {
    const text = typeof summary === 'string' ? summary : JSON.stringify(summary, null, 2);
    const safeText = text.replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    process.stderr.write(`Transaction review\n${safeText}\n`);
    if (yes)
        return;
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
        throw new Error('signing requires confirmation in an interactive terminal or explicit --yes');
    }
    const lines = createInterface({ input: process.stdin, terminal: false });
    try {
        process.stderr.write('Sign this transaction? [y/N] ');
        for await (const answer of lines) {
            if (/^y(?:es)?$/i.test(answer.trim()))
                return;
            break;
        }
        throw new Error('transaction signing cancelled');
    }
    finally {
        lines.close();
    }
}
export class HarborTerminalUI extends AbstractUserInterface {
    async login(context) {
        return {
            walletPluginIndex: 0,
            chainId: context.chain?.id ?? context.chains?.[0]?.id,
            permissionLevel: context.permissionLevel,
        };
    }
    async onError(error) {
        console.error(`[harbor] ${error.message}`);
    }
    async onAccountCreate() {
        return {};
    }
    async onAccountCreateComplete() { }
    async onLogin() { }
    async onLoginComplete() { }
    async onTransact() { }
    async onTransactComplete() { }
    async onSign() { }
    async onSignComplete() { }
    async onBroadcast() { }
    async onBroadcastComplete() { }
    prompt(args) {
        if (args.title) {
            console.log(`\n${args.title}`);
        }
        if (args.body) {
            console.log(args.body);
        }
        const uri = typeof args.elements?.[0]?.data === 'string' ? args.elements[0].data : undefined;
        if (uri && uri.includes(':')) {
            console.log(`\n${uri}\n`);
            qrcode.generate(uri, { small: true });
        }
        return cancelable(Promise.resolve({}), () => { });
    }
    status(message) {
        console.log(`[harbor] ${message}`);
    }
    translate(key, options) {
        return String(options?.default ?? key);
    }
    addTranslations() { }
}
