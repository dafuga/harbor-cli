import assert from 'node:assert/strict';
import test from 'node:test';
import { depositMemo, generatedProposalName, parseBucket, parsePermission, parsePermissionList, requestedWithdrawApprovals, } from './bank.js';
test('parses spending and savings bucket aliases', () => {
    assert.equal(parseBucket('spending'), 0);
    assert.equal(parseBucket('spend'), 0);
    assert.equal(parseBucket('0'), 0);
    assert.equal(parseBucket('savings'), 1);
    assert.equal(parseBucket('staking'), 1);
    assert.equal(parseBucket('1'), 1);
    assert.throws(() => parseBucket('cold'), /unknown bank bucket/);
});
test('formats deposit transfer memos for the selected bucket', () => {
    assert.equal(depositMemo(0), 'harborbank:spending');
    assert.equal(depositMemo(1), 'harborbank:savings');
});
test('parses permission levels and comma-separated approval sets', () => {
    assert.deepEqual(parsePermission('alice@bankhigh'), { actor: 'alice', permission: 'bankhigh' });
    assert.deepEqual(parsePermission('alice'), { actor: 'alice', permission: 'active' });
    assert.deepEqual(parsePermissionList('alice@active, bob@guard'), [
        { actor: 'alice', permission: 'active' },
        { actor: 'bob', permission: 'guard' },
    ]);
});
test('high-value withdrawal approvals target the configured high-value authority', () => {
    assert.deepEqual(requestedWithdrawApprovals('alice', 'alice@bankhigh'), [
        { actor: 'alice', permission: 'bankhigh' },
    ]);
    assert.deepEqual(requestedWithdrawApprovals('alice', 'alice@active'), [
        { actor: 'alice', permission: 'active' },
    ]);
});
test('generated proposal names are valid Antelope names', () => {
    const name = generatedProposalName('bankwd', 1_700_000_000_000);
    assert.match(name, /^[.1-5a-z]{1,13}$/);
    assert.ok(name.startsWith('bankwd'));
    assert.ok(name.length <= 13);
});
