import { describe, expect, it } from 'vitest'
import { foldEvents, prepareRecord, type ExplorationEventV1, type ExplorationItem, type RecordInput } from '../src/domain.ts'

const pi = (revision: number, state: 'active' | 'dismissed' = 'active'): ExplorationEventV1 => ({ schemaVersion: 1, eventId: `00000000-0000-4000-8000-00000000000${revision}`, occurredAt: `2026-08-17T00:00:0${revision}.000Z`, operation: state === 'active' ? 'keep' : 'dismiss', signal: state === 'active' ? 'explicit_interest' : 'explicit_disinterest', item: { id: '10000000-0000-4000-8000-000000000001', state, revision, canonicalUrl: 'https://x.com/a/status/1', sourceUrl: 'https://x.com/a/status/1', title: 'Pi', hook: state === 'active' ? 'cache' : undefined, currentFinding: 'finding', nextQuestion: state === 'active' ? 'why?' : undefined, citations: state === 'active' ? ['https://x.com/a/status/1'] : [], lastSignal: state === 'active' ? 'explicit_interest' : 'explicit_disinterest', createdAt: '2026-08-17T00:00:01.000Z', updatedAt: `2026-08-17T00:00:0${revision}.000Z` } })

describe('exploration fold', () => {
  it('Pi keeps one active item and a repeated URL is revision two, not a second item', () => {
    const result = foldEvents([JSON.stringify(pi(1)), JSON.stringify(pi(2))])
    expect([...result.itemsById.values()]).toHaveLength(1)
    expect(result.itemsById.get(pi(1).item.id)?.revision).toBe(2)
  })
  it('mise may be dismissed before keep and stays out of active projection', () => {
    const result = foldEvents([JSON.stringify(pi(1, 'dismissed'))])
    expect([...result.itemsById.values()].filter(item => item.state === 'active')).toHaveLength(0)
  })
  it('marks malformed/revision-gap lines degraded but preserves independent legal items', () => {
    const result = foldEvents([JSON.stringify(pi(1)), '{bad', JSON.stringify(pi(3))])
    expect(result.integrity.status).toBe('degraded')
    expect(result.itemsById.get(pi(1).item.id)?.revision).toBe(1)
  })
  it('rejects a forged dismissed → update(active) event and retains the dismissed projection', () => {
    const dismissed = pi(1, 'dismissed'); const forged = pi(2); forged.operation = 'update'; forged.signal = 'assistant_judgment'; forged.item.lastSignal = 'assistant_judgment'
    const result = foldEvents([JSON.stringify(dismissed), JSON.stringify(forged)])
    expect(result.integrity.status).toBe('degraded'); expect(result.itemsById.get(dismissed.item.id)?.state).toBe('dismissed')
  })
  it('rejects invalid operation/signal, createdAt changes, duplicate event id, and revision gaps', () => {
    const first = pi(1); const wrongSignal = pi(2); wrongSignal.operation = 'dismiss'; wrongSignal.item.state = 'dismissed'; wrongSignal.item.lastSignal = 'explicit_interest'
    const changedCreated = pi(2); changedCreated.item.createdAt = '2026-08-18T00:00:00.000Z'
    const duplicate = pi(2); duplicate.eventId = first.eventId
    for (const invalid of [wrongSignal, changedCreated, duplicate, pi(4)]) {
      const result = foldEvents([JSON.stringify(first), JSON.stringify(invalid)])
      expect(result.integrity.status).toBe('degraded'); expect(result.itemsById.get(first.item.id)?.revision).toBe(1)
    }
  })
  it('treats structurally incomplete and unknown-schema JSON as degraded instead of throwing', () => {
    const incomplete = { schemaVersion: 1, eventId: '10000000-0000-4000-8000-000000000009', occurredAt: '2026-08-17T00:00:00.000Z' }
    expect(() => foldEvents([JSON.stringify(pi(1)), JSON.stringify(incomplete), JSON.stringify({ ...pi(2), schemaVersion: 2 })])).not.toThrow()
    expect(foldEvents([JSON.stringify(pi(1)), JSON.stringify(incomplete), JSON.stringify({ ...pi(2), schemaVersion: 2 })]).integrity.status).toBe('degraded')
  })
  it('rejects first keep→dismissed and dismiss→active snapshots', () => {
    const keepDismissed = pi(1, 'dismissed'); keepDismissed.operation = 'keep'; keepDismissed.signal = 'assistant_judgment'; keepDismissed.item.lastSignal = 'assistant_judgment'
    const dismissActive = pi(1); dismissActive.operation = 'dismiss'; dismissActive.signal = 'assistant_judgment'; dismissActive.item.lastSignal = 'assistant_judgment'
    for (const invalid of [keepDismissed, dismissActive]) {
      const result = foldEvents([JSON.stringify(invalid)])
      expect(result.integrity.status).toBe('degraded'); expect(result.itemsById.size).toBe(0)
    }
  })
})

