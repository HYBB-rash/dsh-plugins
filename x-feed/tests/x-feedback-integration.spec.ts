import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TelegramInboundEnvelope, TelegramInboundResult } from '@deepseek-ai/dsh-telegram-gateway'
import { runCleanFeedback } from '../src/x-feedback/clean-agent.ts'
import { installTelegramExtension } from '../src/index.ts'

vi.mock('../src/x-feedback/clean-agent.ts', () => ({
  runCleanFeedback: vi.fn(),
  parseFeedbackInterpretation: vi.fn((value: unknown) => value),
}))

type Listener = (...args: never[]) => unknown

interface CordisFixture {
  readonly ctx: Record<string, unknown>
  readonly listeners: Map<string, Listener[]>
  readonly disposerSpies: ReturnType<typeof vi.fn>[]
  readonly cleanups: Array<() => unknown>
}

function makeFixture(): CordisFixture {
  const listeners = new Map<string, Listener[]>()
  const disposerSpies: ReturnType<typeof vi.fn>[] = []
  const cleanups: Array<() => unknown> = []
  const services: Record<string, unknown> = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
    agents: { roots: () => [] },
    sessions: { flush: vi.fn(async () => {}) },
  }
  const ctx: Record<string, unknown> = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    get: (name: string) => services[name],
    on: (name: string, listener: Listener) => {
      const registered = listeners.get(name) ?? []
      registered.push(listener)
      listeners.set(name, registered)
      const dispose = vi.fn(() => {
        const current = listeners.get(name) ?? []
        listeners.set(name, current.filter(value => value !== listener))
      })
      disposerSpies.push(dispose)
      return dispose
    },
    effect: async (callback: () => unknown) => {
      const cleanup = await callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup as () => unknown)
      return cleanup
    },
    agents: services.agents,
    bail: (name: string, value: unknown) => {
      for (const listener of listeners.get(name) ?? []) {
        if (listener(value) === true) return true
      }
      return undefined
    },
    waterfall: (name: string, value: unknown, root: () => TelegramInboundResult | Promise<TelegramInboundResult>) => {
      const chain = listeners.get(name) ?? []
      let index = 0
      const next = (): TelegramInboundResult | Promise<TelegramInboundResult> => {
        const listener = chain[index++]
        return listener === undefined
          ? root()
          : listener(value, next)
      }
      return next()
    },
  }
  return { ctx, listeners, disposerSpies, cleanups }
}

function envelope(currentText: string): TelegramInboundEnvelope {
  return Object.freeze({
    chat: Object.freeze({ id: 42, type: 'private' }),
    message: Object.freeze({ id: 5 }),
    currentText,
    signal: new AbortController().signal,
  })
}

function config(dataDir: string) {
  return {
    cronJobId: '',
    dataDir,
    pythonBin: '/usr/bin/python3',
    pipelinePath: '/tmp/x_insight_pipeline.py',
    telegramSessionId: 'session-telegram',
    feedbackPendingTtlMs: 600_000,
    feedbackTurnTimeoutMs: 30_000,
  }
}

function cleanResult(interpretation: unknown): unknown {
  return {
    interpretation,
    sessionId: 'session-x-feedback-test',
    wire: { provider: 'test-provider', model: 'test-model', messages: [] },
  }
}

let dataDir: string | undefined

afterEach(() => {
  vi.clearAllMocks()
  if (dataDir !== undefined) {
    rmSync(dataDir, { recursive: true, force: true })
    dataDir = undefined
  }
})

