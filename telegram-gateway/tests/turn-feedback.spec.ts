/**
 * TurnFeedback: single-turn Telegram feedback — 👀/👍/👎, typing refresh, and
 * serialized delivery of complete, immutable semantic messages.
 *
 * Contract (Hermes-语义消息投递-落地指南): `assistant/chunk` never becomes
 * visible text; only a complete `assistant/message` with non-empty text AND a
 * tool-call is enqueued as an interim message; text-only messages are delivered
 * exactly once through `finish()`; exact normalized full-text dedup; serial
 * ordering; typing keeps refreshing until the turn ends.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  type SendMessageOptions,
  type TelegramHttp,
  type TelegramMessageRef,
} from '../src/index.ts'
import { normalizeVisibleText, TurnFeedback, type TurnFeedbackLogger } from '../src/turn-feedback.ts'

const CHAT_ID = 7
const TRIGGER_ID = 10

function turnStart(seq: number): SessionEvent<'turn/start'> {
  return { seq, type: 'turn/start', time: seq, data: { turn: 1 } }
}

function turnEnd(seq: number): SessionEvent<'turn/end'> {
  return { seq, type: 'turn/end', time: seq, data: { turn: 1, reason: { kind: 'completed' } } }
}

function textDelta(seq: number, step: number, text: string): SessionEvent<'assistant/chunk'> {
  return {
    seq, type: 'assistant/chunk', time: seq,
    data: { turn: 1, step, chunk: { type: 'text-delta', index: 0, text } },
  }
}

function reasoningDelta(seq: number, step: number, text: string): SessionEvent<'assistant/chunk'> {
  return {
    seq, type: 'assistant/chunk', time: seq,
    data: { turn: 1, step, chunk: { type: 'reasoning-delta', index: 0, text } },
  }
}

function toolCallDelta(seq: number, step: number): SessionEvent<'assistant/chunk'> {
  return {
    seq, type: 'assistant/chunk', time: seq,
    data: { turn: 1, step, chunk: { type: 'tool-call-delta', index: 1, id: 'c1' as never, argumentsDelta: '{}' } },
  }
}

function textOnlyMessage(seq: number, step: number, text: string): SessionEvent<'assistant/message'> {
  return {
    seq, type: 'assistant/message', time: seq,
    data: {
      turn: 1, step,
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    },
  }
}

/** A complete assistant/message carrying text blocks plus a tool-call block. */
function messageWithTool(seq: number, step: number, text: string, reasoning = ''): SessionEvent<'assistant/message'> {
  return {
    seq, type: 'assistant/message', time: seq,
    data: {
      turn: 1, step,
      message: createAssistantMessage({
        content: [
          ...(reasoning !== '' ? [{ type: 'reasoning', text: reasoning }] : []),
          { type: 'text', text },
          { type: 'tool-call', id: `c${seq}` as never, name: 'bash', arguments: '{}' },
        ],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    },
  }
}

/** A complete assistant/message with reasoning + tool-call but no text block. */
function reasoningToolMessage(seq: number, step: number): SessionEvent<'assistant/message'> {
  return {
    seq, type: 'assistant/message', time: seq,
    data: {
      turn: 1, step,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'secret reasoning' },
          { type: 'tool-call', id: `c${seq}` as never, name: 'bash', arguments: '{}' },
        ],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    },
  }
}

/** A complete assistant/message with only a tool-call block. */
function pureToolMessage(seq: number, step: number): SessionEvent<'assistant/message'> {
  return {
    seq, type: 'assistant/message', time: seq,
    data: {
      turn: 1, step,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: `c${seq}` as never, name: 'bash', arguments: '{}' }],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    },
  }
}