const recordInput: RecordInput = { operation: 'keep', sourceUrl: 'https://x.com/a/status/1', title: 'Pi', hook: 'cache', currentFinding: 'finding', nextQuestion: 'why', citations: ['https://x.com/a/status/1'], signal: 'explicit_interest' }
const existing = (state: 'active' | 'dismissed' = 'active', id = '10000000-0000-4000-8000-000000000001'): ExplorationItem => ({ ...pi(1, state).item, id })
const uuid = () => '10000000-0000-4000-8000-000000000002'

describe('record preparation', () => {
  it('enforces the explicit signal matrix and active evidence gate', () => {
    expect(prepareRecord(new Map(), { ...recordInput, operation: 'dismiss', signal: 'explicit_interest' }, '2026-08-17T00:00:00.000Z', uuid)).toMatchObject({ ok: false, code: 'invalid_signal' })
    expect(prepareRecord(new Map(), { ...recordInput, operation: 'keep', signal: 'explicit_disinterest' }, '2026-08-17T00:00:00.000Z', uuid)).toMatchObject({ ok: false, code: 'invalid_signal' })
    expect(prepareRecord(new Map(), { ...recordInput, hook: undefined }, '2026-08-17T00:00:00.000Z', uuid)).toMatchObject({ ok: false, code: 'evidence_required' })
  })
  it('keeps dismissed items only by explicit keep recovery and cannot update them', () => {
    const item = existing('dismissed'); const items = new Map([[item.id, item]])
    expect(prepareRecord(items, { ...recordInput, itemId: item.id, operation: 'update', signal: 'assistant_judgment' }, '2026-08-17T00:00:00.000Z', uuid)).toMatchObject({ ok: false, code: 'invalid_transition' })
    expect(prepareRecord(items, { ...recordInput, itemId: item.id, operation: 'keep' }, '2026-08-17T00:00:00.000Z', uuid)).toMatchObject({ ok: true, created: false, item: { state: 'active', revision: 2 } })
  })
  it('locates in itemId then canonical URL then normalized exact title order', () => {
    const first = existing('active'); const second = existing('active', '10000000-0000-4000-8000-000000000002'); second.canonicalUrl = 'https://x.com/b/status/2'; second.sourceUrl = second.canonicalUrl; second.title = 'Other'
    const items = new Map([[first.id, first], [second.id, second]])
    expect(prepareRecord(items, { ...recordInput, itemId: first.id }, '2026-08-17T00:00:00.000Z', uuid)).toMatchObject({ ok: true, item: { id: first.id } })
    expect(prepareRecord(items, { ...recordInput, sourceUrl: second.sourceUrl, title: 'ignored' }, '2026-08-17T00:00:00.000Z', uuid)).toMatchObject({ ok: true, item: { id: second.id } })
    expect(prepareRecord(items, { ...recordInput, sourceUrl: undefined, title: '  pi  ' }, '2026-08-17T00:00:00.000Z', uuid)).toMatchObject({ ok: true, item: { id: first.id } })
  })
  it('returns conflicts and ambiguities without choosing a target', () => {
    const first = existing(); const second = existing('active', '10000000-0000-4000-8000-000000000002'); second.canonicalUrl = 'https://x.com/b/status/2'; second.sourceUrl = second.canonicalUrl; second.title = first.title
    const items = new Map([[first.id, first], [second.id, second]])
    expect(prepareRecord(items, { ...recordInput, itemId: first.id, sourceUrl: second.sourceUrl }, '2026-08-17T00:00:00.000Z', uuid)).toMatchObject({ ok: false, code: 'target_conflict' })
    expect(prepareRecord(items, { ...recordInput, sourceUrl: undefined }, '2026-08-17T00:00:00.000Z', uuid)).toMatchObject({ ok: false, code: 'ambiguous_target' })
  })
})
