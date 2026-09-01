import {spawn} from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Command} from 'commander'
import {addJsonActionCommand, Field} from './action-fields.js'
import {addTxOptions} from './action.js'
import {
  actionUint64Return,
  canonicalUint64,
  getAllTableRows,
  getTableRows,
  printResult,
  pushAction,
  readContractNextId,
  serializeAction,
  transactActions,
} from '../lib/tx.js'
import {GovernedStorageEncryption, hashFile, putReplicatedObject, putWalrusObject, sha256Bytes} from '../lib/storage.js'
import {parseVaultPublicKey} from '../lib/vault-crypto.js'

const AI_CONTRACT = process.env.HARBOR_AI_CONTRACT ?? 'harborai'
const MARKET_CONTRACT = process.env.HARBOR_MARKET_CONTRACT ?? 'svcmarket'
const DISABLED_INFERENCE_SEED =
  'deployment registration is not inference work; complete a paid, independently settled inference'
const DISABLED_DATA_CONTRIBUTION =
  'legacy data contributions are disabled; use the Vault-backed distillation sample lifecycle'
const DISABLED_DATA_REWARD =
  'legacy data rewards are disabled; fund the Vault-backed staged sample reward pool'

const AI_SERVICE_TYPES: Record<string, {id: number; name: string; aliases: string[]}> = {
  inference: {id: 18, name: 'aiinfer', aliases: ['infer', 'aiinfer', 'model-host', 'host']},
  training: {id: 19, name: 'aitrain', aliases: ['train', 'aitrain', 'trainer']},
  router: {id: 20, name: 'airouter', aliases: ['route', 'airouter', 'ai-router']},
}

interface AiActionSpec {
  command: string
  action: string
  fields: Field[]
  signerField?: string
  disabledReason?: string
}

function addAiAction(root: Command, spec: AiActionSpec): void {
  addJsonActionCommand(root, AI_CONTRACT, spec)
}

interface OfferOptions {
  url?: string
  actor?: string
  permission?: string
  key?: string
  auth?: string
  json?: boolean
  expiration?: string
  marketContract?: string
  rangeStart?: string
  rangeEnd?: string
  capacityBytes?: string
  stake?: string
  metadata?: string
  skipRegisterProvider?: boolean
  dryRun?: boolean
}

interface ProviderRow {
  owner: string
}

interface AiArtifactRow {
  id: number | string
  owner: string
  kind: number | string
  storage_object_id: number | string
  content_hash: string
  metadata?: string
}

interface AiModelRow {
  id: number | string
  owner: string
  model_type: number | string
  parent_model_id: number | string
  weights_artifact_id: number | string
  eval_artifact_id: number | string
  title?: string
  metadata?: string
}

export interface RouteLogRow {
  id: number | string
  infer_id?: number | string
  request_hash?: string
  selected_model_id: number | string
  confidence_bps: number | string
  metadata?: string
}

export type Uint64String = string

export interface SubcallRow {
  id: number | string
  parent_infer_id: number | string
  from_model_id: number | string
  to_model_id: number | string
  metadata?: string
}

export interface TuneNeed {
  base_model_id: Uint64String
  title: string
  route_count: number
  low_confidence_count: number
  subcall_count: number
  avg_confidence_bps: number
  infer_ids: Uint64String[]
  request_hashes: string[]
  metadata: Record<string, unknown>
  request_template: string
}

export interface TuneRequestRow {
  id: number | string
  proposer?: string
  base_model_id: number | string
  dataset_artifact_id?: number | string
  eval_artifact_id?: number | string
  status: number | string
  title?: string
  metadata?: string
}

export interface TuneAutoVotePlan {
  tune_id: Uint64String
  approve: boolean
  quantity: string
  reason: string
  need: TuneNeed
  tune: TuneRequestRow
}

export interface TrustedAiDecision {
  approve?: boolean
  useful?: boolean
  needs_tune?: boolean
  score_bps?: number
  useful_bps?: number
  trust_score_bps?: number
  task?: string
  reason?: string
  raw?: unknown
}

export interface TrustedAiAdapterOptions {
  adapterCommand?: string
  adapterUrl?: string
  timeoutMs?: number
}

export interface AegisConfigOptions {
  reviewer?: string
  command?: string
}

export type FusionLogitMode = 'none' | 'top_k' | 'full'

export interface FusionExpertSpec {
  model_id: Uint64String
  role: string
  weight: number
}

export interface FusionManifestInput {
  base_model_id: Uint64String
  experts: FusionExpertSpec[]
  logit_mode?: FusionLogitMode
  logit_top_k?: number
  selection_policy?: Record<string, unknown>
  eval_artifact_id?: Uint64String
  auto_expert_count?: number
}

export interface FusionManifest {
  format: 'harbor.fusion.v1'
  base_model_id: Uint64String
  expert_model_ids: Uint64String[]
  expert_roles: string[]
  expert_weights: number[]
  fusion_strategy: 'routed_expert'
  logit_mode: FusionLogitMode
  logit_top_k: number
  selection_policy: Record<string, unknown>
  eval_artifact_id: Uint64String
  auto_expert_count?: number
}

export interface FusionRegisterPlan {
  manifest: FusionManifest
  manifest_json: string
  manifest_hash: string
  artifact_metadata: Record<string, unknown>
  model_metadata: Record<string, unknown>
  actions: Array<{contract: string; action: string; data: Record<string, unknown>}>
}

export interface DistributedExpertPlanInput {
  base_model_id: Uint64String
  expert_role: string
  shard_count: number
  participants?: string[]
  dataset_artifact_id?: Uint64String
  model?: string
  aggregation_group_id?: string
  metadata?: Record<string, unknown>
}

export interface DistributedExpertShard {
  shard_index: number
  shard_count: number
  participant?: string
  metadata: Record<string, unknown>
}

export interface DistributedExpertPlan {
  format: 'harbor.distributed_expert_plan.v1'
  base_model_id: Uint64String
  expert_role: string
  shard_count: number
  aggregation_group_id: string
  shards: DistributedExpertShard[]
}

export interface DistributedShardArtifactSpec {
  shard_index: number
  weights_hash: string
  weight: number
  artifact_id?: Uint64String
  trainer?: string
}

export interface DistributedAggregateManifest {
  format: 'harbor.gemma.mlx.aggregate-manifest.v1'
  base_model_id: Uint64String
  expert_role: string
  aggregation_group_id: string
  aggregation_strategy: 'weighted_lora_average'
  shard_artifacts: DistributedShardArtifactSpec[]
}

export interface QueryDatasetExample {
  messages: Array<{role: 'user' | 'assistant'; content: string}>
  metadata: Record<string, unknown>
  rejected_completion?: string
}

export interface QueryDatasetManifest {
  format: 'harbor.ai.query-dataset.v2'
  dataset_format: 'chat_messages_jsonl'
  dataset_hash: string
  source: 'harbor-ai-query-traces'
  contributor?: string
  base_model_id?: Uint64String
  model_id?: Uint64String
  expert_role?: string
  fusion_parent_model_id?: Uint64String
  task?: string
  example_count: number
  example_hashes: string[]
  prompt_hashes: string[]
  response_hashes: string[]
  trace_hashes: string[]
  campaign_ids: Uint64String[]
  consent_policy_hashes: string[]
  consent_receipt_hashes: string[]
  oracle_evidence_hashes?: string[]
  verifier_spec_hashes?: string[]
  reward_policy?: {
    authority: 'svcmarket-oracle'
    sealed_verifiers_only: true
    requires_outcome_signal: true
    requires_nonzero_service_check: true
  }
  retention_policy: {
    not_after_epoch_sec: number
    deletion_required_on_revocation: true
  }
  base_model_hash?: string
  tokenizer_hash?: string
  quality_policy: Record<string, unknown>
  privacy_policy: Record<string, unknown>
  training_metadata?: Record<string, unknown>
}

export interface QueryDatasetPack {
  examples: QueryDatasetExample[]
  dataset_jsonl: string
  dataset_hash: string
  manifest: QueryDatasetManifest
  manifest_json: string
  manifest_hash: string
  skipped: Record<string, number>
}

export interface QueryDatasetPackOptions {
  contributor?: string
  task?: string
  user?: string
  model_id?: Uint64String
  base_model_id?: Uint64String
  expert_role?: string
  fusion_parent_model_id?: Uint64String
  min_useful_bps?: number
  include_all?: boolean
  include_low_score?: boolean
  include_unscored?: boolean
  max_examples?: number
  as_of_epoch_sec?: number
  rlvr_only?: boolean
  base_model_hash?: string
  tokenizer_hash?: string
}

export interface RlvrVerifierSpec {
  id: string
  type: 'exact_text' | 'numeric_tolerance' | 'json_constraints' | 'token_sequence_similarity'
  oracle: string
  oracle_evidence_hash: string
  svc_check_id: Uint64String
  expected?: string | number
  tolerance?: number
  required?: Record<string, string | number | boolean | null>
}

export interface RlvrRecipe {
  format: 'harbor.ai.rlvr-recipe.v1'
  algorithm: 'grpo'
  base_model: string
  base_model_hash: string
  tokenizer_hash: string
  dataset_hash: string
  oracle_evidence_root: string
  seed: number
  group_size: number
  batch_size: number
  steps: number
  max_prompt_tokens: number
  max_completion_tokens: number
  clip_epsilon: number
  kl_coefficient: number
  learning_rate: number
  lora_layers: number
  verifiers: RlvrVerifierSpec[]
}

export function buildRlvrRecipe(input: Omit<RlvrRecipe, 'format' | 'algorithm' | 'oracle_evidence_root'>): {
  recipe: RlvrRecipe
  recipe_json: string
  recipe_hash: string
} {
  const hashes = {
    base_model_hash: hash256(input.base_model_hash),
    tokenizer_hash: hash256(input.tokenizer_hash),
    dataset_hash: hash256(input.dataset_hash),
  }
  if (!input.base_model || input.base_model.length > 256 || Object.values(hashes).some((value) => !value)) {
    throw new Error('RLVR base model and model/tokenizer/dataset hashes are required')
  }
  const boundedInteger = (value: number, label: string, minimum: number, maximum: number) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
    }
    return value
  }
  const boundedNumber = (value: number, label: string, minimum: number, maximum: number) => {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`${label} must be finite and between ${minimum} and ${maximum}`)
    }
    return value
  }
  const supported = new Set(['exact_text', 'numeric_tolerance', 'json_constraints', 'token_sequence_similarity'])
  if (!Array.isArray(input.verifiers) || input.verifiers.length === 0 || input.verifiers.length > 64) {
    throw new Error('RLVR recipe requires 1 to 64 sealed verifiers')
  }
  const verifiers = input.verifiers.map((candidate): RlvrVerifierSpec => {
    if (!candidate.id || candidate.id.length > 128 || !supported.has(candidate.type)) {
      throw new Error(`unsupported or invalid sealed verifier: ${candidate.type}`)
    }
    const evidenceHash = hash256(candidate.oracle_evidence_hash)
    if (!candidate.oracle || candidate.oracle.length > 13 || !evidenceHash) {
      throw new Error('sealed verifier lacks its oracle evidence')
    }
    const svcCheckId = positiveUint64(candidate.svc_check_id, 'verifier service check id')
    if (candidate.type === 'exact_text' || candidate.type === 'token_sequence_similarity') {
      if (typeof candidate.expected !== 'string' || !candidate.expected || candidate.expected.length > 4096) {
        throw new Error(`${candidate.type} requires bounded expected text`)
      }
    } else if (candidate.type === 'numeric_tolerance') {
      if (typeof candidate.expected !== 'number' || !Number.isFinite(candidate.expected) ||
          Math.abs(candidate.expected) > 1e100 ||
          typeof candidate.tolerance !== 'number' || !Number.isFinite(candidate.tolerance) ||
          candidate.tolerance < 0 || candidate.tolerance > 1e100) {
        throw new Error('numeric_tolerance requires bounded finite expected and tolerance values')
      }
    } else if (!isPlainObject(candidate.required) || Object.keys(candidate.required).length === 0 ||
               Object.keys(candidate.required).length > 32 ||
               Object.keys(candidate.required).some((key) => !key || key.length > 128) ||
               Object.values(candidate.required).some((value) => typeof value === 'object' && value !== null)) {
      throw new Error('json_constraints requires 1 to 32 scalar fields')
    }
    return {...candidate, oracle_evidence_hash: evidenceHash, svc_check_id: svcCheckId}
  })
  if (new Set(verifiers.map((verifier) => verifier.id)).size !== verifiers.length) {
    throw new Error('sealed verifier ids must be unique')
  }
  const oracleEvidenceRoot = sha256Bytes(Buffer.from(canonicalJson(
    [...verifiers.map((verifier) => verifier.oracle_evidence_hash)].sort(),
  )))
  const recipe: RlvrRecipe = {
    format: 'harbor.ai.rlvr-recipe.v1',
    algorithm: 'grpo',
    base_model: input.base_model,
    base_model_hash: hashes.base_model_hash as string,
    tokenizer_hash: hashes.tokenizer_hash as string,
    dataset_hash: hashes.dataset_hash as string,
    oracle_evidence_root: oracleEvidenceRoot,
    seed: boundedInteger(input.seed, 'seed', 0, 0xffffffff),
    group_size: boundedInteger(input.group_size, 'group size', 2, 64),
    batch_size: boundedInteger(input.batch_size, 'batch size', 1, 4),
    steps: boundedInteger(input.steps, 'steps', 1, 1024),
    max_prompt_tokens: boundedInteger(input.max_prompt_tokens, 'max prompt tokens', 1, 2048),
    max_completion_tokens: boundedInteger(input.max_completion_tokens, 'max completion tokens', 1, 512),
    clip_epsilon: boundedNumber(input.clip_epsilon, 'clip epsilon', 0.01, 0.5),
    kl_coefficient: boundedNumber(input.kl_coefficient, 'KL coefficient', 0, 1),
    learning_rate: boundedNumber(input.learning_rate, 'learning rate', 1e-8, 1e-2),
    lora_layers: boundedInteger(input.lora_layers, 'LoRA layers', 1, 64),
    verifiers,
  }
  const recipeJson = canonicalJson(recipe)
  return {recipe, recipe_json: recipeJson, recipe_hash: sha256Bytes(Buffer.from(recipeJson))}
}

export const AI_DATA_SCOPE_TRAINING = 1
export const AI_DATA_SCOPE_PROMPT = 2
export const AI_DATA_SCOPE_RESPONSE = 4
export const AI_DATA_SCOPE_FEEDBACK = 16
export const AI_DATA_REQUIRED_SCOPES = AI_DATA_SCOPE_TRAINING | AI_DATA_SCOPE_PROMPT | AI_DATA_SCOPE_RESPONSE
export const AI_DATA_RLVR_REQUIRED_SCOPES = AI_DATA_REQUIRED_SCOPES | AI_DATA_SCOPE_FEEDBACK

