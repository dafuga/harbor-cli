import {Command} from 'commander'
import {configuredLimits, ResourceLimits, saveLimits} from '../lib/resource-limits.js'

function print(limits: ResourceLimits, json?: boolean): void {
  if (json) console.log(JSON.stringify(limits, null, 2))
  else console.table(limits)
}

export function addAgentLimitsCommands(agent: Command): void {
  const limits = agent.command('limits').description('Set default CPU, GPU, and memory caps for new workloads')
  limits.command('show').option('--json', 'print JSON output')
    .action(async (options: {json?: boolean}) => print(await configuredLimits(), options.json))
  limits.command('set').option('--cpu <percent>', 'share of logical CPUs')
    .option('--gpu <percent>', 'GPU layer or memory budget for managed backends')
    .option('--mem <percent>', 'share of physical memory')
    .option('--json', 'print JSON output')
    .action(async (options: {cpu?: string; gpu?: string; mem?: string; json?: boolean}) => {
      print(await saveLimits({cpuPercent: options.cpu, gpuPercent: options.gpu, memoryPercent: options.mem}), options.json)
    })
}
