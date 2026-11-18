import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {installDownloadedBinary, normalizeServiceName, resolveArtifact, sha256Bytes} from './artifacts.js'
import {releaseAsset, runtimeTarget} from './runtime-host.js'

async function tempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harbor-artifacts-'))
}

test('normalizeServiceName accepts canonical names and aliases', () => {
  assert.equal(normalizeServiceName('traceapi').daemon, 'harbor-traceapid')
  assert.equal(normalizeServiceName('trace-api').name, 'traceapi')
  assert.equal(normalizeServiceName('history-actions').name, 'histactions')
  assert.equal(normalizeServiceName('appeal-committee').daemon, 'harbor-appeal-committeed')
  assert.equal(normalizeServiceName('key-custody').daemon, 'harbor-keycustodyd')
})

test('installDownloadedBinary rejects checksum mismatches', {skip: process.platform === 'win32'}, async () => {
  process.env.HARBOR_HOME = await tempHome()
  await assert.rejects(
    () => installDownloadedBinary({
      service: normalizeServiceName('storage'),
      version: 'test',
      bytes: Buffer.from('not the expected binary'),
      expectedSha256: '0'.repeat(64),
      source: 'url',
      provenance: 'test',
    }),
    /checksum mismatch/,
  )
})

test('resolveArtifact requires a checksum for direct URL downloads', {skip: process.platform === 'win32'}, async () => {
  process.env.HARBOR_HOME = await tempHome()
  await assert.rejects(
    () => resolveArtifact({
      service: normalizeServiceName('router'),
      version: 'url-test',
      source: 'url',
      binaryUrl: 'http://127.0.0.1:9/harbor-routerd',
    }),
    /--sha256 is required/,
  )
})

test('installDownloadedBinary writes a target-scoped executable and provenance', {skip: process.platform === 'win32'}, async () => {
  process.env.HARBOR_HOME = await tempHome()
  const bytes = Buffer.from('#!/bin/sh\necho harbor\n')
  const result = await installDownloadedBinary({
    service: normalizeServiceName('router'),
    version: 'v1',
    bytes,
    expectedSha256: sha256Bytes(bytes),
    source: 'url',
    provenance: 'unit-test',
  })

  assert.equal(await fs.readFile(result.binary, 'utf8'), bytes.toString('utf8'))
  const stat = await fs.stat(result.binary)
  assert.equal(Boolean(stat.mode & 0o111), true)
  const metadata = JSON.parse(await fs.readFile(path.join(path.dirname(path.dirname(result.binary)), 'artifact.json'), 'utf8'))
  assert.equal(metadata.target, runtimeTarget())
  assert.equal(metadata.provenance, 'unit-test')
  assert.equal((await resolveArtifact({service: normalizeServiceName('router'), version: 'v1'})).binary, result.binary)
})

test('release target names include Linux arm64 and exclude native Windows daemons', () => {
  assert.equal(releaseAsset('harbor-aiinferd', runtimeTarget('linux', 'arm64')), 'harbor-aiinferd-linux-arm64')
  assert.equal(releaseAsset('harbor-aiinferd', runtimeTarget('darwin', 'x64')), 'harbor-aiinferd-darwin-x64')
  assert.throws(() => runtimeTarget('win32', 'x64'), /WSL2/)
})
