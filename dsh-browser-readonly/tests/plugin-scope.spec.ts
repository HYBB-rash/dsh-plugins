import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

function agent(id: string, tools: string[], sections: string[]) {
  return { session: { id }, ctx: {
    tools: { register: (tool: { name: string }) => { tools.push(tool.name); return () => { const index = tools.indexOf(tool.name); if (index >= 0) tools.splice(index, 1) } } },
    systemPrompt: { section: (section: { name: string }) => { sections.push(section.name); return () => { const index = sections.indexOf(section.name); if (index >= 0) sections.splice(index, 1) } } },
    effect: (callback: () => unknown) => callback(),
  } }
}

describe('browser plugin root scope', () => {
  it('installs only on the precise Telegram root', async () => {
    const telegramTools: string[] = []; const telegramSections: string[] = []
    const cronTools: string[] = []; const cronSections: string[] = []
    const telegram = agent('session-telegram', telegramTools, telegramSections)
    const cron = agent('session-cron-hourly', cronTools, cronSections)
    const handlers: Array<(event: { agent: typeof telegram }) => void> = []
    const ctx = {
      agents: { roots: () => [telegram, cron] },
      effect: async (callback: () => unknown) => await callback(),
      on: (name: string, handler: unknown) => { if (name === 'agent/created') handlers.push(handler as never); return () => undefined },
    }
    await apply(ctx as never, {})
    expect(telegramTools).toEqual(['research_read_page'])
    expect(telegramSections).toEqual(['browser-readonly:contract'])
    expect(cronTools).toEqual([])
    expect(cronSections).toEqual([])
  })

  it('installs a future Telegram root, excludes Web and continuable child, and disposes all contributions', async () => {
    const futureTools: string[] = []; const futureSections: string[] = []
    const webTools: string[] = []; const webSections: string[] = []
    const childTools: string[] = []; const childSections: string[] = []
    const roots: Array<ReturnType<typeof agent>> = []
    const handlers: Array<(event: { agent: ReturnType<typeof agent> }) => void> = []
    const cleanups: Array<() => unknown> = []
    const ctx = {
      agents: { roots: () => roots },
      effect: async (callback: () => unknown) => { const cleanup = await callback(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup },
      on: (name: string, handler: unknown) => { if (name === 'agent/created') handlers.push(handler as never); return () => undefined },
    }
    await apply(ctx as never, {})
    const future = agent('session-telegram', futureTools, futureSections)
    roots.push(future)
    handlers[0]!({ agent: future })
    const web = agent('session-web-root', webTools, webSections)
    roots.push(web)
    handlers[0]!({ agent: web })
    const continuableChild = agent('session-telegram', childTools, childSections)
    handlers[0]!({ agent: continuableChild })
    expect(futureTools).toEqual(['research_read_page'])
    expect(futureSections).toEqual(['browser-readonly:contract'])
    expect(webTools).toEqual([])
    expect(webSections).toEqual([])
    expect(childTools).toEqual([])
    expect(childSections).toEqual([])
    for (const cleanup of cleanups) await cleanup()
    expect(futureTools).toEqual([])
    expect(futureSections).toEqual([])
  })
})
