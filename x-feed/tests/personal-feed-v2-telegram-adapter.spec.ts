import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  TelegramInboundEnvelope,
  TelegramInboundResult,
} from '@deepseek-ai/dsh-telegram-gateway'
import { createPersonalFeedV2RequestCoordinator } from '@herman/personal-feed'
import {
  registerPersonalFeedTelegramAdapter,
} from '../src/personal-feed/telegram-adapter.ts'

type Waterfall = (
  envelope: TelegramInboundEnvelope,
  next: () => TelegramInboundResult | Promise<TelegramInboundResult>,
) => TelegramInboundResult | Promise<TelegramInboundResult>

interface Calls {
  r4: number
  r2: number
  r3: number
  r5: number
}

function context() {
  const registered = new Map<string, Array<(...args: any[]) => unknown>>()
  const ctx = {
    on: (name: string, listener: (...args: any[]) => unknown) => {
      const listeners = registered.get(name) ?? []
      listeners.push(listener)
      registered.set(name, listeners)
      return () => undefined
    },
  }
  return { ctx, registered }
}

function envelope(
  currentText: string,
  reference?: TelegramInboundEnvelope['reference'],
): TelegramInboundEnvelope {
  return Object.freeze({
    chat: Object.freeze({ id: 7, type: 'private' }),
    message: Object.freeze({ id: 11 }),
    currentText,
    ...(reference === undefined ? {} : { reference: Object.freeze(reference) }),
    signal: new AbortController().signal,
  })
}

function listener(registered: Map<string, Array<(...args: any[]) => unknown>>): Waterfall {
  const handlers = registered.get('telegram/inbound') ?? []
  const value = handlers.at(-1)
  if (value === undefined) throw new Error('personal Feed adapter did not register a waterfall listener')
  return value as Waterfall
}

