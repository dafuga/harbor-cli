import os from 'node:os';
import { gpuCapacity } from '../lib/host-policy.js';
import { localModel } from '../lib/local-model.js';
import { configuredLimits } from '../lib/resource-limits.js';
export function addLocalModelCommand(ai) {
    ai.command('local-model')
        .description('Show the selected local inference model profile')
        .option('--model-profile <profile>', 'auto, flagship, qwen3-8b-mlx, inkling-8, or inkling-12', 'auto')
        .option('--json', 'print JSON')
        .action(async (options) => {
        const { memory_bytes } = await configuredLimits();
        const model = { ...localModel(options.modelProfile, os.totalmem(), memory_bytes), gpu: await gpuCapacity(), memory_budget_bytes: memory_bytes };
        if (options.json)
            console.log(JSON.stringify(model, null, 2));
        else
            console.table(model);
    });
}
