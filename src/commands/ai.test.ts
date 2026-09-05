import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  aegisHarborCheckCommand,
  buildDistributedAggregateManifest,
  buildDistributedExpertPlan,
  buildFusionManifest,
  buildFusionRegisterPlan,
  buildQueryDatasetFromTraces,
  buildRlvrRecipe,
  buildRlvrWorkItem,
  buildTuneAutoVotePlan,
  buildTuneNeeds,
  canonicalJson,
  createAiCommand,
  parseDistributedShardSpec,
  parseFusionExpertSpec,
  renderAegisConfig,
  resolveArtifactId,
  resolveModelId,
  runTrustedAiAdapter,
  validateQueryDatasetManifest,
} from './ai.js'

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

test('buildTuneNeeds groups low-confidence route logs into tune request templates', () => {
  const needs = buildTuneNeeds(
    [
      {
        id: 1,
        infer_id: 7,
        request_hash: 'a'.repeat(64),
        selected_model_id: 3,
        confidence_bps: 6200,
        metadata: '{"task":"code-review","outcome":"fallback"}',
      },
      {
        id: 2,
        infer_id: 8,
        request_hash: 'b'.repeat(64),
        selected_model_id: 3,
        confidence_bps: 8200,
        metadata: '{"task":"code-review"}',
      },
      {
        id: 3,
        infer_id: 9,
        request_hash: 'c'.repeat(64),
        selected_model_id: 4,
        confidence_bps: 9900,
        metadata: '{"task":"already-good"}',
      },
    ],
    [
      {id: 1, parent_infer_id: 7, from_model_id: 3, to_model_id: 1},
      {id: 2, parent_infer_id: 7, from_model_id: 3, to_model_id: 2},
    ],
    {
      confidenceThreshold: 8500,
      proposer: 'alice',
      datasetArtifactId: '42',
      evalArtifactId: '0',
      expiresSec: '3600',
    },
  )

  assert.equal(needs.length, 1)
  assert.equal(needs[0].base_model_id, '3')
  assert.equal(needs[0].route_count, 2)
  assert.equal(needs[0].low_confidence_count, 2)
  assert.equal(needs[0].subcall_count, 2)
  assert.equal(needs[0].metadata.task, 'code-review')
  assert.match(needs[0].request_template, /harbor ai tune request alice 3 42 0/)
})

test('buildTuneNeeds can scope trusted low-score tune signals to one user', () => {
  const needs = buildTuneNeeds(
    [
      {
        id: 1,
        infer_id: 11,
        request_hash: 'd'.repeat(64),
        selected_model_id: 9,
        confidence_bps: 9400,
        metadata: '{"user":"alice","task":"legal-drafting","trusted_ai_checked":true,"trusted_ai_score_bps":6100}',
      },
      {
        id: 2,
        infer_id: 12,
        request_hash: 'e'.repeat(64),
        selected_model_id: 9,
        confidence_bps: 9400,
        metadata: '{"user":"bob","task":"legal-drafting","trusted_ai_checked":true,"trusted_ai_score_bps":6000}',
      },
      {
        id: 3,
        infer_id: 13,
        request_hash: 'f'.repeat(64),
        selected_model_id: 9,
        confidence_bps: 6100,
        metadata: '{"user":"alice","task":"general"}',
      },
    ],
    [],
    {confidenceThreshold: 8500, user: 'alice', trustedOnly: true},
  )

  assert.equal(needs.length, 1)
  assert.equal(needs[0].base_model_id, '9')
  assert.equal(needs[0].route_count, 1)
  assert.equal(needs[0].metadata.task, 'legal-drafting')
})

test('tune needs preserve model and inference ids beyond MAX_SAFE_INTEGER', () => {
  const modelId = '9007199254740993'
  const inferId = '9007199254740994'
  const [need] = buildTuneNeeds([{
    id: '9007199254740995',
    infer_id: inferId,
    selected_model_id: modelId,
    confidence_bps: 100,
    metadata: '{"task":"lossless-ids"}',
  }], [], {confidenceThreshold: 8500})
  assert.equal(need.base_model_id, modelId)
  assert.deepEqual(need.infer_ids, [inferId])
  assert.match(need.request_template, new RegExp(`request <proposer> ${modelId}`))
})

test('buildTuneAutoVotePlan matches open proposals by base model and task', () => {
  const needs = buildTuneNeeds(
    [
      {
        id: 1,
        infer_id: 21,
        selected_model_id: 5,
        confidence_bps: 9000,
        metadata: '{"user":"alice","task":"sql","trusted_ai_checked":true,"trusted_ai_score_bps":7000}',
      },
    ],
    [],
    {confidenceThreshold: 8500, user: 'alice', trustedOnly: true},
  )
  const plans = buildTuneAutoVotePlan(needs, [
    {id: 1, base_model_id: 5, status: 1, title: 'Fine-tune sql', metadata: '{"task":"sql"}'},
    {id: 2, base_model_id: 4, status: 0, title: 'Fine-tune sql', metadata: '{"task":"sql"}'},
    {id: 3, base_model_id: 5, status: 0, title: 'Fine-tune SQL', metadata: '{"task":"sql"}'},
  ], {quantity: '2.0000 SYS'})

  assert.equal(plans.length, 1)
  assert.equal(plans[0].tune_id, '3')
  assert.equal(plans[0].quantity, '2.0000 SYS')
  assert.equal(plans[0].approve, true)
})

