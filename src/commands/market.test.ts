import assert from 'node:assert/strict'
import test from 'node:test'
import {bestOpportunity, buildOpportunities} from './market.js'
import {HarborService, HarborServiceType} from '../lib/chain.js'

function serviceType(id: number, name: string, budget: string): HarborServiceType {
  return {
    id,
    service_name: name,
    enabled: 1,
    reward_weight: 1,
    epoch_budget: budget,
    base_provider_reward: '1.0000 SYS',
    provider_fail_penalty: '0.0000 SYS',
    oracle_agree_reward: '0.0000 SYS',
    oracle_disagree_penalty: '0.0000 SYS',
    oracle_miss_penalty: '0.0000 SYS',
    min_provider_stake: '0.0000 SYS',
    min_oracle_stake: '0.0000 SYS',
    min_oracle_reports: 2,
    min_check_window_sec: 1,
  }
}

function service(id: number, serviceTypeId: number): HarborService {
  return {
    id,
    provider: `agent${id}`,
    service_type: serviceTypeId,
    segment_kind: 1,
    range_start: 0,
    range_end: 1,
    capacity_bytes: 1,
    active: 1,
    endpoint: 'http://127.0.0.1',
    metadata: '{}',
  }
}

test('bestOpportunity prefers the best reward, then deeper budget', () => {
  const opportunities = buildOpportunities(
    [
      serviceType(1, 'chainapi', '4.0000 SYS'),
      serviceType(2, 'storage', '10.0000 SYS'),
    ],
    [service(1, 2), service(2, 2)]
  )

  assert.equal(bestOpportunity(opportunities)?.name, 'storage')
})

test('bestOpportunity shifts when a service gets crowded', () => {
  const services = Array.from({length: 12}, (_, index) => service(index + 1, 2))
  const opportunities = buildOpportunities(
    [
      serviceType(1, 'chainapi', '4.0000 SYS'),
      serviceType(2, 'storage', '10.0000 SYS'),
    ],
    services
  )

  assert.equal(bestOpportunity(opportunities)?.name, 'chainapi')
})

test('opportunities describe narrow service duties', () => {
  const opportunities = buildOpportunities(
    [
      serviceType(8, 'bp', '4.0000 SYS'),
      serviceType(2, 'traceapi', '4.0000 SYS'),
      serviceType(3, 'storage', '4.0000 SYS'),
      serviceType(4, 'robocore', '4.0000 SYS'),
      serviceType(9, 'roboactions', '4.0000 SYS'),
      serviceType(10, 'robotx', '4.0000 SYS'),
      serviceType(11, 'roboapi', '4.0000 SYS'),
      serviceType(6, 'p2pseed', '4.0000 SYS'),
    ],
    []
  )

  const bp = opportunities.find((opportunity) => opportunity.name === 'bp')
  const traceApi = opportunities.find((opportunity) => opportunity.name === 'traceapi')
  const storage = opportunities.find((opportunity) => opportunity.name === 'storage')
  const roboCore = opportunities.find((opportunity) => opportunity.name === 'robocore')
  const roboActions = opportunities.find((opportunity) => opportunity.name === 'roboactions')
  const roboTx = opportunities.find((opportunity) => opportunity.name === 'robotx')
  const roboApi = opportunities.find((opportunity) => opportunity.name === 'roboapi')
  const p2pSeed = opportunities.find((opportunity) => opportunity.name === 'p2pseed')

  assert.match(bp?.duties ?? '', /Produce and validate blocks only/)
  assert.match(bp?.mustNot ?? '', /Do not serve chain API/)
  assert.match(traceApi?.duties ?? '', /traces only/)
  assert.match(traceApi?.mustNot ?? '', /Do not serve chain API/)
  assert.match(storage?.duties ?? '', /Store declared Harbor artifacts/)
  assert.match(storage?.oracleChecks ?? '', /sampled object hashes/)
  assert.match(roboCore?.duties ?? '', /declared block range/)
  assert.match(roboActions?.duties ?? '', /account\/action history/)
  assert.match(roboTx?.duties ?? '', /transaction-id lookups/)
  assert.match(roboApi?.mustNot ?? '', /separate range registration/)
  assert.match(p2pSeed?.duties ?? '', /relay blocks\/transactions/)
})