function makeHarness(overrides: { maxMessageChars?: number; typingIntervalMs?: number } = {}) {
  let nextId = 100
  const http = {
    getMe: vi.fn(async () => ({ id: 1 })),
    getUpdates: vi.fn(async () => []),
    sendMessage: vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions): Promise<TelegramMessageRef> => {
      return { messageId: nextId++ }
    }),
    sendTyping: vi.fn(async () => {}),
    setReaction: vi.fn(async () => {}),
  }
  const logger: TurnFeedbackLogger = { debug: vi.fn(), warn: vi.fn() }
  const feedback = new TurnFeedback({
    http: http as unknown as TelegramHttp,
    chatId: CHAT_ID,
    triggerMessageId: TRIGGER_ID,
    signal: new AbortController().signal,
    logger,
    maxMessageChars: overrides.maxMessageChars ?? 4096,
    typingIntervalMs: overrides.typingIntervalMs ?? 4000,
  })
  return { http, logger, feedback }
}

/** Flush pending microtasks (queued interim sends) under fake timers. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

describe('normalizeVisibleText', () => {
  it('only unifies CRLF/CR to LF and trims the full-text ends', () => {
    expect(normalizeVisibleText('a\r\nb\r\nc')).toBe('a\nb\nc')
    expect(normalizeVisibleText('a\rb')).toBe('a\nb')
    expect(normalizeVisibleText('  a\nb  ')).toBe('a\nb')
    expect(normalizeVisibleText('\n\na\nb\n\n')).toBe('a\nb')
    // 内部空白、空行与标点保持原样
    expect(normalizeVisibleText('a  b\n\nc')).toBe('a  b\n\nc')
  })
})

describe('TurnFeedback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms 👀 and typing immediately and refreshes typing until the turn ends', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()

    expect(http.setReaction).toHaveBeenCalledWith(CHAT_ID, TRIGGER_ID, '👀', expect.any(AbortSignal))
    expect(http.sendTyping).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4000)
    expect(http.sendTyping).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4000)
    expect(http.sendTyping).toHaveBeenCalledTimes(3)
  })

  it('keeps refreshing typing after an interim message while the turn continues', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    await vi.advanceTimersByTimeAsync(4000)
    expect(http.sendTyping).toHaveBeenCalledTimes(2)

    feedback.observe(turnStart(1))
    feedback.observe(messageWithTool(2, 1, 'progress note'))
    await flush()
    expect(http.sendMessage).toHaveBeenCalledTimes(1)

    // 发送中途消息后 typing 必须继续刷新
    await vi.advanceTimersByTimeAsync(4000)
    expect(http.sendTyping).toHaveBeenCalledTimes(3)

    await feedback.finish('done')
    await vi.advanceTimersByTimeAsync(12_000)
    expect(http.sendTyping).toHaveBeenCalledTimes(3)
  })

  it('leaves no typing timer after finish, fail, or close', async () => {
    const finished = makeHarness()
    await finished.feedback.start()
    await vi.advanceTimersByTimeAsync(4000)
    expect(finished.http.sendTyping).toHaveBeenCalledTimes(2)
    await finished.feedback.finish('done')
    await vi.advanceTimersByTimeAsync(12_000)
    expect(finished.http.sendTyping).toHaveBeenCalledTimes(2)

    const failed = makeHarness()
    await failed.feedback.start()
    await vi.advanceTimersByTimeAsync(4000)
    await failed.feedback.fail('⚠️ 任务出错：E_X')
    await vi.advanceTimersByTimeAsync(12_000)
    expect(failed.http.sendTyping).toHaveBeenCalledTimes(2)

    const aborted = makeHarness()
    await aborted.feedback.start()
    await vi.advanceTimersByTimeAsync(4000)
    aborted.feedback.close()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(aborted.http.sendTyping).toHaveBeenCalledTimes(2)
  })

  it('never turns any assistant/chunk (text, reasoning, or tool-call delta) into a Telegram message', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    feedback.observe(turnStart(1))
    feedback.observe(textDelta(2, 1, '半句'))
    feedback.observe(reasoningDelta(3, 1, 'secret'))
    feedback.observe(toolCallDelta(4, 1))
    await flush()
    expect(http.sendMessage).not.toHaveBeenCalled()
  })

  it('keeps reasoning+tool-call, pure tool-call, and empty-text messages silent', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    feedback.observe(turnStart(1))
    feedback.observe(reasoningToolMessage(2, 1))
    feedback.observe(pureToolMessage(3, 1))
    feedback.observe(messageWithTool(4, 1, ''))
    await flush()
    expect(http.sendMessage).not.toHaveBeenCalled()
  })

  it('does not send a text-only message early and delivers the final exactly once', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    feedback.observe(turnStart(1))
    feedback.observe(textOnlyMessage(2, 1, '最终结果'))
    await flush()
    expect(http.sendMessage).not.toHaveBeenCalled()

    await feedback.finish('最终结果')
    expect(http.sendMessage).toHaveBeenCalledTimes(1)
    expect(http.sendMessage).toHaveBeenCalledWith(CHAT_ID, '最终结果', { replyToMessageId: TRIGGER_ID }, expect.any(AbortSignal))
    expect(http.setReaction).toHaveBeenLastCalledWith(CHAT_ID, TRIGGER_ID, '👍', expect.any(AbortSignal))
  })

  it('sends a complete text + tool-call message immediately as one immutable message', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    feedback.observe(turnStart(1))
    feedback.observe(messageWithTool(2, 1, '我先读取那份长期记忆。'))
    await flush()
    expect(http.sendMessage).toHaveBeenCalledTimes(1)
    expect(http.sendMessage).toHaveBeenCalledWith(CHAT_ID, '我先读取那份长期记忆。', { replyToMessageId: TRIGGER_ID }, expect.any(AbortSignal))
    // 中途消息只发送，绝不编辑
    expect(http).not.toHaveProperty('editMessage')
  })

  it('keeps interim messages strictly ordered with at most one request in flight', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    const first = Promise.withResolvers<TelegramMessageRef>()
    http.sendMessage.mockReturnValueOnce(first.promise)
    feedback.observe(turnStart(1))
    feedback.observe(messageWithTool(2, 1, 'first note'))
    await flush()
    expect(http.sendMessage).toHaveBeenCalledTimes(1)

    feedback.observe(messageWithTool(3, 1, 'second note'))
    await flush()
    // 慢请求在途时不得并发第二个请求
    expect(http.sendMessage).toHaveBeenCalledTimes(1)

    first.resolve({ messageId: 101 })
    await flush()
    await flush()
    expect(http.sendMessage).toHaveBeenCalledTimes(2)
    expect(http.sendMessage.mock.calls[0]?.[1]).toBe('first note')
    expect(http.sendMessage.mock.calls[1]?.[1]).toBe('second note')
  })

  it('replies only the first delivered visible message to the trigger', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    feedback.observe(turnStart(1))
    feedback.observe(messageWithTool(2, 1, 'first note'))
    await flush()
    feedback.observe(messageWithTool(3, 1, 'second note'))
    await flush()
    await feedback.finish('final note')

    const options = http.sendMessage.mock.calls.map(call => call[2])
    expect(options[0]).toEqual({ replyToMessageId: TRIGGER_ID })
    expect(options[1]).toBeUndefined()
    expect(options[2]).toBeUndefined()
  })

  it('replies the trigger again when the first interim send failed and the final is the first success', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    http.sendMessage.mockRejectedValueOnce(new Error('interim send failed'))
    feedback.observe(turnStart(1))
    feedback.observe(messageWithTool(2, 1, 'lost note'))
    await flush()
    expect(http.sendMessage).toHaveBeenCalledTimes(1)

    await feedback.finish('final note')
    expect(http.sendMessage).toHaveBeenCalledTimes(2)
    expect(http.sendMessage.mock.calls[1]?.[2]).toEqual({ replyToMessageId: TRIGGER_ID })
    expect(http.setReaction).toHaveBeenLastCalledWith(CHAT_ID, TRIGGER_ID, '👍', expect.any(AbortSignal))
  })

  it('deduplicates identical normalized full texts but keeps similar ones', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    feedback.observe(turnStart(1))
    feedback.observe(messageWithTool(2, 1, 'A\r\nB'))
    await flush()
    feedback.observe(messageWithTool(3, 1, 'A\nB')) // 规范化后相同 → 跳过
    await flush()
    feedback.observe(messageWithTool(4, 1, '  A\nB  ')) // 首尾空白相同 → 跳过
    await flush()
    feedback.observe(messageWithTool(5, 1, 'A B')) // 内部空白不同 → 保留
    await flush()
    expect(http.sendMessage).toHaveBeenCalledTimes(2)
    expect(http.sendMessage.mock.calls[0]?.[1]).toBe('A\nB')
    expect(http.sendMessage.mock.calls[1]?.[1]).toBe('A B')
  })

  it('keeps similar-but-different texts as separate messages', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    feedback.observe(turnStart(1))
    feedback.observe(messageWithTool(2, 1, 'version one'))
    await flush()
    feedback.observe(messageWithTool(3, 1, 'version two'))
    await flush()
    expect(http.sendMessage).toHaveBeenCalledTimes(2)
  })

  it('does not resend a final identical to a delivered interim, but still marks 👍', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    feedback.observe(turnStart(1))
    feedback.observe(messageWithTool(2, 1, '说明'))
    await flush()
    expect(http.sendMessage).toHaveBeenCalledTimes(1)

    await feedback.finish('说明')
    expect(http.sendMessage).toHaveBeenCalledTimes(1)
    expect(http.setReaction).toHaveBeenLastCalledWith(CHAT_ID, TRIGGER_ID, '👍', expect.any(AbortSignal))
  })

  it('resends an identical final after the interim send failed and still marks 👍', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    http.sendMessage.mockRejectedValueOnce(new Error('interim send failed'))
    feedback.observe(turnStart(1))
    feedback.observe(messageWithTool(2, 1, 'same text'))
    await flush()
    expect(http.sendMessage).toHaveBeenCalledTimes(1)

    await feedback.finish('same text')
    // 失败的中途不算已交付：最终必须重新发送同一文本
    expect(http.sendMessage).toHaveBeenCalledTimes(2)
    expect(http.sendMessage.mock.calls[1]?.[1]).toBe('same text')
    expect(http.sendMessage.mock.calls[1]?.[2]).toEqual({ replyToMessageId: TRIGGER_ID })
    expect(http.setReaction).toHaveBeenLastCalledWith(CHAT_ID, TRIGGER_ID, '👍', expect.any(AbortSignal))
  })

  it('throws when the final delivery fails, never marks 👍; markFailed() still tries 👎', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    http.sendMessage.mockRejectedValueOnce(new Error('delivery failed'))
    feedback.observe(turnStart(1))
    await expect(feedback.finish('final')).rejects.toThrow('delivery failed')
    expect(http.setReaction).toHaveBeenCalledTimes(1) // 只有 👀
    expect(http.setReaction).not.toHaveBeenCalledWith(CHAT_ID, TRIGGER_ID, '👍', expect.anything())

    await feedback.markFailed()
    expect(http.setReaction).toHaveBeenLastCalledWith(CHAT_ID, TRIGGER_ID, '👎', expect.any(AbortSignal))
  })

  it('awaits queued interim messages before delivering the final', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    const deferred = Promise.withResolvers<TelegramMessageRef>()
    http.sendMessage.mockReturnValueOnce(deferred.promise)
    feedback.observe(turnStart(1))
    feedback.observe(messageWithTool(2, 1, 'interim'))
    await flush()
    expect(http.sendMessage).toHaveBeenCalledTimes(1)

    const finishing = feedback.finish('final')
    await flush()
    // 终稿不得越过仍在途的中途消息
    expect(http.sendMessage).toHaveBeenCalledTimes(1)

    deferred.resolve({ messageId: 101 })
    await finishing
    expect(http.sendMessage).toHaveBeenCalledTimes(2)
    expect(http.sendMessage.mock.calls[1]?.[1]).toBe('final')
    expect(http.setReaction).toHaveBeenLastCalledWith(CHAT_ID, TRIGGER_ID, '👍', expect.any(AbortSignal))
  })

  it('skips an oversized interim but chunk-delivers an oversized final with order and surrogate safety', async () => {
    const { http, feedback } = makeHarness({ maxMessageChars: 8 })
    await feedback.start()
    feedback.observe(turnStart(1))
    feedback.observe(messageWithTool(2, 1, 'x'.repeat(20)))
    await flush()
    // 超长中途不提前拆成多条进度
    expect(http.sendMessage).not.toHaveBeenCalled()

    const long = 'a'.repeat(10) + '😀' + 'b'.repeat(10)
    await feedback.finish(long)
    const texts = http.sendMessage.mock.calls.map(call => call[1] as string)
    expect(texts.join('')).toBe(long)
    expect(texts.every(text => text.length <= 8)).toBe(true)
    expect(texts.every(text => !/[\uD800-\uDBFF]$/.test(text))).toBe(true)
    expect(http.sendMessage.mock.calls[0]?.[2]).toEqual({ replyToMessageId: TRIGGER_ID })
    expect(http.sendMessage.mock.calls[1]?.[2]).toEqual({ replyToMessageId: 100 })
    expect(http.sendMessage.mock.calls[2]?.[2]).toEqual({ replyToMessageId: 101 })
  })

  it('close() blocks new messages and clears the typing timer', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    feedback.observe(turnStart(1))
    feedback.close()
    feedback.observe(messageWithTool(2, 1, 'late'))
    await flush()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(http.sendMessage).not.toHaveBeenCalled()
    expect(http.sendTyping).toHaveBeenCalledTimes(1)
  })

  it('sends nothing for an empty final but still marks 👍', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    feedback.observe(turnStart(1))
    await feedback.finish('')
    expect(http.sendMessage).not.toHaveBeenCalled()
    expect(http.setReaction).toHaveBeenLastCalledWith(CHAT_ID, TRIGGER_ID, '👍', expect.any(AbortSignal))
  })

  it('degrades reaction and typing failures without blocking the final delivery', async () => {
    const { http, feedback } = makeHarness()
    http.setReaction.mockRejectedValue(new Error('reaction unsupported'))
    http.sendTyping.mockRejectedValue(new Error('typing rejected'))
    await expect(feedback.start()).resolves.toBeUndefined()

    feedback.observe(turnStart(1))
    await expect(feedback.finish('final')).resolves.toBeUndefined()
    expect(http.sendMessage).toHaveBeenCalledWith(CHAT_ID, 'final', { replyToMessageId: TRIGGER_ID }, expect.any(AbortSignal))
  })

  it('delivers the agent error text and finishes with 👎', async () => {
    const { http, feedback } = makeHarness()
    await feedback.start()
    feedback.observe(turnStart(1))
    feedback.observe(messageWithTool(2, 1, 'partial note'))
    await flush()
    await feedback.fail('⚠️ 任务出错：E_BOOM: crashed')
    expect(http.sendMessage).toHaveBeenCalledTimes(2)
    expect(http.sendMessage.mock.calls[1]?.[1]).toBe('⚠️ 任务出错：E_BOOM: crashed')
    expect(http.setReaction).toHaveBeenLastCalledWith(CHAT_ID, TRIGGER_ID, '👎', expect.any(AbortSignal))
  })

  it('reports reactionArmed only when the 👀 reaction was applied', async () => {
    const armed = makeHarness()
    await armed.feedback.start()
    expect(armed.feedback.reactionArmed).toBe(true)

    const denied = makeHarness()
    denied.http.setReaction.mockRejectedValueOnce(new Error('nope'))
    await denied.feedback.start()
    expect(denied.feedback.reactionArmed).toBe(false)
  })
})
