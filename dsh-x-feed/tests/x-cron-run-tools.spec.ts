import { describe, expect, it, vi } from 'vitest'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  createXFeedRunTools,
  projectPrepareToolResult,
  projectThemeToolResult,
  projectExploreToolResult,
  projectSearchToolResult,
  type XFeedRunToolPort,
} from '../src/x-cron/run-tools.ts'

function port(): XFeedRunToolPort & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    searchTopic: vi.fn(async (topic: string) => { calls.push(`search:${topic}`); return { ok: true, topic } }),
    exploreCandidate: vi.fn(async (candidateId: string) => { calls.push(`explore:${candidateId}`); return { ok: true, candidateId } }),
    setTheme: vi.fn(async (theme: string) => { calls.push(`theme:${theme}`); return { ok: true, theme } }),
    prepareDelivery: vi.fn(async (text: string, urls: readonly string[]) => {
      calls.push(`prepare:${urls.join(',')}`)
      return { ok: true, preparedUrls: [...urls], text }
    }),
  }
}

describe('X cron narrow run tools', () => {
  it('exposes only the bounded run-local tools and no receipt/feedback/shell tools', () => {
    const definitions = createXFeedRunTools(port())
    const names = definitions.map(definition => definition.name)
    expect(names).toEqual([
      'x_feed_search_topic',
      'x_feed_explore_candidate',
      'x_feed_set_run_theme',
      'x_feed_prepare_delivery',
    ])
    expect(names.some(name => /shell|bash|file|session|browser|search_web|mark|receipt|feedback/i.test(name))).toBe(false)
  })

  it('uses strict schemas that reject unknown fields before the port is called', async () => {
    const deps = port()
    const definitions = createXFeedRunTools(deps)
    const search = definitions.find(definition => definition.name === 'x_feed_search_topic')!
    expect(validateJsonSchemaValue(search.parameters as never, { topic: 'ok', extra: true })).not.toEqual([])
    await expect(search.execute({ topic: 'ok', extra: true }, { signal: new AbortController().signal } as never))
      .rejects.toMatchObject({ code: 'INVALID_ARGS' })
    expect(deps.calls).toEqual([])
  })

  it('accepts model calls only with the exact narrow arguments', async () => {
    const deps = port()
    const definitions = createXFeedRunTools(deps)
    const find = (name: string) => definitions.find(definition => definition.name === name)!
    await find('x_feed_search_topic').execute({ topic: 'agentic systems' }, { signal: new AbortController().signal } as never)
    await find('x_feed_explore_candidate').execute({ candidateId: 'candidate-1' }, { signal: new AbortController().signal } as never)
    await find('x_feed_set_run_theme').execute({ theme: 'agentic systems' }, { signal: new AbortController().signal } as never)
    await find('x_feed_prepare_delivery').execute({
      text: '📦 X 洞察\n\n⭐ 高优先级\n- item (https://x.com/a/1)',
      urls: ['https://x.com/a/1'],
    }, { signal: new AbortController().signal } as never)
    expect(deps.calls).toEqual([
      'search:agentic systems', 'explore:candidate-1', 'theme:agentic systems', 'prepare:https://x.com/a/1',
    ])
  })

  it('converts structured port failures into bounded tool values', async () => {
    const deps = port()
    deps.searchTopic = vi.fn(async () => ({ ok: false, code: 'timeout', message: 'timed out' }))
    const search = createXFeedRunTools(deps).find(definition => definition.name === 'x_feed_search_topic')!
    await expect(search.execute({ topic: 'topic' }, { signal: new AbortController().signal } as never)).resolves.toMatchObject({
      ok: false,
      code: 'timeout',
    })
  })

  it('projects search results to the closed DTO and truncates them at 4KB', () => {
    const result = projectSearchToolResult({
      items: [
        {
          id: 'post-1',
          url: 'https://x.com/alice/status/1',
          text: '🙂'.repeat(3000),
          time: '2026-08-21T00:00:00Z',
          user: 'alice',
          topic: 'agentic systems',
          anchor: 'anchor-1',
          hop: 1,
          secret: 'must be dropped',
        },
        { id: 'post-2', url: 'https://x.com/alice/status/2', text: 'tail item' },
      ],
      unknownTopLevel: 'must be dropped',
    })
    expect(result).toMatchObject({ ok: true })
    const payload = (result as { result: Record<string, unknown> }).result
    expect(payload).toMatchObject({ truncated: true, totalItems: 2 })
    expect(payload.returnedItems).toBeGreaterThanOrEqual(1)
    expect(payload.returnedItems).toBeLessThanOrEqual(2)
    const items = payload.items as unknown[]
    expect(payload.returnedItems).toBe(items.length)
    expect(payload.retainedBytes).toBe(Buffer.byteLength(JSON.stringify({ items }), 'utf8'))
    expect(payload.originalBytes).toBeGreaterThanOrEqual(payload.retainedBytes as number)
    expect(payload).not.toHaveProperty('unknownTopLevel')
    expect(JSON.stringify(payload)).not.toContain('must be dropped')
    expect(JSON.stringify(payload)).not.toContain('\uFFFD')
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(4_000)
  })

  it('projects the real search tool result exactly once and preserves failures', async () => {
    const raw = {
      items: [
        {
          id: 'post-1',
          url: 'https://x.com/alice/status/1',
          text: '🙂'.repeat(3000),
          secret: 'drop me',
        },
        { id: 'post-2', url: 'https://x.com/alice/status/2', text: 'tail item' },
      ],
      unknownTopLevel: 'drop me',
    }
    const deps = port()
    deps.searchTopic = vi.fn(async () => raw)
    const search = createXFeedRunTools(deps).find(definition => definition.name === 'x_feed_search_topic')!
    const oversized = await search.execute({ topic: 'topic' }, { signal: new AbortController().signal } as never)
    expect(oversized).toEqual(projectSearchToolResult(raw))
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeLessThanOrEqual(4_000)

    const ordinaryRaw = { items: [{ id: 'post-1', url: 'https://x.com/1', text: 'small' }] }
    deps.searchTopic = vi.fn(async () => ordinaryRaw)
    const ordinary = await search.execute({ topic: 'topic' }, { signal: new AbortController().signal } as never)
    expect(ordinary).toEqual(projectSearchToolResult(ordinaryRaw))
    expect(ordinary).toMatchObject({ ok: true, result: { items: [{ id: 'post-1', url: 'https://x.com/1', text: 'small' }] } })
    expect((ordinary as { result: Record<string, unknown> }).result).not.toMatchObject({ ok: true })

    const failure = { ok: false as const, code: 'timeout', message: 'timed out' }
    deps.searchTopic = vi.fn(async () => failure)
    await expect(search.execute({ topic: 'topic' }, { signal: new AbortController().signal } as never))
      .resolves.toEqual(failure)
  })

  it('does not include a shown or Telegram operation in the prepare-delivery tool', () => {
    const prepare = createXFeedRunTools(port()).find(definition => definition.name === 'x_feed_prepare_delivery')!
    expect(JSON.stringify(prepare.parameters)).not.toMatch(/shown|telegram|receipt|confirm/i)
    expect(JSON.stringify(prepare.output.schema)).not.toMatch(/shown|telegram|receipt|confirm/i)
  })

  it('projects theme and prepare results to closed DTOs with bounded failures', () => {
    expect(projectThemeToolResult({ theme: 'fake', secret: 'leak' }, 'requested'))
      .toEqual({ ok: true, theme: 'requested' })
    expect(projectPrepareToolResult({ preparedUrls: ['leak'], secret: 'leak' }, 3))
      .toEqual({ ok: true, prepared: true, urlCount: 3 })
    const failure = { ok: false as const, code: 'invalid-output', message: 'x'.repeat(1_000) }
    const projectedFailure = projectPrepareToolResult(failure, 1)
    expect(projectedFailure).toMatchObject({ ok: false, code: 'invalid-output' })
    expect(projectedFailure.message).not.toContain('\uFFFD')
    expect(Buffer.byteLength(projectedFailure.message, 'utf8')).toBeLessThanOrEqual(256)
    const unknownRaw = projectThemeToolResult({ ok: true, unknown: 'x' }, 'requested')
    expect(unknownRaw).toEqual({ ok: true, theme: 'requested' })
    expect(JSON.stringify(unknownRaw)).not.toContain('unknown')
  })

  it('projects theme and prepare through the real tools without double wrapping or leakage', async () => {
    const deps = port()
    deps.setTheme = vi.fn(async () => ({ theme: 'fake', secret: 'leak' }))
    deps.prepareDelivery = vi.fn(async () => ({ preparedUrls: ['leak'], secret: 'leak' }))
    const definitions = createXFeedRunTools(deps)
    const theme = definitions.find(definition => definition.name === 'x_feed_set_run_theme')!
    const prepare = definitions.find(definition => definition.name === 'x_feed_prepare_delivery')!
    await expect(theme.execute({ theme: 'requested' }, { signal: new AbortController().signal } as never))
      .resolves.toEqual({ ok: true, theme: 'requested' })
    await expect(prepare.execute({ text: 'text', urls: ['a', 'b', 'c'] }, { signal: new AbortController().signal } as never))
      .resolves.toEqual({ ok: true, prepared: true, urlCount: 3 })
    deps.setTheme = vi.fn(async () => { throw new Error('x'.repeat(1_000)) })
    const thrown = await theme.execute({ theme: 'requested' }, { signal: new AbortController().signal } as never)
    expect(thrown).toMatchObject({ ok: false, code: 'run-failed' })
    expect((thrown as { message: string }).message).not.toContain('\uFFFD')
    expect(Buffer.byteLength((thrown as { message: string }).message, 'utf8')).toBeLessThanOrEqual(256)
  })

  it('projects explore results to a closed 2KB DTO without truncating title or URLs', () => {
    const raw = {
      title: 'A useful insight',
      body: '🙂'.repeat(3000),
      urls: ['https://x.com/a/1', 'https://x.com/a/2'],
      secret: 'drop me',
    }
    const result = projectExploreToolResult(raw)
    expect(result).toMatchObject({ ok: true })
    const payload = (result as { result: Record<string, unknown> }).result
    expect(payload).toMatchObject({ title: raw.title, urls: raw.urls, truncated: true })
    expect(payload).not.toHaveProperty('secret')
    expect(payload.retainedBytes).toBe(Buffer.byteLength(JSON.stringify({
      title: payload.title,
      body: payload.body,
      urls: payload.urls,
    }), 'utf8'))
    expect(payload.originalBytes).toBeGreaterThan(payload.retainedBytes as number)
    expect(JSON.stringify(result)).not.toContain('\uFFFD')
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(2_000)
  })

  it('fails closed when title or complete URLs cannot fit, and preserves failures', () => {
    const oversizedTitle = projectExploreToolResult({ title: 't'.repeat(2_000), body: '', urls: [] })
    expect(oversizedTitle).toEqual({
      ok: false,
      code: 'tool-result-too-large',
      message: 'X explore result cannot fit the 2000-byte model-result bound.',
    })

    const urls = [`https://x.com/${'u'.repeat(1_990)}`]
    const oversizedUrls = projectExploreToolResult({ title: 'title', body: '', urls })
    expect(oversizedUrls).toEqual({
      ok: false,
      code: 'tool-result-too-large',
      message: 'X explore result cannot fit the 2000-byte model-result bound.',
    })
    expect(JSON.stringify(oversizedUrls)).not.toContain(urls[0])

    const failure = { ok: false as const, code: 'timeout', message: 'timed out' }
    expect(projectExploreToolResult(failure)).toEqual(failure)
  })

  it('projects the real explore tool result exactly once and preserves tool failures', async () => {
    const raw = {
      title: 'A useful insight',
      body: '🙂'.repeat(3000),
      urls: ['https://x.com/a/1'],
      secret: 'drop me',
    }
    const deps = port()
    const explore = createXFeedRunTools(deps).find(definition => definition.name === 'x_feed_explore_candidate')!
    deps.exploreCandidate = vi.fn(async () => raw)
    const oversized = await explore.execute({ candidateId: 'candidate-1' }, { signal: new AbortController().signal } as never)
    expect(oversized).toEqual(projectExploreToolResult(raw))
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeLessThanOrEqual(2_000)

    const ordinaryRaw = { title: 'title', body: 'body', urls: ['https://x.com/1'] }
    deps.exploreCandidate = vi.fn(async () => ordinaryRaw)
    const ordinary = await explore.execute({ candidateId: 'candidate-1' }, { signal: new AbortController().signal } as never)
    expect(ordinary).toEqual(projectExploreToolResult(ordinaryRaw))
    expect(ordinary).toMatchObject({ ok: true, result: { title: 'title', body: 'body', urls: ['https://x.com/1'] } })
    expect((ordinary as { result: Record<string, unknown> }).result).not.toMatchObject({ ok: true })

    const failure = { ok: false as const, code: 'timeout', message: 'timed out' }
    deps.exploreCandidate = vi.fn(async () => failure)
    await expect(explore.execute({ candidateId: 'candidate-1' }, { signal: new AbortController().signal } as never))
      .resolves.toEqual(failure)

    deps.exploreCandidate = vi.fn(async () => { throw new Error('explorer broke') })
    await expect(explore.execute({ candidateId: 'candidate-1' }, { signal: new AbortController().signal } as never))
      .resolves.toEqual({ ok: false, code: 'run-failed', message: 'explorer broke' })
  })
})
