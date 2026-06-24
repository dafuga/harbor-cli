import assert from 'node:assert/strict';
import test from 'node:test';
import { createContractCommand } from './contract.js';
test('contract command exposes upload and place flows', () => {
    const command = createContractCommand();
    const upload = command.commands.find((subcommand) => subcommand.name() === 'upload');
    const place = command.commands.find((subcommand) => subcommand.name() === 'place');
    assert.ok(upload);
    assert.ok(place);
    assert.ok(upload.options.some((option) => option.long === '--dependencies'));
    assert.ok(place.options.some((option) => option.long === '--manifest-hash'));
    assert.ok(place.options.some((option) => option.long === '--target-chain'));
    assert.ok(place.options.some((option) => option.long === '--stake-net'));
    assert.ok(place.options.some((option) => option.long === '--stake-cpu'));
});
