export declare const RUNTIME_TARGETS: readonly ["macos-arm64", "macos-x64", "linux-arm64", "linux-x64"];
type RuntimeTarget = typeof RUNTIME_TARGETS[number];
export declare function hostPlatform(platform?: NodeJS.Platform, arch?: NodeJS.Architecture): string;
export declare function isWsl(): boolean;
export declare function runtimeTarget(platform?: NodeJS.Platform, arch?: NodeJS.Architecture): RuntimeTarget;
export declare function releaseAsset(daemon: string, target?: "macos-arm64" | "macos-x64" | "linux-arm64" | "linux-x64"): string;
export {};