function realCoordinator(directory: string) {
  const calls: Calls = { r4: 0, r2: 0, r3: 0, r5: 0 }
  const coordinator = createPersonalFeedV2RequestCoordinator({
    ledgerPath: join(directory, 'requests.jsonl'),
    clock: { now: () => new Date('2026-08-31T15:59:59.000Z') },
    r4: {
      snapshot: async () => {
        calls.r4 += 1
        return Object.freeze({
          kind: 'sufficient',
          snapshot: Object.freeze({ source: 'x', captured: true }),
        })
      },
    },
    r2: {
      observe: async () => {
        calls.r2 += 1
        return Object.freeze({
          kind: 'complete',
          window: Object.freeze({ source: 'x', complete: true }),
        })
      },
    },
    r3: {
      admit: async (input: { readonly request: { readonly requestId: string }}) => {
        calls.r3 += 1
        const receipt = Object.freeze({
          kind: 'candidate_judgment_completed' as const,
          stableId: 'x-status:42',
          requestId: input.request.requestId,
          position: 0,
          judgment: 'qualified' as const,
          completedAt: '2026-08-31T16:00:00.000Z',
        })
        const lease = Object.freeze({
          stableId: receipt.stableId,
          canonicalUrl: 'https://x.com/alice/status/42',
          position: 0,
          body: 'adapter candidate',
          provenance: Object.freeze({
            capturedAt: '2026-08-31T16:00:00.000Z',
            surface: 'for_you' as const,
            surfaceOrdinal: 0,
            occurrenceOrdinal: 0,
            canonicalUrl: 'https://x.com/alice/status/42',
            authorHandle: 'adapter-author',
            publishedAt: '2026-08-30T12:00:00.000Z',
          }),
          completeCurrent: async () => receipt,
        })
        let borrowed = false
        return Object.freeze({
          kind: 'admitted',
          cursor: Object.freeze({
            borrowCurrent: async () => {
              if (borrowed) return Object.freeze({ kind: 'done' as const })
              borrowed = true
              return Object.freeze({ kind: 'candidate' as const, lease })
            },
            finalize: async () => Object.freeze({ kind: 'selected' as const, selected: { stableId: receipt.stableId, canonicalUrl: lease.canonicalUrl, position: 0 } }),
            close: async () => undefined,
          }),
        })
      },
    },
    r5: {
      judge: async (input: { readonly candidates: { readonly borrowCurrent: (input: { readonly signal: AbortSignal }) => Promise<unknown> }; readonly signal: AbortSignal }) => {
        calls.r5 += 1
        const first = await input.candidates.borrowCurrent({ signal: input.signal }) as { readonly kind: string; readonly lease?: { readonly completeCurrent: (input: unknown) => Promise<unknown> } }
        if (first.kind !== 'candidate' || first.lease === undefined) throw new Error('adapter fixture candidate missing')
        const receipt = await first.lease.completeCurrent({ judgment: 'qualified' })
        expect(await input.candidates.borrowCurrent({ signal: input.signal })).toEqual({ kind: 'done' })
        return Object.freeze({ kind: 'selected' as const, completed: Object.freeze([receipt]), selected: receipt })
      },
    },
  })
  return { coordinator, calls }
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Personal Feed v2 Telegram adapter matcher', () => {
  it('exports one shared request handler that can be invoked independently of adapter registration', async () => {
    const module = await import('../src/personal-feed/telegram-adapter.ts') as {
      readonly createPersonalFeedTelegramRequestHandler?: (options: { readonly coordinator: unknown }) =>
        (envelope: TelegramInboundEnvelope) => Promise<TelegramInboundResult>
    }
    expect(typeof module.createPersonalFeedTelegramRequestHandler).toBe('function')
    if (typeof module.createPersonalFeedTelegramRequestHandler !== 'function') return

    const directory = mkdtempSync(join(tmpdir(), 'x-feed-shared-handler-'))
    temporaryDirectories.push(directory)
    const { coordinator, calls } = realCoordinator(directory)
    const handler = module.createPersonalFeedTelegramRequestHandler({ coordinator })
    expect(typeof handler).toBe('function')
    const result = await handler(envelope('给我一次个人 Feed'))
    expect(result).toMatchObject({
      kind: 'handled-awaiting-delivery',
      finalText: 'https://x.com/alice/status/42',
    })
    if (result.kind !== 'handled-awaiting-delivery') throw new Error('shared handler did not prepare delivery')
    result.settle({
      chatId: 7,
      triggerMessageId: 11,
      visibleText: result.finalText,
      messageIds: [901],
    })
    expect(coordinator.read('telegram:7:11')).toMatchObject({ status: 'delivered' })
    expect(calls).toEqual({ r4: 1, r2: 1, r3: 1, r5: 1 })
  })

  it('handles an empty or whitespace envelope before matcher, request ledger, capture, X, or root', async () => {
    const { ctx, registered } = context()
    const prepare = vi.fn(async () => { throw new Error('blank must not prepare') })
    const dispose = registerPersonalFeedTelegramAdapter(ctx as never, {
      coordinator: { prepare, read: () => undefined },
    } as never)
    const next = vi.fn(() => ({ kind: 'root-delivered' as const }))

    await expect(listener(registered)(envelope('  \t\n  '), next)).resolves.toEqual({ kind: 'handled', finalText: '' })
    expect(prepare).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
    dispose()
  })

  it.each([
    '给我一次个人 Feed',
    '我想看一下 personal feed',
    '我最近不关心通用 AI 新闻了，给我一次个人 Feed。',
  ] as const)('handles the explicit Feed request %s and does not pass it to root', async currentText => {
    const { ctx, registered } = context()
    const prepare = vi.fn(async () => { throw new Error('not reached') })
    const dispose = registerPersonalFeedTelegramAdapter(ctx as never, {
      coordinator: { prepare, read: () => undefined },
    } as never)
    const next = vi.fn(() => ({ kind: 'root-delivered' as const }))

    const result = await listener(registered)(envelope(currentText), next)

    expect(result).toMatchObject({ kind: 'failed' })
    expect(prepare).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
    dispose()
  })

  it.each([
    ['普通消息', undefined],
    ['帮我设计个人 Feed', undefined],
    ['不要给我个人 Feed', undefined],
    ['给我个人 Feed 的设计方案', undefined],
    ['看看 https://x.com/alice/status/42', undefined],
    ['普通消息', { messageText: 'https://x.com/alice/status/42' }],
    ['普通消息', { selectedText: 'https://twitter.com/alice/status/42' }],
    ['给我一次个人 Feed', { messageText: 'https://x.com/alice/status/42' }],
    ['给我一次个人 Feed https://twitter.com/alice/status/42', undefined],
  ] as const)('passes %s when it is not an explicit Feed request or has an X URL in context', async (currentText, reference) => {
    const { ctx, registered } = context()
    const prepare = vi.fn(async () => { throw new Error('must not prepare') })
    const dispose = registerPersonalFeedTelegramAdapter(ctx as never, {
      coordinator: { prepare, read: () => undefined },
    } as never)
    const next = vi.fn(() => ({ kind: 'root-delivered' as const }))

    const result = await listener(registered)(envelope(currentText, reference ?? undefined), next)

    expect(result).toEqual({ kind: 'root-delivered' })
    expect(next).toHaveBeenCalledOnce()
    expect(prepare).not.toHaveBeenCalled()
    dispose()
  })
})

