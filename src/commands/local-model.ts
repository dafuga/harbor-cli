import {Command} from 'commander'
import os from 'node:os'
import {gpuCapacity} from '../lib/host-policy.js'
import {localModel} from '../lib/local-model.js'
import {configuredLimits} from '../lib/resource-limits.js'

export function addLocalModelCommand(ai: Command): void {
  ai.command('local-model')
    .description('Show the Qwen model and expert adapter base for local inference')
    .option('--model-profile <profile>', 'auto or flagship', 'auto')
    .option('--json', 'print JSON')
    .action(async (options: {modelProfile: string; json?: boolean}) => {
      const {memory_bytes} = await configuredLimits()
      const model = {...localModel(options.modelProfile, os.totalmem(), memory_bytes), gpu: await gpuCapacity(), memory_budget_bytes: memory_bytes}
      if (options.json) console.log(JSON.stringify(model, null, 2))
      else console.table(model)
    })
}
