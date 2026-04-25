#!/usr/bin/env node
import { Command } from 'commander';
import { createAgentCommand } from './commands/agent.js';
import { createMarketCommand } from './commands/market.js';
const program = new Command();
program
    .name('harbor')
    .description('Harbor service-agent and market command line tools')
    .version('0.1.0');
program.addCommand(createMarketCommand());
program.addCommand(createAgentCommand());
program.parse(process.argv);
