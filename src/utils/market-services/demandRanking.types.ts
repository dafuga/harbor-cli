// @harness-uid u_uadwyn2yyv
import type {ServiceHost} from '../../lib/host-policy.js'
import type {ResourceLimits} from '../../lib/resource-limits.js'

export interface OpportunitySelection {
  host: ServiceHost
  limits: ResourceLimits
  exclude?: Set<string>
  now?: number
  agent?: string
}
