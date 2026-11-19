// @harness-uid u_765re6m7qj
export interface SealedGuestPreflightOptions {
  platform: NodeJS.Platform
  arch: string
  hasConfig: boolean
  canAccess: (device: string) => Promise<boolean>
}