describe('Personal Feed v2 Telegram adapter lifecycle', () => {
  it('uses the real coordinator to return awaiting delivery and settles the real single-message receipt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'x-feed-personal-v2-telegram-'))
    temporaryDirectories.push(directory)
    const { ctx, registered } = context()
    const { coordinator, calls } = realCoordinator(directory)
    const dispose = registerPersonalFeedTelegramAdapter(ctx as never, { coordinator })
    const next = vi.fn(() => ({ kind: 'root-delivered' as const }))

    const result = await listener(registered)(envelope('给我一次个人 Feed'), next)

    expect(result.kind).toBe('handled-awaiting-delivery')
    if (result.kind !== 'handled-awaiting-delivery') throw new Error('Feed request was not awaiting delivery')
    expect(result.finalText).toBe('https://x.com/alice/status/42')
    result.settle({
      chatId: 7,
      triggerMessageId: 11,
      visibleText: 'https://x.com/alice/status/42',
      messageIds: [901],
    })
    expect(coordinator.read('telegram:7:11')).toMatchObject({
      status: 'delivered',
      request: { requestId: 'telegram:7:11' },
      receipt: {
        chatId: 7,
        triggerMessageId: 11,
        visibleText: 'https://x.com/alice/status/42',
        messageIds: [901],
      },
    })
    expect(next).not.toHaveBeenCalled()
    expect(calls).toEqual({ r4: 1, r2: 1, r3: 1, r5: 1 })
    dispose()
  })

  it('maps a consumed request to old handled empty text without sending or rerunning ports', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'x-feed-personal-v2-duplicate-'))
    temporaryDirectories.push(directory)
    const { ctx, registered } = context()
    const { coordinator, calls } = realCoordinator(directory)
    const dispose = registerPersonalFeedTelegramAdapter(ctx as never, { coordinator })
    const firstNext = vi.fn(() => ({ kind: 'root-delivered' as const }))
    const first = await listener(registered)(envelope('给我一次个人 Feed'), firstNext)
    if (first.kind !== 'handled-awaiting-delivery') throw new Error('fixture did not prepare Feed delivery')
    first.settle({
      chatId: 7,
      triggerMessageId: 11,
      visibleText: first.finalText,
      messageIds: [901],
    })

    const secondNext = vi.fn(() => ({ kind: 'root-delivered' as const }))
    const duplicate = await listener(registered)(envelope('给我一次个人 Feed'), secondNext)

    expect(duplicate).toEqual({ kind: 'handled', finalText: '' })
    expect(secondNext).not.toHaveBeenCalled()
    expect(calls).toEqual({ r4: 1, r2: 1, r3: 1, r5: 1 })
    dispose()
  })

  it('maps a coordinator exception to the exact failed result without entering root', async () => {
    const { ctx, registered } = context()
    const prepare = vi.fn(async () => { throw new Error('ledger unavailable') })
    const dispose = registerPersonalFeedTelegramAdapter(ctx as never, {
      coordinator: { prepare, read: () => undefined },
    } as never)
    const next = vi.fn(() => ({ kind: 'root-delivered' as const }))

    const result = await listener(registered)(envelope('给我一次个人 Feed'), next)

    expect(result).toEqual({
      kind: 'failed',
      visibleError: '这次没有完成：判断或执行未完成。',
    })
    expect(next).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalledOnce()
    dispose()
  })
})
