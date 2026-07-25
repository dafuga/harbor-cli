import {Command} from 'commander'
import {addJsonActionCommand, Field} from './action-fields.js'

interface MarketActionSpec {
  command: string
  action: string
  fields: Field[]
  signerField?: string
  disabledReason?: string
}

const MARKET_CONTRACT = process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket'

const marketActions: MarketActionSpec[] = [
  {
    command: 'configure',
    action: 'setparams',
    fields: [
      'token_symbol',
      'provider_pass_reward',
      'provider_fail_penalty',
      'oracle_agree_reward',
      'oracle_disagree_penalty',
      'oracle_miss_penalty',
      ['min_oracle_reports', 'number'],
      ['min_check_window_sec', 'number'],
      ['max_endpoint_size', 'number'],
      ['max_metadata_size', 'number'],
    ],
  },
  {
    command: 'set-service-type',
    action: 'setsvctype',
    fields: [
      ['service_type', 'number'],
      'service_name',
      ['enabled', 'boolean'],
      ['reward_weight', 'number'],
      'epoch_budget',
      'base_provider_reward',
      'provider_fail_penalty',
      'oracle_agree_reward',
      'oracle_disagree_penalty',
      'oracle_miss_penalty',
      'min_provider_stake',
      'min_oracle_stake',
      ['min_oracle_reports', 'number'],
      ['min_check_window_sec', 'number'],
      'metadata',
    ],
  },
  {command: 'register-provider', action: 'regprovider', fields: ['provider', 'metadata'], signerField: 'provider'},
  {command: 'unregister-provider', action: 'unregprov', fields: ['provider'], signerField: 'provider'},
  {command: 'register-oracle', action: 'regoracle', fields: ['oracle', ['supported_service_mask', 'uint64'], 'metadata'], signerField: 'oracle'},
  {command: 'unregister-oracle', action: 'unregoracle', fields: ['oracle'], signerField: 'oracle'},
  {command: 'stake-provider', action: 'stakeprov', fields: ['provider', 'quantity'], signerField: 'provider'},
  {command: 'stake-oracle', action: 'stakeoracle', fields: ['oracle', 'quantity'], signerField: 'oracle'},
  {command: 'unstake-provider', action: 'unstakeprov', fields: ['provider', 'quantity'], signerField: 'provider'},
  {command: 'unstake-oracle', action: 'unstakeorcl', fields: ['oracle', 'quantity'], signerField: 'oracle'},
  {command: 'fund-reward', action: 'fundreward', fields: ['from', 'quantity'], signerField: 'from'},
  {command: 'set-ibc', action: 'setibc', fields: ['ibc_contract']},
  {command: 'emit-remote-reward', action: 'emitreward', fields: ['provider', 'quantity', 'memo']},
  {
    command: 'claim-remote-reward',
    action: 'claimremote',
    fields: ['provider', 'quantity', ['receipt_id', 'uint64'], 'memo'],
    signerField: 'provider',
  },
  {
    command: 'set-chain',
    action: 'setchain',
    fields: [
      'chain_uid', 'chain_id', 'parent_chain_uid', ['status', 'number'], 'endpoint',
      ['spawn_free_ram_threshold_bps', 'number'],
      ['saturated_free_ram_threshold_bps', 'number'],
      ['min_bp_count', 'number'], ['target_bp_count', 'number'],
      ['min_relayer_count', 'number'], ['initial_bp_premium_bps', 'number'],
      'metadata',
    ],
  },
  {command: 'set-chain-status', action: 'chainstatus', fields: ['chain_uid', ['status', 'number']]},
  {
    command: 'scan-chain-quorum',
    action: 'scanquorum',
    fields: ['chain_uid', ['max_providers', 'number']],
  },
  {
    command: 'set-chain-ram',
    action: 'setchainram',
    fields: [
      'chain_uid', ['free_bytes', 'uint64'], ['used_bytes', 'uint64'],
      ['size_bytes', 'uint64'],
    ],
  },
  {
    command: 'request-chain-spawn',
    action: 'reqspawn',
    fields: [
      'requested_by', 'parent_chain_uid', ['observed_free_bytes', 'uint64'],
      ['observed_used_bytes', 'uint64'], ['observed_size_bytes', 'uint64'],
      'manifest_hash', 'metadata',
    ],
    signerField: 'requested_by',
  },
  {
    command: 'set-chain-spawn',
    action: 'setspawn',
    fields: [
      ['request_id', 'uint64'], ['status', 'number'], 'chain_uid',
      'manifest_hash', 'metadata',
    ],
  },
  {
    command: 'set-route',
    action: 'setroute',
    fields: [
      'route_uid', 'source_chain_uid', 'dest_chain_uid',
      ['cooldown_sec', 'number'], ['enabled', 'boolean'], 'metadata',
    ],
  },
  {
    command: 'set-price-pair',
    action: 'setpricepair',
    fields: [
      ['pair_id', 'uint64'],
      'base_symbol',
      'quote_symbol',
      ['enabled', 'boolean'],
      ['min_reporters', 'number'],
      ['max_age_sec', 'number'],
      ['max_deviation_bps', 'number'],
      'oracle_reward',
    ],
  },
  {command: 'submit-price', action: 'submitprice', fields: ['oracle', ['pair_id', 'uint64'], ['price', 'uint64'], 'source_hash'], signerField: 'oracle'},
  {
    command: 'prune-price',
    action: 'pruneprice',
    fields: [['pair_id', 'uint64'], 'start_oracle', ['max_rows', 'number']],
  },
  {command: 'migrate-stakes', action: 'migstakes', fields: [['max_rows', 'number']]},
  {command: 'rebuild-guard', action: 'rebuildguard', fields: [['max_rows', 'number']]},
  {command: 'refresh-reserve', action: 'refreshresv', fields: [['reserve_id', 'uint64']]},
  {
    command: 'set-reserve-authority',
    action: 'setresvauth',
    fields: ['stable_contract', ['enabled', 'boolean']],
  },
  {
    command: 'set-obligation-consumer',
    action: 'setoblcons',
    fields: ['consumer', ['enabled', 'boolean'], ['max_hold_sec', 'number']],
  },
  {
    command: 'sync-reserve',
    action: 'syncreserve',
    fields: [
      'stable_contract', 'stable_symbol', 'liquid_collateral', 'stable_supply',
      ['min_backing_bps', 'number'], ['stake_haircut_bps', 'number'],
      'collateral_token_contract', 'collateral_symbol', ['price_pair_id', 'uint64'],
    ],
    signerField: 'stable_contract',
  },
  {
    command: 'open-obligation',
    action: 'openoblig',
    fields: [
      'consumer', ['external_id', 'uint64'], ['service_id', 'uint64'],
      'acceptance_hash', ['hold_sec', 'number'],
    ],
    signerField: 'consumer',
  },
  {
    command: 'authorize-obligation',
    action: 'authoblig',
    fields: ['consumer', ['external_id', 'uint64'], 'payload_hash'],
    signerField: 'consumer',
  },
  {
    command: 'authorize-obligation-conflicts',
    action: 'authoblconf',
    fields: [
      'consumer', ['external_id', 'uint64'], 'selection_seed', ['conflicts', 'json'],
    ],
    signerField: 'consumer',
  },
  {
    command: 'authorize-obligation-terms',
    action: 'authoblterm',
    fields: [
      'consumer', ['external_id', 'uint64'], ['sample_start', 'uint64'],
      ['sample_end', 'uint64'], ['commit_window_sec', 'number'],
      ['reveal_window_sec', 'number'],
    ],
    signerField: 'consumer',
  },
  {
    command: 'fund-obligation',
    action: 'fundoblig',
    fields: ['consumer', ['external_id', 'uint64'], 'quantity'],
    signerField: 'consumer',
  },
  {
    command: 'create-obligation-check',
    action: 'createoblchk',
    fields: [
      'consumer', ['external_id', 'uint64'], ['oracles', 'json'],
      ['sample_start', 'uint64'], ['sample_end', 'uint64'], 'payload_hash',
      ['commit_window_sec', 'number'], ['reveal_window_sec', 'number'],
    ],
  },
  {
    command: 'close-obligation',
    action: 'closeoblig',
    fields: ['consumer', ['external_id', 'uint64']],
    signerField: 'consumer',
  },
  {
    command: 'expire-obligation',
    action: 'expireoblig',
    fields: ['consumer', ['external_id', 'uint64']],
  },
  {
    command: 'add-service',
    action: 'addservice',
    fields: [
      'provider',
      ['service_type', 'number'],
      ['segment_kind', 'number'],
      ['range_start', 'uint64'],
      ['range_end', 'uint64'],
      ['capacity_bytes', 'uint64'],
      'endpoint',
      'metadata',
    ],
    signerField: 'provider',
  },
  {
    command: 'add-service-chain',
    action: 'addsvcchain',
    fields: [
      'provider', ['service_type', 'number'], 'chain_uid', 'route_uid',
      ['segment_kind', 'number'], ['range_start', 'uint64'],
      ['range_end', 'uint64'], ['capacity_bytes', 'uint64'],
      'endpoint', 'metadata',
    ],
    signerField: 'provider',
  },
  {command: 'disable-service', action: 'disablesvc', fields: ['provider', ['service_id', 'uint64']], signerField: 'provider'},
  {command: 'heartbeat', action: 'heartbeat', fields: ['provider', ['service_id', 'uint64'], 'status_hash', 'metadata'], signerField: 'provider'},
  {command: 'set-service-ttl', action: 'setsvcttl', fields: [['service_type', 'number'], ['ttl_sec', 'number']]},
  {command: 'expire-service', action: 'expiresvc', fields: [['service_id', 'uint64']]},
  {command: 'migrate-service-current', action: 'migsvccurr', fields: [['max_rows', 'number']]},
  {command: 'migrate-ai-current', action: 'migaicurr', fields: [['max_rows', 'number']]},
  {
    command: 'set-oracle-candidate',
    action: 'setorclcand',
    fields: [['service_type', 'number'], 'oracle', ['enabled', 'boolean']],
  },
  {
    command: 'set-scheduler-candidate',
    action: 'setschedcand',
    fields: ['provider', ['verifier_service_id', 'uint64'], ['enabled', 'boolean']],
  },
  {command: 'migrate-checks', action: 'migchecks', fields: [['max_rows', 'number']]},
  {command: 'migrate-holds', action: 'migholds', fields: [['max_rows', 'number']]},
  {
    command: 'create-check',
    action: 'createcheck',
    fields: [
      ['service_id', 'uint64'],
      ['oracles', 'json'],
      ['sample_start', 'uint64'],
      ['sample_end', 'uint64'],
      'payload_hash',
      ['commit_window_sec', 'number'],
      ['reveal_window_sec', 'number'],
    ],
  },
  {command: 'commit-check', action: 'commit', fields: ['oracle', ['check_id', 'uint64'], 'commitment'], signerField: 'oracle'},
  {command: 'reveal-check', action: 'reveal', fields: ['oracle', ['check_id', 'uint64'], ['passed', 'boolean'], 'result_hash', 'salt'], signerField: 'oracle'},
  {command: 'settle-check', action: 'settle', fields: [['check_id', 'uint64']]},
  {command: 'set-appeals', action: 'setappeals', fields: [['appeal_window_sec', 'number'], ['min_appeal_votes', 'number']]},
  {command: 'open-appeal', action: 'openappeal', fields: ['provider', ['hold_id', 'uint64'], 'reason_hash'], signerField: 'provider'},
  {command: 'assign-appeal', action: 'assignappeal', fields: [['appeal_id', 'uint64'], ['committee', 'json']]},
  {command: 'vote-appeal', action: 'voteappeal', fields: ['voter', ['appeal_id', 'uint64'], ['release', 'boolean'], 'reason_hash'], signerField: 'voter'},
  {command: 'settle-appeal', action: 'settleappeal', fields: [['appeal_id', 'uint64']]},
  {command: 'expire-hold', action: 'expirehold', fields: [['hold_id', 'uint64']]},
  {command: 'claim', action: 'claim', fields: ['owner', 'quantity'], signerField: 'owner'},
  {
    command: 'set-referral-config',
    action: 'setrefcfg',
    fields: [['enabled', 'boolean'], ['first_level_bps', 'number'], ['decay_bps', 'number'], ['max_total_bps', 'number']],
    disabledReason: 'legacy SvcMarket referral config is disabled; use eosio::setinvitecfg',
  },
  {
    command: 'set-referrer',
    action: 'setreferrer',
    fields: ['account', 'referrer'],
    signerField: 'account',
    disabledReason: 'legacy SvcMarket referrers are disabled; use eosio::inviteacct',
  },
  {command: 'set-inflation', action: 'setinfl', fields: ['daily_inflation', 'token_issuer', ['min_epoch_sec', 'number']]},
  {
    command: 'set-inflation-split',
    action: 'setinfsplit',
    fields: [
      ['staking_bps', 'number'],
      ['bp_bps', 'number'],
      ['service_bps', 'number'],
      ['oracle_bps', 'number'],
      ['dapp_bps', 'number'],
    ],
  },
  {command: 'set-project-inflation', action: 'setprojinf', fields: ['project_contract', ['project_bps', 'number']]},
  {command: 'vote-project', action: 'voteproj', fields: ['voter', ['project_id', 'uint64'], 'quantity'], signerField: 'voter'},
  {command: 'unvote-project', action: 'unvoteproj', fields: ['voter'], signerField: 'voter'},
  {command: 'close-inflation', action: 'closeinfl', fields: []},
  {command: 'step-inflation', action: 'stepinfl', fields: [['max_rows', 'number']]},
  {
    command: 'claim-project',
    action: 'claimproj',
    fields: [['epoch_id', 'uint64'], 'project_contract', ['project_id', 'uint64']],
  },
  {
    command: 'sweep-epoch',
    action: 'sweepepoch',
    fields: [['epoch_id', 'uint64'], ['max_rows', 'number']],
  },
]

export function addMarketActionCommands(market: Command): void {
  for (const spec of marketActions) {
    addJsonActionCommand(market, MARKET_CONTRACT, spec)
  }
}
