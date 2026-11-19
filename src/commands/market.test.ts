import assert from 'node:assert/strict'
import test from 'node:test'
import {Command} from 'commander'
import {
  HarborService,
  HarborServiceType,
  bestOpportunity,
  buildOpportunities,
} from '../lib/opportunities.js'
import {collectJsonActionSpecs, fieldName, fieldType} from './action-fields.js'
import {addMarketActionCommands} from './market-actions.js'
import {
  buildAgentOpportunityReportFromSnapshot,
  buildMarketActionData,
  createMarketCommand,
} from './market.js'

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

function opportunityText(opportunities: ReturnType<typeof buildOpportunities>, name: string, key: 'duties' | 'mustNot' | 'oracleChecks'): string {
  const opportunity = opportunities.find((item) => item.name === name)
  assert.ok(opportunity, `${name} opportunity should exist`)
  return String(opportunity[key] ?? '')
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
      serviceType(4, 'histcore', '4.0000 SYS'),
      serviceType(9, 'histactions', '4.0000 SYS'),
      serviceType(10, 'histtx', '4.0000 SYS'),
      serviceType(11, 'histapi', '4.0000 SYS'),
      serviceType(6, 'p2pseed', '4.0000 SYS'),
      serviceType(13, 'verifier', '4.0000 SYS'),
    ],
    []
  )

  const checks = [
    ['bp', 'duties', /Produce and validate blocks only/],
    ['bp', 'mustNot', /Do not serve chain API/],
    ['traceapi', 'duties', /traces only/],
    ['traceapi', 'mustNot', /Do not serve chain API/],
    ['storage', 'duties', /Store declared Harbor artifacts/],
    ['storage', 'oracleChecks', /sampled object hashes/],
    ['histcore', 'duties', /declared block range/],
    ['histactions', 'duties', /account\/action history/],
    ['histtx', 'duties', /transaction-id lookups/],
    ['histapi', 'mustNot', /separate range registration/],
    ['p2pseed', 'duties', /relay blocks\/transactions/],
    ['verifier', 'duties', /registered Harbor agents/],
    ['verifier', 'oracleChecks', /storage replica audits/],
  ] as const

  for (const [name, key, pattern] of checks) {
    assert.match(opportunityText(opportunities, name, key), pattern)
  }
})

test('legacy referral action wrappers preserve ABI payloads but are explicitly disabled', () => {
  assert.deepEqual(
    buildMarketActionData(
      [
        ['enabled', 'boolean'],
        ['first_level_bps', 'number'],
        ['decay_bps', 'number'],
        ['max_total_bps', 'number'],
      ],
      ['true', '500', '5000', '1000']
    ),
    {
      enabled: true,
      first_level_bps: 500,
      decay_bps: 5000,
      max_total_bps: 1000,
    }
  )

  assert.deepEqual(buildMarketActionData(['account', 'referrer'], ['agent1111111', 'mentor11111']), {
    account: 'agent1111111',
    referrer: 'mentor11111',
  })

  const root = new Command()
  addMarketActionCommands(root)
  const specs = Object.fromEntries(
    collectJsonActionSpecs(root).map((spec) => [spec.action, spec]),
  )
  assert.match(specs.setrefcfg.disabledReason ?? '', /eosio::setinvitecfg/)
  assert.match(specs.setreferrer.disabledReason ?? '', /eosio::inviteacct/)

  const referrals = createMarketCommand().commands.find(
    (command) => command.name() === 'referrals',
  )
  assert.match(referrals?.description() ?? '', /native-invite reward stats/)
})

