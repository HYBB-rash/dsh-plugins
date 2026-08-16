/**
 * Interactive-root isolation specs (§10.3): the x_feed tools and the X
 * feedback contract reach ONLY the session-telegram root — never cron roots,
 * children, or the Web root.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, X_FEED_CONTRACT } from '../src/index.ts'
import { DeliveryReceipt } from '../src/receipt.ts'
import { XFeedbackStore } from '../src/store.ts'

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
  runFinishedHandlers: Array<(event: unknown) => Promise<void>>
  cleanups: Array<() => void | Promise<void>>
  emitRunFinished(event: unknown): Promise<void>
  ctx: Record<string, unknown>
}

function makeCtx(agents: MockAgent[], store: XFeedbackStore): Harness {
  const createdHandlers: Harness['createdHandlers'] = []
  const runFinishedHandlers: Harness['runFinishedHandlers'] = []
  const cleanups: Harness['cleanups'] = []
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    get: () => undefined,
    effect: async (cb: () => unknown) => {
      const cleanup = await cb()
      cleanups.push(typeof cleanup === 'function' ? cleanup : () => undefined)
      return cleanup
    },
    on: (name: string, handler: unknown) => {
      const handlers = name === 'agent/created'
        ? createdHandlers
        : name === 'dsh-cron/run-finished'
          ? runFinishedHandlers
          : undefined
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
  return {
    agents,
    createdHandlers,
    runFinishedHandlers,
    cleanups,
    async emitRunFinished(event) {
      for (const handler of [...runFinishedHandlers]) await handler(event)
    },
    ctx,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('root isolation (§10.3)', () => {
  it('session-telegram 看得到两项 x_feed_* 工具和合同', async () => {
    const store = new XFeedbackStore('/tmp/dsh-x-feed-isolation-a')
    const telegram = makeAgent('session-telegram', [], [])
    const tools: string[] = []
    const sections: string[] = []
    const telegramAgent = makeAgent('session-telegram', tools, sections)
    const harness = makeCtx([telegram, telegramAgent], store)
    await apply(harness.ctx as never, { cronJobId: 'cron-x-1' })
    expect(tools).toEqual(expect.arrayContaining(['x_feed_record_feedback', 'x_feed_list_saved']))
    expect(sections).toContain('x-feed:contract')
  })

  it('session-cron-* root 看不到工具与合同', async () => {
    const store = new XFeedbackStore('/tmp/dsh-x-feed-isolation-b')
    const tools: string[] = []
    const sections: string[] = []
    const cron = makeAgent('session-cron-cron-x-1', tools, sections)
    const harness = makeCtx([cron], store)
    await apply(harness.ctx as never, { cronJobId: 'cron-x-1' })
    expect(tools).toEqual([])
    expect(sections).toEqual([])
  })

  it('Web root 看不到（第一批不安装本插件）', async () => {
    const store = new XFeedbackStore('/tmp/dsh-x-feed-isolation-c')
    const tools: string[] = []
    const sections: string[] = []
    const web = makeAgent('session-web-root', tools, sections)
    const harness = makeCtx([web], store)
    await apply(harness.ctx as never, { cronJobId: 'cron-x-1' })
    expect(tools).toEqual([])
    expect(sections).toEqual([])
  })

  it('future telegram root（agent/created）也被安装；非交互 root 不安装', async () => {
    const store = new XFeedbackStore('/tmp/dsh-x-feed-isolation-d')
    const tools: string[] = []
    const sections: string[] = []
    const harness = makeCtx([], store)
    await apply(harness.ctx as never, { cronJobId: 'cron-x-1' })
    expect(harness.createdHandlers.length).toBe(1)
    const future = makeAgent('session-telegram', tools, sections)
    harness.agents.push(future)
    harness.createdHandlers[0]!({ agent: future.agent })
    expect(tools).toEqual(expect.arrayContaining(['x_feed_record_feedback', 'x_feed_list_saved']))
    expect(sections).toContain('x-feed:contract')
    const cronTools: string[] = []
    const cronSections: string[] = []
    const futureCron = makeAgent('session-cron-cron-x-1', cronTools, cronSections)
    harness.agents.push(futureCron)
    harness.createdHandlers[0]!({ agent: futureCron.agent })
    expect(cronTools).toEqual([])
    expect(cronSections).toEqual([])
  })

  it('不为普通 Telegram 对话安装全局中文短语拦截', async () => {
    const store = new XFeedbackStore('/tmp/dsh-x-feed-isolation-e')
    const tools: string[] = []
    const sections: string[] = []
    const rootEventNames: string[] = []
    const telegram = makeAgent('session-telegram', tools, sections, rootEventNames)
    const harness = makeCtx([telegram], store)

    await apply(harness.ctx as never, { cronJobId: 'cron-x-1' })

    expect(rootEventNames).not.toContain('agent/pre-step')
    expect(rootEventNames).not.toContain('agent/status')
  })

  it('dispose 后真正触发已注册 handler 也不再处理事件', async () => {
    const store = new XFeedbackStore('/tmp/dsh-x-feed-isolation-e')
    const harness = makeCtx([], store)
    const handle = vi.spyOn(DeliveryReceipt.prototype, 'handle').mockResolvedValue({ ok: true, skipped: true })
    await apply(harness.ctx as never, { cronJobId: 'cron-x-1' })
    expect(harness.runFinishedHandlers.length).toBe(1)

    await harness.emitRunFinished({ jobId: 'cron-x-1', status: 'success' })
    expect(handle).toHaveBeenCalledTimes(1)

    for (const cleanup of harness.cleanups) await cleanup()
    expect(harness.runFinishedHandlers).toHaveLength(0)
    await harness.emitRunFinished({ jobId: 'cron-x-1', status: 'success' })
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it('合同文本包含定位与歧义规则', () => {
    expect(X_FEED_CONTRACT).toContain('你指哪一条？')
    expect(X_FEED_CONTRACT).toContain('x_feed_record_feedback')
    expect(X_FEED_CONTRACT).toContain('不进长期 canary memory')
  })
})
