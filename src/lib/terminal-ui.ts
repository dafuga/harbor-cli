import {
  AbstractUserInterface,
  cancelable,
  type Cancelable,
  type LoginContext,
  type PromptArgs,
  type PromptResponse,
  type UserInterfaceAccountCreationResponse,
  type UserInterfaceLoginResponse,
  type UserInterfaceTranslateOptions,
} from '@wharfkit/session'
import qrcode from 'qrcode-terminal'

export class HarborTerminalUI extends AbstractUserInterface {
  async login(context: LoginContext): Promise<UserInterfaceLoginResponse> {
    return {
      walletPluginIndex: 0,
      chainId: context.chain?.id ?? context.chains?.[0]?.id,
      permissionLevel: context.permissionLevel,
    }
  }

  async onError(error: Error): Promise<void> {
    console.error(`[harbor] ${error.message}`)
  }

  async onAccountCreate(): Promise<UserInterfaceAccountCreationResponse> {
    return {}
  }

  async onAccountCreateComplete(): Promise<void> {}
  async onLogin(): Promise<void> {}
  async onLoginComplete(): Promise<void> {}
  async onTransact(): Promise<void> {}
  async onTransactComplete(): Promise<void> {}
  async onSign(): Promise<void> {}
  async onSignComplete(): Promise<void> {}
  async onBroadcast(): Promise<void> {}
  async onBroadcastComplete(): Promise<void> {}

  prompt(args: PromptArgs): Cancelable<PromptResponse> {
    if (args.title) {
      console.log(`\n${args.title}`)
    }
    if (args.body) {
      console.log(args.body)
    }
    const uri = typeof args.elements?.[0]?.data === 'string' ? args.elements[0].data : undefined
    if (uri && uri.includes(':')) {
      console.log(`\n${uri}\n`)
      qrcode.generate(uri, {small: true})
    }
    return cancelable(Promise.resolve({} as PromptResponse), () => {})
  }

  status(message: string): void {
    console.log(`[harbor] ${message}`)
  }

  translate(key: string, options?: UserInterfaceTranslateOptions): string {
    return String(options?.default ?? key)
  }

  addTranslations(): void {}
}
