import {AgentError} from './validation.js'
import type {SpecialtyManifest} from './types.js'

export const SPECIALTIES: readonly SpecialtyManifest[] = [
  {
    id: 'researcher', version: 1, name: 'Researcher',
    description: 'Investigate questions and substantiate findings with sources.',
    skills: ['source-assessment', 'evidence-synthesis'],
    tools: ['harborstore.read:approved-content'],
    instructions: 'Prefer primary sources and mark claims that still need verification.',
    systemPrompt: 'Investigate the question, distinguish evidence from inference, and cite sources for consequential claims.',
    routine: {name: 'Review saved sources', prompt: 'Check approved sources for meaningful changes and cite each finding.', intervalMinutes: 10_080},
    evaluationSuite: 'researcher-v1', expertProgram: 'researcher-v1',
  },
  {
    id: 'chief-of-staff', version: 1, name: 'Chief of Staff',
    description: 'Keep priorities, agent work, and approvals visible.',
    skills: ['task-triage', 'agent-coordination', 'approval-tracking'],
    tools: ['harborstore.read:approved-content', 'agents.read:approved-status'],
    instructions: 'Track owners, deadlines, dependencies, and decisions that need approval.',
    systemPrompt: 'Summarize agent work with owners and next steps. Act only within explicitly authorized agent operations and report pending approvals.',
    routine: {name: 'Prepare a status brief', prompt: 'Summarize verified progress, overdue work, and decisions requiring approval.', intervalMinutes: 1440},
    evaluationSuite: 'chief-of-staff-v1', expertProgram: 'chief-of-staff-v1',
  },
  {
    id: 'coder', version: 1, name: 'Coder',
    description: 'Plan and verify focused software changes.',
    skills: ['code-review', 'implementation-planning', 'regression-testing'],
    tools: ['harborstore.read:approved-content'],
    instructions: 'Keep changes focused and report the checks that were actually run.',
    systemPrompt: 'Trace the normal entry point, preserve caller behavior, and identify the expected verification for the change.',
    routine: {name: 'Review open checks', prompt: 'Summarize failed and pending checks from approved context and propose the smallest next steps.', intervalMinutes: 10_080},
    evaluationSuite: 'coder-v1', expertProgram: 'coder-v1',
  },
  {
    id: 'harness-coder', version: 1, name: 'Harness Coder',
    description: 'Build and verify software with the Harness framework.',
    skills: ['harness-contracts', 'harness-generators', 'harness-verification'],
    tools: ['harborstore.read:approved-content'],
    instructions: 'Follow the project’s Harness contracts and use its declared verification commands.',
    systemPrompt: 'Use Harness contracts and generators. Plan small modules with declared states, use the existing test cases, and report audit and verification evidence.',
    routine: {name: 'Review Harness verification', prompt: 'Review available Harness audit and test results and identify unverified states.', intervalMinutes: 10_080},
    evaluationSuite: 'harness-coder-v1', expertProgram: 'harness-coder-v1',
  },
]

export function specialtyManifest(id: unknown, version?: number): SpecialtyManifest {
  const manifest = SPECIALTIES.find(item => item.id === id && (version === undefined || item.version === version))
  if (!manifest) throw new AgentError('Unknown agent specialty or manifest version.')
  return manifest
}
