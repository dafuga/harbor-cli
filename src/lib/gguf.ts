import fs from 'node:fs/promises'

const integerSizes = [1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8]
const retained = new Set(['general.architecture', 'general.file_type', 'qwen3.block_count', 'qwen3.embedding_length'])

export async function verifyQwenGguf(file: string): Promise<void> {
  const handle = await fs.open(file, 'r')
  let data: Buffer
  try {
    const {size} = await handle.stat()
    const header = Buffer.alloc(Math.min(size, 32 * 2 ** 20))
    const {bytesRead} = await handle.read(header, 0, header.length, 0)
    data = header.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  const model = new Map<string, number | string>()
  let offset = 16
  function take(length: number): number {
    const start = offset
    offset += length
    if (!Number.isSafeInteger(offset) || offset > data.length) throw new Error('GGUF metadata is truncated or too large')
    return start
  }
  const int32 = () => data.readUInt32LE(take(4))
  const int64 = () => Number(data.readBigUInt64LE(take(8)))
  function string(read: boolean): string {
    const length = int64()
    const start = take(length)
    return read ? data.toString('utf8', start, offset) : ''
  }
  function skip(type: number): void {
    const width = integerSizes[type]
    if (width) take(width)
    else if (type === 8) string(false)
    else throw new Error('unsupported GGUF metadata type')
  }
  if (data.length < 24 || data.toString('ascii', 0, 4) !== 'GGUF' || ![2, 3].includes(data.readUInt32LE(4))) {
    throw new Error('expected a GGUF version 2 or 3 file')
  }
  const count = int64()
  for (let i = 0; i < count && model.size < retained.size; i++) {
    const key = string(true)
    const type = int32()
    if (retained.has(key) && (type === 4 || type === 8 || type === 10)) {
      model.set(key, type === 4 ? int32() : type === 10 ? int64() : string(true))
    } else if (type === 9) {
      const element = int32()
      const length = int64()
      const width = integerSizes[element]
      if (width) take(width * length)
      else for (let item = 0; item < length; item++) skip(element)
    } else {
      skip(type)
    }
  }
  if (model.get('general.architecture') !== 'qwen3' || model.get('general.file_type') !== 15 ||
      model.get('qwen3.block_count') !== 36 || model.get('qwen3.embedding_length') !== 4096) {
    throw new Error('managed llama.cpp requires a Qwen3 8B Q4_K_M base GGUF')
  }
}