export interface AiDataConsentReceipt {
  campaign_id: Uint64String
  program_id: Uint64String
  consent_version: number
  scope_bits: number
  policy_hash: string
  receipt_hash: string
  expires_at: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item))
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)])
    )
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value))}\n`
}

function jsonLineHash(value: unknown): string {
  return sha256Bytes(Buffer.from(canonicalJson(value)))
}

function unknownRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function unknownRecordNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = Number(record[key])
  return Number.isFinite(value) ? value : undefined
}

function optionalUint64(value: unknown, label: string): Uint64String | undefined {
  try {
    return canonicalUint64(value, label)
  } catch {
    return undefined
  }
}

function positiveUint64(value: unknown, label: string): Uint64String {
  const canonical = canonicalUint64(value, label)
  if (canonical === '0') {
    throw new Error(`${label} must be greater than zero`)
  }
  return canonical
}

function optionalPositiveUint64(value: unknown, label: string): Uint64String | undefined {
  const canonical = optionalUint64(value, label)
  return canonical && canonical !== '0' ? canonical : undefined
}

function compareUint64(left: unknown, right: unknown, label = 'uint64'): number {
  const lhs = BigInt(canonicalUint64(left, label))
  const rhs = BigInt(canonicalUint64(right, label))
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0
}

function unknownRecordBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  if (typeof value === 'boolean') {
    return value
  }
  if (value === 'true' || value === '1') {
    return true
  }
  if (value === 'false' || value === '0') {
    return false
  }
  return undefined
}

function nestedString(record: Record<string, unknown>, parent: string, key: string): string | undefined {
  const value = record[parent]
  if (!isPlainObject(value)) {
    return undefined
  }
  return unknownRecordString(value, key)
}

function nestedNumber(record: Record<string, unknown>, parent: string, key: string): number | undefined {
  const value = record[parent]
  if (!isPlainObject(value)) {
    return undefined
  }
  return unknownRecordNumber(value, key)
}

function extractText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (isPlainObject(parsed)) {
        for (const key of ['text', 'completion', 'content', 'generated_text', 'response', 'output']) {
          const child = extractText(parsed[key])
          if (child) {
            return child
          }
        }
      }
    } catch {
      return value
    }
  }
  return value
}

function firstText(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = extractText(record[key])
    if (value) {
      return value
    }
  }
  return undefined
}

function traceModelId(record: Record<string, unknown>): Uint64String | undefined {
  for (const key of ['fusion_model_id', 'model_id', 'selected_model_id']) {
    const value = optionalPositiveUint64(record[key], `trace ${key}`)
    if (value) {
      return value
    }
  }
  return undefined
}

function traceUsefulScore(record: Record<string, unknown>): number | undefined {
  for (const key of ['feedback_score_bps', 'router_confidence_bps', 'confidence_bps']) {
    const value = unknownRecordNumber(record, key)
    if (value !== undefined && value > 0) {
      return value
    }
  }
  for (const key of ['score_bps', 'trust_score_bps', 'useful_bps']) {
    const value = nestedNumber(record, 'trusted_ai', key)
    if (value !== undefined && value > 0) {
      return value
    }
  }
  return undefined
}

function incrementSkipped(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function epochSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined
  }
  return undefined
}

function hash256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : undefined
}

function consentScopeBits(receipt: Record<string, unknown>): number {
  const numeric = Number(receipt.scope_bits ?? receipt.scopes)
  if (Number.isSafeInteger(numeric) && numeric >= 0) {
    return numeric
  }
  const scopes = receipt.scopes
  if (!Array.isArray(scopes)) {
    return 0
  }
  return scopes.reduce((bits, scope) => {
    if (scope === 'training') {
      return bits | AI_DATA_SCOPE_TRAINING
    }
    if (scope === 'prompt') {
      return bits | AI_DATA_SCOPE_PROMPT
    }
    if (scope === 'response') {
      return bits | AI_DATA_SCOPE_RESPONSE
    }
    return bits
  }, 0)
}

export function parseActiveDataConsent(
  record: Record<string, unknown>,
  asOfEpochSec = Math.floor(Date.now() / 1000),
): AiDataConsentReceipt | undefined {
  const candidate = record.consent_receipt ?? record.data_consent
  if (!isPlainObject(candidate)) {
    return undefined
  }
  const status = unknownRecordString(candidate, 'status')
  if (unknownRecordBoolean(candidate, 'active') !== true || (status && status !== 'active')) {
    return undefined
  }
  if (candidate.revoked_at && epochSeconds(candidate.revoked_at)) {
    return undefined
  }
  const campaignId = optionalPositiveUint64(candidate.campaign_id, 'consent campaign id')
  const programId = optionalPositiveUint64(candidate.program_id, 'consent program id')
  const consentVersion = positiveInteger(candidate.consent_version ?? candidate.version)
  const policyHash = hash256(candidate.policy_hash)
  const receiptHash = hash256(candidate.receipt_hash)
  const expiresAt = epochSeconds(candidate.expires_at)
  const scopeBits = consentScopeBits(candidate)
  if (!campaignId || !programId || !consentVersion || !policyHash || !receiptHash || !expiresAt) {
    return undefined
  }
  if (expiresAt <= asOfEpochSec) {
    return undefined
  }
  if ((scopeBits & AI_DATA_REQUIRED_SCOPES) !== AI_DATA_REQUIRED_SCOPES) {
    return undefined
  }
  return {
    campaign_id: campaignId,
    program_id: programId,
    consent_version: consentVersion,
    scope_bits: scopeBits,
    policy_hash: policyHash,
    receipt_hash: receiptHash,
    expires_at: expiresAt,
  }
}

function passedPrivacyReview(record: Record<string, unknown>): boolean {
  const review = record.privacy_review ?? record.privacy
  if (!isPlainObject(review)) {
    return false
  }
  const status = unknownRecordString(review, 'status')
  const filtered = unknownRecordBoolean(review, 'pii_filtered')
  const reportHash = hash256(review.report_hash ?? review.redaction_hash)
  return (status === 'passed' || filtered === true) && Boolean(reportHash)
}

function privacyReviewHash(record: Record<string, unknown>): string | undefined {
  const review = record.privacy_review ?? record.privacy
  return isPlainObject(review) ? hash256(review.report_hash ?? review.redaction_hash) : undefined
}

interface AcceptedOutcomeEvidence {
  payload_hash: string
  evidence_hash: string
  verifier_spec_hash: string
  oracle: string
  svc_check_id: Uint64String
  verifier_id: string
}

function acceptedOutcomeEvidence(record: Record<string, unknown>): AcceptedOutcomeEvidence | undefined | null {
  const candidate = record.outcome_feedback ??
    (isPlainObject(record.signal) ? record.signal.outcome_feedback ?? record.signal.outcome : undefined)
  if (candidate === undefined) {
    return undefined
  }
  if (!isPlainObject(candidate)) {
    return null
  }
  const source = unknownRecordString(candidate, 'source')
  const status = unknownRecordString(candidate, 'status')
  const schema = unknownRecordString(candidate, 'schema')
  const payloadHash = hash256(candidate.payload_hash)
  const evidenceHash = hash256(candidate.evidence_hash)
  const verifierSpecHash = hash256(candidate.verifier_spec_hash)
  const oracle = unknownRecordString(candidate, 'oracle')
  const svcCheckId = optionalPositiveUint64(candidate.svc_check_id, 'outcome service check id')
  const verifierId = unknownRecordString(candidate, 'verifier_id') ?? verifierSpecHash
  if (schema !== 'harbor.ai.outcome.v1' || source !== 'svcmarket-oracle' || status !== 'accepted' || !payloadHash ||
      !evidenceHash || !verifierSpecHash || !oracle || !svcCheckId ||
      !verifierId || verifierId.length > 128) {
    return null
  }
  return {
    payload_hash: payloadHash,
    evidence_hash: evidenceHash,
    verifier_spec_hash: verifierSpecHash,
    oracle,
    svc_check_id: svcCheckId,
    verifier_id: verifierId,
  }
}

function traceMatchesPackFilters(record: Record<string, unknown>, options: QueryDatasetPackOptions, skipped: Record<string, number>): boolean {
  if (!options.include_all && unknownRecordBoolean(record, 'training_candidate') !== true) {
    incrementSkipped(skipped, 'not_training_candidate')
    return false
  }
  if (options.task && unknownRecordString(record, 'task') !== options.task) {
    incrementSkipped(skipped, 'task_mismatch')
    return false
  }
  if (options.user && unknownRecordString(record, 'user') !== options.user) {
    incrementSkipped(skipped, 'user_mismatch')
    return false
  }
  if (options.model_id && traceModelId(record) !== options.model_id) {
    incrementSkipped(skipped, 'model_mismatch')
    return false
  }
  return true
}

export function buildQueryDatasetFromTraces(lines: string[], options: QueryDatasetPackOptions = {}): QueryDatasetPack {
  const modelId = options.model_id === undefined
    ? undefined
    : canonicalUint64(options.model_id, 'query dataset model id')
  const baseModelId = options.base_model_id === undefined
    ? undefined
    : canonicalUint64(options.base_model_id, 'query dataset base model id')
  const fusionParentModelId = options.fusion_parent_model_id === undefined
    ? undefined
    : canonicalUint64(options.fusion_parent_model_id, 'query dataset fusion parent model id')
  const normalizedOptions = {...options, model_id: modelId}
  const baseModelHash = hash256(options.base_model_hash)
  const tokenizerHash = hash256(options.tokenizer_hash)
  if (options.rlvr_only && (!baseModelHash || !tokenizerHash)) {
    throw new Error('RLVR dataset packing requires immutable base model and tokenizer hashes')
  }
  const minUsefulBps = Number(options.min_useful_bps ?? 8500)
  const maxExamples = Number(options.max_examples ?? 0)
  const asOfEpochSec = Number(options.as_of_epoch_sec ?? Math.floor(Date.now() / 1000))
  const examples: QueryDatasetExample[] = []
  const skipped: Record<string, number> = {}
  const promptHashes: string[] = []
  const responseHashes: string[] = []
  const traceHashes: string[] = []
  const exampleHashes: string[] = []
  const campaignIds: Uint64String[] = []
  const consentPolicyHashes: string[] = []
  const consentReceiptHashes: string[] = []
  const oracleEvidenceHashes: string[] = []
  const verifierSpecHashes: string[] = []
  const consentExpirations: number[] = []
  const seenExamples = new Set<string>()

  for (const line of lines) {
    if (maxExamples > 0 && examples.length >= maxExamples) {
      incrementSkipped(skipped, 'max_examples')
      continue
    }
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    let record: Record<string, unknown>
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (!isPlainObject(parsed)) {
        incrementSkipped(skipped, 'not_object')
        continue
      }
      record = parsed
    } catch {
      incrementSkipped(skipped, 'invalid_json')
      continue
    }
    if (!traceMatchesPackFilters(record, normalizedOptions, skipped)) {
      continue
    }

    const consent = parseActiveDataConsent(record, asOfEpochSec)
    if (!consent) {
      incrementSkipped(skipped, 'missing_or_inactive_consent')
      continue
    }
    const outcome = acceptedOutcomeEvidence(record)
    if (outcome === null) {
      incrementSkipped(skipped, 'invalid_or_unaccepted_oracle_outcome')
      continue
    }
    if (options.rlvr_only && !outcome) {
      incrementSkipped(skipped, 'accepted_oracle_outcome_required')
      continue
    }
    if (!options.rlvr_only && outcome) {
      incrementSkipped(skipped, 'explicit_rlvr_mode_required')
      continue
    }
    if (outcome &&
        (consent.scope_bits & AI_DATA_RLVR_REQUIRED_SCOPES) !== AI_DATA_RLVR_REQUIRED_SCOPES) {
      incrementSkipped(skipped, 'outcome_feedback_consent_required')
      continue
    }
    if (!passedPrivacyReview(record)) {
      incrementSkipped(skipped, 'privacy_review_required')
      continue
    }

    const prompt = unknownRecordString(record, 'prompt')
    if (!prompt) {
      incrementSkipped(skipped, 'missing_prompt')
      continue
    }

    const corrected = firstText(record, ['corrected_output', 'expected_output'])
    const accepted = firstText(record, ['accepted_output'])
    const capturedOutput = firstText(record, ['completion', 'output_text', 'output'])
    const completion = corrected ?? accepted ?? capturedOutput
    if (!completion) {
      incrementSkipped(skipped, 'missing_completion')
      continue
    }

    const supervised = Boolean(corrected || accepted)
    const score = traceUsefulScore(record)
    if (!supervised && !options.include_low_score) {
      if (score === undefined && !options.include_unscored) {
        incrementSkipped(skipped, 'unscored_output')
        continue
      }
      if (score !== undefined && score < minUsefulBps) {
        incrementSkipped(skipped, 'low_score_output')
        continue
      }
    }

    const promptHash = hash256(record.prompt_hash) ?? sha256Bytes(Buffer.from(prompt))
    const traceHash = sha256Bytes(Buffer.from(trimmed))
    const metadata: Record<string, unknown> = {
      source: 'harbor-ai-query-traces',
      source_trace_hash: traceHash,
      trace_kind: unknownRecordString(record, 'kind'),
      request_hash: unknownRecordString(record, 'request_hash') ?? promptHash,
      prompt_hash: promptHash,
      model_id: traceModelId(record),
      task: unknownRecordString(record, 'task'),
      router_confidence_bps: unknownRecordNumber(record, 'router_confidence_bps'),
      expert_disagreement_bps: unknownRecordNumber(record, 'expert_disagreement_bps'),
      trusted_ai_score_bps: nestedNumber(record, 'trusted_ai', 'score_bps'),
      feedback_score_bps: unknownRecordNumber(record, 'feedback_score_bps'),
      target_source: corrected ? 'correction' : accepted ? 'accepted_output' : 'captured_output',
      campaign_id: consent.campaign_id,
      program_id: consent.program_id,
      consent_version: consent.consent_version,
      consent_scope_bits: consent.scope_bits,
      consent_policy_hash: consent.policy_hash,
      consent_receipt_hash: consent.receipt_hash,
      consent_expires_at: consent.expires_at,
      privacy_review_hash: privacyReviewHash(record),
      outcome_payload_hash: outcome?.payload_hash,
      outcome_evidence_hash: outcome?.evidence_hash,
      verifier_spec_hash: outcome?.verifier_spec_hash,
      oracle: outcome?.oracle,
      svc_check_id: outcome?.svc_check_id,
      verifier_id: outcome?.verifier_id,
    }
    const rejected = corrected ? firstText(record, ['rejected_output', 'output']) : firstText(record, ['rejected_output'])
    const example: QueryDatasetExample = {
      messages: [
        {role: 'user', content: prompt},
        {role: 'assistant', content: completion},
      ],
      metadata,
      rejected_completion: rejected && rejected !== completion ? rejected : undefined,
    }
    const dedupeHash = jsonLineHash({messages: example.messages, rejected_completion: example.rejected_completion})
    if (seenExamples.has(dedupeHash)) {
      incrementSkipped(skipped, 'duplicate_example')
      continue
    }
    seenExamples.add(dedupeHash)
    const exampleHash = jsonLineHash(example)
    examples.push(example)
    promptHashes.push(promptHash)
    responseHashes.push(sha256Bytes(Buffer.from(completion)))
    traceHashes.push(traceHash)
    exampleHashes.push(exampleHash)
    campaignIds.push(consent.campaign_id)
    consentPolicyHashes.push(consent.policy_hash)
    consentReceiptHashes.push(consent.receipt_hash)
    consentExpirations.push(consent.expires_at)
    if (outcome) {
      oracleEvidenceHashes.push(outcome.evidence_hash)
      verifierSpecHashes.push(outcome.verifier_spec_hash)
    }
  }

  const datasetJsonl = examples.map((example) => canonicalJson(example)).join('')
  const datasetHash = sha256Bytes(Buffer.from(datasetJsonl))
  const trainingMetadata = options.expert_role ? {
    training_kind: 'expert',
    expert_role: options.expert_role,
    fusion_parent_model_id: fusionParentModelId ?? baseModelId,
  } : undefined
  const manifest: QueryDatasetManifest = {
    format: 'harbor.ai.query-dataset.v2',
    dataset_format: 'chat_messages_jsonl',
    dataset_hash: datasetHash,
    source: 'harbor-ai-query-traces',
    contributor: options.contributor,
    base_model_id: baseModelId,
    model_id: modelId,
    expert_role: options.expert_role,
    fusion_parent_model_id: fusionParentModelId,
    task: options.task,
    example_count: examples.length,
    example_hashes: exampleHashes,
    prompt_hashes: [...new Set(promptHashes)],
    response_hashes: [...new Set(responseHashes)],
    trace_hashes: traceHashes,
    campaign_ids: [...new Set(campaignIds)].sort((left, right) => compareUint64(left, right, 'campaign id')),
    consent_policy_hashes: [...new Set(consentPolicyHashes)].sort(),
    consent_receipt_hashes: [...new Set(consentReceiptHashes)].sort(),
    oracle_evidence_hashes: [...new Set(oracleEvidenceHashes)].sort(),
    verifier_spec_hashes: [...new Set(verifierSpecHashes)].sort(),
    reward_policy: oracleEvidenceHashes.length > 0 ? {
      authority: 'svcmarket-oracle',
      sealed_verifiers_only: true,
      requires_outcome_signal: true,
      requires_nonzero_service_check: true,
    } : undefined,
    retention_policy: {
      not_after_epoch_sec: consentExpirations.length > 0
        ? Math.min(...consentExpirations)
        : asOfEpochSec,
      deletion_required_on_revocation: true,
    },
    base_model_hash: baseModelHash,
    tokenizer_hash: tokenizerHash,
    quality_policy: {
      require_training_candidate: !options.include_all,
      min_useful_bps: minUsefulBps,
      include_low_score: Boolean(options.include_low_score),
      include_unscored: Boolean(options.include_unscored),
      supervised_targets_always_allowed: true,
    },
    privacy_policy: {
      requires_active_versioned_consent: true,
      required_scopes: oracleEvidenceHashes.length > 0
        ? ['training', 'prompt', 'response', 'feedback']
        : ['training', 'prompt', 'response'],
      requires_pii_review: true,
      excludes_direct_user_identifiers_from_manifest: true,
      requires_privacy_reviewed_prompt: true,
      stores_raw_prompts: true,
      stores_raw_completions: true,
      encrypted_at_rest_required: true,
      prospective_revocation: true,
      source_traces_remain_edge_local: true,
    },
    training_metadata: trainingMetadata,
  }
  const manifestJson = canonicalJson(manifest)
  return {
    examples,
    dataset_jsonl: datasetJsonl,
    dataset_hash: datasetHash,
    manifest,
    manifest_json: manifestJson,
    manifest_hash: sha256Bytes(Buffer.from(manifestJson)),
    skipped,
  }
}

function parseObjectJson(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (!isPlainObject(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed
}

function parseLogitMode(value: string | undefined): FusionLogitMode {
  const mode = value ?? 'none'
  if (mode !== 'none' && mode !== 'top_k' && mode !== 'full') {
    throw new Error(`invalid logit mode: ${mode}; expected none, top_k, or full`)
  }
  return mode
}

export function parseFusionExpertSpec(value: string): FusionExpertSpec {
  const [modelRaw, roleRaw, weightRaw] = value.split(':')
  const modelId = positiveUint64(modelRaw, `fusion expert model id in ${value}`)
  const weight = Number(weightRaw ?? 1)
  const role = roleRaw && roleRaw.trim() !== '' ? roleRaw.trim() : 'auto'
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error(`invalid fusion expert weight in ${value}`)
  }
  return {model_id: modelId, role, weight}
}

export function buildFusionManifest(input: FusionManifestInput): FusionManifest {
  const baseModelId = positiveUint64(input.base_model_id, 'base_model_id')
  const autoExpertCount = Number(input.auto_expert_count ?? 0)
  if (!Number.isInteger(autoExpertCount) || autoExpertCount < 0) {
    throw new Error('auto_expert_count must be a non-negative integer')
  }
  if (input.experts.length === 0 && autoExpertCount === 0) {
    throw new Error('at least one fusion expert or --auto-experts count is required')
  }
  const seen = new Set<Uint64String>()
  const experts = input.experts.map((expert) => {
    const modelId = positiveUint64(expert.model_id, 'fusion expert model id')
    if (seen.has(modelId)) {
      throw new Error(`duplicate fusion expert model id: ${modelId}`)
    }
    seen.add(modelId)
    return {...expert, model_id: modelId}
  })
  const logitMode = input.logit_mode ?? 'none'
  const topK = Number(input.logit_top_k ?? 0)
  if (!Number.isInteger(topK) || topK < 0) {
    throw new Error('logit_top_k must be a non-negative integer')
  }
  const selectionPolicy = input.selection_policy ?? (
    autoExpertCount > 0
      ? {
        type: 'capability_profile',
        auto_discover_roles: true,
        max_experts: autoExpertCount,
      }
      : {
        type: 'top_weight',
        max_experts: input.experts.length,
      }
  )
  const manifest: FusionManifest = {
    format: 'harbor.fusion.v1',
    base_model_id: baseModelId,
    expert_model_ids: experts.map((expert) => expert.model_id),
    expert_roles: experts.map((expert) => expert.role),
    expert_weights: experts.map((expert) => expert.weight),
    fusion_strategy: 'routed_expert',
    logit_mode: logitMode,
    logit_top_k: topK,
    selection_policy: selectionPolicy,
    eval_artifact_id: canonicalUint64(input.eval_artifact_id ?? '0', 'eval artifact id'),
  }
  if (autoExpertCount > 0) {
    manifest.auto_expert_count = autoExpertCount
  }
  return manifest
}

export function buildFusionRegisterPlan(input: {
  manifest: FusionManifest
  manifestMetadata?: Record<string, unknown>
  owner: string
  title: string
  storageObjectId?: number | string
  contentHash?: string
  weightsArtifactId?: number | string
  aiContract?: string
  modelMetadata?: Record<string, unknown>
}): FusionRegisterPlan {
  const aiContract = input.aiContract ?? AI_CONTRACT
  if (input.manifest.expert_model_ids.length !== input.manifest.expert_roles.length ||
      input.manifest.expert_model_ids.length !== input.manifest.expert_weights.length) {
    throw new Error('fusion manifest expert arrays must have equal lengths')
  }
  const manifest = buildFusionManifest({
    base_model_id: input.manifest.base_model_id,
    experts: input.manifest.expert_model_ids.map((modelId, index) => ({
      model_id: modelId,
      role: input.manifest.expert_roles[index],
      weight: input.manifest.expert_weights[index],
    })),
    logit_mode: input.manifest.logit_mode,
    logit_top_k: input.manifest.logit_top_k,
    selection_policy: input.manifest.selection_policy,
    eval_artifact_id: input.manifest.eval_artifact_id,
    auto_expert_count: input.manifest.auto_expert_count,
  })
  const manifestJson = canonicalJson(manifest)
  const manifestHash = sha256Bytes(Buffer.from(manifestJson))
  const storageObjectId = input.storageObjectId === undefined
    ? '<storage_object_id>'
    : canonicalUint64(input.storageObjectId, 'fusion manifest storage object id')
  const contentHash = input.contentHash ?? manifestHash
  const weightsArtifactId = input.weightsArtifactId === undefined
    ? '<weights_artifact_id>'
    : canonicalUint64(input.weightsArtifactId, 'fusion weights artifact id')
  const artifactMetadata = {
    format: 'harbor.fusion.v1',
    kind: 'fusion_manifest',
    manifest_hash: manifestHash,
    base_model_id: manifest.base_model_id,
    expert_model_ids: manifest.expert_model_ids,
    auto_expert_count: manifest.auto_expert_count,
    logit_mode: manifest.logit_mode,
    ...input.manifestMetadata,
  }
  const modelMetadata = {
    format: 'harbor.fusion.v1',
    source: 'harbor-ai-fusion-register',
    fusion_strategy: manifest.fusion_strategy,
    fusion_manifest_hash: manifestHash,
    fusion_manifest_artifact_id: weightsArtifactId,
    base_model_id: manifest.base_model_id,
    expert_model_ids: manifest.expert_model_ids,
    expert_roles: manifest.expert_roles,
    expert_weights: manifest.expert_weights,
    auto_expert_count: manifest.auto_expert_count,
    logit_mode: manifest.logit_mode,
    logit_top_k: manifest.logit_top_k,
    selection_policy: manifest.selection_policy,
    ...input.modelMetadata,
  }
  return {
    manifest,
    manifest_json: manifestJson,
    manifest_hash: manifestHash,
    artifact_metadata: artifactMetadata,
    model_metadata: modelMetadata,
    actions: [
      {
        contract: aiContract,
        action: 'addartifact',
        data: {
          owner: input.owner,
          kind: 1,
          storage_object_id: storageObjectId,
          content_hash: contentHash,
          metadata: JSON.stringify(artifactMetadata),
        },
      },
      {
        contract: aiContract,
        action: 'regmodel',
        data: {
          owner: input.owner,
          model_type: 2,
          parent_model_id: manifest.base_model_id,
          weights_artifact_id: weightsArtifactId,
          eval_artifact_id: manifest.eval_artifact_id,
          title: input.title,
          metadata: JSON.stringify(modelMetadata),
        },
      },
    ],
  }
}

export function buildDistributedExpertPlan(input: DistributedExpertPlanInput): DistributedExpertPlan {
  const baseModelId = positiveUint64(input.base_model_id, 'base_model_id')
  const datasetArtifactId = canonicalUint64(input.dataset_artifact_id ?? '0', 'dataset artifact id')
  if (!input.expert_role.trim()) {
    throw new Error('expert_role is required')
  }
  if (!Number.isInteger(input.shard_count) || input.shard_count <= 0) {
    throw new Error('shard_count must be a positive integer')
  }
  const participants = input.participants ?? []
  if (participants.length > 0 && participants.length !== input.shard_count) {
    throw new Error('participant count must match shard_count')
  }
  const aggregationSeed = {
    base_model_id: baseModelId,
    dataset_artifact_id: datasetArtifactId,
    expert_role: input.expert_role,
    model: input.model ?? '',
    shard_count: input.shard_count,
  }
  const aggregationGroupId = input.aggregation_group_id ??
    sha256Bytes(Buffer.from(canonicalJson(aggregationSeed))).slice(0, 16)
  const shards: DistributedExpertShard[] = Array.from({length: input.shard_count}, (_, shardIndex) => {
    const metadata = {
      ...(input.metadata ?? {}),
      training_kind: 'expert',
      distributed_training: true,
      aggregation_group_id: aggregationGroupId,
      expert_role: input.expert_role,
      fusion_parent_model_id: baseModelId,
      base_model_id: baseModelId,
      dataset_artifact_id: datasetArtifactId,
      model: input.model,
      shard_index: shardIndex,
      shard_count: input.shard_count,
    }
    return {
      shard_index: shardIndex,
      shard_count: input.shard_count,
      participant: participants[shardIndex],
      metadata,
    }
  })
  return {
    format: 'harbor.distributed_expert_plan.v1',
    base_model_id: baseModelId,
    expert_role: input.expert_role,
    shard_count: input.shard_count,
    aggregation_group_id: aggregationGroupId,
    shards,
  }
}

export function parseDistributedShardSpec(value: string): DistributedShardArtifactSpec {
  const [indexRaw, hashRaw, weightRaw, artifactRaw, trainerRaw] = value.split(':')
  const shardIndex = Number(indexRaw)
  if (!Number.isInteger(shardIndex) || shardIndex < 0) {
    throw new Error(`invalid shard index in ${value}`)
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hashRaw ?? '')) {
    throw new Error(`invalid shard weights hash in ${value}`)
  }
  const weight = Number(weightRaw ?? 1)
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error(`invalid shard weight in ${value}`)
  }
  const artifactId = artifactRaw && artifactRaw.trim() !== ''
    ? positiveUint64(artifactRaw, `shard artifact id in ${value}`)
    : undefined
  return {
    shard_index: shardIndex,
    weights_hash: hashRaw.toLowerCase(),
    weight,
    artifact_id: artifactId,
    trainer: trainerRaw && trainerRaw.trim() !== '' ? trainerRaw : undefined,
  }
}

export function buildDistributedAggregateManifest(input: {
  base_model_id: Uint64String
  expert_role: string
  aggregation_group_id: string
  shard_artifacts: DistributedShardArtifactSpec[]
}): DistributedAggregateManifest {
  const baseModelId = positiveUint64(input.base_model_id, 'base_model_id')
  if (!input.expert_role.trim()) {
    throw new Error('expert_role is required')
  }
  if (!input.aggregation_group_id.trim()) {
    throw new Error('aggregation_group_id is required')
  }
  if (input.shard_artifacts.length < 2) {
    throw new Error('at least two shard artifacts are required')
  }
  const sorted = input.shard_artifacts
    .map((shard) => ({
      ...shard,
      artifact_id: shard.artifact_id === undefined
        ? undefined
        : positiveUint64(shard.artifact_id, 'distributed shard artifact id'),
    }))
    .sort((left, right) => left.shard_index - right.shard_index)
  const seen = new Set<number>()
  for (const shard of sorted) {
    if (seen.has(shard.shard_index)) {
      throw new Error(`duplicate shard index: ${shard.shard_index}`)
    }
    seen.add(shard.shard_index)
  }
  return {
    format: 'harbor.gemma.mlx.aggregate-manifest.v1',
    base_model_id: baseModelId,
    expert_role: input.expert_role,
    aggregation_group_id: input.aggregation_group_id,
    aggregation_strategy: 'weighted_lora_average',
    shard_artifacts: sorted,
  }
}

export function renderAegisConfig(options: AegisConfigOptions = {}): string {
  const reviewer = options.reviewer ?? 'local-small-judge'
  const command = options.command ?? 'fake-local'
  return `${JSON.stringify({
    models: [
      {
        id: reviewer,
        adapter: 'local',
        command,
        trustLevel: 'trusted',
      },
    ],
    trustedReviewer: reviewer,
    policy: {
      allowedPaths: ['HARBOR_AI_OUTPUT.md'],
      allowedOperations: ['write'],
      maxPatchBytes: 1_000_000,
      requireVerification: false,
    },
  }, null, 2)}\n`
}

export function aegisHarborCheckCommand(configPath: string, options: {aegisCommand?: string} = {}): string {
  const aegisCommand = options.aegisCommand?.trim() || process.env.HARBOR_AEGIS_COMMAND || 'aegis'
  return `${aegisCommand} harbor-check --config ${shellQuote(path.resolve(configPath))}`
}

function resolveAiService(kind: string): {id: number; name: string} {
  for (const [canonical, service] of Object.entries(AI_SERVICE_TYPES)) {
    if (canonical === kind) {
      return service
    }
    if (service.name === kind || service.aliases.includes(kind)) {
      return service
    }
  }
  const names = Object.values(AI_SERVICE_TYPES).map((service) => service.name).join(', ')
  throw new Error(`unknown AI service kind: ${kind}; expected one of ${names}`)
}

function positiveAsset(quantity: string): boolean {
  const [amount] = quantity.trim().split(/\s+/)
  return Number(amount) > 0
}

async function providerIsRegistered(marketContract: string, provider: string, options: OfferOptions): Promise<boolean> {
  const rows = await getTableRows<ProviderRow>(marketContract, 'providers', {
    url: options.url,
    lowerBound: provider,
    upperBound: provider,
    limit: 1,
  })
  return rows.rows.some((row) => row.owner === provider)
}

function parseMetadata(metadata?: string): Record<string, unknown> {
  if (!metadata) {
    return {}
  }
  try {
    const parsed = JSON.parse(metadata)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function metadataText(metadata: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim()
    }
  }
  return undefined
}

function metadataNumber(metadata: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Number(metadata[key])
    if (Number.isFinite(value)) {
      return value
    }
  }
  return undefined
}

function metadataBoolean(metadata: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === 'boolean') {
      return value
    }
  }
  return undefined
}

function metadataMatchesUser(metadata: Record<string, unknown>, user?: string): boolean {
  if (!user) {
    return true
  }
  for (const key of ['user', 'current_user', 'requester', 'account', 'owner']) {
    if (metadata[key] === user) {
      return true
    }
  }
  const users = metadata.users
  return Array.isArray(users) && users.includes(user)
}

function hasTrustedSignal(metadata: Record<string, unknown>): boolean {
  return metadata.trusted_ai_checked === true ||
    typeof metadata.trusted_ai_adapter === 'string' ||
    metadataNumber(metadata, ['trusted_ai_score_bps', 'trust_score_bps']) !== undefined ||
    metadataBoolean(metadata, ['trusted_ai_needs_tune']) !== undefined
}

function routeNeedsTune(route: RouteLogRow, metadata: Record<string, unknown>, confidenceThreshold: number): boolean {
  const confidence = Number(route.confidence_bps)
  if (Number.isFinite(confidence) && confidence > 0 && confidence < confidenceThreshold) {
    return true
  }
  const trustedScore = metadataNumber(metadata, ['trusted_ai_score_bps', 'trust_score_bps'])
  if (trustedScore !== undefined && trustedScore > 0 && trustedScore < confidenceThreshold) {
    return true
  }
  if (metadata.needs_tune === true || metadata.needs_finetune === true) {
    return true
  }
  const outcome = metadataText(metadata, ['outcome', 'status', 'reason'])
  return outcome ? ['fallback', 'miss', 'low_confidence', 'low-confidence', 'weak'].includes(outcome) : false
}

export function buildTuneNeeds(
  routes: RouteLogRow[],
  subcalls: SubcallRow[],
  options: {
    confidenceThreshold?: number
    minCount?: number
    proposer?: string
    datasetArtifactId?: string
    evalArtifactId?: string
    expiresSec?: string
    user?: string
    trustedOnly?: boolean
  } = {},
): TuneNeed[] {
  const confidenceThreshold = options.confidenceThreshold ?? 8500
  const minCount = options.minCount ?? 1
  const subcallsByInfer = new Map<Uint64String, number>()
  for (const subcall of subcalls) {
    const inferId = optionalPositiveUint64(subcall.parent_infer_id, 'subcall parent inference id')
    if (inferId) {
      subcallsByInfer.set(inferId, (subcallsByInfer.get(inferId) ?? 0) + 1)
    }
  }

  const groups = new Map<string, {
    base_model_id: Uint64String
    task: string
    route_count: number
    low_confidence_count: number
    subcall_count: number
    confidence_sum: number
    infer_ids: Set<Uint64String>
    request_hashes: Set<string>
    signals: Set<string>
  }>()

  for (const route of routes) {
    const metadata = parseMetadata(route.metadata)
    if (!metadataMatchesUser(metadata, options.user)) {
      continue
    }
    if (options.trustedOnly && !hasTrustedSignal(metadata)) {
      continue
    }
    if (!routeNeedsTune(route, metadata, confidenceThreshold)) {
      continue
    }
    const baseModelId = optionalPositiveUint64(route.selected_model_id, 'route selected model id')
    if (!baseModelId) {
      continue
    }
    const task = metadataText(metadata, ['task', 'goal', 'domain', 'intent', 'choice']) ?? `model-${baseModelId}`
    const key = `${baseModelId}:${task}`
    const confidence = Number(route.confidence_bps)
    const inferId = optionalPositiveUint64(route.infer_id ?? '0', 'route inference id')
    const group = groups.get(key) ?? {
      base_model_id: baseModelId,
      task,
      route_count: 0,
      low_confidence_count: 0,
      subcall_count: 0,
      confidence_sum: 0,
      infer_ids: new Set<Uint64String>(),
      request_hashes: new Set<string>(),
      signals: new Set<string>(),
    }
    group.route_count += 1
    if (Number.isFinite(confidence)) {
      group.confidence_sum += confidence
      if (confidence < confidenceThreshold) {
        group.low_confidence_count += 1
      }
    }
    if (inferId) {
      group.infer_ids.add(inferId)
      group.subcall_count += subcallsByInfer.get(inferId) ?? 0
    }
    if (route.request_hash) {
      group.request_hashes.add(route.request_hash)
    }
    const signal = metadataText(metadata, ['outcome', 'status', 'reason'])
    if (signal) {
      group.signals.add(signal)
    }
    groups.set(key, group)
  }

  return [...groups.values()]
    .filter((group) => group.route_count >= minCount)
    .sort((a, b) => b.route_count - a.route_count || b.subcall_count - a.subcall_count ||
      compareUint64(a.base_model_id, b.base_model_id, 'base model id'))
    .map((group) => {
      const title = `Fine-tune ${group.task}`
      const metadata = {
        source: 'harbor-ai-tune-needs',
        task: group.task,
        signals: [...group.signals],
        route_count: group.route_count,
        low_confidence_count: group.low_confidence_count,
        subcall_count: group.subcall_count,
        trusted_signal_count: options.trustedOnly ? group.route_count : undefined,
      }
      const proposer = options.proposer ?? '<proposer>'
      const dataset = options.datasetArtifactId === undefined
        ? '<dataset_artifact_id>'
        : canonicalUint64(options.datasetArtifactId, 'tune dataset artifact id')
      const evalArtifact = canonicalUint64(options.evalArtifactId ?? '0', 'tune eval artifact id')
      const expires = options.expiresSec ?? '604800'
      return {
        base_model_id: group.base_model_id,
        title,
        route_count: group.route_count,
        low_confidence_count: group.low_confidence_count,
        subcall_count: group.subcall_count,
        avg_confidence_bps: Math.round(group.confidence_sum / group.route_count),
        infer_ids: [...group.infer_ids],
        request_hashes: [...group.request_hashes],
        metadata,
        request_template: `harbor ai tune request ${proposer} ${group.base_model_id} ${dataset} ${evalArtifact} ${JSON.stringify(title)} '${JSON.stringify(metadata)}' ${expires}`,
      }
    })
}

function normalizeTask(value?: string): string {
  return (value ?? '').trim().toLowerCase()
}

function tuneTask(tune: TuneRequestRow): string | undefined {
  const metadata = parseMetadata(tune.metadata)
  return metadataText(metadata, ['task', 'goal', 'domain', 'intent', 'choice'])
}

function tuneMatchesNeed(tune: TuneRequestRow, need: TuneNeed): boolean {
  if (Number(tune.status) !== 0) {
    return false
  }
  if (canonicalUint64(tune.base_model_id, 'tune base model id') !== need.base_model_id) {
    return false
  }
  const needTask = normalizeTask(String(need.metadata.task ?? ''))
  if (!needTask) {
    return true
  }
  const proposalTask = normalizeTask(tuneTask(tune))
  if (proposalTask && proposalTask === needTask) {
    return true
  }
  return normalizeTask(tune.title).includes(needTask)
}

export function buildTuneAutoVotePlan(
  needs: TuneNeed[],
  tunes: TuneRequestRow[],
  options: {quantity: string},
): TuneAutoVotePlan[] {
  const plans: TuneAutoVotePlan[] = []
  const usedTuneIds = new Set<Uint64String>()
  for (const need of needs) {
    const tune = tunes.find((candidate) => {
      const tuneId = canonicalUint64(candidate.id, 'tune id')
      return !usedTuneIds.has(tuneId) && tuneMatchesNeed(candidate, need)
    })
    if (!tune) {
      continue
    }
    const tuneId = positiveUint64(tune.id, 'tune id')
    usedTuneIds.add(tuneId)
    plans.push({
      tune_id: tuneId,
      approve: true,
      quantity: options.quantity,
      reason: `matched ${need.route_count} tune-need route(s) for ${need.metadata.task ?? need.title}`,
      need,
      tune,
    })
  }
  return plans
}

function parseTrustedAiDecision(raw: string): TrustedAiDecision {
  const trimmed = raw.trim()
  if (!trimmed) {
    return {raw}
  }
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' ? {...parsed, raw: parsed} : {raw: parsed}
  } catch {
    return {raw}
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export async function runTrustedAiAdapter(input: unknown, options: TrustedAiAdapterOptions): Promise<TrustedAiDecision> {
  if (options.adapterUrl) {
    const response = await fetch(options.adapterUrl, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`trusted AI adapter returned ${response.status}: ${text}`)
    }
    return parseTrustedAiDecision(text)
  }
  if (options.adapterCommand) {
    const payloadPath = path.join(os.tmpdir(), `harbor-trusted-ai-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    await fs.writeFile(payloadPath, JSON.stringify(input))
    return new Promise((resolve, reject) => {
      const child = spawn(`${options.adapterCommand!} ${shellQuote(payloadPath)}`, {shell: true, stdio: ['ignore', 'pipe', 'pipe']})
      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        void fs.rm(payloadPath, {force: true})
        reject(new Error('trusted AI adapter timed out'))
      }, options.timeoutMs ?? 120_000)
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
      child.on('error', (error) => {
        clearTimeout(timeout)
        void fs.rm(payloadPath, {force: true})
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timeout)
        void fs.rm(payloadPath, {force: true})
        if (code !== 0) {
          reject(new Error(`trusted AI adapter exited ${code}: ${stderr || stdout}`))
          return
        }
        resolve(parseTrustedAiDecision(stdout))
      })
    })
  }
  return {}
}

