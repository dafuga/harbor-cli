import assert from 'node:assert/strict'
import test from 'node:test'
import {Command} from 'commander'
import {
  addJsonActionCommand,
  buildActionData,
  collectJsonActionSpecs,
  fieldName,
  fieldType,
  parseField,
} from './action-fields.js'
import {createAiCommand} from './ai.js'
import {createStorageCommand} from './storage.js'
import {createVaultCommand} from './vault.js'

type Uint64Abi = Record<string, Record<string, 'uint64' | 'uint64[]'>>

const vaultUint64: Uint64Abi = {
  addlineage: {output_receipt_id: 'uint64', use_id: 'uint64'},
  addpolver: {policy_id: 'uint64'},
  addreward: {policy_id: 'uint64', reference_id: 'uint64'},
  attestdelete: {receipt_id: 'uint64'},
  attestrewrap: {receipt_id: 'uint64', grant_id: 'uint64'},
  claimreward: {reward_id: 'uint64'},
  expirerewrap: {grant_id: 'uint64'},
  finalizedel: {receipt_id: 'uint64'},
  grantaccess: {receipt_id: 'uint64', grant_id: 'uint64', derivative_policy_id: 'uint64'},
  putderived: {use_id: 'uint64', output_consent_id: 'uint64', storage_object_id: 'uint64', bytes: 'uint64'},
  putreceipt: {consent_id: 'uint64', storage_object_id: 'uint64', bytes: 'uint64'},
  reviewrcpt: {receipt_id: 'uint64'},
  revokecons: {consent_id: 'uint64'},
  revokegrant: {grant_id: 'uint64'},
  setconsent: {policy_id: 'uint64'},
  setoperator: {policy_id: 'uint64'},
  setpolstat: {policy_id: 'uint64'},
  tombstone: {receipt_id: 'uint64'},
  usegrant: {grant_id: 'uint64'},
  withdraw: {policy_id: 'uint64'},
}

const storageUint64: Uint64Abi = {
  addkeycust: {object_id: 'uint64'},
  assign: {object_id: 'uint64'},
  attestdel: {object_id: 'uint64', replica_id: 'uint64'},
  attestlost: {object_id: 'uint64', replica_id: 'uint64'},
  attestkey: {object_id: 'uint64'},
  authroute: {object_id: 'uint64'},
  lockobject: {object_id: 'uint64'},
  lockuntil: {object_id: 'uint64'},
  offreplica: {replica_id: 'uint64'},
  putobject: {bytes: 'uint64'},
  puttemp: {bytes: 'uint64'},
  puttempat: {bytes: 'uint64'},
  protolock: {object_id: 'uint64'},
  reassign: {replica_id: 'uint64'},
  report: {object_id: 'uint64'},
  repreport: {replica_id: 'uint64'},
  retirechunk: {object_id: 'uint64'},
  routeassign: {object_id: 'uint64'},
  setexpiry: {object_id: 'uint64'},
  tombstone: {object_id: 'uint64'},
  unlockobj: {object_id: 'uint64'},
}