test('ai train start exposes the starttrain max_submissions argument', () => {
  const ai = createAiCommand()
  const train = ai.commands.find((command) => command.name() === 'train')
  const start = train?.commands.find((command) => command.name() === 'start')
  const argumentNames = start?.registeredArguments.map((argument) => argument.name())

  assert.deepEqual(argumentNames, [
    'creator',
    'tune_id',
    'base_model_id',
    'dataset_artifact_id',
    'reward',
    'max_submissions',
    'metadata',
    'expires_sec',
  ])
})

test('ai exposes remote model, deployment topology, session, and canary arguments in ABI order', async () => {
  const ai = createAiCommand()
  const args = (group: string, command: string) => ai.commands
    .find((candidate) => candidate.name() === group)?.commands
    .find((candidate) => candidate.name() === command)?.registeredArguments
    .map((argument) => argument.name())

  assert.deepEqual(args('model', 'register-remote'), [
    'owner', 'model_type', 'parent_model_id', 'manifest_artifact_id', 'revision_hash',
    'terms_artifact_id', 'output_distillation_allowed', 'requires_session_affinity',
    'preserve_thinking_history', 'eval_artifact_id', 'api_model_id', 'title', 'metadata',
  ])
  assert.deepEqual(args('provider', 'configure-deployment'), [
    'provider', 'deployment_id', 'execution_mode', 'source_model_id',
    'topology_artifact_id', 'node_count', 'aggregate_memory_mb', 'min_node_memory_mb',
    'interconnect', 'sharding_hash', 'runtime_hash', 'validated_context_tokens', 'metadata',
  ])
  assert.deepEqual(args('provider', 'bind-deployment-access'), [
    'provider', 'deployment_id', 'vault_contract', 'vault_receipt_id',
    'vault_grant_id', 'vault_use_id', 'purpose_hash', 'use_hash',
  ])
  assert.deepEqual(args('provider', 'clean-subscriptions'), [
    'provider', 'start_id', 'max_rows',
  ])
  assert.deepEqual(args('provider', 'seed-training-contribution'), [
    'submission_id', 'model_id',
  ])
  assert.deepEqual(args('provider', 'seed-inference-contribution'), [
    'deployment_id',
  ])
  const disabledCommands = [
    ['provider', 'seed-inference-contribution'],
    ['tune', 'contribute-data'],
    ['tune', 'reward-data'],
  ] as const
  for (const [group, command] of disabledCommands) {
    const description = ai.commands
      .find((candidate) => candidate.name() === group)?.commands
      .find((candidate) => candidate.name() === command)?.description() ?? ''
    assert.match(description, /compatibility-disabled/i)
  }
  const dataContribution = ai.commands
    .find((candidate) => candidate.name() === 'data')?.commands
    .find((candidate) => candidate.name() === 'contribute')
  assert.match(dataContribution?.description() ?? '', /Vault-backed distillation batch/i)
  await assert.doesNotReject(
    createAiCommand().parseAsync([
      'node', 'test', 'data', 'contribute', 'alice', '9', '2',
      '--sample', `77:${'a'.repeat(64)}`,
      '--dataset-object-id', '101',
      '--dataset-policy-id', '12',
      '--transform-id', '13',
      '--recipe-artifact-id', '14',
      '--dataset-hash', 'b'.repeat(64),
      '--input-lineage-hash', 'c'.repeat(64),
      '--recipe-hash', 'd'.repeat(64),
      '--dry-run', '--json',
    ]),
  )
  assert.deepEqual(args('provider', 'prune-deployment'), [
    'actor', 'deployment_id',
  ])
  assert.deepEqual(args('model', 'adopt-weights'), [
    'owner', 'model_id', 'weights_artifact_id',
  ])
  assert.deepEqual(args('model', 'bind-custody'), [
    'actor', 'model_id', 'weights_artifact_id', 'vault_contract', 'vault_receipt_id',
  ])
  assert.deepEqual(args('program', 'close'), ['owner', 'program_id'])
  assert.deepEqual(args('program', 'finalize'), ['actor', 'program_id'])
  assert.deepEqual(args('program', 'recover'), ['actor', 'program_id'])
  assert.deepEqual(args('program', 'reclaim-credit'), ['owner', 'program_id'])
  assert.deepEqual(args('program', 'admit-tier'), ['owner', 'program_id', 'model_id'])
  assert.deepEqual(args('program', 'migrate-serving'), ['max_rows'])
  assert.deepEqual(args('model', 'set-tokenizer'), [
    'actor', 'model_id', 'tokenizer_artifact_id', 'tokenizer_hash', 'vocab_size',
    'format_version',
  ])
  assert.deepEqual(args('session', 'request'), [
    'requester', 'session_id', 'min_compute_class', 'max_compute_class', 'routing_policy',
    'prompt_hash', 'max_input_tokens', 'max_output_tokens', 'max_fee', 'max_latency_ms',
    'allow_escalation', 'metadata',
  ])
  assert.deepEqual(args('distill', 'report-canary'), [
    'router', 'batch_id', 'request_count', 'success_count', 'evidence_hash',
  ])
  assert.deepEqual(args('distill', 'record-canary'), [
    'router', 'batch_id', 'infer_id', 'route_log_id', 'svc_check_id', 'success',
    'evidence_hash',
  ])
  assert.deepEqual(args('promotion', 'expire'), ['round_id'])
  assert.deepEqual(args('promotion', 'expire-execution'), ['round_id'])
  assert.deepEqual(args('promotion', 'migrate-stages'), ['max_rows'])
  assert.deepEqual(args('promotion', 'migrate-funding'), ['round_id', 'max_rows'])
  assert.deepEqual(args('promotion', 'migrate-active-rounds'), ['max_rows'])
  assert.deepEqual(args('attestation', 'expire'), ['kind', 'subject_id'])
  assert.deepEqual(args('train', 'cancel'), ['actor', 'train_id'])
  assert.deepEqual(args('infer', 'accept'), ['provider', 'infer_id', 'start_hash'])
  assert.deepEqual(args('infer', 'commit-seed'), [
    'requester', 'infer_id', 'seed_commitment',
  ])
  assert.deepEqual(args('infer', 'acknowledge'), [
    'requester', 'infer_id', 'acceptance_hash',
  ])
  assert.deepEqual(args('infer', 'settle'), ['actor', 'infer_id', 'svc_check_id'])
  assert.deepEqual(args('infer', 'challenge'), [
    'requester', 'infer_id', 'svc_check_id', 'evidence_hash', 'selection_reveal',
  ])
  assert.deepEqual(args('infer', 'resolve'), ['actor', 'infer_id', 'svc_check_id'])
  assert.deepEqual(args('distill', 'bind-data-consent'), [
    'user', 'infer_id', 'vault_consent_id',
  ])
  assert.deepEqual(args('distill', 'commit-sample'), [
    'provider', 'infer_id', 'signals', 'top_k', 'envelope_hash', 'signal_hash',
    'tail_mass_hash', 'vault_object_id', 'vault_policy_id', 'vault_consent_id',
    'vault_receipt_id', 'review_grant_id', 'vault_object_hash', 'key_envelope_hash',
    'svc_check_id', 'expires_sec', 'metadata',
  ])
  assert.deepEqual(args('distill', 'set-batch-spec'), [
    'curator', 'batch_id', 'dataset_object_id', 'dataset_policy_id', 'transform_id',
    'recipe_artifact_id', 'dataset_hash', 'input_lineage_hash', 'recipe_hash', 'metadata',
  ])
  assert.deepEqual(args('distill', 'set-token-translation'), [
    'owner', 'campaign_id', 'translation_artifact_id', 'translation_version',
  ])
  assert.deepEqual(args('distill', 'withdraw-sample'), ['requester', 'infer_id'])
  assert.deepEqual(args('distill', 'expire-batch'), ['batch_id'])
})

