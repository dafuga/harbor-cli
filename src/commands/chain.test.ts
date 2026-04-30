import {strict as assert} from 'node:assert'
import {describe, it} from 'node:test'

import {parseCodeAccounts} from './chain.js'

describe('chain command helpers', () => {
  it('sorts and deduplicates code accounts for valid authority serialization', () => {
    assert.deepEqual(parseCodeAccounts('svcmarket,auditmarket, svcmarket'), [
      {permission: {actor: 'auditmarket', permission: 'eosio.code'}, weight: 1},
      {permission: {actor: 'svcmarket', permission: 'eosio.code'}, weight: 1},
    ])
  })
})