function decisionScore(decision: TrustedAiDecision): number {
  for (const value of [decision.useful_bps, decision.score_bps, decision.trust_score_bps]) {
    const score = Number(value)
    if (Number.isFinite(score)) {
      return score
    }
  }
  return 0
}

function decisionApproves(decision: TrustedAiDecision, minUsefulBps: number): boolean {
  if (typeof decision.approve === 'boolean') {
    return decision.approve
  }
  if (typeof decision.useful === 'boolean') {
    return decision.useful
  }
  if (typeof decision.needs_tune === 'boolean') {
    return decision.needs_tune
  }
  const score = decisionScore(decision)
  return score === 0 || score >= minUsefulBps
}

async function existingTuneVote(contract: string, tuneId: Uint64String, voter: string, options: {url?: string}): Promise<boolean> {
  const rows = await getTableRows<{voter: string}>(contract, 'votes', {
    url: options.url,
    scope: canonicalUint64(tuneId, 'tune id'),
    lowerBound: voter,
    upperBound: voter,
    limit: 1,
  })
  return rows.rows.some((row) => row.voter === voter)
}

function addTuneNeedsCommand(tune: Command): void {
  tune
    .command('needs')
    .description('Analyze routing audit logs and suggest fine-tune requests')
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('-c, --contract <account>', 'Harbor AI contract account', AI_CONTRACT)
    .option('--confidence-bps <bps>', 'confidence below this threshold is a tune signal', '8500')
    .option('--min-count <count>', 'minimum matching route count', '1')
    .option('--limit <count>', 'maximum suggestions to print', '20')
    .option('--user <account>', 'only analyze route logs for this current user')
    .option('--trusted-only', 'only use route logs carrying trusted AI checker signals')
    .option('--proposer <account>', 'fill proposer in request templates')
    .option('--dataset-artifact-id <id>', 'fill dataset artifact id in request templates')
    .option('--eval-artifact-id <id>', 'fill eval artifact id in request templates', '0')
    .option('--expires-sec <seconds>', 'fill tune request expiry seconds', '604800')
    .option('--json', 'print JSON')
    .action(async (options: {
      url?: string
      contract?: string
      confidenceBps?: string
      minCount?: string
      limit?: string
      proposer?: string
      datasetArtifactId?: string
      evalArtifactId?: string
      expiresSec?: string
      user?: string
      trustedOnly?: boolean
      json?: boolean
    }) => {
      const contract = options.contract ?? AI_CONTRACT
      const [routes, subcalls] = await Promise.all([
        getTableRows<RouteLogRow>(contract, 'routelogs', {url: options.url, scope: contract, limit: 1000}),
        getTableRows<SubcallRow>(contract, 'subcalls', {url: options.url, scope: contract, limit: 1000}),
      ])
      const needs = buildTuneNeeds(routes.rows, subcalls.rows, {
        confidenceThreshold: Number(options.confidenceBps ?? 8500),
        minCount: Number(options.minCount ?? 1),
        proposer: options.proposer,
        datasetArtifactId: options.datasetArtifactId,
        evalArtifactId: options.evalArtifactId,
        expiresSec: options.expiresSec,
        user: options.user,
        trustedOnly: Boolean(options.trustedOnly),
      }).slice(0, Number(options.limit ?? 20))

      if (options.json) {
        console.log(JSON.stringify({needs}, null, 2))
        return
      }
      if (needs.length === 0) {
        console.log('No fine-tune needs found from current route logs.')
        return
      }
      console.table(needs.map((need) => ({
        base_model_id: need.base_model_id,
        title: need.title,
        routes: need.route_count,
        low_confidence: need.low_confidence_count,
        subcalls: need.subcall_count,
        avg_confidence_bps: need.avg_confidence_bps,
      })))
      for (const need of needs) {
        console.log(need.request_template)
      }
    })
}

