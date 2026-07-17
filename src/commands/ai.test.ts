import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
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
  buildTuneAutoVotePlan,
  buildTuneNeeds,
  canonicalJson,
  createAiCommand,
  parseDistributedShardSpec,
  parseFusionExpertSpec,
  renderAegisConfig,
  runTrustedAiAdapter,
  validateQueryDatasetManifest,
} from './ai.js'

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
  assert.equal(needs[0].base_model_id, 3)
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
  assert.equal(needs[0].base_model_id, 9)
  assert.equal(needs[0].route_count, 1)
  assert.equal(needs[0].metadata.task, 'legal-drafting')
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
  assert.equal(plans[0].tune_id, 3)
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

test('ai exposes remote model, deployment topology, session, and canary arguments in ABI order', () => {
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
  assert.deepEqual(args('session', 'request'), [
    'requester', 'session_id', 'min_compute_class', 'max_compute_class', 'routing_policy',
    'prompt_hash', 'max_input_tokens', 'max_output_tokens', 'max_fee', 'max_latency_ms',
    'allow_escalation', 'metadata',
  ])
  assert.deepEqual(args('distill', 'report-canary'), [
    'router', 'batch_id', 'request_count', 'success_count', 'evidence_hash',
  ])
})

test('fusion manifest canonicalization is stable and metadata-first', () => {
  const manifest = buildFusionManifest({
    base_model_id: 1,
    experts: [
      parseFusionExpertSpec('3:math:0.6'),
      parseFusionExpertSpec('4:code:0.4'),
    ],
    logit_mode: 'top_k',
    logit_top_k: 8,
    selection_policy: {max_experts: 2, type: 'top_weight'},
    eval_artifact_id: 9,
  })

  assert.deepEqual(manifest.expert_model_ids, [3, 4])
  assert.deepEqual(manifest.expert_roles, ['math', 'code'])
  assert.equal(manifest.format, 'harbor.fusion.v1')
  assert.equal(manifest.fusion_strategy, 'routed_expert')
  assert.equal(
    canonicalJson(manifest),
    '{"base_model_id":1,"eval_artifact_id":9,"expert_model_ids":[3,4],"expert_roles":["math","code"],"expert_weights":[0.6,0.4],"format":"harbor.fusion.v1","fusion_strategy":"routed_expert","logit_mode":"top_k","logit_top_k":8,"selection_policy":{"max_experts":2,"type":"top_weight"}}\n',
  )
})

test('fusion register plan uses existing artifact and model actions', () => {
  const manifest = buildFusionManifest({
    base_model_id: 1,
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
  assert.equal(plan.actions[1].data.parent_model_id, 1)
  assert.equal(plan.actions[1].data.weights_artifact_id, 7)
  assert.match(String(plan.actions[1].data.metadata), /harbor\.fusion\.v1/)
})

test('fusion manifest can ask router to auto-discover expert roles', () => {
  const manifest = buildFusionManifest({
    base_model_id: 1,
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
    base_model_id: 1,
    expert_role: 'code',
    shard_count: 2,
    participants: ['trainer11111', 'trainer22222'],
    dataset_artifact_id: 9,
    model: 'mlx-community/gemma-3-12b-it-4bit',
  })
  const again = buildDistributedExpertPlan({
    base_model_id: 1,
    expert_role: 'code',
    shard_count: 2,
    participants: ['trainer11111', 'trainer22222'],
    dataset_artifact_id: 9,
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
    base_model_id: 1,
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
    `{"aggregation_group_id":"round-001","aggregation_strategy":"weighted_lora_average","base_model_id":1,"expert_role":"code","format":"harbor.gemma.mlx.aggregate-manifest.v1","shard_artifacts":[{"artifact_id":11,"shard_index":0,"trainer":"trainer11111","weight":1,"weights_hash":"${'a'.repeat(64)}"},{"artifact_id":12,"shard_index":1,"trainer":"trainer22222","weight":2,"weights_hash":"${'b'.repeat(64)}"}]}\n`,
  )
})

test('query trace dataset pack keeps corrections and filters weak raw outputs', () => {
  const consentReceipt = {
    active: true,
    status: 'active',
    campaign_id: 7,
    program_id: 3,
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
      model_id: 1,
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
      model_id: 1,
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
      model_id: 1,
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
      model_id: 1,
      task: 'fusion-training',
    }),
    JSON.stringify({
      format: 'harbor.ai.trace.v1',
      kind: 'routed_inference',
      training_candidate: true,
      prompt: 'What is a good answer?',
      output: '{"text":"A concise, verified answer."}',
      model_id: 1,
      task: 'fusion-training',
      trusted_ai: {score_bps: 9100},
      consent_receipt: {...consentReceipt, receipt_hash: 'f'.repeat(64)},
      privacy_review: privacyReview,
    }),
  ]

  const pack = buildQueryDatasetFromTraces(lines, {
    contributor: 'alice',
    task: 'fusion-training',
    base_model_id: 1,
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
  assert.deepEqual(pack.manifest.campaign_ids, [7])
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
