import { describe, expect, it } from 'vitest'
import { InMemoryPendingStore } from '../src/x-feedback/pending-store.ts'

const pending = {
  kind: 'awaiting_reason' as const,
  target: { id: 'x:1', content: '内容', source: 'x://1', scope: '当前消息' },
  dimension: 'content_value' as const,
  sentiment: 'dislike' as const,
  rawUserExpression: '不喜欢。',
}

describe('InMemoryPendingStore', () => {
  it('keeps at most one pending item per conversation key', () => {
    let now = 10
    const store = new InMemoryPendingStore({ ttlMs: 100, clock: { now: () => now } })

    store.set('chat-a', pending)
    store.set('chat-a', { ...pending, rawUserExpression: '不喜欢第二条。' })

    expect(store.get('chat-a')).toMatchObject({ rawUserExpression: '不喜欢第二条。' })
    expect(store.get('chat-b')).toBeUndefined()
  })

  it('expires at the injected clock boundary and can clear/unload without persistence', () => {
    let now = 10
    const store = new InMemoryPendingStore({ ttlMs: 100, clock: { now: () => now } })
    store.set('chat-a', pending)

    now = 110
    expect(store.get('chat-a')).toBeUndefined()
    store.set('chat-a', pending)
    store.clear('chat-a')
    expect(store.get('chat-a')).toBeUndefined()
    store.set('chat-a', pending)
    store.unload()
    expect(store.get('chat-a')).toBeUndefined()
  })
})
