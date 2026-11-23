export class AgentError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError('Expected a JSON object.')
  return value as Record<string, unknown>
}

export function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) {
    throw new AgentError(`${label} must contain 1 to ${max} bytes.`)
  }
  return value.trim()
}

export function amount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) {
    throw new AgentError(`${label} must be a whole number of minor units from 0 to 1 trillion.`)
  }
  return value
}

export function hash(value: string) {
  return /^[0-9a-f]{64}$/.test(value)
}

export function alias(value: string) {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(value)
}

export function permissions(value: unknown, validate: (item: string) => boolean, label: string): string[] {
  if (!Array.isArray(value) || value.length > 16 || value.some(item => typeof item !== 'string' || !validate(item))) {
    throw new AgentError(`Invalid ${label}. Specify at most 16 distinct entries.`)
  }
  return [...new Set(value)]
}