test('service liveness actions preserve ABI field order and uint64 ids', () => {
  const root = new Command()
  addMarketActionCommands(root)
  const specs = Object.fromEntries(
    collectJsonActionSpecs(root).map((spec) => [spec.action, spec]),
  )

  assert.deepEqual(specs.setsvcttl, {
    command: 'set-service-ttl',
    action: 'setsvcttl',
    fields: [
      ['service_type', 'number'],
      ['ttl_sec', 'number'],
    ],
  })
  assert.deepEqual(specs.expiresvc, {
    command: 'expire-service',
    action: 'expiresvc',
    fields: [['service_id', 'uint64']],
  })
  assert.deepEqual(specs.migaicurr, {
    command: 'migrate-ai-current',
    action: 'migaicurr',
    fields: [['max_rows', 'number']],
  })
  assert.deepEqual(specs.migsvccurr, {
    command: 'migrate-service-current',
    action: 'migsvccurr',
    fields: [['max_rows', 'number']],
  })
  assert.deepEqual(specs.setorclcand, {
    command: 'set-oracle-candidate',
    action: 'setorclcand',
    fields: [['service_type', 'number'], 'oracle', ['enabled', 'boolean']],
  })
  assert.deepEqual(specs.setschedcand, {
    command: 'set-scheduler-candidate',
    action: 'setschedcand',
    fields: ['provider', ['verifier_service_id', 'uint64'], ['enabled', 'boolean']],
  })
  assert.deepEqual(specs.setibc, {
    command: 'set-ibc',
    action: 'setibc',
    fields: ['ibc_contract'],
  })
  assert.deepEqual(specs.emitreward, {
    command: 'emit-remote-reward',
    action: 'emitreward',
    fields: ['provider', 'quantity', 'memo'],
  })
  assert.deepEqual(specs.claimremote, {
    command: 'claim-remote-reward',
    action: 'claimremote',
    fields: ['provider', 'quantity', ['receipt_id', 'uint64'], 'memo'],
    signerField: 'provider',
  })
  assert.deepEqual(specs.setchainram, {
    command: 'set-chain-ram',
    action: 'setchainram',
    fields: [
      'chain_uid', ['free_bytes', 'uint64'], ['used_bytes', 'uint64'],
      ['size_bytes', 'uint64'],
    ],
  })
  assert.deepEqual(specs.scanquorum, {
    command: 'scan-chain-quorum',
    action: 'scanquorum',
    fields: ['chain_uid', ['max_providers', 'number']],
  })
  assert.deepEqual(specs.reqspawn, {
    command: 'request-chain-spawn',
    action: 'reqspawn',
    fields: [
      'requested_by', 'parent_chain_uid', ['observed_free_bytes', 'uint64'],
      ['observed_used_bytes', 'uint64'], ['observed_size_bytes', 'uint64'],
      'manifest_hash', 'metadata',
    ],
    signerField: 'requested_by',
  })
  assert.deepEqual(specs.setspawn, {
    command: 'set-chain-spawn',
    action: 'setspawn',
    fields: [
      ['request_id', 'uint64'], ['status', 'number'], 'chain_uid',
      'manifest_hash', 'metadata',
    ],
  })
  assert.deepEqual(specs.syncreserve, {
    command: 'sync-reserve',
    action: 'syncreserve',
    fields: [
      'stable_contract', 'stable_symbol', 'liquid_collateral', 'stable_supply',
      ['min_backing_bps', 'number'], ['stake_haircut_bps', 'number'],
      'collateral_token_contract', 'collateral_symbol', ['price_pair_id', 'uint64'],
    ],
    signerField: 'stable_contract',
  })
  assert.deepEqual(specs.addsvcchain, {
    command: 'add-service-chain',
    action: 'addsvcchain',
    fields: [
      'provider', ['service_type', 'number'], 'chain_uid', 'route_uid',
      ['segment_kind', 'number'], ['range_start', 'uint64'],
      ['range_end', 'uint64'], ['capacity_bytes', 'uint64'],
      'endpoint', 'metadata',
    ],
    signerField: 'provider',
  })
  assert.deepEqual(specs.migchecks, {
    command: 'migrate-checks',
    action: 'migchecks',
    fields: [['max_rows', 'number']],
  })
  assert.deepEqual(specs.migholds, {
    command: 'migrate-holds',
    action: 'migholds',
    fields: [['max_rows', 'number']],
  })
  assert.deepEqual(specs.pruneprice, {
    command: 'prune-price',
    action: 'pruneprice',
    fields: [['pair_id', 'uint64'], 'start_oracle', ['max_rows', 'number']],
  })
  assert.deepEqual(specs.migstakes, {
    command: 'migrate-stakes',
    action: 'migstakes',
    fields: [['max_rows', 'number']],
  })
  assert.deepEqual(specs.rebuildguard, {
    command: 'rebuild-guard',
    action: 'rebuildguard',
    fields: [['max_rows', 'number']],
  })
  assert.deepEqual(specs.refreshresv, {
    command: 'refresh-reserve',
    action: 'refreshresv',
    fields: [['reserve_id', 'uint64']],
  })
  assert.deepEqual(specs.setresvauth, {
    command: 'set-reserve-authority',
    action: 'setresvauth',
    fields: ['stable_contract', ['enabled', 'boolean']],
  })
  assert.deepEqual(specs.setoblcons, {
    command: 'set-obligation-consumer',
    action: 'setoblcons',
    fields: ['consumer', ['enabled', 'boolean'], ['max_hold_sec', 'number']],
  })
  assert.deepEqual(specs.openoblig, {
    command: 'open-obligation',
    action: 'openoblig',
    fields: [
      'consumer', ['external_id', 'uint64'], ['service_id', 'uint64'],
      'acceptance_hash', ['hold_sec', 'number'],
    ],
    signerField: 'consumer',
  })
  assert.deepEqual(specs.authoblig, {
    command: 'authorize-obligation',
    action: 'authoblig',
    fields: ['consumer', ['external_id', 'uint64'], 'payload_hash'],
    signerField: 'consumer',
  })
  assert.deepEqual(specs.authoblconf, {
    command: 'authorize-obligation-conflicts',
    action: 'authoblconf',
    fields: [
      'consumer', ['external_id', 'uint64'], 'selection_seed', ['conflicts', 'json'],
    ],
    signerField: 'consumer',
  })
  assert.deepEqual(specs.authoblterm, {
    command: 'authorize-obligation-terms',
    action: 'authoblterm',
    fields: [
      'consumer', ['external_id', 'uint64'], ['sample_start', 'uint64'],
      ['sample_end', 'uint64'], ['commit_window_sec', 'number'],
      ['reveal_window_sec', 'number'],
    ],
    signerField: 'consumer',
  })
  assert.deepEqual(specs.fundoblig, {
    command: 'fund-obligation',
    action: 'fundoblig',
    fields: ['consumer', ['external_id', 'uint64'], 'quantity'],
    signerField: 'consumer',
  })
  assert.deepEqual(specs.createoblchk, {
    command: 'create-obligation-check',
    action: 'createoblchk',
    fields: [
      'consumer', ['external_id', 'uint64'], ['oracles', 'json'],
      ['sample_start', 'uint64'], ['sample_end', 'uint64'], 'payload_hash',
      ['commit_window_sec', 'number'], ['reveal_window_sec', 'number'],
    ],
  })
  assert.deepEqual(specs.closeoblig, {
    command: 'close-obligation',
    action: 'closeoblig',
    fields: ['consumer', ['external_id', 'uint64']],
    signerField: 'consumer',
  })
  assert.deepEqual(specs.expireoblig, {
    command: 'expire-obligation',
    action: 'expireoblig',
    fields: ['consumer', ['external_id', 'uint64']],
  })
  assert.deepEqual(specs.stepinfl, {
    command: 'step-inflation',
    action: 'stepinfl',
    fields: [['max_rows', 'number']],
  })
  assert.deepEqual(specs.claimproj, {
    command: 'claim-project',
    action: 'claimproj',
    fields: [['epoch_id', 'uint64'], 'project_contract', ['project_id', 'uint64']],
  })
  assert.deepEqual(specs.sweepepoch, {
    command: 'sweep-epoch',
    action: 'sweepepoch',
    fields: [['epoch_id', 'uint64'], ['max_rows', 'number']],
  })
})

