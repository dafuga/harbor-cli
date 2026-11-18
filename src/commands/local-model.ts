import {Command} from 'commander'
import {localModel} from '../lib/local-model.js'

export function addLocalModelCommand(ai: Command): void {
  ai.command('local-model')
    .description('Show the Qwen model and expert adapter base for local inference')
    .option('--model-profile <profile>', 'auto, flagship, compact, or large', 'auto')
    .option('--json', 'print JSON')
    .action((options: {modelProfile: string; json?: boolean}) => {
      const model = localModel(options.modelProfile)
      if (options.json) console.log(JSON.stringify(model, null, 2))
      else console.table(model)
    })
}