test('fusion manifest canonicalization is stable and metadata-first', () => {
  const manifest = buildFusionManifest({
    base_model_id: '1',
    experts: [
      parseFusionExpertSpec('3:math:0.6'),
      parseFusionExpertSpec('4:code:0.4'),
    ],
    logit_mode: 'top_k',
    logit_top_k: 8,
    selection_policy: {max_experts: 2, type: 'top_weight'},
    eval_artifact_id: '9',
  })

  assert.deepEqual(manifest.expert_model_ids, ['3', '4'])
  assert.deepEqual(manifest.expert_roles, ['math', 'code'])
  assert.equal(manifest.format, 'harbor.fusion.v1')
  assert.equal(manifest.fusion_strategy, 'routed_expert')
  assert.equal(
    canonicalJson(manifest),
    '{"base_model_id":"1","eval_artifact_id":"9","expert_model_ids":["3","4"],"expert_roles":["math","code"],"expert_weights":[0.6,0.4],"format":"harbor.fusion.v1","fusion_strategy":"routed_expert","logit_mode":"top_k","logit_top_k":8,"selection_policy":{"max_experts":2,"type":"top_weight"}}\n',
  )
  assert.throws(() => buildFusionManifest({
    base_model_id: '1',
    experts: [parseFusionExpertSpec('3:math:1'), parseFusionExpertSpec('03:code:1')],
  }), /duplicate fusion expert model id/)
})

