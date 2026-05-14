import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {installDownloadedBinary, normalizeServiceName, resolveArtifact, sha256Bytes} from './artifacts.js'

async function tempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harbor-artifacts-'))
}

test('normalizeServiceName accepts canonical names and aliases', () => {
  assert.equal(normalizeServiceName('traceapi').daemon, 'harbor-traceapid')
  assert.equal(normalizeServiceName('trace-api').name, 'traceapi')
  assert.equal(normalizeServiceName('history-actions').name, 'histactions')
  assert.equal(normalizeServiceName('appeal-committee').daemon, 'harbor-appeal-committeed')
})

test('installDownloadedBinary rejects checksum mismatches', async () => {
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

test('resolveArtifact requires a checksum for direct URL downloads', async () => {
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

test('installDownloadedBinary writes executable artifact and provenance', async () => {
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
  assert.match(await fs.readFile(path.join(process.env.HARBOR_HOME, 'artifacts.json'), 'utf8'), /unit-test/)
})
