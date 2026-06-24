import assert from 'node:assert/strict';
import test from 'node:test';
import { createContractAccountActions } from './deploy.js';
test('contract account creation can stake NET and CPU for deployment resources', () => {
    const actions = createContractAccountActions({
        url: 'http://127.0.0.1:8888',
        creator: 'eosio',
        account: 'placed111111',
        ownerKey: 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5SoMSSjU5nYkdVNifQ6qR',
        activeKey: 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5SoMSSjU5nYkdVNifQ6qR',
        ramBytes: 262144,
        stakeNet: '1.0000 SYS',
        stakeCpu: '1.0000 SYS',
    });
    assert.deepEqual(actions.map((action) => action.name), ['newaccount', 'buyrambytes', 'delegatebw']);
    assert.deepEqual(actions[2].data, {
        from: 'eosio',
        receiver: 'placed111111',
        stake_net_quantity: '1.0000 SYS',
        stake_cpu_quantity: '1.0000 SYS',
        transfer: false,
    });
});
