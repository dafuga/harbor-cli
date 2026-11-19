export interface SealedGuestPreflightOptions {
    platform: NodeJS.Platform;
    arch: string;
    hasConfig: boolean;
    canAccess: (device: string) => Promise<boolean>;
}
