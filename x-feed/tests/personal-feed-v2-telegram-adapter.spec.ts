import { describe, expect, it, vi } from 'vitest'
import type { TelegramInboundEnvelope, TelegramInboundResult } from '@deepseek-ai/dsh-telegram-gateway'
import {
  createPersonalFeedTelegramRequestHandler,
  registerPersonalFeedTelegramAdapter,
} from '../src/personal-feed/telegram-adapter.ts'

type Waterfall = (
  envelope: TelegramInboundEnvelope,
  next: () => TelegramInboundResult | Promise<TelegramInboundResult>,
) => TelegramInboundResult | Promise<TelegramInboundResult>

function context() {
  const listeners: Array<(...args: any[]) => unknown> = []
  const stops: number[] = []
  return {
    ctx: {
      on: (_name: string, listener: (...args: any[]) => unknown) => {
        listeners.push(listener)
        return () => { stops.push(1) }
      },
    },
    listener: () => listeners.at(-1) as Waterfall,
    stops,
  }
}

function envelope(currentText: string, reference?: TelegramInboundEnvelope['reference']): TelegramInboundEnvelope {
  return Object.freeze({
    chat: Object.freeze({ id: 7, type: 'private' }),
    message: Object.freeze({ id: 11 }),
    currentText,
    ...(reference === undefined ? {} : { reference: Object.freeze(reference) }),
    signal: new AbortController().signal,
  })
}

describe('Personal Feed v2 Telegram adapter', () => {
  it('uses one shared request handler and returns the coordinator text as a normal handled result without a delivery protocol', async () => {
    const prepare = vi.fn(async () => Object.freeze({
      kind: 'prepared',
      request: Object.freeze({ requestId: 'telegram:7:11', cutoff: '2026-08-31T02:00:00.000Z', shanghaiDay: '2026-08-31' }),
      outcome: Object.freeze({ kind: 'one_link', finalText: 'https://x.com/alice/status/42' }),
    }))
    const handler = createPersonalFeedTelegramRequestHandler({ coordinator: Object.freeze({ prepare }) } as never)
    const result = await handler(envelope('给我一次个人 Feed'))
    expect(result).toEqual({ kind: 'handled', finalText: 'https://x.com/alice/status/42' })
    expect(Reflect.ownKeys(result)).toEqual(['kind', 'finalText'])
    expect(prepare).toHaveBeenCalledWith({ chatId: 7, messageId: 11, signal: expect.any(AbortSignal) })
  })

  it('handles blank input before matcher, coordinator, or root', async () => {
    const sample = context()
    const handler = vi.fn()
    const next = vi.fn(() => ({ kind: 'root-delivered' as const }))
    registerPersonalFeedTelegramAdapter(sample.ctx as never, { handler } as never)
    await expect(sample.listener()(envelope('  \t\n '), next)).resolves.toEqual({ kind: 'handled', finalText: '' })
    expect(handler).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it.each([
    '给我一次个人 Feed',
    '我想看一下 personal feed',
    '我最近不关心通用 AI 新闻了，给我一次个人 Feed。',
  ])('intercepts the explicit request %s exactly once and never reaches root', async currentText => {
    const sample = context()
    const handler = vi.fn(async () => ({ kind: 'handled' as const, finalText: '这次没有完成：判断或执行未完成。' }))
    const next = vi.fn(() => ({ kind: 'root-delivered' as const }))
    registerPersonalFeedTelegramAdapter(sample.ctx as never, { handler } as never)
    await expect(sample.listener()(envelope(currentText), next)).resolves.toEqual({
      kind: 'handled',
      finalText: '这次没有完成：判断或执行未完成。',
    })
    expect(handler).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
  })

  it.each([
    ['普通消息', undefined],
    ['帮我设计个人 Feed', undefined],
    ['不要给我个人 Feed', undefined],
    ['给我个人 Feed 的设计方案', undefined],
    ['看看 https://x.com/alice/status/42', undefined],
    ['普通消息', { messageText: 'https://x.com/alice/status/42' }],
    ['给我一次个人 Feed', { selectedText: 'https://twitter.com/alice/status/42' }],
  ] as const)('passes %s to the old root when it is not an explicit feed request or carries X feedback context', async (currentText, reference) => {
    const sample = context()
    const handler = vi.fn()
    const next = vi.fn(() => ({ kind: 'root-delivered' as const }))
    registerPersonalFeedTelegramAdapter(sample.ctx as never, { handler } as never)
    await expect(sample.listener()(envelope(currentText, reference), next)).resolves.toEqual({ kind: 'root-delivered' })
    expect(handler).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })

  it('returns the exact visible incomplete failure and disposes the single listener once when the coordinator throws', async () => {
    const sample = context()
    const prepare = vi.fn(async () => { throw new Error('unavailable') })
    const next = vi.fn()
    const handler = createPersonalFeedTelegramRequestHandler({ coordinator: { prepare } } as never)
    const dispose = registerPersonalFeedTelegramAdapter(sample.ctx as never, { handler } as never)
    await expect(sample.listener()(envelope('给我一次个人 Feed'), next)).resolves.toEqual({
      kind: 'failed',
      visibleError: '这次没有完成：判断或执行未完成。',
    })
    expect(next).not.toHaveBeenCalled()
    dispose()
    dispose()
    expect(sample.stops).toHaveLength(1)
  })
})