test('fusion register plan uses existing artifact and model actions', () => {
  const manifest = buildFusionManifest({
    base_model_id: '1',
    experts: [parseFusionExpertSpec('3:reasoner:1')],
  })
  const plan = buildFusionRegisterPlan({
    manifest,
    owner: 'alice',
    title: 'Fusion Agent',
    storageObjectId: 42,
    contentHash: 'a'.repeat(64),
    weightsArtifactId: 7,
    aiContract: 'harborai',
  })

  assert.equal(plan.actions.length, 2)
  assert.equal(plan.actions[0].action, 'addartifact')
  assert.equal(plan.actions[0].data.kind, 1)
  assert.equal(plan.actions[1].action, 'regmodel')
  assert.equal(plan.actions[1].data.model_type, 2)
  assert.equal(plan.actions[1].data.parent_model_id, '1')
  assert.equal(plan.actions[1].data.weights_artifact_id, '7')
  assert.match(String(plan.actions[1].data.metadata), /harbor\.fusion\.v1/)
})

test('fusion manifests and registration actions preserve uint64 ids beyond MAX_SAFE_INTEGER', () => {
  const baseModelId = '9007199254740993'
  const expertModelId = '9007199254740994'
  const storageObjectId = '9007199254740995'
  const weightsArtifactId = '9007199254740996'
  const manifest = buildFusionManifest({
    base_model_id: baseModelId,
    experts: [parseFusionExpertSpec(`${expertModelId}:reasoner:1`)],
  })
  const plan = buildFusionRegisterPlan({
    manifest,
    owner: 'alice',
    title: 'Large IDs',
    storageObjectId,
    weightsArtifactId,
  })
  assert.equal(manifest.base_model_id, baseModelId)
  assert.deepEqual(manifest.expert_model_ids, [expertModelId])
  assert.equal(plan.actions[0].data.storage_object_id, storageObjectId)
  assert.equal(plan.actions[1].data.weights_artifact_id, weightsArtifactId)
})

