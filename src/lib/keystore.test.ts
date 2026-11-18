import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {generateKeyPairSync, randomBytes, sign} from 'node:crypto'
import {once} from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {Bytes, PrivateKey, PublicKey} from '@wharfkit/antelope'
import {recoverableR1Signature} from './antelope-key.js'
import {decryptKey, encryptKey, readStoredKey, storeKey} from './keystore.js'

test('encrypted keystore rejects incorrect passwords and authenticated record changes', async () => {
  const generated = PrivateKey.generate('K1')
  const secret = Buffer.from(generated.data.array)
  const password = randomBytes(32)
  const badPassword = randomBytes(32)
  const metadata = {name: 'fallback', publicKey: generated.toPublic().toString(), type: 'K1'} as const
  try {
    const record = await encryptKey(metadata, secret, password)
    const restored = await decryptKey(record, password)
    assert(restored.equals(secret))
    restored.fill(0)
    assert(!JSON.stringify(record).includes(secret.toString('base64')))
    const changed = Buffer.from(record.ciphertext, 'base64')
    changed[0] ^= 1
    const invalid = /incorrect password or modified/
    await assert.rejects(decryptKey(record, badPassword), invalid)
    await assert.rejects(decryptKey({...record, ciphertext: changed.toString('base64')}, password), invalid)
    await assert.rejects(decryptKey({...record, name: 'substituted'}, password), invalid)
  } finally {
    generated.data.array.fill(0)
    secret.fill(0)
    password.fill(0)
    badPassword.fill(0)
  }
})

test('keystore publishes owner-only records and refuses overwrites, unsafe permissions and links', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-keystore-test-'))
  const previous = process.env.HARBOR_HOME
  process.env.HARBOR_HOME = home
  const generated = PrivateKey.generate('R1')
  try {
    const record = {
      version: 1, storage: 'enclave', name: 'device', type: 'R1',
      publicKey: generated.toPublic().toString(), wrapped: Buffer.from('fixture reference').toString('base64'),
    } as const
    const writes = await Promise.allSettled([storeKey(record), storeKey(record)])
    assert.equal(writes.filter(({status}) => status === 'fulfilled').length, 1)
    const rejected = writes.find(({status}) => status === 'rejected')
    assert(rejected?.status === 'rejected')
    assert.match(String(rejected.reason), /already uses this name/)
    const dir = path.join(home, 'keys')
    const file = path.join(dir, 'device.json')
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700)
    assert.deepEqual(await readStoredKey('device'), record)
    await fs.chmod(file, 0o644)
    await assert.rejects(readStoredKey('device'), /mode 0600/)
    await fs.chmod(file, 0o600)
    const hardLink = path.join(home, 'hard-link.json')
    await fs.link(file, hardLink)
    await assert.rejects(readStoredKey('device'), /single link/)
    await fs.unlink(hardLink)
    assert.deepEqual(await readStoredKey('device'), record)
    await fs.symlink(file, path.join(dir, 'link.json'))
    await assert.rejects(readStoredKey('link'), {code: 'ELOOP'})
    await assert.rejects(readStoredKey('../device'), /key name/)
  } finally {
    generated.data.array.fill(0)
    if (previous === undefined) delete process.env.HARBOR_HOME
    else process.env.HARBOR_HOME = previous
    await fs.rm(home, {recursive: true})
  }
})