const aiUint64: Uint64Abi = {
  acceptinfer: {infer_id: 'uint64'},
  ackinfer: {infer_id: 'uint64'},
  admintier: {program_id: 'uint64', model_id: 'uint64'},
  addartifact: {storage_object_id: 'uint64'},
  addmile: {candidate_id: 'uint64'},
  addprogram: {current_model_id: 'uint64', eval_artifact_id: 'uint64'},
  addsample: {batch_id: 'uint64', infer_id: 'uint64'},
  adjudmile: {milestone_id: 'uint64'},
  adoptweight: {model_id: 'uint64', weights_artifact_id: 'uint64'},
  approvemile: {milestone_id: 'uint64'},
  assignexact: {infer_id: 'uint64'},
  assigninfer: {infer_id: 'uint64', quote_id: 'uint64'},
  attestline: {submission_id: 'uint64', output_object_id: 'uint64', output_policy_id: 'uint64'},
  attestpromo: {round_id: 'uint64', infer_id: 'uint64', svc_check_id: 'uint64'},
  bindmodel: {model_id: 'uint64', weights_artifact_id: 'uint64', vault_receipt_id: 'uint64'},
  binddepacc: {
    deployment_id: 'uint64',
    vault_receipt_id: 'uint64',
    vault_grant_id: 'uint64',
    vault_use_id: 'uint64',
  },
  cancelbatch: {batch_id: 'uint64'},
  canceljob: {infer_id: 'uint64'},
  canceltrain: {train_id: 'uint64'},
  challattest: {subject_id: 'uint64'},
  challenginf: {infer_id: 'uint64', svc_check_id: 'uint64'},
  commitseed: {infer_id: 'uint64'},
  cleanbatch: {batch_id: 'uint64'},
  claimdistill: {campaign_id: 'uint64'},
  claimround: {round_id: 'uint64'},
  cleanpromo: {round_id: 'uint64'},
  cleansubs: {start_id: 'uint64'},
  cleantrain: {train_id: 'uint64'},
  claimsampool: {campaign_id: 'uint64'},
  claimsreward: {infer_id: 'uint64'},
  closeprogram: {program_id: 'uint64'},
  closedistill: {campaign_id: 'uint64'},
  closeround: {round_id: 'uint64'},
  closesess: {session_id: 'uint64'},
  closetune: {tune_id: 'uint64'},
  commitcand: {candidate_id: 'uint64', capacity_units: 'uint64'},
  commitsample: {
    infer_id: 'uint64', vault_object_id: 'uint64', vault_policy_id: 'uint64',
    vault_consent_id: 'uint64', vault_receipt_id: 'uint64', review_grant_id: 'uint64',
    svc_check_id: 'uint64',
  },
  completeinf: {infer_id: 'uint64'},
  contribdata: {tune_id: 'uint64', dataset_artifact_id: 'uint64'},
  expireround: {round_id: 'uint64'},
  expirebatch: {batch_id: 'uint64'},
  expiredata: {infer_id: 'uint64'},
  expireinfer: {infer_id: 'uint64'},
  expireattest: {subject_id: 'uint64'},
  expirepromo: {round_id: 'uint64'},
  expiresample: {infer_id: 'uint64'},
  failjob: {infer_id: 'uint64'},
  finalizeprog: {program_id: 'uint64'},
  funddistill: {campaign_id: 'uint64'},
  fundsamprwd: {campaign_id: 'uint64'},
  grantbatch: {batch_id: 'uint64', vault_grant_id: 'uint64', vault_policy_id: 'uint64'},
  logroute: {
    policy_id: 'uint64', infer_id: 'uint64', selected_model_id: 'uint64', classifier_model_id: 'uint64',
  },
  logsubcall: {parent_infer_id: 'uint64', from_model_id: 'uint64', to_model_id: 'uint64'},
  launchpromo: {round_id: 'uint64'},
  migpromfund: {round_id: 'uint64'},
  nominate: {
    round_id: 'uint64', base_model_id: 'uint64', dataset_artifact_id: 'uint64', eval_artifact_id: 'uint64',
  },
  openbatch: {campaign_id: 'uint64'},
  opendistill: {
    program_id: 'uint64', tune_id: 'uint64', teacher_model_id: 'uint64', min_canary_requests: 'uint64',
  },
  openround: {program_id: 'uint64'},
  opensess: {program_id: 'uint64'},
  optindata: {infer_id: 'uint64', campaign_id: 'uint64'},
  binddatacons: {infer_id: 'uint64', vault_consent_id: 'uint64'},
  pledgedemand: {candidate_id: 'uint64'},
  plancanary: {batch_id: 'uint64'},
  promotebatch: {batch_id: 'uint64'},
  prunedeploy: {deployment_id: 'uint64'},
  proptune: {base_model_id: 'uint64', dataset_artifact_id: 'uint64', eval_artifact_id: 'uint64'},
  qualify: {candidate_id: 'uint64'},
  quoteinfer: {infer_id: 'uint64', deployment_id: 'uint64'},
  reclaim: {tune_id: 'uint64'},
  reclaimvote: {round_id: 'uint64'},
  recordcanary: {batch_id: 'uint64', infer_id: 'uint64', route_log_id: 'uint64', svc_check_id: 'uint64'},
  reclaimcred: {program_id: 'uint64'},
  recoverprog: {program_id: 'uint64'},
  regmodel: {parent_model_id: 'uint64', weights_artifact_id: 'uint64', eval_artifact_id: 'uint64'},
  regremote: {
    parent_model_id: 'uint64', manifest_artifact_id: 'uint64', terms_artifact_id: 'uint64', eval_artifact_id: 'uint64',
  },
  releasemile: {milestone_id: 'uint64'},
  reportcanary: {batch_id: 'uint64'},
  reqinfer: {model_id: 'uint64'},
  reqroute: {program_id: 'uint64'},
  reqsession: {session_id: 'uint64'},
  resolvesamp: {infer_id: 'uint64'},
  resolveatt: {subject_id: 'uint64'},
  resolveinf: {infer_id: 'uint64', svc_check_id: 'uint64'},
  reviewsample: {infer_id: 'uint64', review_grant_id: 'uint64', svc_check_id: 'uint64'},
  revokebgrant: {batch_id: 'uint64'},
  revokecons: {program_id: 'uint64'},
  rewarddata: {tune_id: 'uint64'},
  scorebake: {candidate_id: 'uint64'},
  scorebatch: {batch_id: 'uint64'},
  scoretrain: {submission_id: 'uint64'},
  seedinfercon: {deployment_id: 'uint64'},
  seedtraincon: {submission_id: 'uint64', model_id: 'uint64'},
  sealbatch: {batch_id: 'uint64', dataset_artifact_id: 'uint64'},
  setaiparams: {max_voice_weight: 'uint64'},
  setbatchspec: {
    batch_id: 'uint64', dataset_object_id: 'uint64', dataset_policy_id: 'uint64',
    transform_id: 'uint64', recipe_artifact_id: 'uint64',
  },
  setconsent: {campaign_id: 'uint64'},
  setdepcaps: {deployment_id: 'uint64'},
  setdepcfg: {
    deployment_id: 'uint64', source_model_id: 'uint64', topology_artifact_id: 'uint64',
    aggregate_memory_mb: 'uint64', min_node_memory_mb: 'uint64',
  },
  setdeploy: {
    deployment_id: 'uint64', model_id: 'uint64', program_id: 'uint64', capacity_tokens_min: 'uint64',
  },
  setdisttok: {campaign_id: 'uint64', translation_artifact_id: 'uint64'},
  setdistproto: {campaign_id: 'uint64', raw_policy_id: 'uint64', sanitized_policy_id: 'uint64'},
  setmodel: {model_id: 'uint64', weights_artifact_id: 'uint64', eval_artifact_id: 'uint64'},
  setmodelspec: {
    model_id: 'uint64', program_id: 'uint64', license_artifact_id: 'uint64',
    total_params_m: 'uint64', active_params_m: 'uint64',
  },
  settokenizer: {model_id: 'uint64', tokenizer_artifact_id: 'uint64'},
  setroutepol: {policy_id: 'uint64', default_model_id: 'uint64', classifier_model_id: 'uint64'},
  settleattest: {subject_id: 'uint64'},
  settledem: {round_id: 'uint64'},
  settleinf: {infer_id: 'uint64', svc_check_id: 'uint64'},
  settletrain: {train_id: 'uint64'},
  startdistill: {batch_id: 'uint64'},
  startpromo: {round_id: 'uint64'},
  startround: {round_id: 'uint64'},
  starttrain: {tune_id: 'uint64', base_model_id: 'uint64', dataset_artifact_id: 'uint64'},
  contribtrain: {train_id: 'uint64', weights_artifact_id: 'uint64'},
  aggrtrain: {train_id: 'uint64', weights_artifact_id: 'uint64'},
  settrainrnd: {train_id: 'uint64'},
  jointrain: {train_id: 'uint64'},
  fundtrain: {train_id: 'uint64'},
  subscribe: {program_id: 'uint64', capacity_units: 'uint64'},
  unsub: {subscription_id: 'uint64'},
  votecomm: {round_id: 'uint64', rankings: 'uint64[]'},
  votetune: {tune_id: 'uint64'},
  voteuser: {round_id: 'uint64', rankings: 'uint64[]'},
  withdrawsamp: {infer_id: 'uint64'},
}

