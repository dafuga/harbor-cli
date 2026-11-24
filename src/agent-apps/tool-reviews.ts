import type {AgentToolReview} from '@dafuga01/harness-agent-safety'
import {AgentError} from './validation.js'

type VisibleToolReview = AgentToolReview & {agentId: string; runId: string; content: string}
type PendingToolReview = {visible: VisibleToolReview; resolve: (approved: boolean) => void}

export class ToolReviews {
  private readonly pending = new Map<string, PendingToolReview>()

  forAgent(agentId: string, now: number) {
    return [...this.pending.values()].map(item => item.visible)
      .filter(item => item.agentId === agentId && item.expiresAt > now)
  }

  decide(id: string, approved: boolean, now: number) {
    const review = this.pending.get(id)
    if (!review || review.visible.expiresAt <= now) throw new AgentError('Tool review is no longer available.', 404)
    this.pending.delete(id)
    review.resolve(approved)
    return {accepted: true}
  }

  async wait(visible: VisibleToolReview, signal: AbortSignal, now: number) {
    const expiry = AbortSignal.timeout(Math.max(0, visible.expiresAt - now))
    const waiting = AbortSignal.any([expiry, signal])
    waiting.throwIfAborted()
    let abort = () => {}
    try {
      return await new Promise<boolean>((resolve, reject) => {
        abort = () => expiry.aborted ? resolve(false) : reject(waiting.reason)
        this.pending.set(visible.id, {visible, resolve})
        waiting.addEventListener('abort', abort, {once: true})
      })
    } finally {
      this.pending.delete(visible.id)
      waiting.removeEventListener('abort', abort)
    }
  }
}