test('market action specs preserve every ABI uint64 as canonical strings', () => {
  const expected: Record<string, string[]> = {
    regoracle: ['supported_service_mask'],
    claimremote: ['receipt_id'],
    setchainram: ['free_bytes', 'used_bytes', 'size_bytes'],
    reqspawn: ['observed_free_bytes', 'observed_used_bytes', 'observed_size_bytes'],
    setspawn: ['request_id'],
    setpricepair: ['pair_id'],
    submitprice: ['pair_id', 'price'],
    pruneprice: ['pair_id'],
    refreshresv: ['reserve_id'],
    syncreserve: ['price_pair_id'],
    openoblig: ['external_id', 'service_id'],
    authoblig: ['external_id'],
    authoblconf: ['external_id'],
    authoblterm: ['external_id', 'sample_start', 'sample_end'],
    fundoblig: ['external_id'],
    createoblchk: ['external_id', 'sample_start', 'sample_end'],
    closeoblig: ['external_id'],
    expireoblig: ['external_id'],
    addservice: ['range_start', 'range_end', 'capacity_bytes'],
    addsvcchain: ['range_start', 'range_end', 'capacity_bytes'],
    disablesvc: ['service_id'],
    heartbeat: ['service_id'],
    expiresvc: ['service_id'],
    setschedcand: ['verifier_service_id'],
    createcheck: ['service_id', 'sample_start', 'sample_end'],
    commit: ['check_id'],
    reveal: ['check_id'],
    settle: ['check_id'],
    openappeal: ['hold_id'],
    assignappeal: ['appeal_id'],
    voteappeal: ['appeal_id'],
    settleappeal: ['appeal_id'],
    expirehold: ['hold_id'],
    voteproj: ['project_id'],
    claimproj: ['epoch_id', 'project_id'],
    sweepepoch: ['epoch_id'],
  }
  const root = new Command()
  addMarketActionCommands(root)
  const seen = new Set<string>()

  for (const spec of collectJsonActionSpecs(root)) {
    seen.add(spec.action)
    const actual = spec.fields
      .filter((field) => fieldType(field) === 'uint64')
      .map(fieldName)
    assert.deepEqual(actual, expected[spec.action] ?? [], `${spec.action} uint64 fields drifted from its ABI`)
  }
  for (const action of Object.keys(expected)) {
    assert.ok(seen.has(action), `ABI action ${action} is missing from CLI command specs`)
  }
})

