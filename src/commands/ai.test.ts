import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  aegisHarborCheckCommand,
  buildTuneAutoVotePlan,
  buildTuneNeeds,
  createAiCommand,
  renderAegisConfig,
  runTrustedAiAdapter,
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