function addTuneAutoVoteCommand(tune: Command): void {
  addTxOptions(
    tune
      .command('auto-vote')
      .description('Vote for open fine-tune proposals that match current-user trusted tune needs')
      .requiredOption('--voter <account>', 'account casting the fine-tune vote')
      .option('-c, --contract <account>', 'Harbor AI contract account', AI_CONTRACT)
      .option('--quantity <asset>', 'vote escrow quantity', process.env.HARBOR_AI_AUTO_VOTE_QUANTITY ?? '1.0000 SYS')
      .option('--confidence-bps <bps>', 'confidence below this threshold is a tune signal', '8500')
      .option('--min-count <count>', 'minimum matching route count', '1')
      .option('--limit <count>', 'maximum auto-votes to plan', '20')
      .option('--user <account>', 'only vote for route logs for this current user')
      .option('--include-untrusted-signals', 'also vote from ordinary low-confidence route signals')
      .option('--adapter-command <command>', 'trusted AI adapter command; receives JSON payload file path as argv[1] and returns JSON')
      .option('--adapter-url <url>', 'trusted AI adapter HTTP endpoint')
      .option('--min-useful-bps <bps>', 'minimum adapter usefulness score for a yes vote', '8500')
      .option('--revote', 'replace an existing vote from the same voter')
      .option('--dry-run', 'print planned votes without broadcasting')
  ).action(async (options: {
    url?: string
    contract?: string
    voter: string
    quantity?: string
    confidenceBps?: string
    minCount?: string
    limit?: string
    user?: string
    includeUntrustedSignals?: boolean
    adapterCommand?: string
    adapterUrl?: string
    minUsefulBps?: string
    revote?: boolean
    dryRun?: boolean
    json?: boolean
    actor?: string
    permission?: string
    key?: string
    auth?: string
    expiration?: string
  }) => {
    const contract = options.contract ?? AI_CONTRACT
    const quantity = options.quantity ?? '1.0000 SYS'
    const [routes, subcalls, tunes] = await Promise.all([
      getTableRows<RouteLogRow>(contract, 'routelogs', {url: options.url, scope: contract, limit: 1000}),
      getTableRows<SubcallRow>(contract, 'subcalls', {url: options.url, scope: contract, limit: 1000}),
      getTableRows<TuneRequestRow>(contract, 'tunereqs', {url: options.url, scope: contract, limit: 1000}),
    ])
    const needs = buildTuneNeeds(routes.rows, subcalls.rows, {
      confidenceThreshold: Number(options.confidenceBps ?? 8500),
      minCount: Number(options.minCount ?? 1),
      user: options.user ?? options.voter,
      trustedOnly: !options.includeUntrustedSignals,
    })
    const initialPlans = buildTuneAutoVotePlan(needs, tunes.rows, {quantity}).slice(0, Number(options.limit ?? 20))
    const minUsefulBps = Number(options.minUsefulBps ?? 8500)
    const plans: TuneAutoVotePlan[] = []
    const skipped: Array<{tune_id: Uint64String; reason: string}> = []

    for (const plan of initialPlans) {
      if (!options.revote && await existingTuneVote(contract, plan.tune_id, options.voter, {url: options.url})) {
        skipped.push({tune_id: plan.tune_id, reason: 'voter already has a vote'})
        continue
      }
      if (options.adapterCommand || options.adapterUrl) {
        const decision = await runTrustedAiAdapter({
          kind: 'harbor.ai.tune_auto_vote',
          voter: options.voter,
          need: plan.need,
          proposal: plan.tune,
        }, {
          adapterCommand: options.adapterCommand,
          adapterUrl: options.adapterUrl,
        })
        if (!decisionApproves(decision, minUsefulBps)) {
          skipped.push({tune_id: plan.tune_id, reason: decision.reason ?? 'trusted AI adapter did not approve'})
          continue
        }
        plan.reason = decision.reason ?? plan.reason
      }
      plans.push(plan)
    }

    const printablePlans = plans.map((plan) => ({
      tune_id: plan.tune_id,
      approve: plan.approve,
      quantity: plan.quantity,
      base_model_id: plan.need.base_model_id,
      task: plan.need.metadata.task,
      route_count: plan.need.route_count,
      reason: plan.reason,
    }))
    const summary = {voter: options.voter, planned_votes: printablePlans, skipped, needs}

    if (options.dryRun || plans.length === 0) {
      printResult(summary, options.json)
      return
    }

    const actorOptions = {...options, actor: options.actor ?? options.voter}
    const actions = []
    for (const plan of plans) {
      actions.push(await serializeAction({
        contract,
        action: 'votetune',
        data: {
          voter: options.voter,
          tune_id: plan.tune_id,
          approve: plan.approve,
          quantity: plan.quantity,
        },
        url: options.url,
        actor: actorOptions.actor,
        permission: actorOptions.permission,
        key: actorOptions.key,
        authorization: actorOptions.auth,
        expiration: actorOptions.expiration,
      }))
    }
    const result = await transactActions(actorOptions, actions)
    printResult({...summary, result}, options.json)
  })
}

function addTrustCommand(ai: Command): void {
  const trust = new Command('trust')
  trust.description('Configure trusted AI safety adapters for Harbor routing and fine-tune voting')

  trust
    .command('aegis-config <output>')
    .description('Write a starter Aegis trusted-reviewer config for Harbor')
    .option('--reviewer <id>', 'trusted reviewer model id', 'local-small-judge')
    .option('--command <command>', 'local trusted model command; receives an Aegis JSON payload path')
    .option('--force', 'overwrite an existing config file')
    .option('--json', 'print JSON')
    .action(async (output: string, options: {
      reviewer?: string
      command?: string
      force?: boolean
      json?: boolean
    }) => {
      const file = path.resolve(output)
      if (!options.force) {
        try {
          await fs.access(file)
          throw new Error(`refusing to overwrite existing file: ${file}`)
        } catch (error) {
          if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) {
            throw error
          }
        }
      }
      await fs.mkdir(path.dirname(file), {recursive: true})
      await fs.writeFile(file, renderAegisConfig({
        reviewer: options.reviewer,
        command: options.command ?? process.env.HARBOR_AEGIS_TRUSTED_COMMAND,
      }), 'utf8')
      const adapterCommand = aegisHarborCheckCommand(file)
      printResult({
        config: file,
        reviewer: options.reviewer ?? 'local-small-judge',
        trusted_checker_command: adapterCommand,
        env: {HARBOR_AI_TRUSTED_CHECKER_COMMAND: adapterCommand},
      }, options.json)
    })

  trust
    .command('aegis-env')
    .description('Print the Harbor runtime env var for an Aegis trusted checker')
    .requiredOption('--config <path>', 'Aegis config path')
    .option('--aegis-command <command>', 'Aegis executable or command prefix', process.env.HARBOR_AEGIS_COMMAND ?? 'aegis')
    .option('--json', 'print JSON')
    .action((options: {
      config: string
      aegisCommand?: string
      json?: boolean
    }) => {
      const adapterCommand = aegisHarborCheckCommand(options.config, {aegisCommand: options.aegisCommand})
      const envLine = `export HARBOR_AI_TRUSTED_CHECKER_COMMAND=${shellQuote(adapterCommand)}`
      if (options.json) {
        printResult({
          trusted_checker_command: adapterCommand,
          env: {HARBOR_AI_TRUSTED_CHECKER_COMMAND: adapterCommand},
          export: envLine,
        }, true)
        return
      }
      console.log(envLine)
    })

  trust
    .command('aegis-smoke')
    .description('Run a sample Harbor route-verification payload through Aegis')
    .requiredOption('--config <path>', 'Aegis config path')
    .option('--aegis-command <command>', 'Aegis executable or command prefix', process.env.HARBOR_AEGIS_COMMAND ?? 'aegis')
    .option('--task <task>', 'sample task label', 'harbor-safety-smoke')
    .option('--prompt <text>', 'sample prompt', 'Answer safely and identify gaps.')
    .option('--output <text>', 'sample model output', 'fallback: I do not know')
    .option('--user <account>', 'sample current user')
    .option('--json', 'print JSON')
    .action(async (options: {
      config: string
      aegisCommand?: string
      task?: string
      prompt?: string
      output?: string
      user?: string
      json?: boolean
    }) => {
      const adapterCommand = aegisHarborCheckCommand(options.config, {aegisCommand: options.aegisCommand})
      const payload = {
        kind: 'harbor.ai.route_verification',
        router: 'harbor-cli',
        provider: 'smoke',
        policy_id: '0',
        infer_id: '0',
        model_id: '0',
        request_hash: 'smoke',
        user: options.user ?? '',
        task: options.task ?? 'harbor-safety-smoke',
        prompt: options.prompt ?? '',
        output: options.output ?? '',
      }
      const decision = await runTrustedAiAdapter(payload, {adapterCommand})
      printResult({trusted_checker_command: adapterCommand, payload, decision}, options.json)
    })

  ai.addCommand(trust)
}

function addOfferCommand(ai: Command): void {
  addTxOptions(
    ai
      .command('offer <kind> <provider> <endpoint>')
      .description('Register an AI inference, training, or router service in svcmarket')
      .option('--market-contract <account>', 'service market contract account', MARKET_CONTRACT)
      .option('--range-start <value>', 'model/task range start', '0')
      .option('--range-end <value>', 'model/task range end', '0')
      .option('--capacity-bytes <bytes>', 'declared capacity', '0')
      .option('--stake <quantity>', 'provider stake to add before service registration', process.env.HARBOR_AI_PROVIDER_STAKE ?? '20.0000 SYS')
      .option('--metadata <json>', 'service metadata JSON', '{}')
      .option('--skip-register-provider', 'do not create svcmarket provider row if missing')
      .option('--dry-run', 'print planned actions without broadcasting')
  ).action(async (kind: string, provider: string, endpoint: string, options: OfferOptions) => {
    const service = resolveAiService(kind)
    const marketContract = options.marketContract ?? MARKET_CONTRACT
    const actorOptions = {...options, actor: options.actor ?? provider}
    const metadata = options.metadata ?? '{}'
    const planned: Array<{contract: string; action: string; data: Record<string, unknown>}> = []

    if (!options.skipRegisterProvider) {
      const registered = await providerIsRegistered(marketContract, provider, options)
      if (!registered) {
        planned.push({
          contract: marketContract,
          action: 'regprovider',
          data: {provider, metadata: JSON.stringify({source: 'harbor-ai-offer', service: service.name})},
        })
      }
    }

    const stake = options.stake ?? '20.0000 SYS'
    if (positiveAsset(stake)) {
      planned.push({
        contract: marketContract,
        action: 'stakeprov',
        data: {provider, quantity: stake},
      })
    }

    planned.push({
      contract: marketContract,
      action: 'addservice',
      data: {
        provider,
        service_type: service.id,
        segment_kind: 1,
        range_start: canonicalUint64(options.rangeStart ?? '0', 'service range start'),
        range_end: canonicalUint64(options.rangeEnd ?? '0', 'service range end'),
        capacity_bytes: canonicalUint64(options.capacityBytes ?? '0', 'service capacity bytes'),
        endpoint,
        metadata,
      },
    })

    if (options.dryRun) {
      printResult({service_type: service.name, provider, endpoint, actions: planned}, options.json)
      return
    }

    const actions = []
    for (const action of planned) {
      actions.push(await serializeAction({
        contract: action.contract,
        action: action.action,
        data: action.data,
        url: options.url,
        actor: actorOptions.actor,
        permission: actorOptions.permission,
        key: actorOptions.key,
        authorization: actorOptions.auth,
        expiration: actorOptions.expiration,
      }))
    }
    const result = await transactActions(actorOptions, actions)
    printResult({service_type: service.name, provider, endpoint, actions: planned.map((action) => action.action), result}, options.json)
  })
}

async function writeFusionManifestFile(output: string, manifestJson: string, force?: boolean): Promise<string> {
  const file = path.resolve(output)
  if (!force) {
    try {
      await fs.access(file)
      throw new Error(`refusing to overwrite existing file: ${file}`)
    } catch (error) {
      if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
  }
  await fs.mkdir(path.dirname(file), {recursive: true})
  await fs.writeFile(file, manifestJson, 'utf8')
  return file
}

async function writeOutputFile(output: string, contents: string, force?: boolean): Promise<string> {
  const file = path.resolve(output)
  if (!force) {
    try {
      await fs.access(file)
      throw new Error(`refusing to overwrite existing file: ${file}`)
    } catch (error) {
      if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
  }
  await fs.mkdir(path.dirname(file), {recursive: true})
  await fs.writeFile(file, contents, 'utf8')
  return file
}

async function readFusionManifest(file: string): Promise<FusionManifest> {
  const raw = await fs.readFile(path.resolve(file), 'utf8')
  const parsed = JSON.parse(raw) as Partial<FusionManifest>
  if (parsed.format !== 'harbor.fusion.v1') {
    throw new Error(`not a Harbor fusion manifest: ${file}`)
  }
  const experts = (parsed.expert_model_ids ?? []).map((modelId, index) => ({
    model_id: positiveUint64(modelId, `fusion expert model id ${index}`),
    role: String(parsed.expert_roles?.[index] ?? ''),
    weight: Number(parsed.expert_weights?.[index] ?? 1),
  }))
  return buildFusionManifest({
    base_model_id: positiveUint64(parsed.base_model_id, 'fusion base model id'),
    experts,
    logit_mode: parseLogitMode(parsed.logit_mode),
    logit_top_k: Number(parsed.logit_top_k ?? 0),
    selection_policy: isPlainObject(parsed.selection_policy) ? parsed.selection_policy : undefined,
    eval_artifact_id: canonicalUint64(parsed.eval_artifact_id ?? '0', 'fusion eval artifact id'),
    auto_expert_count: Number(parsed.auto_expert_count ?? 0),
  })
}

export async function resolveArtifactId(
  contract: string,
  owner: string,
  kind: number,
  storageObjectId: number | string,
  contentHash: string,
  options: {
    url?: string
    minimumIdInclusive: string
    maximumIdExclusive?: string
    transactionResult?: unknown
  },
): Promise<Uint64String> {
  const minimum = canonicalUint64(options.minimumIdInclusive, 'pre-registration next artifact id')
  const maximum = canonicalUint64(
    options.maximumIdExclusive ?? await readContractNextId(contract, 'next_artifact_id', {url: options.url}),
    'post-registration next artifact id',
  )
  if (BigInt(maximum) <= BigInt(minimum)) {
    throw new Error('AI artifact registration did not advance next_artifact_id')
  }
  const returned = actionUint64Return(options.transactionResult, contract, 'addartifact')
  const lowerBound = returned ?? minimum
  const upperBound = returned ? (BigInt(returned) + 1n).toString() : maximum
  if (BigInt(lowerBound) < BigInt(minimum) || BigInt(lowerBound) >= BigInt(maximum)) {
    throw new Error('AI artifact action returned an id outside its registration window')
  }
  const rows = await getAllTableRows<AiArtifactRow>(contract, 'artifacts', {
    url: options.url,
    scope: contract,
    lowerBound,
    upperBound,
    limit: 1000,
    indexPosition: '1',
    keyType: 'i64',
  })
  const expectedStorageId = canonicalUint64(storageObjectId, 'artifact storage object id')
  const matches = rows
    .filter((row) =>
      row.owner === owner &&
      Number(row.kind) === kind &&
      canonicalUint64(row.storage_object_id, 'artifact storage object id') === expectedStorageId &&
      row.content_hash === contentHash
    )
  if (matches.length !== 1) {
    throw new Error(`AI artifact registration resolved ${matches.length} newly created rows for storage object ${storageObjectId}`)
  }
  const artifactId = canonicalUint64(matches[0].id, 'AI artifact id')
  if (returned && artifactId !== returned) {
    throw new Error('AI artifact action return value does not match the created row')
  }
  return artifactId
}

export async function resolveModelId(
  contract: string,
  owner: string,
  weightsArtifactId: number | string,
  manifestHash: string,
  options: {
    url?: string
    minimumIdInclusive: string
    maximumIdExclusive?: string
    transactionResult?: unknown
  },
): Promise<Uint64String> {
  const minimum = canonicalUint64(options.minimumIdInclusive, 'pre-registration next model id')
  const maximum = canonicalUint64(
    options.maximumIdExclusive ?? await readContractNextId(contract, 'next_model_id', {url: options.url}),
    'post-registration next model id',
  )
  if (BigInt(maximum) <= BigInt(minimum)) {
    throw new Error('AI model registration did not advance next_model_id')
  }
  const returned = actionUint64Return(options.transactionResult, contract, 'regmodel')
  const lowerBound = returned ?? minimum
  const upperBound = returned ? (BigInt(returned) + 1n).toString() : maximum
  if (BigInt(lowerBound) < BigInt(minimum) || BigInt(lowerBound) >= BigInt(maximum)) {
    throw new Error('AI model action returned an id outside its registration window')
  }
  const rows = await getAllTableRows<AiModelRow>(contract, 'models', {
    url: options.url,
    scope: contract,
    lowerBound,
    upperBound,
    limit: 1000,
    indexPosition: '1',
    keyType: 'i64',
  })
  const expectedArtifactId = canonicalUint64(weightsArtifactId, 'weights artifact id')
  const matches = rows
    .filter((row) => row.owner === owner && canonicalUint64(row.weights_artifact_id, 'weights artifact id') === expectedArtifactId)
    .filter((row) => parseMetadata(row.metadata).fusion_manifest_hash === manifestHash)
  if (matches.length !== 1) {
    throw new Error(`AI model registration resolved ${matches.length} newly created rows for artifact ${weightsArtifactId}`)
  }
  const modelId = canonicalUint64(matches[0].id, 'AI model id')
  if (returned && modelId !== returned) {
    throw new Error('AI model action return value does not match the created row')
  }
  return modelId
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value)
  return previous
}

function parseBatchSample(value: string): {infer_id: Uint64String; evidence_hash: string} {
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('--sample must use infer_id:evidence_hash')
  }
  const inferId = positiveUint64(value.slice(0, separator), 'sample inference id')
  const evidenceHash = hash256(value.slice(separator + 1))
  if (!evidenceHash) {
    throw new Error('sample evidence hash must be lowercase SHA-256')
  }
  return {infer_id: inferId, evidence_hash: evidenceHash}
}

