/**
 * Interactive-root isolation specs (§10.3): the x_feed tools and the X
 * feedback contract reach ONLY the session-telegram root — never cron roots,
 * children, or the Web root.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTelegramExtension, X_FEED_CONTRACT } from '../src/index.ts'
import { registerXFeedTools } from '../src/tools.ts'
import { XFeedbackStore } from '../src/store.ts'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface MockAgent {
  agent: {
    session: { id: string | undefined }
    ctx: {
      tools: { register: (def: { name: string }) => () => void }
      systemPrompt: { section: (section: { name: string; order: number; text: string }) => () => void }
      effect: (cb: () => unknown) => unknown
      on: (name: string, handler: unknown) => () => void
    }
  }
}

function makeAgent(
  sessionId: string | undefined,
  tools: string[],
  sections: string[],
  eventNames: string[] = [],
): MockAgent {
  return {
    agent: {
      session: { id: sessionId },
      ctx: {
        tools: {
          register: (def) => {
            tools.push(def.name)
            return () => undefined
          },
          guard: () => () => undefined,
        },
        systemPrompt: {
          section: (section) => {
            sections.push(section.name)
            return () => undefined
          },
        },
        effect: (cb) => {
          const cleanup = cb()
          return typeof cleanup === 'function' ? cleanup : () => undefined
        },
        on: (name) => {
          eventNames.push(name)
          return () => undefined
        },
      },
    },
  }
}

interface Harness {
  agents: MockAgent[]
  createdHandlers: Array<(payload: { agent: { session: { id: string | undefined } } }) => void>
  eventNames: string[]
  ctx: Record<string, unknown>
}

function makeCtx(agents: MockAgent[]): Harness {
  const createdHandlers: Harness['createdHandlers'] = []
  const eventNames: string[] = []
  const sessionQuery = {
    listEvents: async (_sessionId: string) => [],
    readEvent: async (_input: unknown) => undefined,
  }
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    get: (name: string) => name === 'sessionQuery'
      ? sessionQuery
      : name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
        : undefined,
    llm: { stream: async function* (_request: unknown) { /* empty fixture stream */ } },
    on: (name: string, handler: unknown) => {
      eventNames.push(name)
      const handlers = name === 'agent/created' ? createdHandlers : undefined
      if (handlers === undefined) return () => undefined
      const typedHandler = handler as never
      handlers.push(typedHandler)
      return () => {
        const index = handlers.indexOf(typedHandler)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
    agents: { roots: () => agents.map(a => a.agent) },
  }
  return { agents, createdHandlers, eventNames, ctx }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('root isolation (§10.3)', () => {
  it('旧工具 rating 在执行器最前面稳定拒绝且零写入，save/unsave 仍可用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-x-feed-tools-'))
    try {
      const store = new XFeedbackStore(dir)
      const definitions: Array<{ name: string; execute?: (args: Record<string, unknown>) => Promise<unknown> }> = []
      registerXFeedTools({
        tools: { register: (definition: unknown) => {
          definitions.push(definition as { name: string; execute?: (args: Record<string, unknown>) => Promise<unknown> })
          return () => undefined
        } },
      }, { store, logger: { warn: () => undefined } })
      const feedback = definitions.find(definition => definition.name === 'x_feed_record_feedback')!
      const rejected = await feedback.execute!({ operation: 'dislike', url: 'https://x.com/u/1', note: '旧评价' })
      expect(rejected).toMatchObject({ ok: false, code: 'rating_requires_clean_feedback' })
      expect(existsSync(join(dir, 'feedback.jsonl'))).toBe(false)

      const saved = await feedback.execute!({ operation: 'save', url: 'https://twitter.com/u/1?utm_source=test', title: '标题', note: '收藏理由' })
      expect(saved).toMatchObject({ ok: true, event: { operation: 'save', canonicalUrl: 'https://x.com/u/1' } })
      const unsaved = await feedback.execute!({ operation: 'unsave', url: 'https://x.com/u/1' })
      expect(unsaved).toMatchObject({ ok: true, event: { operation: 'unsave' } })
      expect(JSON.parse(readFileSync(join(dir, 'feedback.jsonl'), 'utf8').split('\n')[0]!).operation).toBe('save')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tool2 注册失败时回滚 tool1 并保留原始错误', () => {
    const firstStop = vi.fn()
    const registrationError = new Error('tool2 registration failed')
    let calls = 0
    const toolCtx = {
      tools: {
        register: vi.fn(() => {
          calls += 1
          if (calls === 2) throw registrationError
          return firstStop
        }),
      },
    }

    expect(() => registerXFeedTools(toolCtx, { store: {} as XFeedbackStore, logger: { warn: vi.fn() } }))
      .toThrow(registrationError)
    expect(firstStop).toHaveBeenCalledOnce()
    expect(toolCtx.tools.register).toHaveBeenCalledTimes(2)
  })

  it('正常工具 disposer 严格按 tool2→tool1 执行且重复调用不重复', () => {
    const order: string[] = []
    let registrations = 0
    const toolCtx = {
      tools: {
        register: vi.fn(() => {
          registrations += 1
          const name = registrations === 1 ? 'tool1' : 'tool2'
          return vi.fn(() => { order.push(name) })
        }),
      },
    }

    const dispose = registerXFeedTools(toolCtx, { store: {} as XFeedbackStore, logger: { warn: vi.fn() } })
    dispose()
    dispose()

    expect(order).toEqual(['tool2', 'tool1'])
  })

  it('tool2 disposer 抛错时仍清理 tool1、显式失败，并在重复调用时重抛同一错误', () => {
    const disposerError = new Error('tool2 cleanup failed')
    const order: string[] = []
    let calls = 0
    const toolCtx = {
      tools: {
        register: vi.fn(() => {
          calls += 1
          if (calls === 1) return vi.fn(() => { order.push('tool1') })
          return vi.fn(() => {
            order.push('tool2')
            throw disposerError
          })
        }),
      },
    }

    const dispose = registerXFeedTools(toolCtx, { store: {} as XFeedbackStore, logger: { warn: vi.fn() } })
    expect(() => dispose()).toThrow(disposerError)
    expect(order).toEqual(['tool2', 'tool1'])
    expect(() => dispose()).toThrow(disposerError)
    expect(order).toEqual(['tool2', 'tool1'])
  })

  it('session-telegram 看得到两项 x_feed_* 工具和合同', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'x-feed-isolation-a-'))
    const telegram = makeAgent('session-telegram', [], [])
    const tools: string[] = []
    const sections: string[] = []
    const telegramAgent = makeAgent('session-telegram', tools, sections)
    const harness = makeCtx([telegram, telegramAgent])
    try {
      const dispose = await installTelegramExtension(harness.ctx as never, {
        dataDir,
        personalFeedDataDir: join(dataDir, 'personal-feed'),
      })
      expect(tools).toEqual(expect.arrayContaining(['x_feed_record_feedback', 'x_feed_list_saved']))
      expect(tools.filter(name => /personal.?context|semantic|submission/u.test(name))).toEqual([])
      expect(sections).toContain('x-feed:contract')
      await dispose()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('session-cron-* root 看不到工具与合同', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'x-feed-isolation-b-'))
    const tools: string[] = []
    const sections: string[] = []
    const cron = makeAgent('session-cron-cron-x-1', tools, sections)
    const harness = makeCtx([cron])
    try {
      const dispose = await installTelegramExtension(harness.ctx as never, {
        dataDir,
        personalFeedDataDir: join(dataDir, 'personal-feed'),
      })
      expect(tools).toEqual([])
      expect(sections).toEqual([])
      await dispose()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('Web root 看不到（第一批不安装本插件）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'x-feed-isolation-c-'))
    const tools: string[] = []
    const sections: string[] = []
    const web = makeAgent('session-web-root', tools, sections)
    const harness = makeCtx([web])
    try {
      const dispose = await installTelegramExtension(harness.ctx as never, {
        dataDir,
        personalFeedDataDir: join(dataDir, 'personal-feed'),
      })
      expect(tools).toEqual([])
      expect(sections).toEqual([])
      await dispose()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('future telegram root（agent/created）也被安装；非交互 root 不安装', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'x-feed-isolation-d-'))
    const tools: string[] = []
    const sections: string[] = []
    const harness = makeCtx([])
    try {
      const dispose = await installTelegramExtension(harness.ctx as never, {
        dataDir,
        personalFeedDataDir: join(dataDir, 'personal-feed'),
      })
      expect(harness.createdHandlers.length).toBe(1)
      const future = makeAgent('session-telegram', tools, sections)
      harness.agents.push(future)
      harness.createdHandlers[0]!({ agent: future.agent })
      expect(tools).toEqual(expect.arrayContaining(['x_feed_record_feedback', 'x_feed_list_saved']))
      expect(tools.filter(name => /personal.?context|semantic|submission/u.test(name))).toEqual([])
      expect(sections).toContain('x-feed:contract')
      const cronTools: string[] = []
      const cronSections: string[] = []
      const futureCron = makeAgent('session-cron-cron-x-1', cronTools, cronSections)
      harness.agents.push(futureCron)
      harness.createdHandlers[0]!({ agent: futureCron.agent })
      expect(cronTools).toEqual([])
      expect(cronSections).toEqual([])
      await dispose()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('不为普通 Telegram 对话安装全局中文短语拦截', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'x-feed-isolation-e-'))
    const tools: string[] = []
    const sections: string[] = []
    const rootEventNames: string[] = []
    const telegram = makeAgent('session-telegram', tools, sections, rootEventNames)
    const harness = makeCtx([telegram])
    try {
      const dispose = await installTelegramExtension(harness.ctx as never, {
        dataDir,
        personalFeedDataDir: join(dataDir, 'personal-feed'),
      })
      expect(rootEventNames).not.toContain('agent/pre-step')
      expect(rootEventNames).not.toContain('agent/status')
      expect(harness.eventNames).not.toContain('dsh-cron/run-finished')
      await dispose()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('X 业务适配器没有 Cordis 插件入口', async () => {
    const module = await import('../src/index.ts')
    expect(module).not.toHaveProperty('apply')
    expect(module).not.toHaveProperty('name')
    expect(module).not.toHaveProperty('inject')
  })

  it('合同文本包含定位与歧义规则', () => {
    expect(X_FEED_CONTRACT).toContain('你指哪一条？')
    expect(X_FEED_CONTRACT).toContain('x_feed_record_feedback')
    expect(X_FEED_CONTRACT).toContain('不进长期 canary memory')
  })
})
