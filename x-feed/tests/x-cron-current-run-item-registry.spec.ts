import { describe, expect, it } from 'vitest'
import { CurrentRunItemRegistry } from '../src/x-cron/current-run-item-registry.ts'
import { parseXStatusIdentity } from '../src/x-cron/x-status-identity.ts'

const candidate = {
  id: 'x-status:1',
  source: 'https://x.com/alice/status/1',
  content: '一条候选',
  topics: ['topic-a'],
} as const

describe('current-run item registry', () => {
  it('creates immutable stable itemIds from package candidates and exposes only item references', () => {
    const registry = new CurrentRunItemRegistry([candidate])
    const item = registry.getByItemId('item:x-status:1')

    expect(item).toEqual({
      itemId: 'item:x-status:1',
      canonicalUrl: candidate.source,
      content: candidate.content,
      topics: ['topic-a'],
    })
    expect(Object.isFrozen(item)).toBe(true)
    expect(() => (item as { content: string }).content = 'changed').toThrow()
    expect(registry.modelAllowlist()).toEqual(['item:x-status:1'])
  })

  it('allows one exploration enhancement only for an existing candidate and keeps duplicate/unknown input side-effect free', () => {
    const unknown = new CurrentRunItemRegistry([candidate])
    const beforeUnknown = unknown.snapshot()
    expect(unknown.registerExploration({ kind: 'explore', itemId: 'item:unknown', content: '污染', topics: [] }))
      .toMatchObject({ ok: false, code: 'unknown_item' })
    expect(unknown.snapshot()).toEqual(beforeUnknown)

    const registry = new CurrentRunItemRegistry([candidate])
    expect(registry.registerExploration({ kind: 'explore',
      itemId: 'item:x-status:1',
      content: '探索补充',
      topics: ['topic-a', 'topic-b'],
    })).toMatchObject({ ok: true })
    const afterFirst = registry.snapshot()
    expect(registry.registerExploration({ kind: 'explore',
      itemId: 'item:x-status:1',
      content: '第二次补充',
      topics: ['topic-c'],
    })).toMatchObject({ ok: false, code: 'action_already_registered' })
    expect(registry.snapshot()).toEqual(afterFirst)
    expect(registry.snapshot()).toEqual(afterFirst)
  })

  it('registers a search batch once and rejects any second action without pollution', () => {
    const registry = new CurrentRunItemRegistry([])
    expect(registry.registerExploration({ kind: 'search', items: [candidate] })).toMatchObject({ ok: true })
    const afterFirst = registry.snapshot()
    expect(registry.registerExploration({ kind: 'search', items: [candidate] })).toMatchObject({ ok: false, code: 'action_already_registered' })
    expect(registry.registerExploration({ kind: 'explore', itemId: 'item:x-status:1', content: '第二次', topics: [] }))
      .toMatchObject({ ok: false, code: 'action_already_registered' })
    expect(registry.snapshot()).toEqual(afterFirst)
  })

  it('uses the formal canonical status identity and rejects query, photo, leading-zero, and bad username variants', () => {
    expect(parseXStatusIdentity('https://x.com/Alice/status/1')).toEqual({
      statusId: '1', canonicalUrl: 'https://x.com/alice/status/1', itemId: 'item:x-status:1',
    })
    for (const value of [
      'https://x.com/alice/status/01',
      'https://x.com/alice/status/1?utm_source=analytics',
      'https://x.com/alice/status/1#photo',
      'https://x.com/alice/photo/1',
      'https://x.com/alice-name/status/1',
    ]) expect(parseXStatusIdentity(value)).toBeUndefined()
  })

  it('stores the normalized canonical URL when the formal identity accepts username or twitter host casing', () => {
    const registry = new CurrentRunItemRegistry([{
      ...candidate,
      source: 'https://twitter.com/Alice/status/1',
    }])
    expect(registry.getByItemId('item:x-status:1')?.canonicalUrl).toBe('https://x.com/alice/status/1')
    const searched = new CurrentRunItemRegistry([])
    expect(searched.registerExploration({ kind: 'search', items: [{
      ...candidate,
      source: 'https://x.com/Alice/status/1',
    }] })).toMatchObject({ ok: true, items: [{ canonicalUrl: 'https://x.com/alice/status/1' }] })
  })

  it.each([
    { id: 'x-status:2', source: 'https://x.com/a/status/2?utm_source=bad', content: 'bad', topics: [] },
    { id: 'x-status:2', source: 'not a url', content: 'bad', topics: [] },
    { id: 'x-status:2', source: 'https://x.com/a/status/2', content: '', topics: [] },
    { id: 'x-status:2', source: 'https://x.com/a/status/2', content: 'bad', topics: [''] },
  ] as const)('rejects malformed or noncanonical package candidates without pollution', invalid => {
    expect(() => new CurrentRunItemRegistry([invalid])).toThrow()
  })
})
