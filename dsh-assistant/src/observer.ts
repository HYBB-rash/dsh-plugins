/** Read-only projection of ordinary Web root turns for Telegram status lookup. */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { AssistantStore, type WebObservationRow, type WebObservationState } from './store.ts'

function iso(now: () => number): string {
  return new Date(now()).toISOString()
}

function textOf(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
}

function sessionCwd(session: Session): string | undefined {
  const header = (session as unknown as { header?: { cwd?: unknown } }).header
  return typeof header?.cwd === 'string' ? header.cwd : undefined
}

export interface WebTaskObserverOptions {
  readonly writerInstanceId: string
  readonly writerStartedAt: string
  readonly now?: () => number
}

/** One Web-process writer; rows owned by another writer are immutable. */
export class WebTaskObserver {
  private readonly now: () => number

  constructor(private readonly store: AssistantStore, private readonly options: WebTaskObserverOptions) {
    this.now = options.now ?? Date.now
  }

  handle(session: Session, event: SessionEvent): void {
    const sessionId = String(session.id)
    const now = iso(this.now)
    switch (event.type) {
      case 'turn/start':
        this.store.startWebObservation({
          sessionId,
          turn: event.data.turn,
          ...sessionCwd(session) === undefined ? {} : { cwd: sessionCwd(session)! },
          now,
          writerInstanceId: this.options.writerInstanceId,
          writerStartedAt: this.options.writerStartedAt,
        })
        return
      case 'user/message':
        if (event.data.source.kind !== 'user') return
        {
          const requestText = textOf(event.data.content)
          if (requestText !== '') {
            this.store.updateWebObservation(sessionId, this.options.writerInstanceId, { requestText }, now)
          }
        }
        return
      case 'assistant/message': {
        const assistantText = textOf(event.data.message.content)
        if (assistantText !== '') {
          this.store.updateWebObservation(sessionId, this.options.writerInstanceId, {
            assistantText,
            assistantMessageId: String(event.data.message.id),
          }, now)
        }
        return
      }
      case 'turn/end': {
        const reason = event.data.reason
        let state: WebObservationState
        if (reason.kind === 'completed') state = 'ended'
        else if (reason.kind === 'aborted' || reason.kind === 'interrupted') state = 'interrupted'
        else state = 'abnormal'
        const error = reason.kind === 'error' ? reason.error : undefined
        this.store.updateWebObservation(sessionId, this.options.writerInstanceId, {
          state,
          turnReason: reason.kind,
          ...error === undefined ? {} : { errorCode: error.code, errorMessage: error.message },
          finishedAt: now,
        }, now)
        return
      }
      default:
        return
    }
  }

  dispose(): void {
    const now = iso(this.now)
    this.store.interruptWebObservations(this.options.writerInstanceId, now)
  }
}

export interface WebTaskView {
  readonly sessionId: string
  readonly state: WebObservationState
  readonly turn: number
  readonly request: string | null
  readonly assistantConclusion: string | null
  readonly turnReason: string | null
  readonly updatedAt: string
  readonly evidence: string[]
}

function toView(row: WebObservationRow, now: number, staleAfterMs: number): WebTaskView {
  const evidence: string[] = []
  if (row.cwd !== null) evidence.push(`Web 工作目录：${row.cwd}`)
  evidence.push(`Web 会话 ${row.sessionId}，第 ${row.turn} 轮，最后更新时间 ${row.updatedAt}`)
  if (row.errorCode !== null || row.errorMessage !== null) {
    evidence.push(`异常：${row.errorCode ?? 'UNKNOWN'} ${row.errorMessage ?? ''}`.trim())
  }
  if (row.state === 'running' && now - Date.parse(row.updatedAt) > staleAfterMs) {
    evidence.push('最后更新时间后没有新状态；只能确认没有新事件，无法确认正常或卡住。')
  }
  if (row.state === 'ended') {
    evidence.push('这一轮 Web 会话正常结束；这不等于外部任务已经独立验收。')
  }
  return {
    sessionId: row.sessionId,
    state: row.state,
    turn: row.turn,
    request: row.requestText,
    assistantConclusion: row.lastAssistantText,
    turnReason: row.turnReason,
    updatedAt: row.updatedAt,
    evidence,
  }
}

export interface WebTaskQuery {
  readonly sessionId?: string
  readonly query?: string
  readonly limit?: number
}

export interface WebTaskQueryResult {
  readonly selected: WebTaskView | null
  readonly candidates: WebTaskView[]
  readonly total: number
  readonly truncated: boolean
  readonly ambiguous: boolean
}

/** Read-only Web status lookup. Query matching never grants control. */
export function queryWebTasks(
  store: AssistantStore,
  input: WebTaskQuery,
  now = Date.now(),
  staleAfterMs = 15 * 60_000,
): WebTaskQueryResult {
  const limit = Math.max(1, Math.min(20, input.limit ?? 5))
  let rows: WebObservationRow[]
  if (input.sessionId !== undefined) {
    const exact = store.getWebObservation(input.sessionId)
    rows = exact === undefined ? [] : [exact]
  } else {
    const all = store.listWebObservations(200)
    const query = input.query?.trim().toLocaleLowerCase()
    rows = query === undefined || query === ''
      ? all
      : all.filter(row => [row.sessionId, row.requestText, row.lastAssistantText, row.cwd]
        .some(value => value?.toLocaleLowerCase().includes(query)))
  }
  const total = rows.length
  const candidates = rows.slice(0, limit).map(row => toView(row, now, staleAfterMs))
  return {
    selected: total === 1 ? candidates[0]! : null,
    candidates,
    total,
    truncated: total > candidates.length,
    ambiguous: total > 1,
  }
}
