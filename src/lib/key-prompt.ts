import {timingSafeEqual} from 'node:crypto'
import {openSync, readSync} from 'node:fs'
import {ReadStream} from 'node:tty'

const MAX_INPUT_BYTES = 1024

function readHidden(prompt: string): Promise<Buffer> {
  let input: ReadStream
  try {
    input = new ReadStream(openSync('/dev/tty', 'r'))
  } catch {
    throw new Error('secure key input requires an interactive terminal')
  }
  const bytes = Buffer.alloc(MAX_INPUT_BYTES)
  let length = 0
  return new Promise((resolve, reject) => {
    let finished = false
    function finish(error?: Error) {
      if (finished) return
      finished = true
      try {
        input.setRawMode(false)
      } finally {
        input.destroy()
        process.stderr.write('\n')
        if (error) reject(error)
        else resolve(Buffer.from(bytes.subarray(0, length)))
        bytes.fill(0)
      }
    }
    input.setRawMode(true)
    process.stderr.write(prompt)
    input.once('error', finish)
    input.once('end', () => finish(new Error('secure key input ended')))
    input.on('data', (chunk: Buffer) => {
      try {
        for (const byte of chunk) {
          if (byte === 10 || byte === 13) return finish()
          if (byte === 3 || byte === 4) return finish(new Error('secure key input cancelled'))
          if (byte === 21) length = 0
          else if (byte === 8 || byte === 127) {
            if (length) {
              // Remove one UTF-8 character, including any continuation bytes.
              do length--
              while (length && (bytes[length] & 0xc0) === 0x80)
            }
          } else if (byte >= 32) {
            if (length === bytes.length) return finish(new Error('secure key input is too long'))
            bytes[length++] = byte
          }
        }
      } finally {
        chunk.fill(0)
      }
    })
  })
}

function readPasswordFD(fd: number): Buffer {
  const bytes = Buffer.alloc(MAX_INPUT_BYTES + 2)
  let length = 0
  try {
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length && bytes[length - 1] === 10) length--
    if (length && bytes[length - 1] === 13) length--
    const password = bytes.subarray(0, length)
    if (length > MAX_INPUT_BYTES || password.includes(10) || password.includes(13) || password.includes(0)) {
      throw new Error('password descriptor must contain one line of at most 1024 bytes')
    }
    return Buffer.from(password)
  } finally {
    bytes.fill(0)
  }
}

export async function readKeyPassword(name: string, confirm = false): Promise<Buffer> {
  const descriptor = process.env.HARBOR_KEY_PASSWORD_FD
  if (descriptor !== undefined && !/^([3-9]|[1-9][0-9]{1,5})$/.test(descriptor)) {
    throw new Error('HARBOR_KEY_PASSWORD_FD must name an inherited descriptor of 3 or higher')
  }
  const password = descriptor === undefined
    ? await readHidden(`Password for ${name}: `)
    : readPasswordFD(Number(descriptor))
  try {
    if (!password.length) throw new Error('key password cannot be empty')
    if (confirm && descriptor === undefined) {
      const repeated = await readHidden('Confirm password: ')
      try {
        if (password.length !== repeated.length || !timingSafeEqual(password, repeated)) {
          throw new Error('passwords do not match')
        }
      } finally {
        repeated.fill(0)
      }
    }
    return password
  } catch (error) {
    password.fill(0)
    throw error
  }
}

export function readPrivateKeyInput(): Promise<Buffer> {
  return readHidden('Private key (hidden): ')
}