test('AI registration resolvers page only through the new id window and preserve uint64 strings', async () => {
  const contentHash = 'a'.repeat(64)
  let artifactPages = 0
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      response.writeHead(200, {'content-type': 'application/json'})
      if (body.table === 'artifacts') {
        artifactPages += 1
        response.end(JSON.stringify(artifactPages === 1 ? {
          rows: [{
            id: '9007199254740993', owner: 'other', kind: '1',
            storage_object_id: '9007199254740000', content_hash: contentHash,
          }],
          more: true,
          next_key: '9007199254740994',
        } : {
          rows: [{
            id: '9007199254740994', owner: 'alice', kind: '1',
            storage_object_id: '9007199254740992', content_hash: contentHash,
          }],
          more: false,
        }))
        return
      }
      response.end(JSON.stringify({
        rows: [{
          id: '9007199254741999', owner: 'alice', weights_artifact_id: '9007199254740994',
          metadata: JSON.stringify({fusion_manifest_hash: contentHash}),
        }],
        more: false,
      }))
    })
  })
  try {
    const url = await listen(server)
    const artifactId = await resolveArtifactId(
      'harborai', 'alice', 1, '9007199254740992', contentHash,
      {
        url,
        minimumIdInclusive: '9007199254740993',
        maximumIdExclusive: '9007199254740995',
      },
    )
    assert.equal(artifactId, '9007199254740994')
    assert.equal(artifactPages, 2)
    assert.equal(await resolveModelId('harborai', 'alice', artifactId, contentHash, {
      url,
      minimumIdInclusive: '9007199254741999',
      maximumIdExclusive: '9007199254742000',
    }), '9007199254741999')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('AI registration resolver rejects ambiguous duplicate rows in the new id window', async () => {
  const contentHash = 'b'.repeat(64)
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {'content-type': 'application/json'})
    response.end(JSON.stringify({
      rows: ['41', '42'].map((id) => ({
        id, owner: 'alice', kind: 2, storage_object_id: '9', content_hash: contentHash,
      })),
      more: false,
    }))
  })
  try {
    const url = await listen(server)
    await assert.rejects(
      () => resolveArtifactId('harborai', 'alice', 2, '9', contentHash, {
        url,
        minimumIdInclusive: '41',
        maximumIdExclusive: '43',
      }),
      /resolved 2 newly created rows/,
    )
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('fusion manifest can ask router to auto-discover expert roles', () => {
  const manifest = buildFusionManifest({
    base_model_id: '1',
    experts: [],
    auto_expert_count: 3,
    logit_mode: 'top_k',
    logit_top_k: 4,
  })

  assert.deepEqual(manifest.expert_model_ids, [])
  assert.deepEqual(manifest.expert_roles, [])
  assert.equal(manifest.auto_expert_count, 3)
  assert.deepEqual(manifest.selection_policy, {
    type: 'capability_profile',
    auto_discover_roles: true,
    max_experts: 3,
  })
})

test('distributed expert plan creates deterministic shard metadata', () => {
  const plan = buildDistributedExpertPlan({
    base_model_id: '1',
    expert_role: 'code',
    shard_count: 2,
    participants: ['trainer11111', 'trainer22222'],
    dataset_artifact_id: '9',
    model: 'mlx-community/gemma-3-12b-it-4bit',
  })
  const again = buildDistributedExpertPlan({
    base_model_id: '1',
    expert_role: 'code',
    shard_count: 2,
    participants: ['trainer11111', 'trainer22222'],
    dataset_artifact_id: '9',
    model: 'mlx-community/gemma-3-12b-it-4bit',
  })

  assert.equal(plan.format, 'harbor.distributed_expert_plan.v1')
  assert.equal(plan.aggregation_group_id, again.aggregation_group_id)
  assert.equal(plan.shards.length, 2)
  assert.equal(plan.shards[0].participant, 'trainer11111')
  assert.equal(plan.shards[1].metadata.shard_index, 1)
  assert.equal(plan.shards[1].metadata.shard_count, 2)
  assert.equal(plan.shards[1].metadata.distributed_training, true)
  assert.equal(plan.shards[1].metadata.aggregation_group_id, plan.aggregation_group_id)
})

test('distributed aggregate manifest canonicalizes shard artifact specs', () => {
  const manifest = buildDistributedAggregateManifest({
    base_model_id: '1',
    expert_role: 'code',
    aggregation_group_id: 'round-001',
    shard_artifacts: [
      parseDistributedShardSpec(`1:${'b'.repeat(64)}:2:12:trainer22222`),
      parseDistributedShardSpec(`0:${'a'.repeat(64)}:1:11:trainer11111`),
    ],
  })

  assert.deepEqual(manifest.shard_artifacts.map((shard) => shard.shard_index), [0, 1])
  assert.equal(manifest.aggregation_strategy, 'weighted_lora_average')
  assert.equal(
    canonicalJson(manifest),
    `{"aggregation_group_id":"round-001","aggregation_strategy":"weighted_lora_average","base_model_id":"1","expert_role":"code","format":"harbor.gemma.mlx.aggregate-manifest.v1","shard_artifacts":[{"artifact_id":"11","shard_index":0,"trainer":"trainer11111","weight":1,"weights_hash":"${'a'.repeat(64)}"},{"artifact_id":"12","shard_index":1,"trainer":"trainer22222","weight":2,"weights_hash":"${'b'.repeat(64)}"}]}\n`,
  )
})

test('query trace dataset pack keeps corrections and filters weak raw outputs', () => {
  const campaignId = '9007199254740993'
  const programId = '9007199254740994'
  const modelId = '9007199254740995'
  const consentReceipt = {
    active: true,
    status: 'active',
    campaign_id: campaignId,
    program_id: programId,
    consent_version: 2,
    scope_bits: 7,
    policy_hash: 'c'.repeat(64),
    receipt_hash: 'd'.repeat(64),
    expires_at: 2_000_000_000,
  }
  const privacyReview = {status: 'passed', pii_filtered: true, report_hash: 'e'.repeat(64)}
  const lines = [
    JSON.stringify({
      format: 'harbor.ai.trace.v1',
      kind: 'user_feedback',
      training_candidate: true,
      prompt: 'How should Harbor shard expert training?',
      prompt_hash: 'p'.repeat(64),
      corrected_output: 'Split each expert into independent LoRA shards and average compatible adapters.',
      rejected_output: 'Train one giant model.',
      model_id: modelId,
      task: 'fusion-training',
      user: 'alice',
      feedback_score_bps: 9600,
      consent_receipt: consentReceipt,
      privacy_review: privacyReview,
    }),
    JSON.stringify({
      format: 'harbor.ai.trace.v1',
      kind: 'routed_inference',
      training_candidate: true,
      prompt: 'What is a good answer?',
      prompt_hash: 'q'.repeat(64),
      output: '{"text":"A concise, verified answer."}',
      model_id: modelId,
      task: 'fusion-training',
      trusted_ai: {score_bps: 9100},
      consent_receipt: consentReceipt,
      privacy_review: privacyReview,
    }),
    JSON.stringify({
      format: 'harbor.ai.trace.v1',
      kind: 'routed_inference',
      training_candidate: true,
      prompt: 'What should not be trained?',
      prompt_hash: 'r'.repeat(64),
      output: 'A low trust hallucination.',
      model_id: modelId,
      task: 'fusion-training',
      trusted_ai: {score_bps: 4200},
      consent_receipt: consentReceipt,
      privacy_review: privacyReview,
    }),
    JSON.stringify({
      format: 'harbor.ai.trace.v1',
      kind: 'user_feedback',
      training_candidate: true,
      prompt: 'This record has no consent.',
      accepted_output: 'It must not enter the dataset.',
      model_id: modelId,
      task: 'fusion-training',
    }),
    JSON.stringify({
      format: 'harbor.ai.trace.v1',
      kind: 'routed_inference',
      training_candidate: true,
      prompt: 'What is a good answer?',
      output: '{"text":"A concise, verified answer."}',
      model_id: modelId,
      task: 'fusion-training',
      trusted_ai: {score_bps: 9100},
      consent_receipt: {...consentReceipt, receipt_hash: 'f'.repeat(64)},
      privacy_review: privacyReview,
    }),
  ]

  const pack = buildQueryDatasetFromTraces(lines, {
    contributor: 'alice',
    task: 'fusion-training',
    base_model_id: modelId,
    expert_role: 'planner',
    min_useful_bps: 8500,
    as_of_epoch_sec: 1_900_000_000,
  })

  assert.equal(pack.examples.length, 2)
  assert.equal(pack.skipped.low_score_output, 1)
  assert.equal(pack.skipped.missing_or_inactive_consent, 1)
  assert.equal(pack.skipped.duplicate_example, 1)
  assert.equal(pack.manifest.format, 'harbor.ai.query-dataset.v2')
  assert.equal(pack.manifest.example_count, 2)
  assert.equal(pack.manifest.training_metadata?.expert_role, 'planner')
  assert.deepEqual(pack.manifest.campaign_ids, [campaignId])
  assert.equal(pack.manifest.base_model_id, modelId)
  assert.equal(pack.examples[0].metadata.model_id, modelId)
  assert.equal(pack.examples[0].metadata.program_id, programId)
  assert.deepEqual(pack.manifest.consent_policy_hashes, ['c'.repeat(64)])
  assert.equal(pack.examples[0].metadata.consent_receipt_hash, 'd'.repeat(64))
  assert.equal(pack.examples[0].metadata.user, undefined)
  assert.equal(pack.examples[0].messages[1].content, 'Split each expert into independent LoRA shards and average compatible adapters.')
  assert.equal(pack.examples[0].rejected_completion, 'Train one giant model.')
  assert.equal(pack.examples[1].messages[1].content, 'A concise, verified answer.')
  assert.match(pack.dataset_jsonl, /"messages"/)
  assert.equal(pack.dataset_hash.length, 64)
  assert.equal(pack.manifest_hash.length, 64)
  assert.equal(validateQueryDatasetManifest(pack.manifest).dataset_hash, pack.manifest.dataset_hash)
  assert.throws(
    () => validateQueryDatasetManifest({...pack.manifest, consent_receipt_hashes: []}),
    /incomplete consent-aware query dataset manifest/,
  )
})

test('RLVR query datasets require feedback consent and sealed oracle evidence', () => {
  const outcome = {
    schema: 'harbor.ai.outcome.v1',
    source: 'svcmarket-oracle',
    payload_hash: '1'.repeat(64),
    evidence_hash: '2'.repeat(64),
    verifier_spec_hash: '3'.repeat(64),
    oracle: 'oracle111111',
    svc_check_id: '91',
    status: 'accepted',
  }
  const trace = {
    format: 'harbor.ai.trace.v1',
    kind: 'user_feedback',
    training_candidate: true,
    prompt: 'Return the verified Harbor marker.',
    accepted_output: 'HARBOR',
    infer_id: '101',
    selected_provider: 'aiinfer1111',
    selected_model_id: '7',
    settlement_broadcast: true,
    settlement_tx: '9'.repeat(64),
    model_id: '7',
    consent_receipt: {
      active: true,
      status: 'active',
      campaign_id: '9',
      program_id: '11',
      consent_version: 1,
      scope_bits: 7,
      policy_hash: '4'.repeat(64),
      receipt_hash: '5'.repeat(64),
      expires_at: 2_000_000_000,
    },
    privacy_review: {status: 'passed', pii_filtered: true, report_hash: '6'.repeat(64)},
    outcome_feedback: outcome,
  }

  const denied = buildQueryDatasetFromTraces(
    [JSON.stringify(trace)],
    {
      as_of_epoch_sec: 1_900_000_000,
      rlvr_only: true,
      base_model_hash: '7'.repeat(64),
      tokenizer_hash: '8'.repeat(64),
    },
  )
  assert.equal(denied.examples.length, 0)
  assert.equal(denied.skipped.outcome_feedback_consent_required, 1)

  const allowedTrace = {
    ...trace,
    consent_receipt: {...trace.consent_receipt, scope_bits: 23},
  }
  const allowed = buildQueryDatasetFromTraces(
    [JSON.stringify(allowedTrace)],
    {
      as_of_epoch_sec: 1_900_000_000,
      rlvr_only: true,
      base_model_hash: '7'.repeat(64),
      tokenizer_hash: '8'.repeat(64),
    },
  )
  const manifest = allowed.manifest as unknown as {
    oracle_evidence_hashes?: string[]
    verifier_spec_hashes?: string[]
    response_hashes: string[]
    retention_policy: {not_after_epoch_sec: number}
    privacy_policy: {required_scopes?: string[]}
    reward_policy?: {authority?: string; sealed_verifiers_only?: boolean}
  }
  assert.equal(allowed.examples.length, 1)
  const holdoutOptions = {
    as_of_epoch_sec: 1_900_000_000, rlvr_only: true,
    base_model_hash: '7'.repeat(64), tokenizer_hash: '8'.repeat(64), split: 'eval',
  }
  const holdout = buildQueryDatasetFromTraces([JSON.stringify(allowedTrace)], holdoutOptions)
  assert.equal(JSON.parse(holdout.dataset_jsonl).split, 'eval')
  assert.notEqual(holdout.dataset_hash, allowed.dataset_hash)
  assert.throws(() => buildQueryDatasetFromTraces([JSON.stringify(allowedTrace)], {
    ...holdoutOptions, split: 'unknown',
  } as typeof holdoutOptions), /split/)
  assert.deepEqual(manifest.oracle_evidence_hashes, ['2'.repeat(64)])
  assert.deepEqual(manifest.verifier_spec_hashes, ['3'.repeat(64)])
  assert.ok(manifest.privacy_policy.required_scopes?.includes('feedback'))
  assert.equal(manifest.reward_policy?.authority, 'svcmarket-oracle')
  assert.equal(manifest.reward_policy?.sealed_verifiers_only, true)
  assert.equal(manifest.response_hashes.length, 1)
  assert.equal(manifest.response_hashes[0].length, 64)
  assert.equal(manifest.retention_policy.not_after_epoch_sec, 2_000_000_000)
  assert.equal(allowed.examples[0].metadata.outcome_payload_hash, '1'.repeat(64))
  assert.equal(allowed.examples[0].metadata.oracle, 'oracle111111')
  assert.equal(allowed.examples[0].metadata.svc_check_id, '91')
  assert.deepEqual(allowed.examples[0].metadata.network_rollout, {
    format: 'harbor.ai.rlvr-network-rollout.v1',
    infer_id: '101',
    provider: 'aiinfer1111',
    model_id: '7',
    result_hash: allowed.manifest.response_hashes[0],
    settled: true,
    settlement_tx: '9'.repeat(64),
  })
  const unsettled = buildQueryDatasetFromTraces([
    JSON.stringify({...allowedTrace, settlement_broadcast: undefined}),
  ], {
    as_of_epoch_sec: 1_900_000_000,
    rlvr_only: true,
    base_model_hash: 'b'.repeat(64),
    tokenizer_hash: 'c'.repeat(64),
  })
  assert.equal(unsettled.manifest.example_count, 0)
  assert.equal(unsettled.skipped.settled_network_rollout_required, 1)
  assert.throws(
    () => validateQueryDatasetManifest({...allowed.manifest, reward_policy: undefined}),
    /incomplete consent-aware query dataset manifest/,
  )
  assert.throws(
    () => validateQueryDatasetManifest({
      ...allowed.manifest,
      oracle_evidence_hashes: [],
      verifier_spec_hashes: [],
    }),
    /incomplete consent-aware query dataset manifest/,
  )
})

test('RLVR recipes canonically bind bounded oracle-approved verifiers', () => {
  const rlvr = createAiCommand().commands.find((command) => command.name() === 'rlvr')
  assert.ok(rlvr?.commands.some((command) => command.name() === 'work-item'),
    'the governed trainer needs a canonical work-item packer')
  const built = buildRlvrRecipe({
    base_model: 'mlx-community/gemma-3-270m-4bit',
    base_model_hash: 'a'.repeat(64),
    tokenizer_hash: 'b'.repeat(64),
    dataset_hash: 'c'.repeat(64),
    seed: 7,
    group_size: 4,
    batch_size: 1,
    steps: 2,
    max_prompt_tokens: 128,
    max_completion_tokens: 32,
    clip_epsilon: 0.2,
    kl_coefficient: 0.02,
    learning_rate: 1e-5,
    lora_layers: 1,
    verifiers: [{
      id: 'marker',
      type: 'exact_text',
      expected: 'HARBOR',
      oracle: 'oracle111111',
      oracle_evidence_hash: 'd'.repeat(64),
      svc_check_id: '91',
    }],
  })
  assert.equal(built.recipe.format, 'harbor.ai.rlvr-recipe.v1')
  assert.equal(built.recipe.algorithm, 'grpo')
  assert.equal(built.recipe.group_size, 4)
  assert.equal(built.recipe.oracle_evidence_root.length, 64)
  assert.equal(built.recipe_hash.length, 64)
  assert.equal(canonicalJson(built.recipe), built.recipe_json)
  const example = (prompt: string, split: string) => ({
    messages: [{role: 'user', content: prompt}, {role: 'assistant', content: 'HARBOR'}],
    verifier_id: 'marker', split,
  })
  const packageExamples = (examples: unknown[]) => {
    const dataset = examples.map((value) => canonicalJson(value)).join('')
    const recipe = buildRlvrRecipe({...built.recipe,
      dataset_hash: createHash('sha256').update(dataset).digest('hex')}).recipe
    return buildRlvrWorkItem(recipe, dataset)
  }
  const work = JSON.parse(packageExamples([example('train', 'train'), example('unseen', 'eval')]))
  assert.equal(work.format, 'harbor.ai.rlvr-work-item.v1')
  assert.equal(work.examples[1].split, 'eval')
  assert.throws(() => packageExamples([example('train', 'train')]), /holdout/)
  assert.throws(() => packageExamples([example('same', 'train'), example('same', 'eval')]), /overlap/)
  assert.throws(() => buildRlvrWorkItem(built.recipe, '{}\n'), /dataset hash/)
  const network = buildRlvrRecipe({
    ...built.recipe,
    steps: 1,
    rollout_source: 'network',
    network_model_id: '7',
    minimum_rollout_providers: 2,
  })
  assert.equal(network.recipe.rollout_source, 'network')
  assert.equal(network.recipe.network_model_id, '7')
  assert.equal(network.recipe.minimum_rollout_providers, 2)
  assert.throws(
    () => buildRlvrRecipe({...network.recipe, steps: 2}),
    /exactly one optimizer step/,
  )
  assert.throws(
    () => buildRlvrRecipe({...built.recipe, verifiers: [{
      id: 'unsafe',
      type: 'shell_command' as never,
      oracle: 'oracle111111',
      oracle_evidence_hash: 'e'.repeat(64),
      svc_check_id: '92',
    }]}),
    /unsupported or invalid sealed verifier/,
  )
  assert.throws(
    () => buildRlvrRecipe({...built.recipe, verifiers: [{
      id: 'unbounded-number',
      type: 'numeric_tolerance',
      expected: 1e101,
      tolerance: 0,
      oracle: 'oracle111111',
      oracle_evidence_hash: 'f'.repeat(64),
      svc_check_id: '93',
    }]}),
    /bounded finite expected and tolerance/,
  )
  assert.throws(
    () => buildRlvrRecipe({...built.recipe, verifiers: [{
      id: 'unbounded-json-key',
      type: 'json_constraints',
      required: {['x'.repeat(129)]: true},
      oracle: 'oracle111111',
      oracle_evidence_hash: '0'.repeat(64),
      svc_check_id: '94',
    }]}),
    /json_constraints requires 1 to 32 scalar fields/,
  )
})

test('runTrustedAiAdapter command passes a JSON payload file path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-ai-adapter-'))
  const script = path.join(dir, 'checker.js')
  try {
    await fs.writeFile(script, `
const fs = require('node:fs')
const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
process.stdout.write(JSON.stringify({approve: payload.kind === 'harbor.ai.tune_auto_vote', useful_bps: 9100, reason: payload.need.metadata.task}))
`)

    const decision = await runTrustedAiAdapter({
      kind: 'harbor.ai.tune_auto_vote',
      need: {metadata: {task: 'sql'}},
    }, {adapterCommand: `${process.execPath} ${script}`})

    assert.equal(decision.approve, true)
    assert.equal(decision.useful_bps, 9100)
    assert.equal(decision.reason, 'sql')
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
  }
})

test('renderAegisConfig creates a trusted reviewer config for Harbor', () => {
  const config = JSON.parse(renderAegisConfig({
    reviewer: 'judge',
    command: '/usr/local/bin/trusted-judge',
  }))

  assert.equal(config.trustedReviewer, 'judge')
  assert.equal(config.models[0].id, 'judge')
  assert.equal(config.models[0].command, '/usr/local/bin/trusted-judge')
  assert.equal(config.models[0].trustLevel, 'trusted')
  assert.deepEqual(config.policy.allowedPaths, ['HARBOR_AI_OUTPUT.md'])
})

test('aegisHarborCheckCommand builds the command Harbor will invoke', () => {
  const command = aegisHarborCheckCommand('/tmp/aegis config.json', {
    aegisCommand: 'bun /repo/aegis/src/commands/AegisCommand.ts',
  })

  assert.equal(
    command,
    "bun /repo/aegis/src/commands/AegisCommand.ts harbor-check --config '/tmp/aegis config.json'",
  )
})
