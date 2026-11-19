import type { ServiceHost } from '../../lib/host-policy.js';
import type { ResourceLimits } from '../../lib/resource-limits.js';
import type { Eligibility } from './serviceEligibility.types.js';
export declare const RELAY_MEMORY_FLOOR: number;
/** Example: relay on a qualified 20 Mbps uplink can carry 4291 MiB per hour. */
export declare function serviceEligibility(name: string, host: ServiceHost, limits: ResourceLimits): Eligibility;
