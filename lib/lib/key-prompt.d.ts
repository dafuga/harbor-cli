export declare function readKeyPassword(name: string, confirm?: boolean): Promise<Buffer>;
export declare function readRotationPassword(name: string, stage: 'current' | 'new'): Promise<Buffer>;
export declare function readPrivateKeyInput(): Promise<Buffer>;
