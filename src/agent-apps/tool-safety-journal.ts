import type {AgentToolEvent, AgentToolJournal, AgentToolJournalTransaction} from '@dafuga01/harness-agent-safety'
import type {AgentStore} from './store.js'

export function toolSafetyJournal(store: AgentStore, runId: string): AgentToolJournal {
  return {
    transaction<T>(write: (journal: AgentToolJournalTransaction) => T): T {
      return store.transaction(() => write({
        append: event => append(store, runId, event),
        pending(id) {
          const held = store.query<Extract<AgentToolEvent, {state: 'held'}>>(`
            SELECT data FROM tool_safety_events
            WHERE approval_id = ? AND state = 'held'
              AND NOT EXISTS (SELECT 1 FROM tool_safety_events WHERE approval_id = ? AND state = 'reserved')
          `, id, id)[0]
          return held?.approval
        },
        usage(agentId, since, currency) {
          return store.query<{count: number; spend: number}>(`
            SELECT json_object(
              'count', COALESCE(SUM(CASE WHEN at > ? THEN 1 ELSE 0 END), 0),
              'spend', COALESCE(SUM(CASE WHEN currency = ? THEN maximum ELSE 0 END), 0)
            ) AS data
            FROM tool_safety_events WHERE agent_id = ? AND state = 'reserved'
          `, since, currency ?? null, agentId)[0]
        },
      }))
    },
  }
}

function append(store: AgentStore, runId: string, event: AgentToolEvent) {
  const approvalId = event.state === 'held' ? event.approval.id : event.state === 'reserved' ? event.approvalId : undefined
  const charge = event.state === 'reserved' ? event.charge : undefined
  store.run(`
    INSERT INTO tool_safety_events (agent_id, at, state, approval_id, currency, maximum, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, event.agentId, event.at, event.state, approvalId ?? null, charge?.currency ?? null,
  charge?.maximum ?? null, JSON.stringify(event))
  const {agentId, at, attemptId, tool, state} = event
  store.run('INSERT INTO audit (data) VALUES (?)', JSON.stringify({
    agentId, at, runId, attemptId, tool,
    event: 'tool_policy_' + state,
    ...(event.state === 'denied' ? {detail: event.reason} : {}),
  }))
}
