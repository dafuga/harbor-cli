export type AgentStatus = 'active' | 'paused' | 'killed'
export type RunStatus = 'queued' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled' | 'needs_attention'

export interface AgentInput {
  name: string
  instructions: string
  model: string
  perRun: number
  total: number
  files: string[]
  secrets: string[]
}

export interface Agent extends AgentInput {
  id: string
  status: AgentStatus
  revision: number
}

export interface RoutineInput {
  name: string
  prompt: string
  kind: 'interval' | 'trigger'
  intervalMinutes?: number
  maxCost: number
}

export interface Routine extends RoutineInput {
  id: string
  agentId: string
  enabled: boolean
  nextAt: number | null
}

export interface Model {
  id: string
  label: string
}

export interface Price {
  maxCost: number
  deployment: string
}

export interface Quote extends Price {
  id: string
  agentId: string
  revision: number
  requestId: string
  prompt: string
  expiresAt: number
}

export interface Run {
  id: string
  agentId: string
  revision: number
  routineId: string | null
  prompt: string
  limit: number
  status: RunStatus
  reserved: number
  paid: number
  createdAt: number
  startedAt?: number
  price?: Price
  promptHash?: string
  inferId?: string
  result?: string
  tools?: ToolReceipt[]
  detail?: string
}

export interface ToolCall {
  name: 'read_file' | 'use_secret'
  resource: string
  message?: string
}

export interface ToolReceipt {
  name: ToolCall['name']
  resource: string
  result: string
  verification: string
}

export interface AuditEntry {
  at: number
  event: string
  agentId?: string
  runId?: string
  routineId?: string
  detail?: string
}

export interface Delivery {
  text: string
  calls: ToolCall[]
  paid: number | null
}

export interface Network {
  identity?: string
  models: Model[]
  currency: {symbol: string; precision: number}
  quote(agent: Agent, prompt: string, ceiling: number, signal?: AbortSignal): Promise<Price>
  execute(input: {
    agent: Agent
    prompt: string
    price: Price
    signal: AbortSignal
    starting(): void
    submitted(inferId: string): void
    assertActive(): void
  }): Promise<Delivery>
  reconcile(run: Run, agent: Agent, signal?: AbortSignal): Promise<number | null>
  verify(call: ToolCall, context: {runId: string; inferId: string; prompt: string; response: string}, signal: AbortSignal): Promise<string>
  readFile(hash: string, signal: AbortSignal): Promise<string>
  useSecret(alias: string, message: string, context: {runId: string; assertActive(): void}, signal: AbortSignal): Promise<string>
}
