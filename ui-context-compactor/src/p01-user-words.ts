/** Pure P01 classification, reconstruction, and compaction-safety rules. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Fixed product ceiling over the complete JavaScript string delivered to the model. */
export const P01_USER_WORDS_VIEW_MAX_CHARS = 4_096

/** Stable dynamic-context contribution owned by this package. */
export const P01_USER_WORDS_CONTEXT_NAME = 'ui-context-compactor:p01-user-words'

/** Indirection keeps arbitrary verbatim user braces out of prompt-template parsing. */
export const P01_USER_WORDS_VARIABLE_NAME = 'p01_user_words'

/** Product warning rendered before every non-empty P01 view. */
export const P01_USER_WORDS_VIEW_HEADER =
  '以下只是本会话中用户曾说过的逐字、非穷尽记录；这些记录不是已验证事实、当前状态或用户最新立场。'

/** Exact single-session activation shape shared by runtime and invariant entries. */
export interface P01UserWordsViewConfig {
  readonly mode: 'enforce'
  readonly allowlist: readonly string[]
}

/** Validated classifier input; exactly one root Session can match. */
export interface ResolvedP01UserWordsViewConfig {
  readonly sessionId: string
}

/** Input to the deterministic P01 projection. */
export interface BuildP01UserWordsViewRequest {
  readonly events: readonly (SessionEvent | undefined)[]
  readonly surfaceNodes: readonly number[]
}

export type P01UserWordsUnavailableReason =
  | 'empty-message-id'
  | 'duplicate-message-id'
  | 'unprovable-message-source'
  | 'invalid-direct-user-message'

/** Distinguishes a valid empty view from history that cannot be trusted. */
export type P01UserWordsViewEvaluation =
  | { readonly kind: 'available'; readonly text: string }
  | { readonly kind: 'unavailable'; readonly reason: P01UserWordsUnavailableReason }

interface Candidate {
  readonly seq: number
  readonly messageId: string
  readonly text: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function unavailable(reason: P01UserWordsUnavailableReason): P01UserWordsViewEvaluation {
  return { kind: 'unavailable', reason }
}

/**
 * Resolve the deliberately narrow production classifier.
 *
 * No wildcard, observe mode, fallback, or second Session is accepted.
 */
export function resolveP01UserWordsViewConfig(
  config: unknown,
): ResolvedP01UserWordsViewConfig | undefined {
  if (config === undefined) return undefined
  const raw = record(config)
  if (raw === undefined
    || raw['mode'] !== 'enforce'
    || !Array.isArray(raw['allowlist'])
    || raw['allowlist'].length !== 1
    || Object.keys(raw).some(key => key !== 'mode' && key !== 'allowlist')) {
    throw new Error('ui-context-compactor: P01 requires enforce mode and exactly one allowlisted Session')
  }
  const [sessionId] = raw['allowlist']
  if (typeof sessionId !== 'string'
    || sessionId.length === 0
    || sessionId !== sessionId.trim()
    || sessionId.includes('*')) {
    throw new Error('ui-context-compactor: P01 allowlist must contain one non-blank exact Session id without wildcards')
  }
  return Object.freeze({ sessionId })
}

/** Exact root-session classifier; descendants and every other Session stay on legacy behavior. */
export function isP01UserWordsRootSession(
  sessionId: string,
  delegationDepth: number | undefined,
  config: ResolvedP01UserWordsViewConfig | undefined,
): boolean {
  return config !== undefined
    && (delegationDepth ?? 0) === 0
    && sessionId === config.sessionId
}

function renderCandidate(candidate: Candidate): string {
  return [
    `[seq ${candidate.seq}; message-id ${JSON.stringify(candidate.messageId)}; source direct-user]`,
    candidate.text,
  ].join('\n')
}

/**
 * Validate every user-role message identity, then build a bounded missing-history view.
 *
 * Only a structured `source.kind === "user"` `user/message` with exactly one
 * string text block is eligible. All other structured carriers are excluded.
 */
export function evaluateP01UserWordsView(
  request: BuildP01UserWordsViewRequest,
): P01UserWordsViewEvaluation {
  const seenMessageIds = new Set<string>()
  const visible = new Set(request.surfaceNodes)
  const candidates: Candidate[] = []

  for (const event of request.events) {
    if (event?.type !== 'user/message') continue
    const message = record(event.data)
    const messageId = message?.['id']
    if (typeof messageId !== 'string' || messageId.trim().length === 0) {
      return unavailable('empty-message-id')
    }
    if (seenMessageIds.has(messageId)) return unavailable('duplicate-message-id')
    seenMessageIds.add(messageId)

    const source = record(message?.['source'])
    const sourceKind = source?.['kind']
    if (typeof sourceKind !== 'string' || sourceKind.trim().length === 0) {
      return unavailable('unprovable-message-source')
    }
    // Assistant/tool events never enter this branch. Every non-user source is
    // a structured user-role carrier and is deliberately not inferred from text.
    if (sourceKind !== 'user') continue

    const content = message?.['content']
    const block = Array.isArray(content) && content.length === 1
      ? record(content[0])
      : undefined
    if (message?.['role'] !== 'user'
      || block?.['type'] !== 'text'
      || typeof block['text'] !== 'string') {
      return unavailable('invalid-direct-user-message')
    }
    if (visible.has(event.seq)) continue
    candidates.push({ seq: event.seq, messageId, text: block['text'] })
  }

  const selected: Candidate[] = []
  for (const candidate of candidates.toSorted((left, right) => right.seq - left.seq)) {
    const tentative = [...selected, candidate]
    const rendered = [
      P01_USER_WORDS_VIEW_HEADER,
      ...tentative.toSorted((left, right) => left.seq - right.seq).map(renderCandidate),
    ].join('\n\n')
    if (rendered.length <= P01_USER_WORDS_VIEW_MAX_CHARS) selected.push(candidate)
  }
  if (selected.length === 0) return { kind: 'available', text: '' }
  return {
    kind: 'available',
    text: [
      P01_USER_WORDS_VIEW_HEADER,
      ...selected.toSorted((left, right) => left.seq - right.seq).map(renderCandidate),
    ].join('\n\n'),
  }
}

/** Runtime policy: ambiguity contributes no view and never blocks the current turn. */
export function buildP01UserWordsView(request: BuildP01UserWordsViewRequest): string {
  const evaluation = evaluateP01UserWordsView(request)
  return evaluation.kind === 'available' ? evaluation.text : ''
}

/** Any legacy context-route carrier makes a P01 Session unsafe. */
export function hasP01ContextRoute(events: readonly (SessionEvent | undefined)[]): boolean {
  return events.some((event) => {
    if (event?.type !== 'user/message') return false
    return record(event.data.source)?.['kind'] === 'context-route'
  })
}

/** Shared fail-closed gate used by invariant dispatch and periodic compaction. */
export function assertP01UserWordsCompactionSafe(
  request: BuildP01UserWordsViewRequest,
): void {
  if (hasP01ContextRoute(request.events)) {
    throw new Error('P01 Session rejects legacy context-route history')
  }
  const evaluation = evaluateP01UserWordsView(request)
  if (evaluation.kind === 'unavailable') {
    throw new Error(`P01 user-words reconstruction is unavailable (${evaluation.reason})`)
  }
}