describe('dsh-x-feed shared composition', () => {
  it('registers readiness and waterfall, handles one operation after clean output, and unloads both listeners', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'x-feed-integration-'))
    const fixture = makeFixture()
    const cleanRunner = vi.mocked(runCleanFeedback)
    let cleanOutputValidated = false
    cleanRunner.mockImplementation(async (ctx, request) => {
      expect(ctx).toBe(fixture.ctx)
      expect(request.currentMessage.text).toContain('https://x.com/OpenAI/status/123')
      expect(existsSync(join(dataDir!, 'feedback.jsonl'))).toBe(false)
      cleanOutputValidated = true
      return cleanResult({ kind: 'operation', operation: 'save', targetId: 'x-status:123' }) as never
    })

    const dispose = await installTelegramExtension(fixture.ctx as never, config(dataDir))

    expect(fixture.listeners.get('telegram/inbound/ready')).toHaveLength(1)
    expect(fixture.listeners.get('telegram/inbound')).toHaveLength(1)
    const value = envelope('请收藏 https://x.com/OpenAI/status/123')
    expect(fixture.ctx.bail!('telegram/inbound/ready', value)).toBe(true)
    const root = vi.fn((): TelegramInboundResult => ({ kind: 'root-delivered' }))
    const result = await fixture.ctx.waterfall!('telegram/inbound', value, root)

    expect(result).toEqual({ kind: 'handled', finalText: '已记录这次反馈。' })
    expect(root).not.toHaveBeenCalled()
    expect(cleanOutputValidated).toBe(true)
    expect(JSON.parse(readFileSync(join(dataDir, 'feedback.jsonl'), 'utf8')).operation).toBe('save')

    await dispose()
    expect(fixture.disposerSpies).toHaveLength(3)
    expect(fixture.disposerSpies.every(dispose => dispose.mock.calls.length === 1)).toBe(true)
  })

  it.each([
    ['ordinary', '普通对话，不含任何 URL'],
    ['not-feedback', 'https://x.com/openai/status/123 只是引用，不是反馈'],
  ])('delegates %s input to root without a side effect', async (_label, currentText) => {
    dataDir = mkdtempSync(join(tmpdir(), 'x-feed-integration-'))
    const fixture = makeFixture()
    const cleanRunner = vi.mocked(runCleanFeedback)
    cleanRunner.mockResolvedValue(cleanResult({ kind: 'pass', reason: 'not_feedback' }) as never)
    await installTelegramExtension(fixture.ctx as never, config(dataDir))

    const root = vi.fn((): TelegramInboundResult => ({ kind: 'root-delivered' }))
    const result = await fixture.ctx.waterfall!('telegram/inbound', envelope(currentText), root)

    expect(result).toEqual({ kind: 'root-delivered' })
    expect(root).toHaveBeenCalledOnce()
    if (_label === 'ordinary') expect(cleanRunner).not.toHaveBeenCalled()
    else expect(cleanRunner).toHaveBeenCalledOnce()
    expect(existsSync(join(dataDir, 'feedback.jsonl'))).toBe(false)
  })

  it('fails closed when clean output rejects and never falls through to root', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'x-feed-integration-'))
    const fixture = makeFixture()
    vi.mocked(runCleanFeedback).mockRejectedValue(new Error('clean failed'))
    await installTelegramExtension(fixture.ctx as never, config(dataDir))

    const root = vi.fn((): TelegramInboundResult => ({ kind: 'root-delivered' }))
    const result = await fixture.ctx.waterfall!('telegram/inbound', envelope('反馈 https://x.com/openai/status/123'), root)

    expect(result).toEqual({ kind: 'failed', visibleError: 'X 反馈处理失败：clean failed' })
    expect(root).not.toHaveBeenCalled()
    expect(existsSync(join(dataDir, 'feedback.jsonl'))).toBe(false)
  })

  it.each([
    ['mixed intent', 'mixed_intent'],
    ['ambiguous target', 'target_ambiguous'],
  ] as const)('delegates %s to root exactly once without an effect', async (_label, reason) => {
    dataDir = mkdtempSync(join(tmpdir(), 'x-feed-integration-'))
    const fixture = makeFixture()
    vi.mocked(runCleanFeedback).mockResolvedValue(cleanResult({ kind: 'pass', reason }) as never)
    await installTelegramExtension(fixture.ctx as never, config(dataDir))

    const root = vi.fn((): TelegramInboundResult => ({ kind: 'root-delivered' }))
    const result = await fixture.ctx.waterfall!(
      'telegram/inbound',
      envelope('请帮我处理 https://x.com/openai/status/123 和其他事情'),
      root,
    )

    expect(result).toEqual({ kind: 'root-delivered' })
    expect(root).toHaveBeenCalledOnce()
    expect(existsSync(join(dataDir, 'feedback.jsonl'))).toBe(false)
  })
})