test('market ids, masks, prices, ranges, and capacities remain exact above MAX_SAFE_INTEGER', () => {
  const aboveSafeInteger = '9007199254740993'
  const maxUint64 = '18446744073709551615'

  assert.deepEqual(
    buildMarketActionData(
      [
        'provider',
        ['service_type', 'number'],
        ['segment_kind', 'number'],
        ['range_start', 'uint64'],
        ['range_end', 'uint64'],
        ['capacity_bytes', 'uint64'],
        'endpoint',
        'metadata',
      ],
      ['provider', '3', '1', aboveSafeInteger, maxUint64, maxUint64, 'https://storage.example', '{}'],
    ),
    {
      provider: 'provider',
      service_type: 3,
      segment_kind: 1,
      range_start: aboveSafeInteger,
      range_end: maxUint64,
      capacity_bytes: maxUint64,
      endpoint: 'https://storage.example',
      metadata: '{}',
    },
  )
  assert.deepEqual(
    buildMarketActionData(
      [['service_id', 'uint64']],
      [maxUint64],
    ),
    {service_id: maxUint64},
  )
  assert.deepEqual(
    buildMarketActionData(
      ['oracle', ['supported_service_mask', 'uint64'], 'metadata'],
      ['oracle', maxUint64, '{}'],
    ),
    {oracle: 'oracle', supported_service_mask: maxUint64, metadata: '{}'},
  )
})

