import type {Model} from './types.js'

export interface HarborModel extends Model {
  programId: string
  modelId: string
  revision: string
  policyId: string
  computeClass: number
  weights: 'AWQ' | 'MLX'
  kind: 'flagship' | 'lora'
  baseRevision?: string
}

export interface VaultBinding {
  grantId: string
  objectId: string
  contentHash: string
  recipientKey: string
}

export interface HarborConfig {
  chainId: string
  rpc: URL
  router: URL
  checker?: URL
  checkerToken?: string
  routerAuth?: {audience: string; keyId: string; secret: string}
  account: string
  permission: string
  key: string
  models: HarborModel[]
  currency: {symbol: string; precision: number}
  storageOrigins: Set<string>
  vault: Map<string, VaultBinding>
}
