#!/usr/bin/env node
import {Command} from 'commander'
import {createActionCommand} from './commands/action.js'
import {createAgentCommand} from './commands/agent.js'
import {createChainCommand} from './commands/chain.js'
import {createContractCommand} from './commands/contract.js'
import {
  createAuditCommand,
  createChatCommand,
  createDappsCommand,
  createGovCommand,
  createIbcCommand,
  createPowerupCommand,
  createProjectsCommand,
  createSitesCommand,
} from './commands/domains.js'
import {createMarketCommand} from './commands/market.js'
import {createSignCommand} from './commands/sign.js'
import {createStorageCommand} from './commands/storage.js'
import {createTableCommand} from './commands/table.js'
import {createWalletCommand} from './commands/wallet.js'

const program = new Command()

program
  .name('harbor')
  .description('Harbor service-agent and market command line tools')
  .version('0.1.0')

program.addCommand(createChainCommand())
program.addCommand(createTableCommand())
program.addCommand(createActionCommand())
program.addCommand(createSignCommand())
program.addCommand(createContractCommand())
program.addCommand(createWalletCommand())
program.addCommand(createMarketCommand())
program.addCommand(createAgentCommand())
program.addCommand(createStorageCommand())
program.addCommand(createSitesCommand())
program.addCommand(createChatCommand())
program.addCommand(createDappsCommand())
program.addCommand(createAuditCommand())
program.addCommand(createPowerupCommand())
program.addCommand(createGovCommand())
program.addCommand(createProjectsCommand())
program.addCommand(createIbcCommand())

program.parse(process.argv)