async function readTraceLines(input: string, allTraces?: boolean): Promise<{trace_file: string; lines: string[]}> {
  let traceFile = path.resolve(input)
  const stat = await fs.stat(traceFile)
  if (stat.isDirectory()) {
    traceFile = path.join(traceFile, allTraces ? 'traces.jsonl' : 'candidates.jsonl')
  }
  const raw = await fs.readFile(traceFile, 'utf8')
  return {trace_file: traceFile, lines: raw.split(/\r?\n/)}
}

export function validateQueryDatasetManifest(parsed: unknown, label = 'manifest'): QueryDatasetManifest {
  if (!isPlainObject(parsed) || parsed.format !== 'harbor.ai.query-dataset.v2') {
    throw new Error(`not a Harbor query dataset manifest: ${label}`)
  }
  const hashArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length > 0 && value.every((entry) => Boolean(hash256(entry)))
  const campaignIds = Array.isArray(parsed.campaign_ids)
    ? parsed.campaign_ids.map((entry) => optionalPositiveUint64(entry, 'manifest campaign id'))
    : []
  const privacy = parsed.privacy_policy
  const scopes = isPlainObject(privacy) ? privacy.required_scopes : undefined
  const rewardPolicy = parsed.reward_policy
  const retentionPolicy = parsed.retention_policy
  const hasRewardPolicy = rewardPolicy !== undefined
  const carriesRewardEvidence = (
    (Array.isArray(parsed.oracle_evidence_hashes) && parsed.oracle_evidence_hashes.length > 0) ||
    (Array.isArray(parsed.verifier_spec_hashes) && parsed.verifier_spec_hashes.length > 0)
  )
  const validRewardPolicy = !hasRewardPolicy || (
    isPlainObject(rewardPolicy) &&
    rewardPolicy.authority === 'svcmarket-oracle' &&
    rewardPolicy.sealed_verifiers_only === true &&
    rewardPolicy.requires_outcome_signal === true &&
    rewardPolicy.requires_nonzero_service_check === true &&
    hashArray(parsed.oracle_evidence_hashes) &&
    hashArray(parsed.verifier_spec_hashes) &&
    Boolean(hash256(parsed.base_model_hash)) &&
    Boolean(hash256(parsed.tokenizer_hash)) &&
    Array.isArray(scopes) && scopes.includes('feedback')
  )
  if (
    !hash256(parsed.dataset_hash) ||
    parsed.dataset_format !== 'chat_messages_jsonl' ||
    parsed.source !== 'harbor-ai-query-traces' ||
    !positiveInteger(parsed.example_count) ||
    !hashArray(parsed.example_hashes) ||
    parsed.example_hashes.length !== Number(parsed.example_count) ||
    !hashArray(parsed.trace_hashes) ||
    parsed.trace_hashes.length !== Number(parsed.example_count) ||
    !hashArray(parsed.prompt_hashes) ||
    !hashArray(parsed.response_hashes) ||
    campaignIds.length === 0 ||
    campaignIds.some((entry) => !entry) ||
    !hashArray(parsed.consent_policy_hashes) ||
    !hashArray(parsed.consent_receipt_hashes) ||
    !isPlainObject(privacy) ||
    !isPlainObject(retentionPolicy) ||
    !positiveInteger(retentionPolicy.not_after_epoch_sec) ||
    retentionPolicy.deletion_required_on_revocation !== true ||
    privacy.requires_active_versioned_consent !== true ||
    privacy.requires_pii_review !== true ||
    privacy.encrypted_at_rest_required !== true ||
    !Array.isArray(scopes) ||
    !['training', 'prompt', 'response'].every((scope) => scopes.includes(scope)) ||
    carriesRewardEvidence !== hasRewardPolicy ||
    !validRewardPolicy
  ) {
    throw new Error(`incomplete consent-aware query dataset manifest: ${label}`)
  }
  const normalized = {...parsed} as unknown as QueryDatasetManifest
  normalized.campaign_ids = campaignIds as Uint64String[]
  for (const [field, label] of [
    ['base_model_id', 'manifest base model id'],
    ['model_id', 'manifest model id'],
    ['fusion_parent_model_id', 'manifest fusion parent model id'],
  ] as const) {
    const value = parsed[field]
    if (value !== undefined) {
      normalized[field] = positiveUint64(value, label)
    }
  }
  return normalized
}

async function readQueryDatasetManifest(file?: string): Promise<QueryDatasetManifest | undefined> {
  if (!file) {
    return undefined
  }
  const raw = await fs.readFile(path.resolve(file), 'utf8')
  const parsed = JSON.parse(raw) as unknown
  return validateQueryDatasetManifest(parsed, file)
}

function queryDatasetArtifactMetadata(input: {
  datasetHash: string
  manifestHash?: string
  manifest?: QueryDatasetManifest
  metadata?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    ...input.metadata,
    kind: 'dataset',
    format: 'harbor.ai.query-dataset.v2',
    dataset_format: 'chat_messages_jsonl',
    dataset_hash: input.datasetHash,
    manifest_hash: input.manifestHash,
    source: 'harbor-ai-query-data',
    example_count: input.manifest?.example_count,
    task: input.manifest?.task,
    base_model_id: input.manifest?.base_model_id,
    expert_role: input.manifest?.expert_role,
    fusion_parent_model_id: input.manifest?.fusion_parent_model_id,
    campaign_ids: input.manifest?.campaign_ids,
    consent_policy_hashes: input.manifest?.consent_policy_hashes,
    consent_receipt_count: input.manifest?.consent_receipt_hashes?.length,
    base_model_hash: input.manifest?.base_model_hash,
    tokenizer_hash: input.manifest?.tokenizer_hash,
    retention_policy: input.manifest?.retention_policy,
    oracle_evidence_hashes: input.manifest?.oracle_evidence_hashes,
    verifier_spec_hashes: input.manifest?.verifier_spec_hashes,
    reward_policy: input.manifest?.reward_policy,
    encrypted_at_rest_required: true,
  }
}

function defaultQueryDatasetManifestPath(output: string): string {
  return /\.jsonl$/i.test(output) ? output.replace(/\.jsonl$/i, '.manifest.json') : `${output}.manifest.json`
}

function addRlvrCommand(ai: Command): void {
  const rlvr = new Command('rlvr')
  rlvr.description('Build sealed, oracle-approved GRPO training recipes')
  rlvr
    .command('recipe <base_model>')
    .description('Create a canonical harbor.ai.rlvr-recipe.v1 artifact')
    .requiredOption('--base-model-hash <hash>', 'immutable base model revision hash')
    .requiredOption('--tokenizer-hash <hash>', 'immutable tokenizer hash')
    .requiredOption('--dataset-hash <hash>', 'canonical plaintext query-dataset hash')
    .option('--verifier <file>', 'sealed oracle-approved verifier JSON; repeat per verifier', collectOption, [])
    .option('--seed <seed>', 'deterministic random seed', '7')
    .option('--group-size <count>', 'rollouts per prompt', '4')
    .option('--batch-size <count>', 'prompt batch size', '1')
    .option('--steps <count>', 'bounded optimizer steps', '1')
    .option('--max-prompt-tokens <count>', 'maximum prompt tokens', '128')
    .option('--max-completion-tokens <count>', 'maximum generated tokens', '32')
    .option('--clip-epsilon <value>', 'GRPO ratio clipping epsilon', '0.2')
    .option('--kl-coefficient <value>', 'reference-model KL coefficient', '0.02')
    .option('--learning-rate <value>', 'AdamW learning rate', '0.00001')
    .option('--lora-layers <count>', 'number of final transformer layers adapted', '1')
    .option('-o, --output <path>', 'recipe JSON output path', 'rlvr-recipe.json')
    .option('--force', 'overwrite output file')
    .option('--json', 'print JSON')
    .action(async (baseModel: string, options: {
      baseModelHash: string
      tokenizerHash: string
      datasetHash: string
      verifier?: string[]
      seed?: string
      groupSize?: string
      batchSize?: string
      steps?: string
      maxPromptTokens?: string
      maxCompletionTokens?: string
      clipEpsilon?: string
      klCoefficient?: string
      learningRate?: string
      loraLayers?: string
      output?: string
      force?: boolean
      json?: boolean
    }) => {
      if (!options.verifier?.length) {
        throw new Error('at least one --verifier JSON file is required')
      }
      const verifiers: RlvrVerifierSpec[] = []
      for (const verifierFile of options.verifier) {
        const parsed = JSON.parse(await fs.readFile(path.resolve(verifierFile), 'utf8')) as unknown
        if (!isPlainObject(parsed)) {
          throw new Error(`sealed verifier must be a JSON object: ${verifierFile}`)
        }
        verifiers.push(parsed as unknown as RlvrVerifierSpec)
      }
      const result = buildRlvrRecipe({
        base_model: baseModel,
        base_model_hash: options.baseModelHash,
        tokenizer_hash: options.tokenizerHash,
        dataset_hash: options.datasetHash,
        seed: Number(options.seed ?? 7),
        group_size: Number(options.groupSize ?? 4),
        batch_size: Number(options.batchSize ?? 1),
        steps: Number(options.steps ?? 1),
        max_prompt_tokens: Number(options.maxPromptTokens ?? 128),
        max_completion_tokens: Number(options.maxCompletionTokens ?? 32),
        clip_epsilon: Number(options.clipEpsilon ?? 0.2),
        kl_coefficient: Number(options.klCoefficient ?? 0.02),
        learning_rate: Number(options.learningRate ?? 1e-5),
        lora_layers: Number(options.loraLayers ?? 1),
        verifiers,
      })
      const output = await writeOutputFile(options.output ?? 'rlvr-recipe.json', result.recipe_json, options.force)
      printResult({ok: true, output, recipe_hash: result.recipe_hash, recipe: result.recipe}, options.json)
    })
  ai.addCommand(rlvr)
}

