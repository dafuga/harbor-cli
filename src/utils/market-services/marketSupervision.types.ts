// @harness-uid u_bl2btg3qjb
export interface MarketCandidate {
  name: string
  status: string
  estimatedHourlyReward?: string
  reason?: string
}

export type MarketEvent =
  | {event: 'service-selected'; service: string; estimate?: string; reason?: string}
  | {event: 'service-ready'; service: string}
  | {event: 'service-unavailable'; service: string; reason: string}
  | {event: 'no-eligible-service'}
  | {event: 'market-unavailable'; reason: string}

export interface MarketSupervisor<Plan> {
  inspect(): Promise<MarketCandidate[]>
  prepare(name: string): Promise<Plan>
  start(plan: Plan, lifecycle: {signal: AbortSignal; onReady: () => void}): Promise<void>
  wait(signal: AbortSignal): Promise<void>
  report(event: MarketEvent): void
}

export interface MarketSupervisionOptions {
  signal: AbortSignal
  cooldownMs: number
}

export interface RunningMarketService {
  name: string
  controller: AbortController
  stopped: Promise<void>
}

export interface SupervisorState {
  current?: RunningMarketService
  failures: Map<string, number>
}
