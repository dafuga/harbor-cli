import { AbstractUserInterface, cancelable, } from '@wharfkit/session';
import qrcode from 'qrcode-terminal';
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