function addDataCommand(ai: Command): void {
  const data = new Command('data')
  data.description('Package inference traces into decentralized training datasets')

  data
    .command('pack <trace_path>')
    .description('Convert local AI trace candidates into a canonical trainable JSONL dataset')
    .option('--all-traces', 'read traces.jsonl instead of candidates.jsonl when trace_path is a directory')
    .option('--include-all', 'include traces even when training_candidate is false')
    .option('--include-low-score', 'allow captured low-score outputs without corrections')
    .option('--include-unscored', 'allow captured unscored outputs without corrections')
    .option('--rlvr', 'pack only oracle-approved outcome samples with consent mask 23')
    .option('--min-useful-bps <bps>', 'minimum score for captured outputs without explicit correction', '8500')
    .option('--max-examples <count>', 'maximum examples to include', '0')
    .option('--contributor <account>', 'dataset contributor account for manifest attribution')
    .option('--task <task>', 'only include traces for one task')
    .option('--user <account>', 'only include traces for one user/account')
    .option('--model-id <id>', 'only include traces for one model id')
    .option('--base-model-id <id>', 'base model id for downstream training metadata')
    .option('--base-model-hash <hash>', 'immutable base model hash; required with --rlvr')
    .option('--tokenizer-hash <hash>', 'immutable tokenizer hash; required with --rlvr')
    .option('--expert-role <role>', 'expert role for downstream distributed expert training')
    .option('--fusion-parent-model-id <id>', 'fusion parent model id for expert metadata')
    .option('-o, --output <path>', 'dataset JSONL output path', 'query-dataset.jsonl')
    .option('--manifest-output <path>', 'manifest JSON output path')
    .option('--force', 'overwrite output files')
    .option('--json', 'print JSON')
    .action(async (tracePath: string, options: {
      allTraces?: boolean
      includeAll?: boolean
      includeLowScore?: boolean
      includeUnscored?: boolean
      rlvr?: boolean
      minUsefulBps?: string
      maxExamples?: string
      contributor?: string
      task?: string
      user?: string
      modelId?: string
      baseModelId?: string
      baseModelHash?: string
      tokenizerHash?: string
      expertRole?: string
      fusionParentModelId?: string
      output?: string
      manifestOutput?: string
      force?: boolean
      json?: boolean
    }) => {
      const {trace_file, lines} = await readTraceLines(tracePath, options.allTraces)
      const pack = buildQueryDatasetFromTraces(lines, {
        contributor: options.contributor,
        task: options.task,
        user: options.user,
        model_id: options.modelId ? positiveUint64(options.modelId, 'model id') : undefined,
        base_model_id: options.baseModelId ? positiveUint64(options.baseModelId, 'base model id') : undefined,
        base_model_hash: options.baseModelHash,
        tokenizer_hash: options.tokenizerHash,
        expert_role: options.expertRole,
        fusion_parent_model_id: options.fusionParentModelId
          ? positiveUint64(options.fusionParentModelId, 'fusion parent model id')
          : undefined,
        min_useful_bps: Number(options.minUsefulBps ?? 8500),
        include_all: Boolean(options.includeAll),
        include_low_score: Boolean(options.includeLowScore),
        include_unscored: Boolean(options.includeUnscored),
        rlvr_only: Boolean(options.rlvr),
        max_examples: Number(options.maxExamples ?? 0),
      })
      if (pack.examples.length === 0) {
        throw new Error(`no usable training examples found; skipped=${JSON.stringify(pack.skipped)}`)
      }
      const output = await writeOutputFile(options.output ?? 'query-dataset.jsonl', pack.dataset_jsonl, options.force)
      const manifestOutput = await writeOutputFile(
        options.manifestOutput ?? defaultQueryDatasetManifestPath(output),
        pack.manifest_json,
        options.force,
      )
      printResult({
        ok: true,
        trace_file,
        output,
        manifest_output: manifestOutput,
        dataset_hash: pack.dataset_hash,
        manifest_hash: pack.manifest_hash,
        example_count: pack.examples.length,
        skipped: pack.skipped,
        manifest: pack.manifest,
      }, options.json)
    })

  addTxOptions(
    data
      .command('register <owner> <dataset_file>')
      .description('Store a query-derived dataset and register it as an existing harborai dataset artifact')
      .option('-c, --contract <account>', 'Harbor AI contract account', AI_CONTRACT)
      .option('--backend <backend>', 'storage backend: harbor or walrus', 'harbor')
      .option('--manifest <path>', 'query dataset manifest produced by harbor ai data pack')
      .option('--metadata <json>', 'additional artifact metadata JSON object')
      .option('--market-contract <account>', 'service market contract account', MARKET_CONTRACT)
      .option('--storage-contract <account>', 'storage registry contract account', process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore')
      .option('--router-url <url>', 'explicit storage router endpoint for Harbor-backed storage')
      .option('--recipient-public-key <file>', 'unique per-dataset governed-data public key JSON (or HARBOR_AI_DATA_RECIPIENT_PUBLIC_KEY)')
      .option('--vault-policy-id <id>', 'sanitized-data Vault policy id')
      .option('--vault-consent-id <id>', 'sanitized-data Vault consent id')
      .option('--purpose <purpose>', 'governed processing purpose', 'specialist-training')
      .option('--ttl-sec <seconds>', 'envelope and temporary-object lifetime', '86400')
      .option('--key-custodians <json>', 'JSON array of accounts required to attest key erasure')
      .option('--prepared-output <path>', 'persist exact governed envelope bytes here before chain registration')
      .option('--private-key <key>', 'removed legacy option; password-derived encryption is rejected')
      .option('--walrus-command <path>', 'Walrus CLI command', process.env.WALRUS_CLI ?? 'walrus')
      .option('--walrus-publisher-url <url>', 'Walrus publisher URL')
      .option('--walrus-aggregator-url <url>', 'Walrus aggregator URL to preserve in metadata')
      .option('--walrus-epochs <epochs>', 'Walrus storage epochs')
      .option('--dry-run', 'print the planned storage/action flow without broadcasting')
  ).action(async (owner: string, datasetFile: string, options: {
    contract?: string
    backend?: string
    manifest?: string
    metadata?: string
    marketContract?: string
    storageContract?: string
    routerUrl?: string
    privateKey?: string
    recipientPublicKey?: string
    vaultPolicyId?: string
    vaultConsentId?: string
    purpose?: string
    ttlSec?: string
    keyCustodians?: string
    preparedOutput?: string
    walrusCommand?: string
    walrusPublisherUrl?: string
    walrusAggregatorUrl?: string
    walrusEpochs?: string
    dryRun?: boolean
    url?: string
    actor?: string
    permission?: string
    key?: string
    auth?: string
    json?: boolean
    expiration?: string
  }) => {
    const contract = options.contract ?? AI_CONTRACT
    const file = path.resolve(datasetFile)
    const datasetHash = await hashFile(file)
    const manifest = await readQueryDatasetManifest(options.manifest)
    if (!manifest) {
      throw new Error('a consent-aware harbor.ai.query-dataset.v2 manifest is required')
    }
    if (manifest && manifest.dataset_hash !== datasetHash) {
      throw new Error(`dataset hash mismatch: manifest has ${manifest.dataset_hash}, file has ${datasetHash}`)
    }
    const manifestHash = manifest ? sha256Bytes(Buffer.from(canonicalJson(manifest))) : undefined
    const artifactMetadata = queryDatasetArtifactMetadata({
      datasetHash,
      manifestHash,
      manifest,
      metadata: options.metadata ? parseObjectJson(options.metadata, 'metadata') : undefined,
    })
    const storageMetadata = JSON.stringify(artifactMetadata)
    if (options.privateKey || process.env.HARBOR_AI_DATA_KEY) {
      throw new Error('password-derived AI data encryption was removed; use a governed recipient public key')
    }
    const recipientPublicKey = options.recipientPublicKey ?? process.env.HARBOR_AI_DATA_RECIPIENT_PUBLIC_KEY
    const governedRequired: Array<[string, string | undefined]> = [
      ['--recipient-public-key', recipientPublicKey],
      ['--vault-policy-id', options.vaultPolicyId],
      ['--vault-consent-id', options.vaultConsentId],
      ['--key-custodians', options.keyCustodians],
    ]
    const missingGoverned = governedRequired.filter(([, value]) => !value).map(([flag]) => flag)
    if (!options.dryRun && missingGoverned.length > 0) {
      throw new Error(`consented AI datasets require governed encryption options: ${missingGoverned.join(', ')}`)
    }
    const plannedAction = {
      contract,
      action: 'addartifact',
      data: {
        owner,
        kind: 2,
        storage_object_id: '<storage_object_id>',
        content_hash: '<encrypted_storage_content_hash>',
        metadata: JSON.stringify(artifactMetadata),
      },
    }

    if (options.dryRun) {
      printResult({
        dry_run: true,
        backend: options.backend ?? 'harbor',
        dataset_file: file,
        dataset_hash: datasetHash,
        manifest_hash: manifestHash,
        encrypted: true,
        temporary: true,
        governed_envelope: 'harbor.governed-data-envelope.v1',
        missing_governed_options: missingGoverned,
        artifact_metadata: artifactMetadata,
        actions: [plannedAction],
      }, options.json)
      return
    }

    if (options.backend && options.backend !== 'harbor' && options.backend !== 'walrus') {
      throw new Error(`unknown storage backend: ${options.backend}`)
    }
    const ttlSec = Number(options.ttlSec ?? 86400)
    if (!Number.isSafeInteger(ttlSec) || ttlSec <= 0) {
      throw new Error('--ttl-sec must be a positive safe integer')
    }
    let keyCustodians: unknown
    try {
      keyCustodians = JSON.parse(options.keyCustodians as string)
    } catch {
      throw new Error('--key-custodians must be a JSON array')
    }
    if (!Array.isArray(keyCustodians) || keyCustodians.length === 0 ||
        keyCustodians.some((value) => typeof value !== 'string' || !value)) {
      throw new Error('--key-custodians must be a non-empty JSON array of accounts')
    }
    const recipientKey = parseVaultPublicKey(await fs.readFile(recipientPublicKey as string, 'utf8'))
    const createdAt = Math.floor(Date.now() / 1000)
    if (createdAt + ttlSec > manifest.retention_policy.not_after_epoch_sec) {
      throw new Error('dataset storage TTL exceeds the consent-bound retention deadline')
    }
    const governed: GovernedStorageEncryption = {
      recipientPublicKey: recipientKey.publicKey,
      context: {
        policy_id: options.vaultPolicyId as string,
        consent_id: options.vaultConsentId as string,
        receipt_id: '',
        object_id: '',
        purpose: options.purpose ?? 'specialist-training',
        created_at: createdAt,
        expires_at: createdAt + ttlSec,
      },
      recipient: {
        grant_id: '',
        processor: '',
        key_id: recipientKey.keyId,
      },
      keyCustodians: keyCustodians as string[],
    }
    const stored = options.backend === 'walrus'
      ? await putWalrusObject({
        ...options,
        file,
        owner,
        metadata: storageMetadata,
        encrypt: true,
        governed,
        contentFormat: 'application/x-ndjson',
      })
      : await putReplicatedObject({
        ...options,
        file,
        owner,
        metadata: storageMetadata,
        encrypt: true,
        governed,
      })
    const actorOptions = {...options, actor: options.actor ?? owner}
    const minimumArtifactId = await readContractNextId(contract, 'next_artifact_id', {url: options.url})
    const artifactTx = await pushAction({
      contract,
      action: 'addartifact',
      data: {
        owner,
        kind: 2,
        storage_object_id: stored.object_id,
        content_hash: stored.content_hash,
        metadata: JSON.stringify(artifactMetadata),
      },
      url: options.url,
      actor: actorOptions.actor,
      permission: actorOptions.permission,
      key: actorOptions.key,
      authorization: actorOptions.auth,
      expiration: actorOptions.expiration,
    })
    const artifactId = await resolveArtifactId(contract, owner, 2, stored.object_id, stored.content_hash, {
      url: options.url,
      minimumIdInclusive: minimumArtifactId,
      transactionResult: artifactTx,
    })
    printResult({
      ok: true,
      owner,
      dataset_artifact_id: artifactId,
      storage_object_id: stored.object_id,
      content_hash: stored.content_hash,
      dataset_hash: datasetHash,
      manifest_hash: manifestHash,
      artifact_metadata: artifactMetadata,
      storage: stored,
      artifact_tx: artifactTx,
    }, options.json)
  })

  addTxOptions(
    data
      .command('contribute <curator> <campaign_id> <dataset_artifact_id>')
      .description('Create and seal a Vault-backed distillation batch for a governed query dataset')
      .option('-c, --contract <account>', 'Harbor AI contract account', AI_CONTRACT)
      .option('--owner <account>', 'campaign owner; defaults to curator')
      .option('--sample <infer_id:evidence_hash>', 'accepted sample and independent evidence commitment; repeat per sample', collectOption, [])
      .requiredOption('--dataset-object-id <id>', 'sanitized encrypted HarborStore object id')
      .requiredOption('--dataset-policy-id <id>', 'sanitized HarborVault policy id')
      .requiredOption('--transform-id <id>', 'accepted HarborVault aggregate lineage id')
      .requiredOption('--recipe-artifact-id <id>', 'public sealed RLVR recipe artifact id')
      .requiredOption('--dataset-hash <hash>', 'encrypted dataset content hash')
      .requiredOption('--input-lineage-hash <hash>', 'canonical accepted-input lineage root')
      .requiredOption('--recipe-hash <hash>', 'sealed RLVR recipe hash')
      .option('--manifest-hash <hash>', 'query dataset manifest hash to preserve in batch metadata')
      .option('--metadata <json>', 'additional batch metadata JSON object')
      .option('--dry-run', 'print the planned action sequence without broadcasting')
  ).action(async (curator: string, campaignIdInput: string, datasetArtifactIdInput: string, options: {
    contract?: string
    owner?: string
    sample?: string[]
    datasetObjectId: string
    datasetPolicyId: string
    transformId: string
    recipeArtifactId: string
    datasetHash: string
    inputLineageHash: string
    recipeHash: string
    manifestHash?: string
    metadata?: string
    dryRun?: boolean
    url?: string
    actor?: string
    permission?: string
    key?: string
    auth?: string
    json?: boolean
    expiration?: string
  }) => {
    const contract = options.contract ?? AI_CONTRACT
    const owner = options.owner ?? curator
    if (owner !== curator) {
      throw new Error('v1 batch contribution requires campaign owner and curator to be the same signer')
    }
    const campaignId = positiveUint64(campaignIdInput, 'campaign id')
    const datasetArtifactId = positiveUint64(datasetArtifactIdInput, 'dataset artifact id')
    const datasetObjectId = positiveUint64(options.datasetObjectId, 'dataset object id')
    const datasetPolicyId = positiveUint64(options.datasetPolicyId, 'dataset policy id')
    const transformId = positiveUint64(options.transformId, 'transform id')
    const recipeArtifactId = positiveUint64(options.recipeArtifactId, 'recipe artifact id')
    const datasetHash = hash256(options.datasetHash)
    const inputLineageHash = hash256(options.inputLineageHash)
    const recipeHash = hash256(options.recipeHash)
    const manifestHash = options.manifestHash ? hash256(options.manifestHash) : undefined
    if (!datasetHash || !inputLineageHash || !recipeHash || (options.manifestHash && !manifestHash)) {
      throw new Error('dataset, input-lineage, recipe, and optional manifest hashes must be lowercase SHA-256')
    }
    const samples = (options.sample ?? []).map(parseBatchSample)
    if (samples.length === 0) {
      throw new Error('at least one --sample infer_id:evidence_hash is required')
    }
    const uniqueInferences = new Set(samples.map((sample) => sample.infer_id))
    if (uniqueInferences.size !== samples.length) {
      throw new Error('duplicate sample inference id')
    }
    const suppliedMetadata = options.metadata ? parseObjectJson(options.metadata, 'metadata') : {}
    const metadata = JSON.stringify({
      ...suppliedMetadata,
      format: 'harbor.ai.rlvr-batch.v1',
      algorithm: 'grpo',
      dataset_artifact_id: datasetArtifactId,
      manifest_hash: manifestHash,
    })
    const actionData = (batchId: string) => [
      {
        contract,
        action: 'openbatch',
        data: {owner, campaign_id: campaignId, curator, metadata},
      },
      ...samples.map((sample) => ({
        contract,
        action: 'addsample',
        data: {curator, batch_id: batchId, ...sample},
      })),
      {
        contract,
        action: 'setbatchspec',
        data: {
          curator,
          batch_id: batchId,
          dataset_object_id: datasetObjectId,
          dataset_policy_id: datasetPolicyId,
          transform_id: transformId,
          recipe_artifact_id: recipeArtifactId,
          dataset_hash: datasetHash,
          input_lineage_hash: inputLineageHash,
          recipe_hash: recipeHash,
          metadata,
        },
      },
      {
        contract,
        action: 'sealbatch',
        data: {curator, batch_id: batchId, dataset_artifact_id: datasetArtifactId},
      },
    ]
    if (options.dryRun) {
      printResult({
        dry_run: true,
        modern_vault_backed_lifecycle: true,
        actions: actionData('<new_batch_id>'),
      }, options.json)
      return
    }

    const actorOptions = {...options, actor: options.actor ?? owner}
    const beforeRows = await getAllTableRows<Record<string, unknown>>(contract, 'distbatches', {
      scope: contract,
      url: options.url,
    })
    const beforeIds = new Set(beforeRows.map((row) => canonicalUint64(row.id, 'batch id')))
    const openResult = await pushAction({
      ...actionData('<new_batch_id>')[0],
      url: options.url,
      actor: actorOptions.actor,
      permission: actorOptions.permission,
      key: actorOptions.key,
      authorization: actorOptions.auth,
      expiration: actorOptions.expiration,
    })
    const returnedBatchId = actionUint64Return(openResult, contract, 'openbatch')
    const afterRows = await getAllTableRows<Record<string, unknown>>(contract, 'distbatches', {
      scope: contract,
      url: options.url,
    })
    const created = afterRows.filter((row) => {
      const id = canonicalUint64(row.id, 'batch id')
      return !beforeIds.has(id) &&
        canonicalUint64(row.campaign_id, 'campaign id') === campaignId &&
        row.curator === curator
    })
    const batchId = returnedBatchId ?? (created.length === 1
      ? canonicalUint64(created[0].id, 'batch id')
      : undefined)
    if (!batchId || (created.length > 0 && !created.some((row) => canonicalUint64(row.id, 'batch id') === batchId))) {
      throw new Error('could not resolve the newly opened governed distillation batch')
    }
    const followups = []
    for (const action of actionData(batchId).slice(1)) {
      followups.push(await serializeAction({
        ...action,
        url: options.url,
        actor: actorOptions.actor,
        permission: actorOptions.permission,
        key: actorOptions.key,
        authorization: actorOptions.auth,
        expiration: actorOptions.expiration,
      }))
    }
    const sealedResult = await transactActions(actorOptions, followups)
    printResult({
      ok: true,
      campaign_id: campaignId,
      batch_id: batchId,
      dataset_artifact_id: datasetArtifactId,
      sample_count: samples.length,
      open_result: openResult,
      sealed_result: sealedResult,
    }, options.json)
  })

  ai.addCommand(data)
}

function addFusionCommand(ai: Command): void {
  const fusion = new Command('fusion')
  fusion.description('Create, register, and inspect Harbor AI fusion manifests')

  const manifest = new Command('manifest')
  manifest.description('Build Harbor AI fusion manifest artifacts')
  manifest
    .command('create <base_model_id>')
    .description('Create a canonical harbor.fusion.v1 JSON manifest')
    .option('--expert <model_id:role:weight>', 'expert model id, role, and fusion weight; repeat for each expert; role may be auto', collectOption, [])
    .option('--auto-experts <count>', 'let the router discover this many experts from capability profiles', '0')
    .option('--logit-mode <mode>', 'none, top_k, or full', 'none')
    .option('--logit-top-k <count>', 'top-k logprob entries per token when logit-mode is top_k', '0')
    .option('--selection-policy <json>', 'selection policy JSON object')
    .option('--eval-artifact-id <id>', 'evaluation artifact id for the registered fusion model', '0')
    .option('-o, --output <path>', 'write manifest to a file')
    .option('--force', 'overwrite output file')
    .option('--json', 'print JSON')
    .action(async (baseModelId: string, options: {
      expert: string[]
      autoExperts?: string
      logitMode?: string
      logitTopK?: string
      selectionPolicy?: string
      evalArtifactId?: string
      output?: string
      force?: boolean
      json?: boolean
    }) => {
      const manifestObject = buildFusionManifest({
        base_model_id: positiveUint64(baseModelId, 'base model id'),
        experts: (options.expert ?? []).map(parseFusionExpertSpec),
        auto_expert_count: Number(options.autoExperts ?? 0),
        logit_mode: parseLogitMode(options.logitMode),
        logit_top_k: Number(options.logitTopK ?? 0),
        selection_policy: options.selectionPolicy ? parseObjectJson(options.selectionPolicy, 'selection policy') : undefined,
        eval_artifact_id: canonicalUint64(options.evalArtifactId ?? '0', 'eval artifact id'),
      })
      const manifestJson = canonicalJson(manifestObject)
      const manifestHash = sha256Bytes(Buffer.from(manifestJson))
      const output = options.output ? await writeFusionManifestFile(options.output, manifestJson, options.force) : undefined
      if (options.json) {
        printResult({manifest: manifestObject, manifest_hash: manifestHash, output}, true)
        return
      }
      if (output) {
        console.log(output)
        return
      }
      process.stdout.write(manifestJson)
    })
  fusion.addCommand(manifest)

  addTxOptions(
    fusion
      .command('register <owner> <manifest_file>')
      .description('Store a fusion manifest as a weights artifact and register a normal Harbor AI model')
      .option('-c, --contract <account>', 'Harbor AI contract account', AI_CONTRACT)
      .option('--backend <backend>', 'storage backend: harbor or walrus', 'harbor')
      .option('--title <title>', 'registered model title', 'Fusion Model')
      .option('--metadata <json>', 'additional model metadata JSON object')
      .option('--artifact-metadata <json>', 'additional artifact metadata JSON object')
      .option('--market-contract <account>', 'service market contract account', MARKET_CONTRACT)
      .option('--storage-contract <account>', 'storage registry contract account', process.env.HARBOR_STORAGE_CONTRACT ?? 'harborstore')
      .option('--router-url <url>', 'explicit storage router endpoint for Harbor-backed storage')
      .option('--walrus-command <path>', 'Walrus CLI command', process.env.WALRUS_CLI ?? 'walrus')
      .option('--walrus-publisher-url <url>', 'Walrus publisher URL')
      .option('--walrus-aggregator-url <url>', 'Walrus aggregator URL to preserve in metadata')
      .option('--walrus-epochs <epochs>', 'Walrus storage epochs')
      .option('--dry-run', 'print the planned storage/action flow without broadcasting')
  ).action(async (owner: string, manifestFile: string, options: {
    contract?: string
    backend?: string
    title?: string
    metadata?: string
    artifactMetadata?: string
    marketContract?: string
    storageContract?: string
    routerUrl?: string
    walrusCommand?: string
    walrusPublisherUrl?: string
    walrusAggregatorUrl?: string
    walrusEpochs?: string
    dryRun?: boolean
    url?: string
    actor?: string
    permission?: string
    key?: string
    auth?: string
    json?: boolean
    expiration?: string
  }) => {
    const contract = options.contract ?? AI_CONTRACT
    const manifestObject = await readFusionManifest(manifestFile)
    const basePlan = buildFusionRegisterPlan({
      manifest: manifestObject,
      owner,
      title: options.title ?? 'Fusion Model',
      aiContract: contract,
      manifestMetadata: options.artifactMetadata ? parseObjectJson(options.artifactMetadata, 'artifact metadata') : undefined,
      modelMetadata: options.metadata ? parseObjectJson(options.metadata, 'model metadata') : undefined,
    })
    if (options.dryRun) {
      printResult({
        dry_run: true,
        backend: options.backend ?? 'harbor',
        manifest_file: path.resolve(manifestFile),
        ...basePlan,
      }, options.json)
      return
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-fusion-'))
    const canonicalPath = path.join(tempDir, 'manifest.json')
    try {
      await fs.writeFile(canonicalPath, basePlan.manifest_json, 'utf8')
      if (options.backend && options.backend !== 'harbor' && options.backend !== 'walrus') {
        throw new Error(`unknown storage backend: ${options.backend}`)
      }
      const storageMetadata = JSON.stringify({
        format: 'harbor.fusion.v1',
        source: 'harbor-ai-fusion-register',
        manifest_hash: basePlan.manifest_hash,
      })
      const stored = options.backend === 'walrus'
        ? await putWalrusObject({
          ...options,
          file: canonicalPath,
          owner,
          metadata: storageMetadata,
          contentFormat: 'application/harbor-fusion+json',
        })
        : await putReplicatedObject({
          ...options,
          file: canonicalPath,
          owner,
          metadata: storageMetadata,
        })

      const actionOptions = {...options, actor: options.actor ?? owner}
      const artifactPlan = buildFusionRegisterPlan({
        manifest: manifestObject,
        owner,
        title: options.title ?? 'Fusion Model',
        aiContract: contract,
        storageObjectId: stored.object_id,
        contentHash: stored.content_hash,
        manifestMetadata: options.artifactMetadata ? parseObjectJson(options.artifactMetadata, 'artifact metadata') : undefined,
        modelMetadata: options.metadata ? parseObjectJson(options.metadata, 'model metadata') : undefined,
      })
      const minimumArtifactId = await readContractNextId(contract, 'next_artifact_id', {url: options.url})
      const artifactAction = await serializeAction({
        contract,
        action: 'addartifact',
        data: artifactPlan.actions[0].data,
        url: options.url,
        actor: actionOptions.actor,
        permission: actionOptions.permission,
        key: actionOptions.key,
        authorization: actionOptions.auth,
        expiration: actionOptions.expiration,
      })
      const artifactTx = await transactActions(actionOptions, [artifactAction])
      const artifactId = await resolveArtifactId(contract, owner, 1, stored.object_id, stored.content_hash, {
        url: options.url,
        minimumIdInclusive: minimumArtifactId,
        transactionResult: artifactTx,
      })
      const finalPlan = buildFusionRegisterPlan({
        manifest: manifestObject,
        owner,
        title: options.title ?? 'Fusion Model',
        aiContract: contract,
        storageObjectId: stored.object_id,
        contentHash: stored.content_hash,
        weightsArtifactId: artifactId,
        manifestMetadata: options.artifactMetadata ? parseObjectJson(options.artifactMetadata, 'artifact metadata') : undefined,
        modelMetadata: options.metadata ? parseObjectJson(options.metadata, 'model metadata') : undefined,
      })
      const minimumModelId = await readContractNextId(contract, 'next_model_id', {url: options.url})
      const modelAction = await serializeAction({
        contract,
        action: 'regmodel',
        data: finalPlan.actions[1].data,
        url: options.url,
        actor: actionOptions.actor,
        permission: actionOptions.permission,
        key: actionOptions.key,
        authorization: actionOptions.auth,
        expiration: actionOptions.expiration,
      })
      const modelTx = await transactActions(actionOptions, [modelAction])
      const modelId = await resolveModelId(contract, owner, artifactId, finalPlan.manifest_hash, {
        url: options.url,
        minimumIdInclusive: minimumModelId,
        transactionResult: modelTx,
      })
      printResult({
        ok: true,
        owner,
        model_id: modelId,
        weights_artifact_id: artifactId,
        storage_object_id: stored.object_id,
        content_hash: stored.content_hash,
        manifest_hash: finalPlan.manifest_hash,
        artifact_tx: artifactTx,
        model_tx: modelTx,
        storage: stored,
      }, options.json)
    } finally {
      await fs.rm(tempDir, {recursive: true, force: true})
    }
  })

  fusion
    .command('inspect <model_id>')
    .description('Inspect a fusion model and its route/subcall participation')
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('-c, --contract <account>', 'Harbor AI contract account', AI_CONTRACT)
    .option('--json', 'print JSON')
    .action(async (modelId: string, options: {url?: string; contract?: string; json?: boolean}) => {
      const contract = options.contract ?? AI_CONTRACT
      const [models, artifacts, routes, subcalls] = await Promise.all([
        getTableRows<AiModelRow>(contract, 'models', {url: options.url, scope: contract, limit: 1000}),
        getTableRows<AiArtifactRow>(contract, 'artifacts', {url: options.url, scope: contract, limit: 1000}),
        getTableRows<RouteLogRow>(contract, 'routelogs', {url: options.url, scope: contract, limit: 1000}),
        getTableRows<SubcallRow>(contract, 'subcalls', {url: options.url, scope: contract, limit: 1000}),
      ])
      const canonicalModelId = positiveUint64(modelId, 'model id')
      const model = models.rows.find((row) =>
        canonicalUint64(row.id, 'model row id') === canonicalModelId)
      if (!model) {
        throw new Error(`model not found: ${modelId}`)
      }
      const metadata = parseMetadata(model.metadata)
      const weightsArtifactId = canonicalUint64(model.weights_artifact_id, 'weights artifact id')
      const artifact = artifacts.rows.find((row) =>
        canonicalUint64(row.id, 'artifact row id') === weightsArtifactId)
      const fusionRoutes = routes.rows.filter((row) => {
        const routeMetadata = parseMetadata(row.metadata)
        return canonicalUint64(row.selected_model_id, 'route selected model id') === canonicalModelId ||
          optionalUint64(routeMetadata.fusion_model_id, 'route fusion model id') === canonicalModelId
      })
      const inferIds = new Set(fusionRoutes
        .map((row) => optionalPositiveUint64(row.infer_id, 'route inference id'))
        .filter((id): id is Uint64String => Boolean(id)))
      const fusionSubcalls = subcalls.rows.filter((row) =>
        canonicalUint64(row.from_model_id, 'subcall source model id') === canonicalModelId ||
        inferIds.has(canonicalUint64(row.parent_infer_id, 'subcall parent inference id'))
      )
      const expertParticipation = new Map<string, {calls: number; roles: Set<string>; providers: Set<string>}>()
      for (const route of fusionRoutes) {
        const routeMetadata = parseMetadata(route.metadata)
        const selected = Array.isArray(routeMetadata.selected_experts) ? routeMetadata.selected_experts : []
        for (const expert of selected) {
          if (!isPlainObject(expert)) {
            continue
          }
          const key = String(expert.model_id ?? expert.provider ?? 'unknown')
          const entry = expertParticipation.get(key) ?? {calls: 0, roles: new Set<string>(), providers: new Set<string>()}
          entry.calls += 1
          if (typeof expert.role === 'string') {
            entry.roles.add(expert.role)
          }
          if (typeof expert.provider === 'string') {
            entry.providers.add(expert.provider)
          }
          expertParticipation.set(key, entry)
        }
      }
      const summary = {
        model,
        metadata,
        weights_artifact: artifact,
        route_count: fusionRoutes.length,
        subcall_count: fusionSubcalls.length,
        expert_participation: [...expertParticipation.entries()].map(([expert, entry]) => ({
          expert,
          calls: entry.calls,
          roles: [...entry.roles],
          providers: [...entry.providers],
        })),
        recent_routes: fusionRoutes.slice(-10),
        recent_subcalls: fusionSubcalls.slice(-20),
      }
      printResult(summary, options.json)
    })

  const distributed = new Command('distributed')
  distributed.description('Plan and inspect distributed expert shard training')
  distributed
    .command('plan <expert_role> <base_model_id>')
    .description('Create deterministic shard assignments for one distributed expert')
    .option('--shards <count>', 'number of participant shards', '2')
    .option('--participant <account>', 'participant account for one shard; repeat shard_count times', collectOption, [])
    .option('--dataset-artifact-id <id>', 'dataset artifact id assigned to this expert', '0')
    .option('--model <name>', 'trainable local model/checkpoint name')
    .option('--aggregation-group-id <id>', 'explicit aggregation group id')
    .option('--metadata <json>', 'additional shard metadata JSON object')
    .option('--json', 'print JSON')
    .action((expertRole: string, baseModelId: string, options: {
      shards?: string
      participant: string[]
      datasetArtifactId?: string
      model?: string
      aggregationGroupId?: string
      metadata?: string
      json?: boolean
    }) => {
      const plan = buildDistributedExpertPlan({
        base_model_id: positiveUint64(baseModelId, 'base model id'),
        expert_role: expertRole,
        shard_count: Number(options.shards ?? 2),
        participants: options.participant ?? [],
        dataset_artifact_id: canonicalUint64(options.datasetArtifactId ?? '0', 'dataset artifact id'),
        model: options.model,
        aggregation_group_id: options.aggregationGroupId,
        metadata: options.metadata ? parseObjectJson(options.metadata, 'metadata') : undefined,
      })
      printResult({
        plan,
        plan_hash: sha256Bytes(Buffer.from(canonicalJson(plan))),
        shard_metadata: plan.shards.map((shard) => ({
          shard_index: shard.shard_index,
          participant: shard.participant,
          metadata_json: JSON.stringify(shard.metadata),
        })),
      }, options.json)
    })

  const aggregation = new Command('aggregation')
  aggregation.description('Build distributed expert aggregation manifests')
  aggregation
    .command('manifest <expert_role> <base_model_id>')
    .description('Create a canonical weighted LoRA aggregate manifest from shard artifact hashes')
    .requiredOption('--aggregation-group-id <id>', 'aggregation group id shared by all shards')
    .option('--shard <index:weights_hash:weight:artifact_id:trainer>', 'shard artifact spec; repeat for each shard', collectOption, [])
    .option('-o, --output <path>', 'write manifest to a file')
    .option('--force', 'overwrite output file')
    .option('--json', 'print JSON')
    .action(async (expertRole: string, baseModelId: string, options: {
      aggregationGroupId: string
      shard: string[]
      output?: string
      force?: boolean
      json?: boolean
    }) => {
      const manifest = buildDistributedAggregateManifest({
        base_model_id: positiveUint64(baseModelId, 'base model id'),
        expert_role: expertRole,
        aggregation_group_id: options.aggregationGroupId,
        shard_artifacts: (options.shard ?? []).map(parseDistributedShardSpec),
      })
      const manifestJson = canonicalJson(manifest)
      const manifestHash = sha256Bytes(Buffer.from(manifestJson))
      const output = options.output ? await writeFusionManifestFile(options.output, manifestJson, options.force) : undefined
      if (options.json) {
        printResult({manifest, manifest_hash: manifestHash, output}, true)
        return
      }
      if (output) {
        console.log(output)
        return
      }
      process.stdout.write(manifestJson)
    })
  distributed.addCommand(aggregation)
  fusion.addCommand(distributed)

  fusion
    .command('expert-metadata <expert_role> <fusion_parent_model_id>')
    .description('Print metadata JSON for expert training jobs and submissions')
    .option('--metadata <json>', 'additional metadata JSON object')
    .option('--json', 'print JSON')
    .action((expertRole: string, fusionParentModelId: string, options: {metadata?: string; json?: boolean}) => {
      const metadata = {
        ...(options.metadata ? parseObjectJson(options.metadata, 'metadata') : {}),
        training_kind: 'expert',
        expert_role: expertRole,
        fusion_parent_model_id: positiveUint64(fusionParentModelId, 'fusion parent model id'),
      }
      if (options.json) {
        printResult({metadata, metadata_json: JSON.stringify(metadata)}, true)
        return
      }
      console.log(JSON.stringify(metadata))
    })

  ai.addCommand(fusion)
}

function group(name: string, description: string, specs: AiActionSpec[]): Command {
  const cmd = new Command(name)
  cmd.description(description)
  for (const spec of specs) {
    addAiAction(cmd, spec)
  }
  return cmd
}

export function createAiCommand(): Command {
  const ai = new Command('ai')
  ai.description('Manage Harbor AI models, tuning, training, inference, and routing')
  addOfferCommand(ai)
  addTrustCommand(ai)
  addRlvrCommand(ai)
  addDataCommand(ai)
  addFusionCommand(ai)

  addAiAction(ai, {
    command: 'configure',
    action: 'setparams',
    fields: [
      'token_symbol',
      'token_contract',
      'storage_contract',
      'svcmarket_contract',
      ['max_title_size', 'number'],
      ['max_metadata_size', 'number'],
      ['tune_threshold_bps', 'number'],
      ['tune_quorum_bps', 'number'],
      ['min_train_scores', 'number'],
    ],
  })
  addAiAction(ai, {
    command: 'configure-selection',
    action: 'setaiparams',
    fields: [
      ['max_candidates', 'number'],
      ['max_ranked_choices', 'number'],
      ['min_qualification_reviews', 'number'],
      ['min_bakeoff_scores', 'number'],
      ['community_quorum_bps', 'number'],
      ['max_voice_weight', 'uint64'],
      ['voice_epoch_sec', 'number'],
      ['runoff_sec', 'number'],
    ],
  })
  addAiAction(ai, {command: 'claim', action: 'claim', fields: ['owner', 'quantity'], signerField: 'owner'})

  ai.addCommand(group('artifact', 'Register Harbor AI artifact references', [
    {
      command: 'add',
      action: 'addartifact',
      fields: ['owner', ['kind', 'number'], ['storage_object_id', 'uint64'], 'content_hash', 'metadata'],
      signerField: 'owner',
    },
  ]))

  ai.addCommand(group('model', 'Register and retire AI models', [
    {
      command: 'register',
      action: 'regmodel',
      fields: ['owner', ['model_type', 'number'], ['parent_model_id', 'uint64'], ['weights_artifact_id', 'uint64'], ['eval_artifact_id', 'uint64'], 'title', 'metadata'],
      signerField: 'owner',
    },
    {
      command: 'register-remote',
      action: 'regremote',
      fields: [
        'owner', ['model_type', 'number'], ['parent_model_id', 'uint64'],
        ['manifest_artifact_id', 'uint64'], 'revision_hash', ['terms_artifact_id', 'uint64'],
        ['output_distillation_allowed', 'boolean'], ['requires_session_affinity', 'boolean'],
        ['preserve_thinking_history', 'boolean'], ['eval_artifact_id', 'uint64'],
        'api_model_id', 'title', 'metadata',
      ],
      signerField: 'owner',
    },
    {
      command: 'set',
      action: 'setmodel',
      fields: ['owner', ['model_id', 'uint64'], ['weights_artifact_id', 'uint64'], ['eval_artifact_id', 'uint64'], ['status', 'number'], 'title', 'metadata'],
      signerField: 'owner',
    },
    {
      command: 'adopt-weights',
      action: 'adoptweight',
      fields: ['owner', ['model_id', 'uint64'], ['weights_artifact_id', 'uint64']],
      signerField: 'owner',
    },
    {
      command: 'bind-custody',
      action: 'bindmodel',
      fields: [
        'actor', ['model_id', 'uint64'], ['weights_artifact_id', 'uint64'],
        'vault_contract', ['vault_receipt_id', 'uint64'],
      ],
      signerField: 'actor',
    },
    {
      command: 'set-tokenizer',
      action: 'settokenizer',
      fields: [
        'actor', ['model_id', 'uint64'], ['tokenizer_artifact_id', 'uint64'],
        'tokenizer_hash', ['vocab_size', 'number'], ['format_version', 'number'],
      ],
      signerField: 'actor',
    },
  ]))

  ai.addCommand(group('program', 'Manage specialized model programs and exact model specifications', [
    {
      command: 'add',
      action: 'addprogram',
      fields: ['owner', ['current_model_id', 'uint64'], ['current_compute_class', 'number'], ['eval_artifact_id', 'uint64'], 'title', 'metadata'],
      signerField: 'owner',
    },
    {
      command: 'set-model-spec',
      action: 'setmodelspec',
      fields: [
        'owner', ['model_id', 'uint64'], ['program_id', 'uint64'], 'revision_hash',
        ['license_artifact_id', 'uint64'], ['compute_class', 'number'], ['total_params_m', 'uint64'],
        ['active_params_m', 'uint64'], ['context_tokens', 'number'], ['required_vram_mb', 'number'],
        ['training_methods', 'number'], 'metadata',
      ],
      signerField: 'owner',
    },
    {command: 'close', action: 'closeprogram', fields: ['owner', ['program_id', 'uint64']], signerField: 'owner'},
    {
      command: 'finalize',
      action: 'finalizeprog',
      fields: ['actor', ['program_id', 'uint64']],
      signerField: 'actor',
    },
    {
      command: 'recover',
      action: 'recoverprog',
      fields: ['actor', ['program_id', 'uint64']],
      signerField: 'actor',
    },
    {
      command: 'reclaim-credit',
      action: 'reclaimcred',
      fields: ['owner', ['program_id', 'uint64']],
      signerField: 'owner',
    },
    {
      command: 'admit-tier',
      action: 'admintier',
      fields: ['owner', ['program_id', 'uint64'], ['model_id', 'uint64']],
      signerField: 'owner',
    },
    {
      command: 'migrate-serving',
      action: 'migserving',
      fields: [['max_rows', 'number']],
    },
  ]))

  ai.addCommand(group('provider', 'Subscribe AI providers and publish model deployment offers', [
    {
      command: 'subscribe',
      action: 'subscribe',
      fields: ['provider', ['program_id', 'uint64'], ['roles', 'number'], ['max_compute_class', 'number'], ['capacity_units', 'uint64'], 'bond', ['expires_sec', 'number'], 'metadata'],
      signerField: 'provider',
    },
    {command: 'unsubscribe', action: 'unsub', fields: ['provider', ['subscription_id', 'uint64']], signerField: 'provider'},
    {
      command: 'clean-subscriptions',
      action: 'cleansubs',
      fields: ['provider', ['start_id', 'uint64'], ['max_rows', 'number']],
      signerField: 'provider',
    },
    {
      command: 'seed-training-contribution',
      action: 'seedtraincon',
      fields: [['submission_id', 'uint64'], ['model_id', 'uint64']],
    },
    {
      command: 'seed-inference-contribution',
      action: 'seedinfercon',
      fields: [['deployment_id', 'uint64']],
      disabledReason: DISABLED_INFERENCE_SEED,
    },
    {
      command: 'deploy',
      action: 'setdeploy',
      fields: [
        'provider', ['deployment_id', 'uint64'], ['model_id', 'uint64'], ['program_id', 'uint64'], ['active', 'boolean'],
        'input_price_million', 'output_price_million', 'min_fee', ['capacity_tokens_min', 'uint64'],
        ['p95_latency_ms', 'number'], 'metadata',
      ],
      signerField: 'provider',
    },
    {
      command: 'configure-deployment',
      action: 'setdepcfg',
      fields: [
        'provider', ['deployment_id', 'uint64'], ['execution_mode', 'number'],
        ['source_model_id', 'uint64'], ['topology_artifact_id', 'uint64'], ['node_count', 'number'],
        ['aggregate_memory_mb', 'uint64'], ['min_node_memory_mb', 'uint64'], ['interconnect', 'number'],
        'sharding_hash', 'runtime_hash', ['validated_context_tokens', 'number'], 'metadata',
      ],
      signerField: 'provider',
    },
    {
      command: 'set-signal-capabilities',
      action: 'setdepcaps',
      fields: [
        'provider', ['deployment_id', 'uint64'], ['signals', 'number'], ['max_top_k', 'number'],
        'tokenizer_hash', 'runtime_hash', 'signal_schema_hash', 'attestation_hash', 'metadata',
      ],
      signerField: 'provider',
    },
    {
      command: 'bind-deployment-access',
      action: 'binddepacc',
      fields: [
        'provider', ['deployment_id', 'uint64'], 'vault_contract',
        ['vault_receipt_id', 'uint64'], ['vault_grant_id', 'uint64'],
        ['vault_use_id', 'uint64'], 'purpose_hash', 'use_hash',
      ],
      signerField: 'provider',
    },
    {
      command: 'prune-deployment',
      action: 'prunedeploy',
      fields: ['actor', ['deployment_id', 'uint64']],
      signerField: 'actor',
    },
  ]))

  const tune = group('tune', 'Request and vote on community fine-tunes', [
    {
      command: 'propose',
      action: 'proptune',
      fields: ['proposer', ['base_model_id', 'uint64'], ['dataset_artifact_id', 'uint64'], ['eval_artifact_id', 'uint64'], 'title', 'metadata', ['expires_sec', 'number']],
      signerField: 'proposer',
    },
    {
      command: 'request',
      action: 'proptune',
      fields: ['proposer', ['base_model_id', 'uint64'], ['dataset_artifact_id', 'uint64'], ['eval_artifact_id', 'uint64'], 'title', 'metadata', ['expires_sec', 'number']],
      signerField: 'proposer',
    },
    {command: 'vote', action: 'votetune', fields: ['voter', ['tune_id', 'uint64'], ['approve', 'boolean'], 'quantity'], signerField: 'voter'},
    {command: 'close', action: 'closetune', fields: [['tune_id', 'uint64']]},
    {command: 'reclaim', action: 'reclaim', fields: ['voter', ['tune_id', 'uint64']], signerField: 'voter'},
    {
      command: 'contribute-data',
      action: 'contribdata',
      fields: ['contributor', ['tune_id', 'uint64'], ['dataset_artifact_id', 'uint64'], ['reward_weight', 'number'], 'metadata'],
      signerField: 'contributor',
      disabledReason: DISABLED_DATA_CONTRIBUTION,
    },
    {
      command: 'reward-data',
      action: 'rewarddata',
      fields: ['payer', ['tune_id', 'uint64'], 'reward', 'memo'],
      signerField: 'payer',
      disabledReason: DISABLED_DATA_REWARD,
    },
  ])
  addTuneNeedsCommand(tune)
  addTuneAutoVoteCommand(tune)
  ai.addCommand(tune)

  ai.addCommand(group('promotion', 'Select and launch larger specialist model tiers', [
    {
      command: 'open',
      action: 'openround',
      fields: [
        'proposer', ['program_id', 'uint64'], ['target_compute_class', 'number'], 'min_demand',
        'training_budget', ['min_training_providers', 'number'], ['min_inference_providers', 'number'],
        ['min_quality_bps', 'number'], ['min_safety_bps', 'number'], ['nomination_sec', 'number'],
        ['voting_sec', 'number'], 'metadata',
      ],
      signerField: 'proposer',
    },
    {
      command: 'nominate',
      action: 'nominate',
      fields: [
        'proposer', ['round_id', 'uint64'], ['base_model_id', 'uint64'], ['dataset_artifact_id', 'uint64'],
        ['eval_artifact_id', 'uint64'], 'estimated_training_cost', 'estimated_input_price_million',
        'estimated_output_price_million', 'title', 'metadata',
      ],
      signerField: 'proposer',
    },
    {
      command: 'qualify',
      action: 'qualify',
      fields: ['validator', ['candidate_id', 'uint64'], ['approve', 'boolean'], ['license_ok', 'boolean'], ['reproducible', 'boolean'], ['serving_ok', 'boolean'], 'report_hash'],
      signerField: 'validator',
    },
    {
      command: 'score-bakeoff',
      action: 'scorebake',
      fields: ['validator', ['candidate_id', 'uint64'], ['quality_bps', 'number'], ['blind_preference_bps', 'number'], ['safety_bps', 'number'], ['cost_efficiency_bps', 'number'], ['transfer_bps', 'number'], 'report_hash'],
      signerField: 'validator',
    },
    {
      command: 'commit-provider',
      action: 'commitcand',
      fields: ['provider', ['candidate_id', 'uint64'], ['roles', 'number'], ['capacity_units', 'uint64'], 'quoted_cost', 'metadata'],
      signerField: 'provider',
    },
    {command: 'pledge-demand', action: 'pledgedemand', fields: ['supporter', ['candidate_id', 'uint64'], 'quantity'], signerField: 'supporter'},
    {command: 'start-vote', action: 'startround', fields: [['round_id', 'uint64']]},
    {command: 'expire', action: 'expireround', fields: [['round_id', 'uint64']]},
    {command: 'vote-user', action: 'voteuser', fields: ['voter', ['round_id', 'uint64'], ['rankings', 'uint64[]']], signerField: 'voter'},
    {command: 'vote-community', action: 'votecomm', fields: ['voter', ['round_id', 'uint64'], ['rankings', 'uint64[]'], 'quantity'], signerField: 'voter'},
    {command: 'close', action: 'closeround', fields: [['round_id', 'uint64']]},
    {command: 'settle-demand', action: 'settledem', fields: ['supporter', ['round_id', 'uint64']], signerField: 'supporter'},
    {command: 'reclaim-vote', action: 'reclaimvote', fields: ['voter', ['round_id', 'uint64']], signerField: 'voter'},
    {command: 'claim-round', action: 'claimround', fields: ['proposer', ['round_id', 'uint64']], signerField: 'proposer'},
    {
      command: 'add-milestone',
      action: 'addmile',
      fields: ['proposer', ['candidate_id', 'uint64'], 'payee', 'amount', 'title', 'metadata'],
      signerField: 'proposer',
    },
    {command: 'approve-milestone', action: 'approvemile', fields: ['validator', ['milestone_id', 'uint64'], 'report_hash'], signerField: 'validator'},
    {command: 'release-milestone', action: 'releasemile', fields: [['milestone_id', 'uint64'], 'evidence_hash']},
    {
      command: 'adjudicate-milestone',
      action: 'adjudmile',
      fields: [['milestone_id', 'uint64'], ['honor', 'boolean'], 'decision_hash'],
    },
    {command: 'start-training', action: 'startpromo', fields: ['creator', ['round_id', 'uint64'], ['max_submissions', 'number'], 'metadata', ['expires_sec', 'number']], signerField: 'creator'},
    {
      command: 'attest-canary',
      action: 'attestpromo',
      fields: ['router', ['round_id', 'uint64'], ['infer_id', 'uint64'], ['svc_check_id', 'uint64']],
      signerField: 'router',
    },
    {command: 'launch', action: 'launchpromo', fields: ['owner', ['round_id', 'uint64']], signerField: 'owner'},
    {command: 'expire-execution', action: 'expirepromo', fields: [['round_id', 'uint64']]},
    {command: 'migrate-stages', action: 'migpromos', fields: [['max_rows', 'number']]},
    {
      command: 'migrate-funding',
      action: 'migpromfund',
      fields: [['round_id', 'uint64'], ['max_rows', 'number']],
    },
    {command: 'migrate-active-rounds', action: 'migactpromo', fields: [['max_rows', 'number']]},
    {
      command: 'clean-round',
      action: 'cleanpromo',
      fields: [['round_id', 'uint64'], ['max_rows', 'number']],
    },
  ]))

  ai.addCommand(group('attestation', 'Challenge and settle bonded AI attestations', [
    {
      command: 'configure',
      action: 'setattestcfg',
      fields: [['challenge_sec', 'number'], ['resolution_sec', 'number']],
    },
    {
      command: 'challenge',
      action: 'challattest',
      fields: [
        'challenger', ['kind', 'number'], ['subject_id', 'uint64'],
        'challenge_hash',
      ],
      signerField: 'challenger',
    },
    {
      command: 'resolve',
      action: 'resolveatt',
      fields: [
        ['kind', 'number'], ['subject_id', 'uint64'], ['uphold', 'boolean'],
        'decision_hash',
      ],
    },
    {
      command: 'settle',
      action: 'settleattest',
      fields: [['kind', 'number'], ['subject_id', 'uint64']],
    },
    {
      command: 'expire',
      action: 'expireattest',
      fields: [['kind', 'number'], ['subject_id', 'uint64']],
    },
  ]))

  ai.addCommand(group('treasury', 'Govern protocol-retained AI signal funds', [
    {
      command: 'spend-signal',
      action: 'spendsignal',
      fields: [
        'recipient', 'inference_quantity', 'demand_quantity',
        'purpose_hash', 'memo',
      ],
    },
  ]))

  ai.addCommand(group('train', 'Run Harbor AI training job lifecycle actions', [
    {
      command: 'start',
      action: 'starttrain',
      fields: ['creator', ['tune_id', 'uint64'], ['base_model_id', 'uint64'], ['dataset_artifact_id', 'uint64'], 'reward', ['max_submissions', 'number'], 'metadata', ['expires_sec', 'number']],
      signerField: 'creator',
    },
    {
      command: 'submit',
      action: 'submittrain',
      fields: ['trainer', ['train_id', 'uint64'], ['weights_artifact_id', 'uint64'], 'metrics_hash', 'metadata'],
      signerField: 'trainer',
    },
    {
      command: 'attest-lineage',
      action: 'attestline',
      fields: [
        'trainer', ['submission_id', 'uint64'], ['output_object_id', 'uint64'],
        ['output_policy_id', 'uint64'], 'output_lineage_hash', 'attestation_hash',
      ],
      signerField: 'trainer',
    },
    {
      command: 'score',
      action: 'scoretrain',
      fields: ['validator', ['submission_id', 'uint64'], ['score', 'number'], 'report_hash'],
      signerField: 'validator',
    },
    {command: 'settle', action: 'settletrain', fields: [['train_id', 'uint64']]},
    {
      command: 'cancel',
      action: 'canceltrain',
      fields: ['actor', ['train_id', 'uint64']],
      signerField: 'actor',
    },
    {
      command: 'clean',
      action: 'cleantrain',
      fields: [['train_id', 'uint64'], ['max_rows', 'number']],
    },
  ]))

  ai.addCommand(group('distill', 'Run consented, batched specialist distillation campaigns', [
    {
      command: 'open',
      action: 'opendistill',
      fields: [
        'owner', ['program_id', 'uint64'], ['tune_id', 'uint64'], ['teacher_model_id', 'uint64'],
        ['required_scopes', 'number'], ['discount_bps', 'number'], 'max_discount_per_infer',
        'discount_fund', ['min_batch_samples', 'number'], ['max_batch_samples', 'number'],
        ['min_quality_bps', 'number'], ['min_safety_bps', 'number'], ['min_transfer_bps', 'number'],
        ['min_canary_requests', 'uint64'], ['min_canary_success_bps', 'number'],
        'title', 'metadata',
      ],
      signerField: 'owner',
    },
    {command: 'fund', action: 'funddistill', fields: ['payer', ['campaign_id', 'uint64'], 'quantity'], signerField: 'payer'},
    {
      command: 'set-protocol',
      action: 'setdistproto',
      fields: [
        'owner', ['campaign_id', 'uint64'], 'vault_contract', ['raw_policy_id', 'uint64'],
        ['sanitized_policy_id', 'uint64'], ['required_signals', 'number'], ['min_top_k', 'number'],
        ['review_quorum', 'number'], ['approval_quorum', 'number'], ['sample_ttl_sec', 'number'],
        'user_admission_reward', 'provider_admission_reward', 'promotion_reward', 'metadata',
      ],
      signerField: 'owner',
    },
    {
      command: 'set-token-translation',
      action: 'setdisttok',
      fields: [
        'owner', ['campaign_id', 'uint64'], ['translation_artifact_id', 'uint64'],
        ['translation_version', 'number'],
      ],
      signerField: 'owner',
    },
    {command: 'fund-sample-rewards', action: 'fundsamprwd', fields: ['payer', ['campaign_id', 'uint64'], 'quantity'], signerField: 'payer'},
    {command: 'close', action: 'closedistill', fields: ['owner', ['campaign_id', 'uint64']], signerField: 'owner'},
    {command: 'claim', action: 'claimdistill', fields: ['owner', ['campaign_id', 'uint64'], 'quantity'], signerField: 'owner'},
    {command: 'claim-sample-pool', action: 'claimsampool', fields: ['owner', ['campaign_id', 'uint64'], 'quantity'], signerField: 'owner'},
    {command: 'migrate-batches', action: 'migbatches', fields: [['max_rows', 'number']]},
    {command: 'clean-batch', action: 'cleanbatch', fields: [['batch_id', 'uint64'], ['max_rows', 'number']]},
    {command: 'consent', action: 'setconsent', fields: ['user', ['campaign_id', 'uint64'], ['scopes', 'number'], ['expires_sec', 'number']], signerField: 'user'},
    {command: 'revoke-consent', action: 'revokecons', fields: ['user', ['program_id', 'uint64']], signerField: 'user'},
    {command: 'opt-in', action: 'optindata', fields: ['user', ['infer_id', 'uint64'], ['campaign_id', 'uint64']], signerField: 'user'},
    {
      command: 'bind-data-consent',
      action: 'binddatacons',
      fields: ['user', ['infer_id', 'uint64'], ['vault_consent_id', 'uint64']],
      signerField: 'user',
    },
    {
      command: 'commit-sample',
      action: 'commitsample',
      fields: [
        'provider', ['infer_id', 'uint64'], ['signals', 'number'], ['top_k', 'number'],
        'envelope_hash', 'signal_hash', 'tail_mass_hash', ['vault_object_id', 'uint64'],
        ['vault_policy_id', 'uint64'], ['vault_consent_id', 'uint64'],
        ['vault_receipt_id', 'uint64'], ['review_grant_id', 'uint64'], 'vault_object_hash',
        'key_envelope_hash', ['svc_check_id', 'uint64'], ['expires_sec', 'number'], 'metadata',
      ],
      signerField: 'provider',
    },
    {
      command: 'review-sample',
      action: 'reviewsample',
      fields: [
        'validator', ['infer_id', 'uint64'], ['approve', 'boolean'],
        ['structure_ok', 'boolean'], ['replay_ok', 'boolean'], ['rights_ok', 'boolean'],
        ['privacy_ok', 'boolean'], ['review_grant_id', 'uint64'],
        ['svc_check_id', 'uint64'], 'report_hash',
      ],
      signerField: 'validator',
    },
    {command: 'resolve-sample', action: 'resolvesamp', fields: [['infer_id', 'uint64']]},
    {command: 'expire-sample', action: 'expiresample', fields: [['infer_id', 'uint64']]},
    {command: 'expire-data', action: 'expiredata', fields: ['actor', ['infer_id', 'uint64']], signerField: 'actor'},
    {command: 'claim-sample-reward', action: 'claimsreward', fields: ['actor', ['infer_id', 'uint64']], signerField: 'actor'},
    {command: 'open-batch', action: 'openbatch', fields: ['owner', ['campaign_id', 'uint64'], 'curator', 'metadata'], signerField: 'owner'},
    {command: 'add-sample', action: 'addsample', fields: ['curator', ['batch_id', 'uint64'], ['infer_id', 'uint64'], 'evidence_hash'], signerField: 'curator'},
    {command: 'withdraw-sample', action: 'withdrawsamp', fields: ['requester', ['infer_id', 'uint64']], signerField: 'requester'},
    {command: 'cancel-batch', action: 'cancelbatch', fields: ['actor', ['batch_id', 'uint64']], signerField: 'actor'},
    {command: 'expire-batch', action: 'expirebatch', fields: [['batch_id', 'uint64']]},
    {
      command: 'set-batch-spec',
      action: 'setbatchspec',
      fields: [
        'curator', ['batch_id', 'uint64'], ['dataset_object_id', 'uint64'],
        ['dataset_policy_id', 'uint64'], ['transform_id', 'uint64'],
        ['recipe_artifact_id', 'uint64'], 'dataset_hash', 'input_lineage_hash',
        'recipe_hash', 'metadata',
      ],
      signerField: 'curator',
    },
    {command: 'seal-batch', action: 'sealbatch', fields: ['curator', ['batch_id', 'uint64'], ['dataset_artifact_id', 'uint64']], signerField: 'curator'},
    {
      command: 'grant-batch',
      action: 'grantbatch',
      fields: [
        'actor', ['batch_id', 'uint64'], 'processor', ['vault_grant_id', 'uint64'],
        ['vault_policy_id', 'uint64'], 'purpose_hash', ['max_uses', 'number'],
        ['expires_sec', 'number'],
      ],
      signerField: 'actor',
    },
    {
      command: 'revoke-batch-grant',
      action: 'revokebgrant',
      fields: ['actor', ['batch_id', 'uint64'], 'processor'],
      signerField: 'actor',
    },
    {
      command: 'start-batch',
      action: 'startdistill',
      fields: ['creator', ['batch_id', 'uint64'], 'reward', ['max_submissions', 'number'], 'metadata', ['expires_sec', 'number']],
      signerField: 'creator',
    },
    {
      command: 'score-batch',
      action: 'scorebatch',
      fields: ['validator', ['batch_id', 'uint64'], ['quality_bps', 'number'], ['safety_bps', 'number'], ['transfer_bps', 'number'], 'report_hash'],
      signerField: 'validator',
    },
    {
      command: 'plan-canary',
      action: 'plancanary',
      fields: ['owner', ['batch_id', 'uint64'], 'router', ['max_requests', 'number']],
      signerField: 'owner',
    },
    {
      command: 'record-canary',
      action: 'recordcanary',
      fields: [
        'router', ['batch_id', 'uint64'], ['infer_id', 'uint64'], ['route_log_id', 'uint64'],
        ['svc_check_id', 'uint64'], ['success', 'boolean'], 'evidence_hash',
      ],
      signerField: 'router',
    },
    {
      command: 'report-canary',
      action: 'reportcanary',
      fields: ['router', ['batch_id', 'uint64'], ['request_count', 'number'], ['success_count', 'number'], 'evidence_hash'],
      signerField: 'router',
    },
    {command: 'promote-batch', action: 'promotebatch', fields: ['owner', ['batch_id', 'uint64']], signerField: 'owner'},
  ]))

  ai.addCommand(group('infer', 'Request and settle Harbor AI inference jobs', [
    {
      command: 'request',
      action: 'reqinfer',
      fields: ['requester', ['model_id', 'uint64'], 'prompt_hash', ['max_input_tokens', 'number'], ['max_output_tokens', 'number'], 'max_fee', 'metadata'],
      signerField: 'requester',
    },
    {
      command: 'assign-exact',
      action: 'assignexact',
      fields: ['requester', ['infer_id', 'uint64'], 'provider'],
      signerField: 'requester',
    },
    {
      command: 'commit-seed',
      action: 'commitseed',
      fields: ['requester', ['infer_id', 'uint64'], 'seed_commitment'],
      signerField: 'requester',
    },
    {
      command: 'complete',
      action: 'completeinf',
      fields: ['provider', ['infer_id', 'uint64'], 'result_hash', ['input_tokens', 'number'], ['output_tokens', 'number'], 'fee', 'metadata'],
      signerField: 'provider',
    },
    {
      command: 'accept',
      action: 'acceptinfer',
      fields: ['provider', ['infer_id', 'uint64'], 'start_hash'],
      signerField: 'provider',
    },
    {
      command: 'acknowledge',
      action: 'ackinfer',
      fields: ['requester', ['infer_id', 'uint64'], 'acceptance_hash'],
      signerField: 'requester',
    },
    {
      command: 'settle',
      action: 'settleinf',
      fields: ['actor', ['infer_id', 'uint64'], ['svc_check_id', 'uint64']],
      signerField: 'actor',
    },
    {
      command: 'challenge',
      action: 'challenginf',
      fields: [
        'requester', ['infer_id', 'uint64'], ['svc_check_id', 'uint64'],
        'evidence_hash', 'selection_reveal',
      ],
      signerField: 'requester',
    },
    {
      command: 'resolve',
      action: 'resolveinf',
      fields: ['actor', ['infer_id', 'uint64'], ['svc_check_id', 'uint64']],
      signerField: 'actor',
    },
    {command: 'fail', action: 'failjob', fields: ['actor', ['infer_id', 'uint64'], 'reason_hash', 'metadata'], signerField: 'actor'},
    {command: 'cancel', action: 'canceljob', fields: ['requester', ['infer_id', 'uint64']], signerField: 'requester'},
    {command: 'expire', action: 'expireinfer', fields: ['actor', ['infer_id', 'uint64']], signerField: 'actor'},
  ]))

  ai.addCommand(group('session', 'Create session-affine routed inference for preserved model history', [
    {
      command: 'open',
      action: 'opensess',
      fields: ['requester', ['program_id', 'uint64'], ['preserve_thinking_history', 'boolean'], ['expires_sec', 'number'], 'metadata'],
      signerField: 'requester',
    },
    {command: 'close', action: 'closesess', fields: ['requester', ['session_id', 'uint64']], signerField: 'requester'},
    {
      command: 'request',
      action: 'reqsession',
      fields: [
        'requester', ['session_id', 'uint64'], ['min_compute_class', 'number'], ['max_compute_class', 'number'],
        ['routing_policy', 'number'], 'prompt_hash', ['max_input_tokens', 'number'], ['max_output_tokens', 'number'],
        'max_fee', ['max_latency_ms', 'number'], ['allow_escalation', 'boolean'], 'metadata',
      ],
      signerField: 'requester',
    },
  ]))

  ai.addCommand(group('route', 'Configure and audit AI routing decisions', [
    {
      command: 'request',
      action: 'reqroute',
      fields: [
        'requester', ['program_id', 'uint64'], ['min_compute_class', 'number'], ['max_compute_class', 'number'],
        ['routing_policy', 'number'], 'prompt_hash', ['max_input_tokens', 'number'], ['max_output_tokens', 'number'],
        'max_fee', ['max_latency_ms', 'number'], ['allow_escalation', 'boolean'], 'metadata',
      ],
      signerField: 'requester',
    },
    {
      command: 'quote',
      action: 'quoteinfer',
      fields: ['router', ['infer_id', 'uint64'], ['deployment_id', 'uint64'], 'max_fee', ['expires_sec', 'number'], 'reason_hash', 'metadata'],
      signerField: 'router',
    },
    {command: 'assign', action: 'assigninfer', fields: ['router', ['infer_id', 'uint64'], ['quote_id', 'uint64']], signerField: 'router'},
    {
      command: 'policy',
      action: 'setroutepol',
      fields: ['owner', ['policy_id', 'uint64'], ['default_model_id', 'uint64'], ['classifier_model_id', 'uint64'], ['token_interval', 'number'], 'metadata'],
      signerField: 'owner',
    },
    {
      command: 'log',
      action: 'logroute',
      fields: ['router', ['policy_id', 'uint64'], ['infer_id', 'uint64'], 'request_hash', ['selected_model_id', 'uint64'], ['token_start', 'number'], ['token_end', 'number'], ['classifier_model_id', 'uint64'], ['confidence_bps', 'number'], 'metadata'],
      signerField: 'router',
    },
    {
      command: 'subcall',
      action: 'logsubcall',
      fields: ['caller', ['parent_infer_id', 'uint64'], ['from_model_id', 'uint64'], ['to_model_id', 'uint64'], 'call_hash', ['token_start', 'number'], ['token_end', 'number'], 'metadata'],
      signerField: 'caller',
    },
  ]))

  return ai
}