test('keys passwd preserves existing entries on failure and rotates encrypted keys', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-passwd-test-'))
  const dir = path.join(home, 'keys')
  const file = path.join(dir, 'fixture.json')
  const passwords = [randomBytes(24), randomBytes(24), randomBytes(24)]
  for (const password of passwords) password.forEach((byte, index) => { password[index] = 33 + byte % 94 })
  const [current, next, wrong] = passwords
  const key = PrivateKey.generate('K1')
  const secret = Buffer.from(key.data.array)
  const publicKey = key.toPublic().toString()
  t.after(async () => {
    key.data.array.fill(0)
    for (const buffer of [secret, current, next, wrong]) buffer.fill(0)
    await fs.rm(home, {recursive: true})
  })

  const cli = fileURLToPath(new URL('../index.js', import.meta.url))
  const env = {...process.env, HARBOR_HOME: home, HARBOR_KEY_PASSWORD_FD: '3'}
  async function passwd(lines: Buffer[], name = 'fixture', preload?: string) {
    const input = Buffer.concat(lines.flatMap((line) => [line, Buffer.of(10)]))
    const args = preload ? ['--import', 'data:text/javascript,' + encodeURIComponent(preload)] : []
    const child = spawn(process.execPath, [...args, cli, 'keys', 'passwd', name], {
      env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    })
    const descriptor = child.stdio[3] as NodeJS.WritableStream
    descriptor.on('error', () => {})
    descriptor.end(input, () => input.fill(0))
    let output = ''
    child.stdout!.on('data', (chunk) => { output += chunk })
    child.stderr!.on('data', (chunk) => { output += chunk })
    try {
      const [code, signal] = await once(child, 'close')
      for (const password of [current, next, wrong]) {
        assert.equal(output.includes(password.toString()), false, 'CLI exposed password input')
      }
      return {code, signal, output}
    } finally {
      input.fill(0)
    }
  }

  await fs.mkdir(dir, {mode: 0o700})
  const original = await encryptKey({name: 'fixture', publicKey, type: 'K1'}, secret, current)
  const originalBytes = JSON.stringify(original) + '\n'
  await fs.writeFile(file, originalBytes, {mode: 0o600})

  async function rejects(lines: Buffer[], message: RegExp, name?: string, preload?: string) {
    const result = await passwd(lines, name, preload)
    assert.equal(result.code, 1)
    assert.match(result.output, message)
    assert.equal(await fs.readFile(file, 'utf8'), originalBytes)
  }

  await t.test('checks current password before reading replacement input', async () => {
    await rejects([wrong], /incorrect password/)
  })
  await t.test('rejects an authenticated key that disagrees with its public key', async () => {
    const other = PrivateKey.generate('K1')
    const otherSecret = Buffer.from(other.data.array)
    const invalid = await encryptKey(original, otherSecret, current).finally(() => {
      otherSecret.fill(0)
      other.data.array.fill(0)
    })
    await fs.writeFile(file, JSON.stringify(invalid))
    try {
      const result = await passwd([current])
      assert.equal(result.code, 1)
      assert.match(result.output, /does not match its public key/)
      assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(invalid))
    } finally {
      await fs.writeFile(file, originalBytes)
    }
  })
  await t.test('rejects mismatched and empty replacement passwords', async () => {
    await rejects([current, next, wrong], /passwords do not match/)
    await rejects([current, next], /passwords do not match/)
    await rejects([current, Buffer.alloc(0), Buffer.alloc(0)], /password cannot be empty/)
  })
  await t.test('requires a different password to retire the old password', async () => {
    await rejects([current, current, current], /new password must differ/)
  })
  await t.test('refuses symlinks, hard links, and enclave entries', async () => {
    const symlink = path.join(dir, 'symlink.json')
    const hardlink = path.join(home, 'hardlink.json')
    const enclave = path.join(dir, 'enclave.json')
    const r1 = PrivateKey.generate('R1')
    try {
      await fs.symlink(file, symlink)
      await rejects([], /ELOOP|too many symbolic links/i, 'symlink')
      assert((await fs.lstat(symlink)).isSymbolicLink())
      await fs.link(file, hardlink)
      await rejects([], /single link/)
      const reference = {
        name: 'enclave', type: 'R1', publicKey: r1.toPublic().toString(),
        version: 1, storage: 'enclave', wrapped: 'AA==',
      }
      await fs.writeFile(enclave, JSON.stringify(reference), {mode: 0o600})
      await rejects([], /Secure Enclave.*no password/i, 'enclave')
      assert.equal(await fs.readFile(enclave, 'utf8'), JSON.stringify(reference))
    } finally {
      r1.data.array.fill(0)
      await fs.rm(symlink, {force: true})
      await fs.rm(hardlink, {force: true})
      await fs.rm(enclave, {force: true})
    }
  })
  await t.test('keeps the original if the staged record cannot be verified', async () => {
    const corruptTemporary = `
      import fs from 'node:fs/promises'
      import path from 'node:path'
      const open = fs.open
      fs.open = async (...args) => {
        const file = await open(...args)
        if (path.dirname(args[0]) === path.join(process.env.HARBOR_HOME, 'keys') && args[1] === 'wx') {
          const write = file.writeFile.bind(file)
          file.writeFile = (json) => {
            const record = JSON.parse(json)
            record.tag = Buffer.alloc(16).toString('base64')
            return write(JSON.stringify(record))
          }
        }
        return file
      }
    `
    await rejects([current, next, next], /incorrect password or modified/, 'fixture', corruptTemporary)
    assert.deepEqual(await fs.readdir(dir), ['fixture.json'])
  })
  await t.test('an interrupted write leaves the old key readable', async () => {
    const interruptWrite = `
      import fs from 'node:fs/promises'
      import path from 'node:path'
      const open = fs.open
      fs.open = async (...args) => {
        const file = await open(...args)
        if (path.dirname(args[0]) === path.join(process.env.HARBOR_HOME, 'keys') && args[1] === 'wx') {
          file.sync = async () => process.kill(process.pid, 'SIGKILL')
        }
        return file
      }
    `
    const result = await passwd([current, next, next], 'fixture', interruptWrite)
    assert.equal(result.signal, 'SIGKILL')
    assert.equal(await fs.readFile(file, 'utf8'), originalBytes)
    const restored = await decryptKey(JSON.parse(await fs.readFile(file, 'utf8')), current)
    try {
      assert(restored.equals(secret))
    } finally {
      restored.fill(0)
    }
  })
  await t.test('rotates the password while preserving permissions and key identity', async () => {
    const result = await passwd([current, next, next])
    assert.equal(result.code, 0, result.output)
    const rotated = JSON.parse(await fs.readFile(file, 'utf8')) as typeof original
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
    assert.equal(rotated.publicKey, publicKey)
    assert.equal(rotated.name, original.name)
    assert.equal(rotated.type, original.type)
    assert.notEqual(rotated.salt, original.salt)
    assert.notEqual(rotated.nonce, original.nonce)
    await assert.rejects(decryptKey(rotated, current), /incorrect password/)
    const restored = await decryptKey(rotated, next)
    try {
      assert(restored.equals(secret))
    } finally {
      restored.fill(0)
    }
  })
  await t.test('concurrent rotations cannot both replace the same entry', async () => {
    const [first, second] = await Promise.all([
      passwd([next, current, current]),
      passwd([next, wrong, wrong]),
    ])
    assert.deepEqual([first.code, second.code].sort(), [0, 1])
    const rotated = JSON.parse(await fs.readFile(file, 'utf8')) as typeof original
    const restored = await decryptKey(rotated, first.code === 0 ? current : wrong)
    try {
      assert(restored.equals(secret))
    } finally {
      restored.fill(0)
    }
  })
})

