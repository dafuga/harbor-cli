export interface TableRowsResponse<T> {
  rows: T[]
  more: boolean | string
  next_key?: string
}

export interface HarborServiceType {
  id: number
  name: string
  enabled: boolean | number
  reward_weight: number | string
  epoch_budget: string
  base_provider_reward: string
  provider_fail_penalty: string
  oracle_agree_reward: string
  oracle_disagree_penalty: string
  oracle_miss_penalty: string
  min_provider_stake: string
  min_oracle_stake: string
  min_oracle_reports: number
  min_check_window_sec: number
}

export interface HarborService {
  id: number
  provider: string
  service_type: number
  segment_kind: number
  range_start: number
  range_end: number
  capacity_bytes: number | string
  active: boolean | number
  endpoint: string
  metadata: string
}

export interface HarborState {
  reward_pool: string
}

export function normalizeUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

export async function getTableRows<T>(
  url: string,
  contract: string,
  table: string,
  options: {scope?: string; limit?: number} = {}
): Promise<TableRowsResponse<T>> {
  const response = await fetch(`${normalizeUrl(url)}/v1/chain/get_table_rows`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      json: true,
      code: contract,
      scope: options.scope ?? contract,
      table,
      limit: options.limit ?? 100,
    }),
  })

  if (!response.ok) {
    throw new Error(`get_table_rows ${contract}::${table} failed: ${response.status}`)
  }

  return (await response.json()) as TableRowsResponse<T>
}

export function parseAssetAmount(asset: string): number {
  const [amount] = asset.split(' ')
  return Number(amount)
}

export function assetSymbol(asset: string): string {
  const [, symbol] = asset.split(' ')
  return symbol ?? ''
}

export function isActive(value: boolean | number): boolean {
  return value === true || value === 1
}
