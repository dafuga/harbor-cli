import { Command } from 'commander';
import { ArtifactSource } from '../lib/artifacts.js';
export declare function addRuntimeOptions(command: Command): Command;
export declare function validateRuntimeSource(source: ArtifactSource | undefined): void;
export declare function createRunCommand(): Command;