test('a native P-256 signature becomes a canonical recoverable Antelope signature', () => {
  const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'})
  const {x, y} = publicKey.export({format: 'jwk'})
  const xBytes = Buffer.from(x!, 'base64url')
  const yBytes = Buffer.from(y!, 'base64url')
  const compressed = Buffer.concat([Buffer.of(2 | (yBytes[31] & 1)), xBytes])
  const key = PublicKey.from({type: 'R1', compressed})
  const input = Buffer.from('disposable R1 signature fixture')
  const raw = sign('sha256', input, {key: privateKey, dsaEncoding: 'ieee-p1363'})
  // Force the high-S case to exercise normalization.
  const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
  const s = BigInt('0x' + raw.subarray(32).toString('hex'))
  if (s <= order / 2n) Buffer.from((order - s).toString(16).padStart(64, '0'), 'hex').copy(raw, 32)
  const message = Bytes.from(input)
  const signature = recoverableR1Signature(raw, message, key)
  assert(signature.recoverMessage(message).equals(key))
  assert(signature.verifyMessage(message, key))
  assert(BigInt('0x' + Buffer.from(signature.data.array.subarray(33)).toString('hex')) <= order / 2n)
  assert.throws(() => recoverableR1Signature(raw, Bytes.from(Buffer.of(0)), key), /did not match/)
})