function assertUint64Conformance(root: Command, expected: Uint64Abi): void {
  const seen = new Set<string>()
  for (const spec of collectJsonActionSpecs(root)) {
    seen.add(spec.action)
    const actual = Object.fromEntries(
      spec.fields
        .filter((field) => fieldType(field) === 'uint64' || fieldType(field) === 'uint64[]')
        .map((field) => [fieldName(field), fieldType(field)]),
    )
    assert.deepEqual(actual, expected[spec.action] ?? {}, `${spec.action} uint64 field types drifted from its ABI`)
  }
  for (const action of Object.keys(expected)) {
    assert.ok(seen.has(action), `ABI action ${action} is missing from CLI command specs`)
  }
}

test('Vault, Store, and AI command specs preserve every ABI uint64 as canonical strings', () => {
  assertUint64Conformance(createVaultCommand(), vaultUint64)
  assertUint64Conformance(createStorageCommand(), storageUint64)
  assertUint64Conformance(createAiCommand(), aiUint64)
})

test('Vault expired rewrap cleanup preserves ABI fields and keeper authority', () => {
  const specs = Object.fromEntries(
    collectJsonActionSpecs(createVaultCommand()).map((spec) => [spec.action, spec]),
  )
  assert.deepEqual(specs.expirerewrap, {
    command: 'expire-rewrap',
    action: 'expirerewrap',
    fields: ['actor', ['grant_id', 'uint64']],
    signerField: 'actor',
  })
  assert.deepEqual(
    buildActionData(specs.expirerewrap.fields, ['keeper', '9007199254740993']),
    {actor: 'keeper', grant_id: '9007199254740993'},
  )
})

