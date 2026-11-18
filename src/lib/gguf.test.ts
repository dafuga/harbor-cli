import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {verifyQwenGguf} from './gguf.js'

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value)
  return bytes
}

function u64(value: number): Buffer {
  return Buffer.concat([u32(value), u32(0)])
}

function str(value: string): Buffer {
  return Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)])
}

test('checks the Qwen3 8B architecture and 4-bit quantization in GGUF metadata', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-gguf-'))
  t.after(() => fs.rm(directory, {recursive: true, force: true}))
  const file = path.join(directory, 'weights.gguf')
  const header = (type: number) => Buffer.concat([
    Buffer.from('GGUF'), u32(3), u64(1), u64(5),
    str('general.architecture'), u32(8), str('qwen3'),
    str('qwen3.block_count'), u32(4), u32(36),
    str('qwen3.embedding_length'), u32(4), u32(4096),
    str('tokenizer.ggml.tokens'), u32(9), u32(8), u64(2), str('first'), str('second'),
    str('general.file_type'), u32(4), u32(type),
  ])
  await fs.writeFile(file, header(15))
  await verifyQwenGguf(file)
  await fs.writeFile(file, header(7))
  await assert.rejects(verifyQwenGguf(file), /Q4_K_M/)
})
