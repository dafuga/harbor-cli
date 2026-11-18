export declare function renderLaunchdPlist(input: {
    label: string;
    command: string;
    args?: string[];
    workingDirectory?: string;
    restartOnFailure?: boolean;
    supervisorLog?: string;
}): string;