test('Store retirement and retention commands preserve ABI field order and signer authority', () => {
  const specs = Object.fromEntries(
    collectJsonActionSpecs(createStorageCommand()).map((spec) => [spec.action, spec]),
  )
  assert.deepEqual(specs.setretire, {
    command: 'set-retirement',
    action: 'setretire',
    fields: [['loss_timeout_sec', 'number']],
  })
  assert.deepEqual(specs.lockobject, {
    command: 'lock-object',
    action: 'lockobject',
    fields: ['owner', ['object_id', 'uint64'], 'controller', 'reason_hash'],
    signerField: 'owner',
  })
  assert.deepEqual(specs.lockuntil, {
    command: 'lock-until',
    action: 'lockuntil',
    fields: [
      'owner', ['object_id', 'uint64'], 'controller', 'reason_hash',
      'retention_until',
    ],
    signerField: 'owner',
  })
  assert.deepEqual(specs.setlockprot, {
    command: 'set-lock-protocol',
    action: 'setlockprot',
    fields: ['protocol', ['active', 'boolean']],
  })
  assert.deepEqual(specs.protolock, {
    command: 'protocol-lock',
    action: 'protolock',
    fields: [
      'controller', 'owner', ['object_id', 'uint64'], 'reason_hash',
      'retention_until',
    ],
    signerField: 'controller',
  })
  assert.deepEqual(specs.retirechunk, {
    command: 'retire-chunk',
    action: 'retirechunk',
    fields: [['object_id', 'uint64'], ['max_rows', 'number']],
  })
  assert.deepEqual(specs.unlockobj, {
    command: 'unlock-object',
    action: 'unlockobj',
    fields: ['controller', ['object_id', 'uint64']],
    signerField: 'controller',
  })
  assert.deepEqual(specs.attestlost, {
    command: 'attest-lost',
    action: 'attestlost',
    fields: ['verifier', ['object_id', 'uint64'], ['replica_id', 'uint64'], 'evidence_hash'],
    signerField: 'verifier',
  })
  assert.deepEqual(specs.migratekeys, {
    command: 'migrate-keys',
    action: 'migratekeys',
    fields: [['max_rows', 'number']],
  })
  assert.deepEqual(specs.migcapacity, {
    command: 'migrate-capacity',
    action: 'migcapacity',
    fields: [['max_rows', 'number']],
  })
  assert.deepEqual(specs.report, {
    command: 'report',
    action: 'report',
    fields: [['object_id', 'uint64'], 'verifier', ['healthy', 'boolean'], 'report_hash'],
    signerField: 'verifier',
  })
  assert.deepEqual(specs.repreport, {
    command: 'report-replica',
    action: 'repreport',
    fields: [['replica_id', 'uint64'], 'verifier', ['healthy', 'boolean'], 'report_hash'],
    signerField: 'verifier',
  })
})

