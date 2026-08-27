/**
 * Cold-start classification for the one managed Telegram chat.
 *
 * This is deliberately a source-tag classifier, not a route decoder: legacy
 * route text is migration history and can never supply a focus, a candidate,
 * or a canonical state.  Lifecycle wiring owns every subsequent F02/F01/F06-
 * F09 hand-off and every user-visible failure.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

export type TelegramStateRecoveryClass =
  | 'new'
  | 'precanonical_focus'
  | 'legacy_route'
  | 'expected_missing'

export interface TelegramStateRecoveryInput {
  readonly sessionId: string
  readonly events: readonly SessionEvent[]
  /** Already exact-schema-validated F02 sidecar projection; never decoded here. */
  readonly hasPreCanonicalFocus: boolean
  /** Existing finalized state material was validated by its owning recovery path. */
  readonly hasCanonicalStateMaterial?: boolean
  /** H2 physically retained a direct close, but its later state material is absent. */
  readonly hasExpectedNoFocusEvidence?: boolean
}

function sourceKind(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message') return undefined
  return event.data.source.kind
}

function hasCanonicalState(events: readonly SessionEvent[]): boolean {
  return events.some(event => {
    const kind = sourceKind(event)
    return kind === 'context-manager-canonical'
      || kind === 'context-manager-local-restriction'
      || kind === 'context-manager-no-safe-action'
  })
}

function hasLegacyRoute(events: readonly SessionEvent[]): boolean {
  return events.some(event => sourceKind(event) === 'context-route')
}

/**
 * Four mutually exclusive startup classes, ordered by the recovery safety
 * boundary. A visible canonical family without its exact sidecar is an
 * incident even when stale route or pre-canonical projections also exist.
 */
export function classifyTelegramStateRecovery(
  input: TelegramStateRecoveryInput,
): TelegramStateRecoveryClass {
  if (input.sessionId !== 'session-telegram') return 'new'
  if (hasCanonicalState(input.events) && input.hasCanonicalStateMaterial !== true) return 'expected_missing'
  if (input.hasPreCanonicalFocus) return 'precanonical_focus'
  if (hasLegacyRoute(input.events)) return 'legacy_route'
  if (input.hasExpectedNoFocusEvidence === true) return 'expected_missing'
  return 'new'
}
