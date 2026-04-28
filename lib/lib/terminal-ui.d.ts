import { AbstractUserInterface, type Cancelable, type LoginContext, type PromptArgs, type PromptResponse, type UserInterfaceAccountCreationResponse, type UserInterfaceLoginResponse, type UserInterfaceTranslateOptions } from '@wharfkit/session';
export declare class HarborTerminalUI extends AbstractUserInterface {
    login(context: LoginContext): Promise<UserInterfaceLoginResponse>;
    onError(error: Error): Promise<void>;
    onAccountCreate(): Promise<UserInterfaceAccountCreationResponse>;
    onAccountCreateComplete(): Promise<void>;
    onLogin(): Promise<void>;
    onLoginComplete(): Promise<void>;
    onTransact(): Promise<void>;
    onTransactComplete(): Promise<void>;
    onSign(): Promise<void>;
    onSignComplete(): Promise<void>;
    onBroadcast(): Promise<void>;
    onBroadcastComplete(): Promise<void>;
    prompt(args: PromptArgs): Cancelable<PromptResponse>;
    status(message: string): void;
    translate(key: string, options?: UserInterfaceTranslateOptions): string;
    addTranslations(): void;
}
