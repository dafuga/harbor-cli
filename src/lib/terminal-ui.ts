import {createInterface} from 'node:readline'
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

export async function reviewTransaction(summary: object | string, yes?: boolean): Promise<void> {
  const text = typeof summary === 'string' ? summary : JSON.stringify(summary, null, 2)
  const safeText = text.replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
  process.stderr.write(`Transaction review\n${safeText}\n`)
  if (yes) return
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error('signing requires confirmation in an interactive terminal or explicit --yes')
  }

  const lines = createInterface({input: process.stdin, terminal: false})
  try {
    process.stderr.write('Sign this transaction? [y/N] ')
    for await (const answer of lines) {
      if (/^y(?:es)?$/i.test(answer.trim())) return
      break
    }
    throw new Error('transaction signing cancelled')
  } finally {
    lines.close()
  }
}

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
