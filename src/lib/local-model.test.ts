import assert from 'node:assert/strict'
import test from 'node:test'
import {localModel} from './local-model.js'

test('Qwen3 8B Q4 remains the legacy auto profile and reports whether it fits the cap', () => {
  assert.equal(localModel('auto', 8 * 2 ** 30).model, 'qwen3:8b-q4_K_M')
  assert.equal(localModel('auto', 8 * 2 ** 30).fits_memory_cap, false)
  assert.equal(localModel('auto', 15 * 2 ** 30, 15 * 2 ** 30).fits_memory_cap, false)
  assert.equal(localModel('auto', 16 * 2 ** 30).fits_memory_cap, true)
  const flagship = localModel('flagship', 16 * 2 ** 30)
  assert.ok('expert_adapter_base' in flagship)
  assert.equal(flagship.expert_adapter_base, 'Qwen/Qwen3-8B')
})

test('alternate model sizes are rejected', () => {
  assert.throws(() => localModel('large', 64 * 2 ** 30), /Qwen3 8B 4-bit/)
  assert.throws(() => localModel('compact', 8 * 2 ** 30), /Qwen3 8B 4-bit/)
})

test('Harbor runtime profiles distinguish MLX and both pinned Inkling tiers', () => {
  assert.equal(localModel('qwen3-8b-mlx').model, 'qwen3:8b-mlx-4bit')
  assert.equal(localModel('inkling-8', 24 * 2 ** 30).model, 'inkling-2-mini:8.33gb')
  assert.equal(localModel('inkling-12', 64 * 2 ** 30, 12 * 2 ** 30).fits_memory_cap, false)
})
