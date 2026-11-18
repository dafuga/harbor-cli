import assert from 'node:assert/strict'
import test from 'node:test'
import {localModel} from './local-model.js'

test('Qwen3 selects 4B for 8 GiB and 8B by default on higher-memory systems', () => {
  assert.equal(localModel('auto', 8 * 2 ** 30).model, 'qwen3:4b-q4_K_M')
  assert.equal(localModel('auto', 64 * 2 ** 30).model, 'qwen3:8b-q4_K_M')
  assert.equal(localModel('flagship', 16 * 2 ** 30).expert_adapter_base, 'Qwen/Qwen3-8B')
})

test('the 27B profile is explicitly selected and needs 48 GiB', () => {
  assert.throws(() => localModel('large', 47 * 2 ** 30), /48 GiB/)
  assert.equal(localModel('large', 48 * 2 ** 30).model, 'qwen3.5:27b-q4_K_M')
})
