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

function options(r2: Readonly<{ readonly observe: (input: unknown) => unknown }>, r4?: Readonly<{ readonly snapshot: (input: unknown) => unknown }>) {
  const root = directory()
  return Object.freeze({
    r4: r4 ?? Object.freeze({ snapshot: () => Object.freeze({ kind: 'sufficient', snapshot: Object.freeze({ context: 'safe' }) }) }),
    r2,
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
