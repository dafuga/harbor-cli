import assert from 'node:assert/strict'
import test from 'node:test'
import {parseWslDistributions, selectWslDistribution} from './wsl.js'

test('Windows selects a WSL2 distribution from the native UTF-16 listing', () => {
  const result = parseWslDistributions(Buffer.from(
    '\uFEFF  NAME               STATE           VERSION\r\n* Ubuntu             Stopped         1\r\n  Harbor Linux       En cours        2\r\n',
    'utf16le',
  ))
  assert.deepEqual(result, [
    {name: 'Ubuntu', version: 1, default: true},
    {name: 'Harbor Linux', version: 2, default: false},
  ])
  assert.equal(selectWslDistribution(result, '')?.name, 'Harbor Linux')
  assert.equal(selectWslDistribution(result, 'Ubuntu'), undefined)
})
