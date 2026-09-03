import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TelegramInboundEnvelope, TelegramInboundResult } from '@deepseek-ai/dsh-telegram-gateway'
import { createPersonalFeedTelegramProductionComposition } from '../src/personal-feed/telegram-production-composition.ts'

const directories: string[] = []
const CLOCK = Object.freeze({ now: () => new Date('2026-09-01T00:00:00.000Z') })

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'personal-feed-production-'))
  directories.push(value)
  return value
}

function envelope(messageId: number, signal = new AbortController().signal): TelegramInboundEnvelope {
  return Object.freeze({
    chat: Object.freeze({ id: 7, type: 'private' }),
    message: Object.freeze({ id: messageId }),
    currentText: '给我一次个人 Feed',
    signal,
  })
}

function options(
  r2: Readonly<{ readonly observe: (input: unknown) => unknown }>,
  r4?: Readonly<{ readonly snapshot: (input: unknown) => unknown }>,
  r5: Readonly<{ readonly judgeOne: (input: unknown) => unknown }> = Object.freeze({
    judgeOne: () => Object.freeze({ kind: 'incomplete' }),
  }),
) {
  const root = directory()
  return Object.freeze({
    r4: r4 ?? Object.freeze({ snapshot: () => Object.freeze({ kind: 'sufficient', snapshot: Object.freeze({ context: 'safe' }) }) }),
    r2,
    r5,
    candidateStatePath: join(root, 'candidate-state.jsonl'),
    clock: CLOCK,
  })
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(resolveValue => { resolve = resolveValue })
  return { promise, resolve }
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('Personal Feed Telegram production composition', () => {
  it('accepts one already-created R2 port and exposes only handler plus one disposer', () => {
    const r2 = Object.freeze({ observe: () => Object.freeze({ kind: 'unknown' }) })
    const composition = createPersonalFeedTelegramProductionComposition(options(r2))
    expect(Object.keys(composition)).toEqual(['handler', 'shutdown'])
    expect(Object.isFrozen(composition)).toBe(true)
    expect(() => createPersonalFeedTelegramProductionComposition(Object.freeze({
      ...options(r2),
      startupFactory: () => undefined,
    }))).toThrow('composition options are invalid')
  })

  it('runs R4 then the same R2 once and keeps source failure distinct from business empty', async () => {
    const order: string[] = []
    const r4 = Object.freeze({
      snapshot: vi.fn(() => {
        order.push('r4')
        return Object.freeze({ kind: 'sufficient', snapshot: Object.freeze({ context: 'safe' }) })
      }),
    })
    const r2 = Object.freeze({
      observe: vi.fn(() => {
        order.push('r2')
        return Object.freeze({ kind: 'unknown' })
      }),
    })
    const composition = createPersonalFeedTelegramProductionComposition(options(r2, r4))
    const result = await composition.handler(envelope(11))
    expect(order).toEqual(['r4', 'r2'])
    expect(result).toMatchObject({
      kind: 'handled',
      finalText: '这次没有完成：X 来源或观察窗口未完成。',
    })
    expect((result as { readonly finalText?: string }).finalText).not.toBe('这次没有值得看的内容。')
    await composition.shutdown()
  })

  it.each([
    ['qualified', 'https://x.com/alpha/status/101'],
    ['not qualified', '这次没有值得看的内容。'],
    ['incomplete', '这次没有完成：判断或执行未完成。'],
  ] as const)('passes injected R5 through the real candidate-state chain when it returns %s', async (judgment, expectedText) => {
    const requestCutoff = '2026-09-01T00:00:00.000Z'
    const capture = Object.freeze({
      take: vi.fn(() => '一个完整候选正文'),
      close: vi.fn(async () => undefined),
    })
    const window = Object.freeze({
      requestId: 'telegram:7:41',
      cutoff: requestCutoff,
      shanghaiDay: '2026-09-01',
      startedAt: '2026-09-01T00:00:00.100Z',
      completedAt: '2026-09-01T00:00:03.000Z',
      surfaces: Object.freeze([
        Object.freeze({
          kind: 'complete', surface: 'for_you', surfaceOrdinal: 0,
          startedAt: '2026-09-01T00:00:00.100Z', completedAt: '2026-09-01T00:00:01.000Z',
          occurrences: Object.freeze([Object.freeze({
            sourceUrl: 'https://x.com/alpha/status/101',
            body: Object.freeze({ kind: 'sufficient', capture }),
            occurrenceOrdinal: 0, capturedAt: '2026-09-01T00:00:00.400Z',
            authorHandle: 'alpha', publishedAt: '2026-08-31T00:00:00.000Z',
          })]),
        }),
        Object.freeze({
          kind: 'natural_zero', surface: 'following', surfaceOrdinal: 1,
          startedAt: '2026-09-01T00:00:01.000Z', completedAt: '2026-09-01T00:00:02.000Z',
          occurrences: Object.freeze([]),
        }),
        Object.freeze({
          kind: 'natural_zero', surface: 'explore', surfaceOrdinal: 2,
          startedAt: '2026-09-01T00:00:02.000Z', completedAt: '2026-09-01T00:00:03.000Z',
          occurrences: Object.freeze([]),
        }),
      ]),
    })
    const r2 = Object.freeze({
      observe: vi.fn(async () => Object.freeze({
        kind: 'complete',
        window,
        close: vi.fn(async () => undefined),
      })),
    })
    const seen: unknown[] = []
    const r5 = Object.freeze({
      judgeOne: vi.fn(async (input: unknown) => {
        seen.push(input)
        return Object.freeze({ kind: judgment === 'qualified' ? 'qualified' : judgment === 'not qualified' ? 'not_qualified' : 'incomplete' })
      }),
    })
    const composition = createPersonalFeedTelegramProductionComposition(options(r2, undefined, r5))
    const result = await composition.handler(envelope(41))

    expect(result).toEqual({ kind: 'handled', finalText: expectedText })
    expect(r5.judgeOne).toHaveBeenCalledOnce()
    expect(seen).toHaveLength(1)
    const judged = seen[0] as { readonly request: unknown; readonly snapshot: unknown; readonly candidate: unknown; readonly signal: unknown }
    expect(Object.keys(judged).sort()).toEqual(['candidate', 'request', 'signal', 'snapshot'])
    expect(Object.hasOwn(judged, 'window')).toBe(false)
    expect(judged.request).toEqual({ requestId: 'telegram:7:41', cutoff: requestCutoff, shanghaiDay: '2026-09-01' })
    expect(judged.snapshot).toEqual({ context: 'safe' })
    expect(judged.candidate).toMatchObject({
      stableId: 'x-status:101',
      canonicalUrl: 'https://x.com/alpha/status/101',
      body: '一个完整候选正文',
    })
    expect(Object.keys(judged.candidate as object).sort()).toEqual(['body', 'canonicalUrl', 'provenance', 'stableId'])
    expect(JSON.stringify(judged)).not.toContain('surfaces')
    expect(JSON.stringify(judged)).not.toContain('batch')
    await composition.shutdown()
  })

  it('reuses exactly one R2 object for multiple requests without a startup factory or owner shutdown API', async () => {
    const receivers: unknown[] = []
    const r2 = Object.freeze({
      observe: vi.fn(function (this: unknown) {
        receivers.push(this)
        return Object.freeze({ kind: 'unknown' })
      }),
    })
    const composition = createPersonalFeedTelegramProductionComposition(options(r2))
    await composition.handler(envelope(21))
    await composition.handler(envelope(22))
    expect(r2.observe).toHaveBeenCalledTimes(2)
    expect(receivers).toEqual([r2, r2])
    await composition.shutdown()
  })

  it('aborts the install signal, waits for the active call, rejects new work, and reuses one shutdown promise', async () => {
    const entered = deferred<AbortSignal>()
    const release = deferred<unknown>()
    const r2 = Object.freeze({
      observe: vi.fn(async (input: unknown) => {
        entered.resolve((input as { readonly signal: AbortSignal }).signal)
        return await release.promise
      }),
    })
    const composition = createPersonalFeedTelegramProductionComposition(options(r2))
    const active = composition.handler(envelope(31))
    const signal = await entered.promise
    const shutdown = composition.shutdown()
    expect(composition.shutdown()).toBe(shutdown)
    expect(signal.aborted).toBe(true)
    expect(await composition.handler(envelope(32))).toEqual({
      kind: 'failed',
      visibleError: '这次没有完成：判断或执行未完成。',
    })
    let settled = false
    void shutdown.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve(Object.freeze({ kind: 'unknown' }))
    const result = await active
    expect(result).toMatchObject({ kind: 'handled' })
    await shutdown
  })
})
