import { strict as assert } from 'node:assert';
import test from 'node:test';
import { stableMintMemo } from './stable.js';
test('stable mint memo defaults and includes slippage guard', () => {
    assert.equal(stableMintMemo(), 'usdh:mint');
    assert.equal(stableMintMemo('10.0000 USDH'), 'usdh:mint:10.0000 USDH');
});