test('Store retention, reporting, and lost-replica action ids remain exact above MAX_SAFE_INTEGER', () => {
  const maxUint64 = '18446744073709551615'
  const aboveSafeInteger = '9007199254740993'
  assert.deepEqual(
    buildActionData(
      ['owner', ['object_id', 'uint64'], 'controller', 'reason_hash'],
      ['alice', maxUint64, 'harborai', '1'.repeat(64)],
    ),
    {
      owner: 'alice',
      object_id: maxUint64,
      controller: 'harborai',
      reason_hash: '1'.repeat(64),
    },
  )
  assert.deepEqual(
    buildActionData(
      ['verifier', ['object_id', 'uint64'], ['replica_id', 'uint64'], 'evidence_hash'],
      ['verifier', aboveSafeInteger, maxUint64, '2'.repeat(64)],
    ),
    {
      verifier: 'verifier',
      object_id: aboveSafeInteger,
      replica_id: maxUint64,
      evidence_hash: '2'.repeat(64),
    },
  )
  assert.deepEqual(
    buildActionData(
      [['object_id', 'uint64'], 'verifier', ['healthy', 'boolean'], 'report_hash'],
      [aboveSafeInteger, 'verifier', 'true', '3'.repeat(64)],
    ),
    {
      object_id: aboveSafeInteger,
      verifier: 'verifier',
      healthy: true,
      report_hash: '3'.repeat(64),
    },
  )
  assert.deepEqual(
    buildActionData(
      [['replica_id', 'uint64'], 'verifier', ['healthy', 'boolean'], 'report_hash'],
      [maxUint64, 'verifier', 'false', '4'.repeat(64)],
    ),
    {
      replica_id: maxUint64,
      verifier: 'verifier',
      healthy: false,
      report_hash: '4'.repeat(64),
    },
  )
})

