#!/usr/bin/env node
import {Command} from 'commander'
import {createAccountCommand} from './commands/account.js'
import {createActionCommand} from './commands/action.js'
import {createAgentCommand} from './commands/agent.js'
import {createAiCommand} from './commands/ai.js'
import {createBankCommand} from './commands/bank.js'
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
import {createMsigCommand} from './commands/msig.js'
import {createSolanaCommand} from './commands/solana.js'
import {createMarketCommand} from './commands/market.js'
import {createRunCommand} from './commands/run.js'
import {createSignCommand} from './commands/sign.js'
import {createSocialCommand} from './commands/social.js'
import {createStableCommand} from './commands/stable.js'
import {createStorageCommand} from './commands/storage.js'
import {createTableCommand} from './commands/table.js'
import {createKeysCommand, createWalletCommand} from './commands/wallet.js'
import {createVaultCommand} from './commands/vault.js'

const program = new Command()

program
  .name('harbor')
  .description('Harbor service-agent and market command line tools')
  .version('0.1.0')
  .enablePositionalOptions()

program.addCommand(createChainCommand())
program.addCommand(createTableCommand())
program.addCommand(createActionCommand())
program.addCommand(createAccountCommand())
program.addCommand(createKeysCommand())
program.addCommand(createMsigCommand())
program.addCommand(createSolanaCommand())
program.addCommand(createSignCommand())
program.addCommand(createContractCommand())
program.addCommand(createWalletCommand())
program.addCommand(createMarketCommand())
program.addCommand(createRunCommand())
program.addCommand(createAgentCommand())
program.addCommand(createAiCommand())
program.addCommand(createStorageCommand())
program.addCommand(createVaultCommand())
program.addCommand(createSocialCommand())
program.addCommand(createBankCommand())
program.addCommand(createStableCommand())
program.addCommand(createSitesCommand())
program.addCommand(createChatCommand())
program.addCommand(createDappsCommand())
program.addCommand(createAuditCommand())
program.addCommand(createPowerupCommand())
program.addCommand(createGovCommand())
program.addCommand(createProjectsCommand())
program.addCommand(createIbcCommand())

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'command failed'
  // Keep legacy raw Antelope keys out of diagnostics, including exceptions from dependencies.
  console.error(message.replace(/PVT_[A-Z0-9]+_[1-9A-HJ-NP-Za-km-z]+|\b5[1-9A-HJ-NP-Za-km-z]{50}\b/g, '[redacted key]'))
  process.exitCode = 1
})
