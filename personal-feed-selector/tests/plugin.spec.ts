import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  installSelectionTools,
  PERSONAL_FEED_SELECT_ATTENTION_TOOL,
  registerSelectionTool,
} from '../src/plugin.ts'

function fakeAgent(id: string) {
  const registered: unknown[] = []
  const dispose = vi.fn()
  const ctx = {
    tools: { register: vi.fn((definition: unknown) => { registered.push(definition); return dispose }) },
    effect: vi.fn((factory: () => () => void) => factory()),
  }
  return {
    agent: {
      session: { id: SessionId(id), requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) },
      options: {},
      ctx,
    },
    registered,
    dispose,
  }
}

describe('root-scoped installation', () => {
  it('installs on a Web root but not a child or cron root', () => {
    const root = fakeAgent('session-web')
    const cron = fakeAgent('session-cron-1')
    const child = fakeAgent('session-child')
    const roots = [root.agent, cron.agent]
    let created: ((event: { agent: typeof root.agent }) => void) | undefined
    const stop = installSelectionTools({
      agents: { roots: () => roots } as never,
      llm: { stream: vi.fn() } as never,
      on: vi.fn((_name, callback) => { created = callback as never; return vi.fn() }) as never,
    }, { mode: 'web' })

    expect(root.registered).toHaveLength(1)
    expect(cron.registered).toHaveLength(0)
    created?.({ agent: child.agent })
    expect(child.registered).toHaveLength(0)
    stop()
    expect(root.dispose).toHaveBeenCalledTimes(1)
  })

  it('installs in Telegram only on the configured interactive root', () => {
    const telegram = fakeAgent('session-telegram-test')
    const other = fakeAgent('session-other')
    const roots = [telegram.agent, other.agent]
    const stop = installSelectionTools({
      agents: { roots: () => roots } as never,
      llm: { stream: vi.fn() } as never,
      on: vi.fn(() => vi.fn()) as never,
    }, { mode: 'telegram', telegramParentSessionId: 'session-telegram-test' })
    expect(telegram.registered).toHaveLength(1)
    expect(other.registered).toHaveLength(0)
    stop()
  })
})

describe('tool contract', () => {
  it('uses the public stable name and returns the explicit use-case result', async () => {
    const root = fakeAgent('root')
    const judge = {
      judge: vi.fn(async () => ({ status: 'completed' as const, decision: { kind: 'empty' as const } })),
    }
    registerSelectionTool(root.agent.ctx as never, judge)
    const definition = root.registered[0] as {
      name: string
      execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<unknown>
    }
    expect(definition.name).toBe(PERSONAL_FEED_SELECT_ATTENTION_TOOL)
    await expect(definition.execute({
      personalContext: { longTermInterests: 'agents', existingUnderstanding: 'basic retries' },
      candidates: [{ url: 'https://x.com/a/status/1', content: 'new protocol' }],
    }, { signal: new AbortController().signal })).resolves.toEqual({
      status: 'completed', outcome: { kind: 'empty' },
    })
  })
})
