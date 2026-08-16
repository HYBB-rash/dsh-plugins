/**
 * Feedback ledger specs (§10.1): validation, canonicalization, folding,
 * corrupt-line resilience, and the saved (read-later) list.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalizeUrl,
  foldFeedback,
  XFeedbackStore,
  type XFeedbackEvent,
} from '../src/store.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-x-feed-store-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let clock = 1_700_000_000_000
const now = () => clock++

describe('canonicalizeUrl', () => {
  it('X/Twitter 统一到 https://x.com/...，去 query 和 fragment', () => {
    expect(canonicalizeUrl('https://twitter.com/a/status/1?utm_source=x#frag')).toBe('https://x.com/a/status/1')
    expect(canonicalizeUrl('http://www.twitter.com/a/status/2?x=1')).toBe('https://x.com/a/status/2')
    expect(canonicalizeUrl('https://mobile.twitter.com/a/status/3')).toBe('https://x.com/a/status/3')
    expect(canonicalizeUrl('https://x.com/a/status/4?lang=zh')).toBe('https://x.com/a/status/4')
  })

  it('非 X URL 保留 host，去 query/fragment', () => {
    expect(canonicalizeUrl('https://github.com/o/r?tab=readme#top')).toBe('https://github.com/o/r')
  })
})

describe('XFeedbackStore.append validation (§10.1)', () => {
  it('url 与 topic 都没有 → 稳定错误，不写账本', () => {
    const store = new XFeedbackStore(tempDir())
    const r = store.append({ operation: 'like', now })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('missing_target')
    expect(store.readAll()).toHaveLength(0)
  })

  it('非法 operation → 稳定错误', () => {
    const store = new XFeedbackStore(tempDir())
    const r = store.append({ operation: 'favorite' as never, url: 'https://x.com/a/1', now })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid_operation')
  })

  it('写入事件包含规范化字段与原始 URL', () => {
    const store = new XFeedbackStore(tempDir())
    const r = store.append({ operation: 'like', url: 'https://twitter.com/u/status/9?x=1', title: '标题', note: '有增量', now })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.event.canonicalUrl).toBe('https://x.com/u/status/9')
    expect(r.event.originalUrl).toBe('https://twitter.com/u/status/9?x=1')
    expect(r.event.title).toBe('标题')
    expect(r.event.note).toBe('有增量')
    expect(r.event.schemaVersion).toBe(1)
    expect(r.event.id).toBeTruthy()
  })

  it('topic-only 事件允许（batch feedback，不伪造 URL）', () => {
    const store = new XFeedbackStore(tempDir())
    const r = store.append({ operation: 'dislike', topic: 'Codex 转述', note: '没有新增信息', now })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.event.topic).toBe('Codex 转述')
    expect(r.event.canonicalUrl).toBeUndefined()
  })
})

describe('folding (§10.1)', () => {
  function ev(partial: Partial<XFeedbackEvent>): XFeedbackEvent {
    return { schemaVersion: 1, id: partial.id ?? 'x', createdAt: partial.createdAt ?? 't', operation: 'like', ...partial } as XFeedbackEvent
  }

  it('同一 URL 后来的 like/dislike 覆盖旧偏好；save/unsave 独立维度', () => {
    const events = [
      ev({ operation: 'like', canonicalUrl: 'https://x.com/u/1', createdAt: 't1' }),
      ev({ operation: 'save', canonicalUrl: 'https://x.com/u/1', createdAt: 't2' }),
      ev({ operation: 'dislike', canonicalUrl: 'https://x.com/u/1', createdAt: 't3' }),
    ]
    const folded = foldFeedback(events)
    const state = folded.get('https://x.com/u/1')!
    expect(state.like).toBe(false) // dislike 覆盖 like
    expect(state.saved).toBe(true) // save 独立保留
  })

  it('原始事件不原地改写（append-only）', () => {
    const dir = tempDir()
    const store = new XFeedbackStore(dir)
    store.append({ operation: 'like', url: 'https://x.com/u/1', now })
    store.append({ operation: 'dislike', url: 'https://x.com/u/1', now })
    const all = store.readAll()
    expect(all).toHaveLength(2)
    expect(all[0]!.operation).toBe('like')
    expect(all[1]!.operation).toBe('dislike')
  })

  it('损坏的单行读取时跳过并告警，不影响其余事件', () => {
    const dir = tempDir()
    const store = new XFeedbackStore(dir)
    store.append({ operation: 'save', url: 'https://x.com/u/1', now })
    const ledger = join(dir, 'feedback.jsonl')
    writeFileSync(ledger, '{"broken"\n', { flag: 'a' })
    const beforeRead = readFileSync(ledger)
    const warns: string[] = []
    const all = store.readAll(message => warns.push(message))
    expect(all).toHaveLength(1)
    expect(warns.length).toBeGreaterThan(0)
    expect(readFileSync(ledger).equals(beforeRead)).toBe(true)

    // 后续 append 仍可用；坏行和此前所有字节必须原样保留。
    store.append({ operation: 'save', url: 'https://x.com/u/2', now })
    const afterAppend = readFileSync(ledger)
    expect(afterAppend.subarray(0, beforeRead.length).equals(beforeRead)).toBe(true)
    expect(afterAppend.toString('utf8')).toContain('{"broken"\n')
    const after = store.readAll()
    expect(after).toHaveLength(2)
    expect(after[0]!.canonicalUrl).toBe('https://x.com/u/1')
  })

  it('单条追加后，追加前的全部字节仍是文件的精确前缀', () => {
    const dir = tempDir()
    const ledger = join(dir, 'feedback.jsonl')
    const original = Buffer.from('{"broken"\n{"schemaVersion":1,"id":"old","createdAt":"t","operation":"like","topic":"旧主题"}\n', 'utf8')
    writeFileSync(ledger, original)

    const result = new XFeedbackStore(dir).append({
      operation: 'dislike',
      topic: '新主题',
      now,
    })

    expect(result.ok).toBe(true)
    const after = readFileSync(ledger)
    expect(after.subarray(0, original.length).equals(original)).toBe(true)
    expect(after.length).toBeGreaterThan(original.length)
  })

  it('两个 store 近并发追加 URL dislike 与 topic dislike 时不丢任何事件', async () => {
    const dir = tempDir()
    const first = new XFeedbackStore(dir)
    const second = new XFeedbackStore(dir)
    const totalExtraEvents = 40

    await Promise.all([
      Promise.resolve().then(() => first.append({
        operation: 'dislike',
        url: 'https://x.com/u/1',
        now,
      })),
      Promise.resolve().then(() => second.append({
        operation: 'dislike',
        topic: 'Codex 纯转述',
        now,
      })),
      ...Array.from({ length: totalExtraEvents }, (_, index) => Promise.resolve().then(() => {
        const store = index % 2 === 0 ? first : second
        return store.append({
          operation: 'save',
          url: `https://x.com/u/${index + 10}`,
          now,
        })
      })),
    ])

    const events = first.readAll()
    expect(events).toHaveLength(totalExtraEvents + 2)
    expect(events.some(event => event.canonicalUrl === 'https://x.com/u/1' && event.operation === 'dislike')).toBe(true)
    expect(events.some(event => event.topic === 'Codex 纯转述' && event.operation === 'dislike')).toBe(true)
  })
})

describe('saved list (§10.2)', () => {
  it('fold save/unsave，默认返回最近 20 条仍 saved，含 url/title/savedAt/note', () => {
    const store = new XFeedbackStore(tempDir())
    store.append({ operation: 'save', url: 'https://x.com/u/1', title: '第一条', now })
    store.append({ operation: 'save', url: 'https://x.com/u/2', title: '第二条', note: '值得回看', now })
    store.append({ operation: 'save', url: 'https://x.com/u/3', now })
    store.append({ operation: 'unsave', url: 'https://x.com/u/3', now })
    const saved = store.listSaved(20)
    expect(saved).toHaveLength(2)
    expect(saved[0]!.url).toBe('https://x.com/u/2') // 最新 save 在前
    expect(saved[0]!.note).toBe('值得回看')
    expect(saved[1]!.url).toBe('https://x.com/u/1')
    expect(saved.every(item => item.savedAt !== undefined)).toBe(true)
  })

  it('limit 生效且不访问 X/浏览器（纯本地读取）', () => {
    const store = new XFeedbackStore(tempDir())
    for (let i = 0; i < 5; i++) store.append({ operation: 'save', url: `https://x.com/u/${i}`, now })
    expect(store.listSaved(2)).toHaveLength(2)
  })
})
