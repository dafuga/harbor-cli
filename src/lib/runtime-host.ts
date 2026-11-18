import os from 'node:os'

export const RUNTIME_TARGETS = ['macos-arm64', 'macos-x64', 'linux-arm64', 'linux-x64'] as const
type RuntimeTarget = typeof RUNTIME_TARGETS[number]

export function hostPlatform(platform = process.platform, arch = process.arch): string {
  return `${platform === 'darwin' ? 'macos' : platform}-${arch}`
}

export function isWsl(): boolean {
  return process.platform === 'linux' && (Boolean(process.env.WSL_INTEROP) || /microsoft/i.test(os.release()))
}

export function runtimeTarget(platform = process.platform, arch = process.arch): RuntimeTarget {
  const target = hostPlatform(platform, arch)
  const supported = RUNTIME_TARGETS.find((item) => item === target)
  if (supported) return supported
  if (platform === 'win32') {
    throw new Error('Harbor services on Windows run inside WSL2. Run harbor doctor here for setup, or run harbor inside your WSL2 distribution.')
  }
  throw new Error(`Harbor services are unavailable for ${target}. Supported targets: ${RUNTIME_TARGETS.join(', ')}.`)
}

export function releaseAsset(daemon: string, target = runtimeTarget()): string {
  return `${daemon}-${target}`
}
