import type {
  TelegramInboundEnvelope,
  TelegramInboundResult,
} from '@deepseek-ai/dsh-telegram-gateway'
import type { PersonalContextOwner } from '@herman/personal-feed'
import { describe, expect, it, vi } from 'vitest'
import { createPersonalContextTelegramRuntime } from '../src/personal-feed/personal-context-telegram-runtime.ts'

type Listener = (
  envelope: TelegramInboundEnvelope,
  next: () => TelegramInboundResult | Promise<TelegramInboundResult>,
) => TelegramInboundResult | Promise<TelegramInboundResult>

function envelope(currentText: string, messageId = 11): TelegramInboundEnvelope {
  return Object.freeze({
    chat: Object.freeze({ id: -7001, type: 'private' }),
    message: Object.freeze({ id: messageId }),
    currentText,
    signal: new AbortController().signal,
  })
}

function context() {
  let listener: Listener | undefined
  let stopped = false
  return {
    ctx: {
      on: vi.fn((_name: string, value: Listener) => {
        listener = value
        return () => { stopped = true }
      }),
    },
    run: async (value: TelegramInboundEnvelope, next: () => TelegramInboundResult | Promise<TelegramInboundResult>) => {
      if (listener === undefined) throw new Error('listener missing')
      return listener(value, next)
    },
    stopped: () => stopped,
  }
}

function owner(options: {
  readonly observe?: (input: unknown) => unknown | Promise<unknown>
  readonly snapshot?: (input: unknown) => unknown
} = {}) {
  return {
    observe: vi.fn(options.observe ?? (() => ({ kind: 'ignored' }))),
    snapshot: vi.fn(options.snapshot ?? (() => ({ kind: 'insufficient', laneStatus: {} }))),
  } as unknown as PersonalContextOwner & {
    readonly observe: ReturnType<typeof vi.fn>
    readonly snapshot: ReturnType<typeof vi.fn>
  }
}

describe('minimal Telegram Personal Context runtime', () => {
  it('observes an ordinary Telegram message once, then leaves the existing root and X feedback waterfall untouched', async () => {
    const facts = owner()
    const lifetime = new AbortController()
    const runtime = createPersonalContextTelegramRuntime({ owner: facts, installSignal: lifetime.signal })
    const harness = context()
    const stop = runtime.registerSourceFirst(harness.ctx as never)
    const next = vi.fn(async () => ({ kind: 'handled', finalText: 'old root' } as const))

    await expect(harness.run(envelope('这是普通消息'), next)).resolves.toEqual({ kind: 'handled', finalText: 'old root' })
    expect(facts.observe).toHaveBeenCalledTimes(1)
    expect(facts.observe.mock.calls[0]?.[0]).toMatchObject({
      source: { kind: 'telegram_inbound', chatId: -7001, messageId: 11 },
      rawText: '这是普通消息',
    })
    expect((facts.observe.mock.calls[0]?.[0] as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal)
    expect(next).toHaveBeenCalledTimes(1)

    stop()
    expect(harness.stopped()).toBe(true)
  })

  it('observes an explicit Feed request before continuing to the one downstream request handler and serves its same-request snapshot', async () => {
    const snapshot = Object.freeze({ kind: 'sufficient', snapshot: Object.freeze({ cutoff: 'same' }) })
    const facts = owner({ snapshot: () => snapshot })
    const runtime = createPersonalContextTelegramRuntime({ owner: facts, installSignal: new AbortController().signal })
    const harness = context()
    const request = Object.freeze({
      requestId: 'telegram:-7001:12',
      cutoff: '2026-09-01T00:00:00.000Z',
      shanghaiDay: '2026-09-01',
    })
    const personalFeedHandler = vi.fn(async () => {
      const r4 = await runtime.r4.snapshot({ request, signal: value.signal })
      expect(r4).toBe(snapshot)
      return { kind: 'handled', finalText: 'feed handled' } as const
    })
    runtime.registerSourceFirst(harness.ctx as never)

    const value = envelope('给我一次个人 Feed', 12)
    await expect(harness.run(value, personalFeedHandler)).resolves.toEqual({
      kind: 'handled', finalText: 'feed handled',
    })
    expect(facts.observe).toHaveBeenCalledTimes(1)
    expect(facts.snapshot).toHaveBeenCalledWith({ request })
    expect(personalFeedHandler).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['incomplete result', async () => ({ kind: 'incomplete', reason: 'semantic_unavailable' })],
    ['throw', async () => { throw new Error('PRIVATE_SEMANTIC_FAILURE') }],
  ])('marks only the current Feed request unknown when source observation has an %s', async (_label, observe) => {
    const facts = owner({ observe, snapshot: () => ({ kind: 'sufficient', snapshot: {} }) })
    const runtime = createPersonalContextTelegramRuntime({ owner: facts, installSignal: new AbortController().signal })
    const harness = context()
    const request = Object.freeze({
      requestId: 'telegram:-7001:13',
      cutoff: '2026-09-01T00:00:00.000Z',
      shanghaiDay: '2026-09-01',
    })
    const personalFeedHandler = vi.fn(async () => {
      const result = await runtime.r4.snapshot({ request, signal: value.signal })
      expect(result).toEqual({ kind: 'unknown', reason: 'current_source_unavailable' })
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SEMANTIC_FAILURE')
      return { kind: 'handled', finalText: '这次没有完成：个人语境未完成。' } as const
    })
    runtime.registerSourceFirst(harness.ctx as never)

    const value = envelope('给我一次个人 Feed', 13)
    await expect(harness.run(value, personalFeedHandler)).resolves.toMatchObject({
      kind: 'handled', finalText: '这次没有完成：个人语境未完成。',
    })
    expect(facts.snapshot).not.toHaveBeenCalled()
    expect(personalFeedHandler).toHaveBeenCalledTimes(1)

    await expect(runtime.r4.snapshot({ request, signal: new AbortController().signal })).resolves.toEqual({
      kind: 'sufficient', snapshot: {},
    })
    expect(facts.snapshot).toHaveBeenCalledTimes(1)
  })

  it('does not hijack X feedback or block the old root when ordinary context observation fails', async () => {
    const facts = owner({ observe: async () => { throw new Error('context unavailable') } })
    const runtime = createPersonalContextTelegramRuntime({ owner: facts, installSignal: new AbortController().signal })
    const harness = context()
    runtime.registerSourceFirst(harness.ctx as never)
    const next = vi.fn(async () => ({ kind: 'handled', finalText: 'x feedback' } as const))

    await expect(harness.run(envelope('https://x.com/alice/status/42'), next)).resolves.toEqual({
      kind: 'handled', finalText: 'x feedback',
    })
    expect(next).toHaveBeenCalledTimes(1)
  })
})
