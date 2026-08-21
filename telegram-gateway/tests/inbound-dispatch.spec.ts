import { describe, expect, it, vi } from 'vitest'
import type { TelegramInboundEnvelope, TelegramInboundResult } from '../src/inbound-contract.ts'
import { dispatchInbound } from '../src/inbound-dispatch.ts'

const signal = new AbortController().signal

function envelope(): TelegramInboundEnvelope {
  return Object.freeze({
    chat: Object.freeze({ id: 7, type: 'private' }),
    message: Object.freeze({ id: 11 }),
    currentText: '当前消息',
    signal,
  })
}

function delivered(): TelegramInboundResult {
  return { kind: 'root-delivered' }
}

function handled(finalText = '已处理'): TelegramInboundResult {
  return { kind: 'handled', finalText }
}

function failed(visibleError = '已失败'): TelegramInboundResult {
  return { kind: 'failed', visibleError }
}

function context(options: {
  ready?: true | void
  readyError?: unknown
  waterfall?: (value: TelegramInboundEnvelope, next: () => TelegramInboundResult | Promise<TelegramInboundResult>) => TelegramInboundResult | Promise<TelegramInboundResult>
} = {}) {
  const bail = vi.fn(() => {
    if (options.readyError !== undefined) throw options.readyError
    return options.ready
  })
  const waterfall = vi.fn((name: string, value: TelegramInboundEnvelope, root: () => TelegramInboundResult | Promise<TelegramInboundResult>) => {
    if (options.waterfall === undefined) return root()
    return options.waterfall(value, root)
  })
  return { bail, waterfall }
}

describe('dispatchInbound', () => {
  it('fails before dispatch when readiness is required but not true', async () => {
    const ctx = context()
    const root = vi.fn(() => delivered())

    const result = await dispatchInbound(ctx, envelope(), true, root)

    expect(result.kind).toBe('failed')
    expect(ctx.bail).toHaveBeenCalledWith('telegram/inbound/ready', expect.anything())
    expect(ctx.waterfall).not.toHaveBeenCalled()
    expect(root).not.toHaveBeenCalled()
  })

  it('uses the root without a readiness or waterfall handler when interception is optional', async () => {
    const ctx = context()
    const root = vi.fn(() => delivered())

    const result = await dispatchInbound(ctx, envelope(), false, root)

    expect(result).toEqual(delivered())
    expect(ctx.waterfall).toHaveBeenCalledOnce()
    expect(root).toHaveBeenCalledOnce()
  })

  it('passes the frozen envelope through readiness and waterfall', async () => {
    const value = envelope()
    const ctx = context({ ready: true })
    const root = vi.fn(() => delivered())

    await dispatchInbound(ctx, value, true, root)

    expect(ctx.bail.mock.calls[0]?.[1]).toBe(value)
    expect(ctx.waterfall.mock.calls[0]?.[1]).toBe(value)
    expect(Object.isFrozen(value)).toBe(true)
    expect(value.signal).toBe(signal)
  })

  it('enters the next listener exactly when requested and reaches the root once', async () => {
    const calls: string[] = []
    const ctx = context({
      waterfall: (_value, next) => {
        calls.push('first')
        const result = next()
        calls.push('after-first')
        return result
      },
    })
    const root = vi.fn(() => {
      calls.push('root')
      return delivered()
    })

    const result = await dispatchInbound(ctx, envelope(), false, root)

    expect(result).toEqual(delivered())
    expect(calls).toEqual(['first', 'root', 'after-first'])
    expect(root).toHaveBeenCalledOnce()
  })

  it('does not enter the root when a listener handles the envelope', async () => {
    const ctx = context({ waterfall: () => handled('中止后续') })
    const root = vi.fn(() => delivered())

    const result = await dispatchInbound(ctx, envelope(), false, root)

    expect(result).toEqual(handled('中止后续'))
    expect(root).not.toHaveBeenCalled()
  })

  it('does not enter the root when a listener fails the envelope', async () => {
    const ctx = context({ waterfall: () => failed('监听器已失败') })
    const root = vi.fn(() => delivered())

    const result = await dispatchInbound(ctx, envelope(), false, root)

    expect(result).toEqual(failed('监听器已失败'))
    expect(root).not.toHaveBeenCalled()
  })

  it('preserves the order of multiple listeners in the waterfall chain', async () => {
    const calls: string[] = []
    const ctx = context({
      waterfall: (_value, next) => {
        calls.push('outer')
        const middle = () => {
          calls.push('middle')
          return next()
        }
        const result = middle()
        calls.push('outer-complete')
        return result
      },
    })
    const root = vi.fn(() => {
      calls.push('root')
      return delivered()
    })

    const result = await dispatchInbound(ctx, envelope(), false, root)

    expect(result).toEqual(delivered())
    expect(calls).toEqual(['outer', 'middle', 'root', 'outer-complete'])
  })

  it('converts listener throws and rejected listeners into failed results', async () => {
    const thrown = new Error('listener broke')
    const ctx = context({ waterfall: () => Promise.reject(thrown) })
    const root = vi.fn(() => delivered())

    const result = await dispatchInbound(ctx, envelope(), false, root)

    expect(result.kind).toBe('failed')
    expect(root).not.toHaveBeenCalled()
  })

  it('converts a root throw into a failed result without retrying the root', async () => {
    const ctx = context()
    const root = vi.fn(() => {
      throw new Error('root broke')
    })

    const result = await dispatchInbound(ctx, envelope(), false, root)

    expect(result.kind).toBe('failed')
    expect(root).toHaveBeenCalledOnce()
  })

  it('preserves the original abort signal for every listener', async () => {
    const value = envelope()
    const seen: AbortSignal[] = []
    const ctx = context({
      ready: true,
      waterfall: (incoming, next) => {
        seen.push(incoming.signal)
        return next()
      },
    })
    const root = vi.fn(() => {
      seen.push(value.signal)
      return delivered()
    })

    await dispatchInbound(ctx, value, true, root)

    expect(seen).toEqual([signal, signal])
  })
})