test('agent unable markers remove opportunities from best selection', () => {
  const report = buildAgentOpportunityReportFromSnapshot(
    {
      types: [
        serviceType(14, 'router', '10.0000 SYS'),
        serviceType(1, 'chainapi', '4.0000 SYS'),
      ],
      services: [],
      state: {reward_pool: '10.0000 SYS'},
    },
    [{
      service_type: 14,
      service_name: 'router',
      reason: 'requires a domain',
      metadata: '{"missing":"domain"}',
      updated_at: '2026-05-05T00:00:00',
    }],
    'agent1111111'
  )

  assert.equal(report.best?.name, 'chainapi')
  const router = report.opportunities.find((opportunity) => opportunity.name === 'router')
  assert.equal(router?.status, 'unable')
  assert.equal(router?.unableReason, 'requires a domain')
})

test('market --best ranks fresh on-chain demand against the selected host profile', async (t) => {
  const {writeFile, mkdtemp, rm} = await import('node:fs/promises')
  const {tmpdir} = await import('node:os')
  const {join} = await import('node:path')
  const temporary = await mkdtemp(join(tmpdir(), 'harbor-market-'))
  t.after(() => rm(temporary, {recursive: true, force: true}))
  const profile = join(temporary, 'host.json')
  const GiB = 2 ** 30
  const host = {
    cpuCores: 8, memoryBytes: 16 * GiB, availableMemoryBytes: 14 * GiB,
    gpuKind: 'apple-unified', gpuBytes: 16 * GiB, freeDiskBytes: 64 * GiB,
    bandwidthMbps: 100, alwaysOn: true, confidentialVm: null,
  }
  const estimate = (unitsPerHour: number, unitPrice: string) => JSON.stringify({
    demand: {unitsPerHour, unitPrice, expiresAt: new Date(Date.now() + 60_000).toISOString()},
  })
  const types = [
    {...serviceType(8, 'bp', '100.0000 SYS')},
    {...serviceType(18, 'aiinfer', '1.0000 SYS'), metadata: estimate(10, '1.0000 SYS')},
    {...serviceType(23, 'sealedcompute', '50.0000 SYS'), metadata: estimate(100, '1.0000 SYS')},
    {...serviceType(24, 'relay', '1.0000 SYS'), metadata: estimate(5, '1.0000 SYS')},
  ]
  t.mock.method(globalThis, 'fetch', async (_url: unknown, request?: RequestInit) => {
    const table = JSON.parse(String(request?.body)).table
    return new Response(JSON.stringify({rows: table === 'svctypes' ? types : [], more: false}))
  })
  const output: string[] = []
  t.mock.method(console, 'log', (line: string) => output.push(line))

  async function report(hardware: object, extra: string[] = []) {
    await writeFile(profile, JSON.stringify(hardware))
    const program = new Command().exitOverride().addCommand(createMarketCommand())
    program.commands[0].commands.find((command) => command.name() === 'opportunities')?.exitOverride()
    await program.parseAsync(['market', 'opportunities', '--best', '--json', '--hardware-profile', profile, ...extra], {from: 'user'})
    return JSON.parse(output.pop()!)
  }

  const mac = await report(host)
  assert.equal(mac.best.name, 'aiinfer')
  assert.match(mac.opportunities.find(({name}: {name: string}) => name === 'sealedcompute').reason, /SEV-SNP or TDX/)
  assert.equal((await report({...host, cpuCores: 2, memoryBytes: GiB, availableMemoryBytes: 0.8 * GiB, gpuKind: 'none', gpuBytes: 0})).best.name, 'relay')
  assert.equal((await report({...host, confidentialVm: 'sev-snp'})).best.name, 'sealedcompute')
  assert.equal((await report(host, ['--exclude', 'aiinfer'])).best.name, 'relay')
})