test('AI promotion and distillation canary commands preserve ABI order and signer authority', () => {
  const specs = Object.fromEntries(
    collectJsonActionSpecs(createAiCommand()).map((spec) => [spec.action, spec]),
  )
  assert.deepEqual(specs.attestpromo, {
    command: 'attest-canary',
    action: 'attestpromo',
    fields: ['router', ['round_id', 'uint64'], ['infer_id', 'uint64'], ['svc_check_id', 'uint64']],
    signerField: 'router',
  })
  assert.deepEqual(specs.launchpromo, {
    command: 'launch',
    action: 'launchpromo',
    fields: ['owner', ['round_id', 'uint64']],
    signerField: 'owner',
  })
  assert.deepEqual(specs.expirepromo, {
    command: 'expire-execution',
    action: 'expirepromo',
    fields: [['round_id', 'uint64']],
  })
  assert.deepEqual(specs.migpromos, {
    command: 'migrate-stages',
    action: 'migpromos',
    fields: [['max_rows', 'number']],
  })
  assert.deepEqual(specs.migpromfund, {
    command: 'migrate-funding',
    action: 'migpromfund',
    fields: [['round_id', 'uint64'], ['max_rows', 'number']],
  })
  assert.deepEqual(specs.migactpromo, {
    command: 'migrate-active-rounds',
    action: 'migactpromo',
    fields: [['max_rows', 'number']],
  })
  assert.deepEqual(specs.cleanpromo, {
    command: 'clean-round',
    action: 'cleanpromo',
    fields: [['round_id', 'uint64'], ['max_rows', 'number']],
  })
  assert.deepEqual(specs.adjudmile, {
    command: 'adjudicate-milestone',
    action: 'adjudmile',
    fields: [['milestone_id', 'uint64'], ['honor', 'boolean'], 'decision_hash'],
  })
  assert.deepEqual(specs.setattestcfg, {
    command: 'configure',
    action: 'setattestcfg',
    fields: [['challenge_sec', 'number'], ['resolution_sec', 'number']],
  })
  assert.deepEqual(specs.challattest, {
    command: 'challenge',
    action: 'challattest',
    fields: ['challenger', ['kind', 'number'], ['subject_id', 'uint64'], 'challenge_hash'],
    signerField: 'challenger',
  })
  assert.deepEqual(specs.resolveatt, {
    command: 'resolve',
    action: 'resolveatt',
    fields: [
      ['kind', 'number'], ['subject_id', 'uint64'], ['uphold', 'boolean'],
      'decision_hash',
    ],
  })
  assert.deepEqual(specs.settleattest, {
    command: 'settle',
    action: 'settleattest',
    fields: [['kind', 'number'], ['subject_id', 'uint64']],
  })
  assert.deepEqual(specs.expireattest, {
    command: 'expire',
    action: 'expireattest',
    fields: [['kind', 'number'], ['subject_id', 'uint64']],
  })
  assert.deepEqual(
    buildActionData(specs.expireattest.fields, ['8', '9007199254740993']),
    {kind: 8, subject_id: '9007199254740993'},
  )
  assert.deepEqual(specs.spendsignal, {
    command: 'spend-signal',
    action: 'spendsignal',
    fields: [
      'recipient', 'inference_quantity', 'demand_quantity',
      'purpose_hash', 'memo',
    ],
  })
  assert.deepEqual(specs.plancanary, {
    command: 'plan-canary',
    action: 'plancanary',
    fields: ['owner', ['batch_id', 'uint64'], 'router', ['max_requests', 'number']],
    signerField: 'owner',
  })
  assert.deepEqual(specs.migbatches, {
    command: 'migrate-batches',
    action: 'migbatches',
    fields: [['max_rows', 'number']],
  })
  assert.deepEqual(specs.cleanbatch, {
    command: 'clean-batch',
    action: 'cleanbatch',
    fields: [['batch_id', 'uint64'], ['max_rows', 'number']],
  })
  assert.deepEqual(specs.expireinfer, {
    command: 'expire',
    action: 'expireinfer',
    fields: ['actor', ['infer_id', 'uint64']],
    signerField: 'actor',
  })
  assert.deepEqual(specs.canceltrain, {
    command: 'cancel',
    action: 'canceltrain',
    fields: ['actor', ['train_id', 'uint64']],
    signerField: 'actor',
  })
  assert.deepEqual(specs.cleantrain, {
    command: 'clean',
    action: 'cleantrain',
    fields: [['train_id', 'uint64'], ['max_rows', 'number']],
  })
  assert.deepEqual(specs.prunedeploy, {
    command: 'prune-deployment',
    action: 'prunedeploy',
    fields: ['actor', ['deployment_id', 'uint64']],
    signerField: 'actor',
  })
  assert.deepEqual(specs.bindmodel, {
    command: 'bind-custody',
    action: 'bindmodel',
    fields: [
      'actor', ['model_id', 'uint64'], ['weights_artifact_id', 'uint64'],
      'vault_contract', ['vault_receipt_id', 'uint64'],
    ],
    signerField: 'actor',
  })
  assert.deepEqual(specs.closeprogram, {
    command: 'close',
    action: 'closeprogram',
    fields: ['owner', ['program_id', 'uint64']],
    signerField: 'owner',
  })
  assert.deepEqual(specs.finalizeprog, {
    command: 'finalize',
    action: 'finalizeprog',
    fields: ['actor', ['program_id', 'uint64']],
    signerField: 'actor',
  })
  assert.deepEqual(specs.recoverprog, {
    command: 'recover',
    action: 'recoverprog',
    fields: ['actor', ['program_id', 'uint64']],
    signerField: 'actor',
  })
  assert.deepEqual(specs.reclaimcred, {
    command: 'reclaim-credit',
    action: 'reclaimcred',
    fields: ['owner', ['program_id', 'uint64']],
    signerField: 'owner',
  })
  assert.deepEqual(specs.admintier, {
    command: 'admit-tier',
    action: 'admintier',
    fields: ['owner', ['program_id', 'uint64'], ['model_id', 'uint64']],
    signerField: 'owner',
  })
  assert.deepEqual(specs.migserving, {
    command: 'migrate-serving',
    action: 'migserving',
    fields: [['max_rows', 'number']],
  })
  assert.deepEqual(specs.settokenizer, {
    command: 'set-tokenizer',
    action: 'settokenizer',
    fields: [
      'actor', ['model_id', 'uint64'], ['tokenizer_artifact_id', 'uint64'],
      'tokenizer_hash', ['vocab_size', 'number'], ['format_version', 'number'],
    ],
    signerField: 'actor',
  })
  assert.deepEqual(specs.seedtraincon, {
    command: 'seed-training-contribution',
    action: 'seedtraincon',
    fields: [['submission_id', 'uint64'], ['model_id', 'uint64']],
  })
  assert.deepEqual(specs.seedinfercon, {
    command: 'seed-inference-contribution',
    action: 'seedinfercon',
    fields: [['deployment_id', 'uint64']],
    disabledReason:
      'deployment registration is not inference work; complete a paid, independently settled inference',
  })
  assert.deepEqual(specs.setdisttok, {
    command: 'set-token-translation',
    action: 'setdisttok',
    fields: [
      'owner', ['campaign_id', 'uint64'], ['translation_artifact_id', 'uint64'],
      ['translation_version', 'number'],
    ],
    signerField: 'owner',
  })

  assert.match(specs.contribdata.disabledReason ?? '', /Vault-backed distillation sample lifecycle/)
  assert.match(specs.rewarddata.disabledReason ?? '', /Vault-backed staged sample reward pool/)
  assert.deepEqual(specs.acceptinfer, {
    command: 'accept',
    action: 'acceptinfer',
    fields: ['provider', ['infer_id', 'uint64'], 'start_hash'],
    signerField: 'provider',
  })
  assert.deepEqual(specs.commitseed, {
    command: 'commit-seed',
    action: 'commitseed',
    fields: ['requester', ['infer_id', 'uint64'], 'seed_commitment'],
    signerField: 'requester',
  })
  assert.deepEqual(specs.ackinfer, {
    command: 'acknowledge',
    action: 'ackinfer',
    fields: ['requester', ['infer_id', 'uint64'], 'acceptance_hash'],
    signerField: 'requester',
  })
  assert.deepEqual(specs.settleinf, {
    command: 'settle',
    action: 'settleinf',
    fields: ['actor', ['infer_id', 'uint64'], ['svc_check_id', 'uint64']],
    signerField: 'actor',
  })
  assert.deepEqual(specs.challenginf, {
    command: 'challenge',
    action: 'challenginf',
    fields: [
      'requester', ['infer_id', 'uint64'], ['svc_check_id', 'uint64'],
      'evidence_hash', 'selection_reveal',
    ],
    signerField: 'requester',
  })
  assert.deepEqual(specs.resolveinf, {
    command: 'resolve',
    action: 'resolveinf',
    fields: ['actor', ['infer_id', 'uint64'], ['svc_check_id', 'uint64']],
    signerField: 'actor',
  })
})

test('action field parsing is strict for booleans and canonical for uint64 arrays', () => {
  assert.equal(parseField('true', 'boolean'), true)
  assert.equal(parseField('1', 'boolean'), true)
  assert.equal(parseField('false', 'boolean'), false)
  assert.equal(parseField('0', 'boolean'), false)
  assert.throws(() => parseField('yes', 'boolean'), /boolean must be one of/)
  assert.deepEqual(
    parseField('["18446744073709551614","0002"]', 'uint64[]'),
    ['18446744073709551614', '2'],
  )
  assert.throws(() => parseField('["18446744073709551616"]', 'uint64[]'), /exceeds uint64/)
})

test('compatibility-disabled JSON actions fail locally before transaction construction', async () => {
  const root = new Command()
  addJsonActionCommand(root, 'harborai', {
    command: 'legacy',
    action: 'legacyact',
    fields: ['owner'],
    signerField: 'owner',
    disabledReason: 'use the replacement protocol',
  })

  await assert.rejects(
    root.parseAsync(['node', 'test', 'legacy', 'alice']),
    /legacyact is compatibility-disabled: use the replacement protocol/,
  )
})
