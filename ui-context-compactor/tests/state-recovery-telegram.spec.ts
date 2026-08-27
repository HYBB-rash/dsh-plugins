import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { classifyTelegramStateRecovery } from '../src/state-recovery.ts'

const chat = 'session-telegram'

function event(source: Record<string, unknown>, id: string): SessionEvent {
  return {
    type: 'user/message',
    seq: Number(id.replace(/\D/g, '') || 0),
    data: {
      id,
      role: 'user',
      content: [{ type: 'text', text: id }],
      source,
    },
  } as unknown as SessionEvent
}

function direct(id: string): SessionEvent {
  return event({ kind: 'user' }, id)
}

function legacyRoute(id: string): SessionEvent {
  // The classifier only consumes the structured source tag.  This deliberately
  // does not supply, parse, or trust a route snapshot body.
  return event({ kind: 'context-route' }, id)
}

function finalizedCanonical(id: string): SessionEvent {
  return event({
    kind: 'context-manager-canonical',
    phase: 'finalized',
    machine: { kind: 'no_focus' },
  }, id)
}

describe('F07-T2 Telegram cold-state classification', () => {
  it('positive: classifies an old route plus an explicit close as legacy migration material', () => {
    expect(classifyTelegramStateRecovery({
      sessionId: chat,
      events: [direct('old-direct'), legacyRoute('route-1'), direct('close-direct')],
      hasPreCanonicalFocus: false,
      hasExpectedNoFocusEvidence: true,
    })).toBe('legacy_route')
  })

  it('positive: preserves an F02 pre-canonical focus for a later direct continue', () => {
    expect(classifyTelegramStateRecovery({
      sessionId: chat,
      events: [direct('focus-direct')],
      hasPreCanonicalFocus: true,
    })).toBe('precanonical_focus')
  })

  it('positive: leaves a genuinely new Telegram chat on its normal first-state path', () => {
    expect(classifyTelegramStateRecovery({
      sessionId: chat,
      events: [],
      hasPreCanonicalFocus: false,
    })).toBe('new')
  })

  it('negative: sends a finalized canonical log without an owner row to expected-missing', () => {
    expect(classifyTelegramStateRecovery({
      sessionId: chat,
      events: [finalizedCanonical('finalized-1')],
      hasPreCanonicalFocus: false,
    })).toBe('expected_missing')
  })

  it('negative: does not turn a route summary into canonical state', () => {
    expect(classifyTelegramStateRecovery({
      sessionId: chat,
      events: [legacyRoute('route-summary')],
      hasPreCanonicalFocus: false,
    })).toBe('legacy_route')
  })

  it('negative: does not infer authority from the newest of several legacy routes', () => {
    expect(classifyTelegramStateRecovery({
      sessionId: chat,
      events: [legacyRoute('route-old'), direct('between'), legacyRoute('route-new')],
      hasPreCanonicalFocus: false,
    })).toBe('legacy_route')
  })

  it('negative: keeps an H2-retained close without later state material out of the new-chat path', () => {
    expect(classifyTelegramStateRecovery({
      sessionId: chat,
      events: [direct('retained-close')],
      hasPreCanonicalFocus: false,
      hasExpectedNoFocusEvidence: true,
    })).toBe('expected_missing')
  })

  it('negative: keeps a legacy route plus a missing finalized canonical state out of the legacy path', () => {
    expect(classifyTelegramStateRecovery({
      sessionId: chat,
      events: [legacyRoute('route-2'), finalizedCanonical('finalized-3')],
      hasPreCanonicalFocus: false,
    })).toBe('expected_missing')
  })
})
