import assert from 'node:assert/strict';
import test from 'node:test';
import { SYSTEM_UIS, systemUiActionData } from './domains.js';
test('system UI seed payloads fit dappreg metadata limits', () => {
    assert.ok(SYSTEM_UIS.length >= 8);
    for (const ui of SYSTEM_UIS) {
        assert.match(ui.dapp, /^[a-z1-5.]{1,12}$/);
        const payload = systemUiActionData(ui);
        assert.equal(payload.active, true);
        assert.equal(payload.title, ui.title);
        assert.equal(typeof payload.metadata, 'string');
        assert.ok(String(payload.metadata).length <= 256);
        assert.equal(JSON.parse(String(payload.metadata)).system, true);
    }
});
