import { describe, expect, it } from 'vitest'
import { collectFeedbackTargetCatalog } from '../src/x-feedback/target-catalog.ts'

describe('x feedback target catalog', () => {
  it('normalizes equivalent X status hosts and removes query, fragment, and trailing slash', () => {
    const result = collectFeedbackTargetCatalog(
      '请看 https://twitter.com/alice/status/123/?utm_source=chat#reply',
    )

    expect(result.catalog.currentMessage).toEqual([
      expect.objectContaining({
        id: 'x-status:123',
        source: 'https://x.com/alice/status/123',
        scope: 'current',
        content: expect.stringContaining('https://twitter.com/alice/status/123/'),
      }),
    ])
  })

  it('keeps multiple current candidates and does not semantically select one', () => {
    const result = collectFeedbackTargetCatalog(
      '喜欢 https://x.com/a/status/1，也看看 https://www.x.com/b/status/2',
    )

    expect(result.catalog.currentMessage.map((target) => target.source)).toEqual([
      'https://x.com/a/status/1',
      'https://x.com/b/status/2',
    ])
    expect(result.quick).toEqual({ kind: 'candidates', count: 2 })
  })

  it('deduplicates across current and reference while preferring current', () => {
    const result = collectFeedbackTargetCatalog(
      '当前 https://x.com/a/status/1',
      '引用 https://mobile.twitter.com/a/status/1/ 和 https://x.com/b/status/2',
    )

    expect(result.catalog.currentMessage).toHaveLength(1)
    expect(result.catalog.reference).toHaveLength(1)
    expect(result.catalog.reference[0]?.source).toBe('https://x.com/b/status/2')
    expect(result.catalog.currentMessage[0]?.content).toContain('当前')
    expect(result.catalog.reference[0]?.content).toContain('引用')
  })

  it('normalizes usernames case-insensitively before cross-source dedupe', () => {
    const result = collectFeedbackTargetCatalog(
      '当前 twitter.com/Alice/status/123',
      '引用 x.com/alice/status/123',
    )

    expect(result.catalog.currentMessage).toHaveLength(1)
    expect(result.catalog.reference).toEqual([])
    expect(result.catalog.currentMessage[0]?.source).toBe('https://x.com/alice/status/123')
  })

  it('rejects non-status links, invalid URLs, and ordinary words', () => {
    const result = collectFeedbackTargetCatalog(
      '这个方案我不喜欢 x.com/a/home https://x.com/a/status/not-a-number example.com/status/4',
      '普通词 status/55 与 https://x.com/a/status/ 没有候选',
    )

    expect(result.catalog).toEqual({ currentMessage: [], reference: [] })
    expect(result.quick).toEqual({ kind: 'pass' })
  })

  it('keeps source scope explicit and returns a structured quick result', () => {
    const result = collectFeedbackTargetCatalog(
      'https://x.com/a/status/99',
      'https://x.com/b/status/100',
    )

    expect(result.catalog.currentMessage[0]).toMatchObject({ scope: 'current' })
    expect(result.catalog.reference[0]).toMatchObject({ scope: 'reference' })
    expect(result.quick).toEqual({ kind: 'candidates', count: 2 })
  })
})
