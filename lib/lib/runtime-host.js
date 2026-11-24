import os from 'node:os';
export const RUNTIME_TARGETS = ['macos-arm64', 'macos-x64', 'linux-arm64', 'linux-x64'];
export function hostPlatform(platform = process.platform, arch = process.arch) {
    return `${platform === 'darwin' ? 'macos' : platform}-${arch}`;
}
export function isWsl() {
    return process.platform === 'linux' && (Boolean(process.env.WSL_INTEROP) || /microsoft/i.test(os.release()));
}
export function runtimeTarget(platform = process.platform, arch = process.arch) {
    const target = hostPlatform(platform, arch);
    const supported = RUNTIME_TARGETS.find((item) => item === target);
    if (supported)
        return supported;
    if (platform === 'win32') {
        throw new Error('Harbor services on Windows run inside WSL2. Run harbor doctor here for setup, or run harbor inside your WSL2 distribution.');
    }
    throw new Error(`Harbor services are unavailable for ${target}. Supported targets: ${RUNTIME_TARGETS.join(', ')}.`);
}
export function releaseAsset(daemon, target = runtimeTarget()) {
    return `${daemon}-${target.replace(/^macos-/, 'darwin-')}`;
}
