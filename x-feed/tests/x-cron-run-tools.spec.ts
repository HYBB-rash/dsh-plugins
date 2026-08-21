import { describe, expect, it, vi } from 'vitest'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createXFeedRunTools, type XFeedRunToolPort } from '../src/x-cron/run-tools.ts'

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

  it('does not include a shown or Telegram operation in the prepare-delivery tool', () => {
    const prepare = createXFeedRunTools(port()).find(definition => definition.name === 'x_feed_prepare_delivery')!
    expect(JSON.stringify(prepare.parameters)).not.toMatch(/shown|telegram|receipt|confirm/i)
    expect(JSON.stringify(prepare.output.schema)).not.toMatch(/shown|telegram|receipt|confirm/i)
  })
})
