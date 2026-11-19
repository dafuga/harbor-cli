// @harness-uid u_uadwyn2yyv
import {Asset} from '@wharfkit/antelope'
import type {HarborServiceType, MarketSnapshot, Opportunity} from '../../lib/opportunities.js'
import {serviceEligibility} from './serviceEligibility.js'
import type {OpportunitySelection} from './demandRanking.types.js'

function demandEstimate(type: HarborServiceType, now: number) {
  try {
    const demand = JSON.parse(type.metadata ?? '{}')?.demand
    if (!demand || !Number.isFinite(demand.unitsPerHour) || demand.unitsPerHour < 0 ||
        typeof demand.unitPrice !== 'string' || typeof demand.expiresAt !== 'string') return undefined
    const expires = Date.parse(demand.expiresAt)
    if (!Number.isFinite(expires) || expires <= now) return undefined
    const price = Asset.from(demand.unitPrice)
    if (!price.symbol.equals(Asset.from(type.epoch_budget).symbol) || price.value < 0) return undefined
    return {unitsPerHour: demand.unitsPerHour as number, price}
  } catch {
    return undefined
  }
}

export function liveProviderRows(snapshot: MarketSnapshot, now: number): MarketSnapshot['services'] {
  const ttls = new Map(snapshot.ttls?.map((row) => [Number(row.service_type), row.ttl_sec]))
  return snapshot.services.filter((service) => {
    const {last_heartbeat: time, active} = service
    const at = time ? Date.parse(time.endsWith('Z') ? time : `${time}Z`) : NaN
    const ttl = ttls.get(Number(service.service_type)) ?? ttls.get(0) ?? 300
    return (active === true || active === 1) && Number.isFinite(at) && at + ttl * 1000 > now
  })
}

function providerSupply(services: MarketSnapshot['services']): Map<number, Set<string>> {
  const supply = new Map<number, Set<string>>()
  for (const {service_type, provider} of services) {
    const id = Number(service_type)
    let providers = supply.get(id)
    if (!providers) {
      providers = new Set()
      supply.set(id, providers)
    }
    providers.add(provider)
  }
  return supply
}

function pricedOpportunity(opportunity: Opportunity, demand: NonNullable<ReturnType<typeof demandEstimate>>, capacity: ReturnType<typeof serviceEligibility>, providers: {active: number; expected: number}): Opportunity {
  const expectedUnits = Math.min(demand.unitsPerHour / providers.expected, capacity.units)
  const amount = expectedUnits * demand.price.value
  if (!Number.isFinite(amount)) return {...opportunity, status: 'no-demand', reason: 'Invalid hourly demand estimate.'}
  const reward = `${amount.toFixed(demand.price.symbol.precision)} ${demand.price.symbol.name}`
  const reason = `${expectedUnits.toFixed(2)} ${capacity.unit}/hour at ${demand.price} with ${providers.expected} potential provider(s).`
  return {...opportunity, activeProviders: providers.active, hourlyRewardAmount: amount, estimatedHourlyReward: reward, reason}
}

function competingProviders(enrolled: Set<string> | undefined, agent?: string) {
  const active = enrolled?.size ?? 0
  const additional = agent !== undefined && enrolled?.has(agent) ? 0 : 1
  return {active, expected: active + additional}
}

/** Example: 12 units/hour at 1.2500 HRBR shared with one live provider yields 7.5000 HRBR/hour. */
export function demandRanking(opportunities: Opportunity[], snapshot: MarketSnapshot, selection: OpportunitySelection): Opportunity[] {
  const types = new Map(snapshot.types.map((type) => [Number(type.id), type]))
  const now = selection.now ?? Date.now()
  const supply = providerSupply(snapshot.services)
  return opportunities.map((opportunity) => {
    const demand = demandEstimate(types.get(opportunity.id)!, now)
    const capacity = serviceEligibility(opportunity.name, selection.host, selection.limits)
    const result = {
      ...opportunity,
      unit: capacity.unit,
      demandUnitsPerHour: demand?.unitsPerHour,
      unitPrice: demand?.price.toString(),
      capacityUnitsPerHour: capacity.blocked ? undefined : capacity.units,
    }
    if (result.status !== 'open') return {...result, reason: 'Service type disabled on chain.'}
    if (selection.exclude?.has(result.name)) return {...result, status: 'excluded', reason: 'Disabled by the operator.'}
    if (capacity.blocked) return {...result, status: 'ineligible', reason: capacity.blocked}
    if (!demand || !demand.unitsPerHour || !demand.price.value) {
      return {...result, status: 'no-demand', reason: 'No current priced demand estimate on chain.'}
    }
    return pricedOpportunity(result, demand, capacity, competingProviders(supply.get(result.id), selection.agent))
  }).sort((a, b) => (b.hourlyRewardAmount ?? 0) - (a.hourlyRewardAmount ?? 0) || a.id - b.id)
}
