/** Telegram gateway: turn summarization, HTTP face, chunking, offset store, and error classification. */

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import {
  apply, chunkText, createOffsetStore, createTelegramHttp, formatMarkdownV2, runGateway, summarizeTurn,
  inject as gatewayInject, isTelegramInboundEnvelope, TelegramApiError, type Config, type SendMessageOptions, type TelegramHttp, type TelegramUpdate,
} from '../src/index.ts'
import type { TelegramInboundEnvelope, TelegramInboundResult } from '../src/inbound-contract.ts'
import {
  apply as applyInvariant,
  inject as invariantInject,
  name as invariantName,
} from '../src/invariant.ts'

/** Build a minimal event list for one completed turn. */
function makeTurnEvents(overrides: { text?: string; error?: { code: string; message: string } } = {}): SessionEvent[] {
  const events: SessionEvent[] = [
    { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
    { seq: 1, type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
  ]
  if (overrides.text !== undefined) {
    events.push({
      seq: 2, type: 'assistant/message', time: 3,
      data: {
        turn: 1, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: overrides.text }],
          source: { provider: 'test-provider', model: 'test-model' },
        }),
      },
    })
  }
  events.push({ seq: 3, type: 'step/end', time: 4, data: { turn: 1, step: 1 } })
  events.push({
    seq: 4, type: 'turn/end', time: 5,
    data: overrides.error !== undefined
      ? { turn: 1, reason: { kind: 'error', error: overrides.error } }
      : { turn: 1, reason: { kind: 'completed' } },
  })
  return events
}

let scratch: string | undefined

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  }
})

function gatewayConfig(overrides: Partial<Config> = {}): Config {
  return {
    sessionId: 'session-telegram',
    apiBaseUrl: 'https://api.telegram.org',
    pollTimeoutSeconds: 30,
    offsetDir: scratch ?? '',
    maxMessageChars: 4096,
    requireInboundInterceptor: false,
    ...overrides,
  }
}

function gatewayContext(options: {
  credentialValues?: Array<string | undefined>
  live?: boolean
  persisted?: boolean
  token?: string
  inbound?: {
    ready?: true
    waterfall?: (envelope: TelegramInboundEnvelope, next: () => TelegramInboundResult | Promise<TelegramInboundResult>) => TelegramInboundResult | Promise<TelegramInboundResult>
  }
} = {}) {
  const dispose = vi.fn(async () => {})
  const agent = {
    session: { seq: 0, events: [] as SessionEvent[] },
    followup: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  }
  const setupContext = { on: vi.fn(() => vi.fn()) } as unknown as Context
  const makeHandle = async (request: { setup?: (ctx: Context) => void }) => {
    request.setup?.(setupContext)
    return { agent, dispose }
  }
  const agents = {
    get: vi.fn(() => options.live === true ? agent : undefined),
    create: vi.fn(makeHandle),
    resume: vi.fn(makeHandle),
  }
  const credentialValues = options.credentialValues ?? [options.token]
  const resolveCredential = vi.fn(async () => {
    const value = credentialValues.shift()
    return value === undefined ? undefined : { value }
  })
  const services: Record<string, unknown> = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
    agents,
    sessions: { flush: vi.fn(async () => {}) },
    sessionPersistence: {
      list: vi.fn(async () => options.persisted === true
        ? [{ id: 'session-telegram' }]
        : []),
    },
    credentials: {
      resolve: resolveCredential,
    },
    appExit: vi.fn(),
  }
  let cleanup: (() => Promise<void>) | undefined
  const sessionEventHandlers = new Map<string, (session: unknown, event: SessionEvent) => void>()
  const ctx = {
    get: (key: string) => services[key],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    on: vi.fn((event: string, handler: (session: unknown, event: SessionEvent) => void) => {
      sessionEventHandlers.set(event, handler)
      return vi.fn()
    }),
    bail: vi.fn((_event: string, _envelope: TelegramInboundEnvelope) => options.inbound?.ready),
    waterfall: vi.fn((_event: string, envelope: TelegramInboundEnvelope, next: () => TelegramInboundResult | Promise<TelegramInboundResult>) => {
      return options.inbound?.waterfall?.(envelope, next) ?? next()
    }),
    effect: async (setup: () => Promise<() => Promise<void>>) => {
      cleanup = await setup()
      return cleanup
    },
  } as unknown as Context
  return {
    agent,
    agents,
    cleanup: () => cleanup,
    ctx,
    dispose,
    emit: (session: unknown, event: SessionEvent) => {
      sessionEventHandlers.get('session/event')?.(session, event)
    },
    services,
    setupContext,
  }
}

it('declares the llm service required by trusted Telegram extensions', () => {
  expect(gatewayInject).toContain('llm')
})

describe('summarizeTurn', () => {
  it('aggregates the last assistant text after the firstSeq boundary', () => {
    const events = [
      { seq: 10, type: 'turn/start', time: 1, data: { turn: 2 } },
      { seq: 11, type: 'assistant/message', time: 2, data: { turn: 2, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'hello' }], source: { provider: 'p', model: 'm' } }) } },
      { seq: 12, type: 'turn/end', time: 3, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    expect(summarizeTurn(events, 10)).toEqual({ text: 'hello', error: undefined })
  })

  it('ignores events before the boundary', () => {
    const first = makeTurnEvents({ text: 'old' })
    const second = makeTurnEvents({ text: 'new' }).map(event => ({ ...event, seq: event.seq + 10 }))
    const events = [...first, ...second]
    const result = summarizeTurn(events, 10)
    expect(result.text).toBe('new')
  })

  it('reports the turn error reason', () => {
    const result = summarizeTurn(makeTurnEvents({ error: { code: 'E_TEST', message: 'boom' } }), 0)
    expect(result.error).toBe('E_TEST: boom')
  })

  it('returns empty text when the turn produced no text', () => {
    const result = summarizeTurn(makeTurnEvents(), 0)
    expect(result.text).toBe('')
    expect(result.error).toBeUndefined()
  })

  it('ignores in-range events until a turn starts and non-text assistant blocks', () => {
    const events = [
      { seq: 0, type: 'step/start', time: 1, data: { turn: 1, step: 1 } },
      { seq: 1, type: 'turn/start', time: 2, data: { turn: 1 } },
      {
        seq: 2,
        type: 'assistant/message',
        time: 3,
        data: {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'reasoning', text: 'hidden' }],
            source: { provider: 'p', model: 'm' },
          }),
        },
      },
    ] as SessionEvent[]
    expect(summarizeTurn(events, 0)).toEqual({ text: '', error: undefined })
  })
})

describe('chunkText', () => {
  it('returns the whole text when within the limit', () => {
    expect(chunkText('short', 4096)).toEqual(['short'])
  })

  it('splits oversize text into continuation chunks', () => {
    const text = 'x'.repeat(9000)
    const chunks = chunkText(text, 4096)
    expect(chunks.length).toBe(3)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every(chunk => chunk.length <= 4096)).toBe(true)
  })

  it('does not split a surrogate pair at a chunk boundary', () => {
    expect(chunkText(`a😀b`, 2)).toEqual(['a', '😀', 'b'])
  })
})

describe('createOffsetStore', () => {
  it('persists monotonic offsets and reads them back', () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-offset-'))
    const file = join(scratch, 'offset.txt')
    const store = createOffsetStore(file)
    expect(store.read()).toBe(0)
    store.write(42)
    expect(store.read()).toBe(42)
    expect(Number(readFileSync(file, 'utf8'))).toBe(42)
    // A reopened store resumes from disk.
    expect(createOffsetStore(file).read()).toBe(42)
  })

  it('ignores non-monotonic writes and recovers from an unreadable file', () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-offset-'))
    const file = join(scratch, 'offset.txt')
    writeFileSync(file, 'garbage', 'utf8')
    const store = createOffsetStore(file)
    expect(store.read()).toBe(0)
    store.write(7)
    expect(store.read()).toBe(7)
    store.write(3) // stale — ignored
    expect(store.read()).toBe(7)
  })

  it('rejects a negative numeric offset', () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-offset-'))
    const file = join(scratch, 'offset.txt')
    writeFileSync(file, '-1', 'utf8')
    expect(createOffsetStore(file).read()).toBe(0)
  })
})

describe('createTelegramHttp', () => {
  it('builds getUpdates with offset and timeout query params', async () => {
    const fetchMock = vi.fn(async (_url: string | URL) => ({
      ok: true,
      json: async () => ({ ok: true, result: [{ update_id: 42 }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const http = createTelegramHttp('https://api.telegram.org', 'tok-123')
    const updates = await http.getUpdates(41, 25)

    expect(updates).toEqual([{ update_id: 42 }])
    const called = String(fetchMock.mock.calls[0]?.[0])
    expect(called).toContain('/bottok-123/getUpdates')
    expect(called).toContain('offset=41')
    expect(called).toContain('timeout=25')
  })

  it('accepts a caller signal, trims one trailing slash, and defaults a missing update result', async () => {
    const fetchMock = vi.fn(async (_url: string | URL) => ({
      json: async () => ({ ok: true }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    const http = createTelegramHttp('https://api.telegram.org/', 'tok')

    expect(await http.getUpdates(0, 1, signal)).toEqual([])
    expect(String(fetchMock.mock.calls[0]?.[0]).startsWith('https://api.telegram.org/bottok/getUpdates')).toBe(true)
  })

  it('classifies a 429 as retryable with retry_after', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 7 } }),
    })))
    const http = createTelegramHttp('https://api.telegram.org', 'tok')
    await expect(http.getUpdates(0, 10)).rejects.toMatchObject({
      kind: 'retry',
      retryAfterSeconds: 7,
    } satisfies Partial<TelegramApiError>)
  })

  it('classifies a 500 without retry metadata as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ ok: false, error_code: 500 }),
    })))
    await expect(createTelegramHttp('https://api.telegram.org', 'tok').getMe())
      .rejects.toMatchObject({ kind: 'retry', retryAfterSeconds: undefined })
  })

  it('classifies a 409 as conflict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, error_code: 409, description: 'terminated by other getUpdates' }),
    })))
    const http = createTelegramHttp('https://api.telegram.org', 'tok')
    await expect(http.getUpdates(0, 10)).rejects.toMatchObject({ kind: 'conflict' } satisfies Partial<TelegramApiError>)
  })

  it('classifies a 401 as fatal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }),
    })))
    const http = createTelegramHttp('https://api.telegram.org', 'bad')
    await expect(http.getMe()).rejects.toMatchObject({ kind: 'fatal' } satisfies Partial<TelegramApiError>)
  })

  it('classifies an error without a code or description as fatal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ ok: false }),
    })))
    await expect(createTelegramHttp('https://api.telegram.org', 'tok').getMe())
      .rejects.toThrow('getMe failed: error_code unknown')
  })

  it('throws a retry error on a non-JSON (HTML) 5xx body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
    })))
    const http = createTelegramHttp('https://api.telegram.org', 'tok')
    await expect(http.sendMessage(1, 'hi')).rejects.toThrow()
  })

  it('posts ordinary outbound text as a MarkdownV2 sendMessage, never RichMessage', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const http = createTelegramHttp('https://api.telegram.org', 'tok')
    await http.sendMessage(1, 'hi')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: 1,
      text: 'hi',
      parse_mode: 'MarkdownV2',
    })
  })

  it('converts ordinary Markdown and sends it through sendMessage + MarkdownV2', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { message_id: 12 } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const http = createTelegramHttp('https://api.telegram.org', 'tok')

    await expect(http.sendMessage(1, '**bold**\n\n```ts\nconst n = 1\n```'))
      .resolves.toEqual({ messageId: 12 })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain('/sendMessage')
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: 1,
      text: '*bold*\n\n```ts\nconst n = 1\n```',
      parse_mode: 'MarkdownV2',
    })
  })

  it('falls back once to raw plain sendMessage when MarkdownV2 is explicitly rejected', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({ ok: false, error_code: 400, description: "Can't parse entities" }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { message_id: 13 } }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const http = createTelegramHttp('https://api.telegram.org', 'tok')

    await expect(http.sendMessage(1, '**unclosed', { replyToMessageId: 5 }))
      .resolves.toEqual({ messageId: 13 })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [formattedUrl, formattedInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    const [plainUrl, plainInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(String(formattedUrl)).toContain('/sendMessage')
    expect(JSON.parse(String(formattedInit.body))).toEqual({
      chat_id: 1,
      text: '\\*\\*unclosed',
      parse_mode: 'MarkdownV2',
      reply_parameters: { message_id: 5, allow_sending_without_reply: true },
    })
    expect(String(plainUrl)).toContain('/sendMessage')
    expect(JSON.parse(String(plainInit.body))).toEqual({
      chat_id: 1,
      text: '**unclosed',
      reply_parameters: { message_id: 5, allow_sending_without_reply: true },
    })
  })

  it('does not risk a duplicate plain send after a retryable MarkdownV2 failure', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 3 } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const http = createTelegramHttp('https://api.telegram.org', 'tok')

    await expect(http.sendMessage(1, '**bold**')).rejects.toMatchObject({
      kind: 'retry',
      retryAfterSeconds: 3,
    } satisfies Partial<TelegramApiError>)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not risk a duplicate plain send after MarkdownV2 was accepted without a message id', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: true, result: {} }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const http = createTelegramHttp('https://api.telegram.org', 'tok')

    await expect(http.sendMessage(1, '**bold**'))
      .rejects.toThrow('sendMessage failed: response omitted message_id')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns bot identity from getMe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ ok: true, result: { id: 7, username: 'bot' } }),
    })))
    const controller = new AbortController()
    await expect(createTelegramHttp('https://api.telegram.org', 'tok').getMe(controller.signal))
      .resolves.toEqual({ id: 7, username: 'bot' })
  })

  it('returns the result message id from sendMessage', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { message_id: 77 } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const http = createTelegramHttp('https://api.telegram.org', 'tok')
    await expect(http.sendMessage(1, 'hi')).resolves.toEqual({ messageId: 77 })
  })

  it('includes reply_parameters when replying to a message', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { message_id: 8 } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const http = createTelegramHttp('https://api.telegram.org', 'tok')
    await http.sendMessage(1, 'hi', { replyToMessageId: 5 })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: 1,
      text: 'hi',
      parse_mode: 'MarkdownV2',
      reply_parameters: { message_id: 5, allow_sending_without_reply: true },
    })
  })

  it('omits reply_parameters when not replying', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { message_id: 8 } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const http = createTelegramHttp('https://api.telegram.org', 'tok')
    await http.sendMessage(1, 'hi', undefined, new AbortController().signal)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: 1,
      text: 'hi',
      parse_mode: 'MarkdownV2',
    })
  })

  it('does not fall back after an ambiguous timeout or a 5xx MarkdownV2 failure', async () => {
    const timeout = new DOMException('timed out', 'TimeoutError')
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ json: async () => ({ ok: false, error_code: 502 }) })
    vi.stubGlobal('fetch', fetchMock)
    const http = createTelegramHttp('https://api.telegram.org', 'tok')

    await expect(http.sendMessage(1, 'first')).rejects.toBe(timeout)
    await expect(http.sendMessage(1, 'second')).rejects.toMatchObject({ kind: 'retry' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('posts sendChatAction typing', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true, result: true }) }))
    vi.stubGlobal('fetch', fetchMock)
    const http = createTelegramHttp('https://api.telegram.org', 'tok')
    await http.sendTyping(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain('/sendChatAction')
    expect(JSON.parse(String(init.body))).toEqual({ chat_id: 1, action: 'typing' })
  })

  it('posts setMessageReaction with a single emoji reaction', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true, result: true }) }))
    vi.stubGlobal('fetch', fetchMock)
    const http = createTelegramHttp('https://api.telegram.org', 'tok')
    await http.setReaction(1, 4, '👀')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain('/setMessageReaction')
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: 1,
      message_id: 4,
      reaction: [{ type: 'emoji', emoji: '👀' }],
    })
  })

  it('clears reactions with an empty array', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true, result: true }) }))
    vi.stubGlobal('fetch', fetchMock)
    const http = createTelegramHttp('https://api.telegram.org', 'tok')
    await http.setReaction(1, 4, undefined)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ chat_id: 1, message_id: 4, reaction: [] })
  })

  it('classifies new-endpoint failures per the existing taxonomy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 3 } }),
    })))
    const http = createTelegramHttp('https://api.telegram.org', 'tok')
    await expect(http.setReaction(1, 4, '👀')).rejects.toMatchObject({
      kind: 'retry',
      retryAfterSeconds: 3,
    } satisfies Partial<TelegramApiError>)
  })

  it('exposes no editMessageText endpoint anymore', async () => {
    const http = createTelegramHttp('https://api.telegram.org', 'tok')
    expect((http as Record<string, unknown>).editMessage).toBeUndefined()
  })

  it('surfaces a non-JSON body from a new endpoint without masking classification', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
    })))
    const http = createTelegramHttp('https://api.telegram.org', 'tok')
    await expect(http.sendTyping(1)).rejects.toThrow()
  })
})

describe('formatMarkdownV2', () => {
  it('converts everyday Markdown while escaping literal MarkdownV2 punctuation', () => {
    expect(formatMarkdownV2([
      '# 标题!',
      '**粗体**、*斜体*、~~删除~~、||剧透||。',
      '[链接](https://example.com/a_(b)?q=1) 和 `a_b()`。',
      '> 引用 *内容*',
      '- 列表 1',
      '1. 列表 2',
      '中文 / emoji 🙂: a.b! [x] = y + z',
    ].join('\n'))).toBe([
      '*标题\\!*',
      '*粗体*、_斜体_、~删除~、||剧透||。',
      '[链接](https://example.com/a_(b\\)?q=1) 和 `a_b()`。',
      '> 引用 _内容_',
      '\\- 列表 1',
      '1\\. 列表 2',
      '中文 / emoji 🙂: a\\.b\\! \\[x\\] \\= y \\+ z',
    ].join('\n'))
  })

  it('protects inline and fenced code instead of escaping their content as prose', () => {
    expect(formatMarkdownV2('`x_y()`\n```ts\nconst a_b = `x`; // !\n```')).toBe(
      '`x_y()`\n```ts\nconst a_b = \\`x\\`; // !\n```',
    )
  })
})

describe('invariant companion', () => {
  it('reserves package ownership with an empty installer', async () => {
    const dispose = vi.fn()
    const register = vi.fn((_packageName: string, installer: () => void) => {
      installer()
      return dispose
    })
    const ctx = { invariants: { register } } as unknown as Context

    expect(invariantName).toBe('telegram-gateway-invariant')
    expect(invariantInject).toEqual(['invariants'])
    await expect(applyInvariant(ctx)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-telegram-gateway', expect.any(Function))
  })

  it('publishes the inbound contract from the package root for declaration consumers', () => {
    const declaration = readFileSync(new URL('../lib/types/index.d.ts', import.meta.url), 'utf8')
    expect(declaration).toContain('inbound-contract')
    expect(declaration).toContain('TelegramInboundEnvelope')
    expect(isTelegramInboundEnvelope({
      chat: { id: 42, type: 'private' },
      message: { id: 7 },
      currentText: 'hello',
      signal: new AbortController().signal,
    })).toBe(true)
  })
})

describe('gateway lifecycle', () => {
  it('fails closed when an inbound interceptor is required but not ready', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 1 }))
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{ update_id: 1, message: { message_id: 5, chat: { id: 42, type: 'private' }, text: 'go' } }]
        }
        lifetime.abort()
        return []
      },
      sendMessage,
    }

    await runGateway(harness.ctx, gatewayConfig({ requireInboundInterceptor: true }), http, lifetime.signal)

    expect(harness.agent.followup).not.toHaveBeenCalled()
    expect(harness.ctx.bail).toHaveBeenCalledOnce()
    expect(harness.ctx.waterfall).not.toHaveBeenCalled()
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      '✅ 已连接。你可以让我记住、跟进，或执行一件当前事情。',
      'Inbound interceptor required',
    ])
  })

  it('passes one ready inbound through the root with a transport-only envelope', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    let seenEnvelope: TelegramInboundEnvelope | undefined
    const harness = gatewayContext({
      credentialValues: ['42'],
      inbound: {
        ready: true,
        waterfall: (envelope, next) => {
          seenEnvelope = envelope
          return next()
        },
      },
    })
    const lifetime = new AbortController()
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = makeTurnEvents({ text: 'root result' })
    })
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{
            update_id: 1,
            message: {
              message_id: 5,
              chat: { id: 42, type: 'private' },
              text: '用户原文',
              quote: { text: '选中的引用' },
              reply_to_message: { message_id: 4, caption: '完整引用' },
            },
          }]
        }
        lifetime.abort()
        return []
      },
      sendMessage: async () => ({ messageId: 1 }),
    }

    await runGateway(harness.ctx, gatewayConfig({ requireInboundInterceptor: true }), http, lifetime.signal)

    expect(harness.agent.followup).toHaveBeenCalledOnce()
    expect(seenEnvelope).toMatchObject({
      chat: { id: 42, type: 'private' },
      message: { id: 5 },
      currentText: '用户原文',
      reference: { messageId: 4, selectedText: '选中的引用', messageText: '完整引用' },
    })
    expect(seenEnvelope?.signal).toBeInstanceOf(AbortSignal)
    expect(harness.ctx.bail).toHaveBeenCalledOnce()
    expect(harness.ctx.waterfall).toHaveBeenCalledOnce()
  })

  it('finishes a handled inbound without entering the root', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({
      credentialValues: ['42'],
      inbound: { ready: true, waterfall: () => ({ kind: 'handled', finalText: '已处理' }) },
    })
    const lifetime = new AbortController()
    const setReaction = vi.fn(async () => {})
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 1 }))
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{ update_id: 1, message: { message_id: 5, chat: { id: 42, type: 'private' }, text: 'handled' } }]
        }
        lifetime.abort()
        return []
      },
      sendMessage,
      setReaction,
      sendTyping: async () => {},
    }

    await runGateway(harness.ctx, gatewayConfig({ requireInboundInterceptor: true }), http, lifetime.signal)

    expect(harness.agent.followup).not.toHaveBeenCalled()
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      '✅ 已连接。你可以让我记住、跟进，或执行一件当前事情。',
      '已处理',
    ])
    expect(setReaction).toHaveBeenNthCalledWith(2, 42, 5, '👍', expect.any(AbortSignal))
  })

  it('fails a rejected inbound listener without entering the root or retrying terminal delivery', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({
      credentialValues: ['42'],
      inbound: { ready: true, waterfall: () => Promise.reject(new Error('listener broke')) },
    })
    const lifetime = new AbortController()
    const setReaction = vi.fn(async () => {})
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 1 }))
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{ update_id: 1, message: { message_id: 5, chat: { id: 42, type: 'private' }, text: 'failed' } }]
        }
        lifetime.abort()
        return []
      },
      sendMessage,
      setReaction,
      sendTyping: async () => {},
    }

    await runGateway(harness.ctx, gatewayConfig({ requireInboundInterceptor: true }), http, lifetime.signal)

    expect(harness.agent.followup).not.toHaveBeenCalled()
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      '✅ 已连接。你可以让我记住、跟进，或执行一件当前事情。',
      'Inbound dispatch failed',
    ])
    expect(setReaction).toHaveBeenNthCalledWith(2, 42, 5, '👎', expect.any(AbortSignal))
  })

  it('uses the credential-backed token and waits for Agent disposal', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ token: 'credential-token' })
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1, username: 'test-bot' }),
      getUpdates: async (_offset, _timeout, signal) => new Promise<TelegramUpdate[]>((resolve) => {
        signal?.addEventListener('abort', () => resolve([]), { once: true })
      }),
      sendMessage: async () => ({ messageId: 1 }),
    }
    const createHttp = vi.fn(() => http)

    await apply(harness.ctx, gatewayConfig(), { createHttp })

    expect(createHttp).toHaveBeenCalledWith('https://api.telegram.org', 'credential-token')
    await harness.cleanup()?.()
    expect(harness.dispose).toHaveBeenCalledOnce()
  })

  it('uses configured credentials without consulting the credential service', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext()
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async (_offset, _timeout, signal) => new Promise<TelegramUpdate[]>((resolve) => {
        signal?.addEventListener('abort', () => resolve([]), { once: true })
      }),
      sendMessage: async () => ({ messageId: 1 }),
    }
    const createHttp = vi.fn(() => http)

    await apply(harness.ctx, gatewayConfig({ token: 'configured-token', allowedChatId: '42' }), { createHttp })
    await harness.cleanup()?.()

    expect(createHttp).toHaveBeenCalledWith('https://api.telegram.org', 'configured-token')
    expect((harness.services.credentials as { resolve: ReturnType<typeof vi.fn> }).resolve).not.toHaveBeenCalled()
  })

  it('rejects activation when neither config nor credentials provide a token', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext()
    await expect(apply(harness.ctx, gatewayConfig())).rejects.toThrow('TELEGRAM_BOT_TOKEN is required')
  })

  it('uses the built-in HTTP client when no transport override is supplied', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext()
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/getMe')) {
        return { json: async () => ({ ok: true, result: { id: 1 } }) }
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }))

    await apply(harness.ctx, gatewayConfig({ token: 'configured-token' }))
    await harness.cleanup()?.()
    expect(fetch).toHaveBeenCalled()
  })

  it('rejects plugin activation when startup validation fails', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ token: 'credential-token' })
    const fatal = new TelegramApiError('fatal', 'bad token')
    const http: TelegramHttp = {
      getMe: async () => { throw fatal },
      getUpdates: async () => [],
      sendMessage: async () => ({ messageId: 1 }),
    }
    await expect(apply(harness.ctx, gatewayConfig(), { createHttp: () => http })).rejects.toBe(fatal)
  })

  it('requests application shutdown when polling fails after readiness', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ token: 'credential-token' })
    const poll = Promise.withResolvers<TelegramUpdate[]>()
    const fatal = new TelegramApiError('fatal', 'revoked')
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => poll.promise,
      sendMessage: async () => ({ messageId: 1 }),
    }

    await apply(harness.ctx, gatewayConfig(), { createHttp: () => http })
    poll.reject(fatal)
    await vi.waitFor(() => {
      expect(harness.services.appExit).toHaveBeenCalledWith(1)
    })
    await harness.cleanup()?.()
    expect(harness.ctx.logger.error).toHaveBeenCalledWith('telegram-gateway: revoked')
  })

  it('suppresses an owned disposal failure after cleanup aborts the gateway', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ token: 'credential-token' })
    harness.dispose.mockRejectedValueOnce(new Error('dispose failed'))
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async (_offset, _timeout, signal) => new Promise<TelegramUpdate[]>((resolve) => {
        signal?.addEventListener('abort', () => resolve([]), { once: true })
      }),
      sendMessage: async () => ({ messageId: 1 }),
    }

    await apply(harness.ctx, gatewayConfig(), { createHttp: () => http })
    await expect(harness.cleanup()?.()).resolves.toBeUndefined()
    expect(harness.services.appExit).not.toHaveBeenCalled()
  })

  it('formats a non-Error failure after readiness before requesting shutdown', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ token: 'credential-token' })
    harness.dispose.mockRejectedValueOnce('dispose failed')
    const poll = Promise.withResolvers<TelegramUpdate[]>()
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => poll.promise,
      sendMessage: async () => ({ messageId: 1 }),
    }

    await apply(harness.ctx, gatewayConfig(), { createHttp: () => http })
    poll.reject(new TelegramApiError('fatal', 'revoked'))
    await vi.waitFor(() => {
      expect(harness.ctx.logger.error).toHaveBeenCalledWith('telegram-gateway: dispose failed')
    })
    await harness.cleanup()?.()
  })

  it('advances and persists the inclusive Telegram offset', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext()
    const lifetime = new AbortController()
    const offsets: number[] = []
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async (offset) => {
        offsets.push(offset)
        if (offset === 0) return [{ update_id: 42 }]
        lifetime.abort()
        return []
      },
      sendMessage: async () => ({ messageId: 1 }),
    }

    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)

    expect(offsets).toEqual([0, 43])
    expect(readFileSync(join(scratch, 'offset.txt'), 'utf8')).toBe('43')
    expect(harness.dispose).toHaveBeenCalledOnce()
  })

  it('adopts the first private chat, ignores unrelated updates, and chunks the reply', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext()
    const lifetime = new AbortController()
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = makeTurnEvents({ text: 'abcd' })
    })
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 1 }))
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1, username: 'test-bot' }),
      getUpdates: async () => {
        polls += 1
        if (polls === 1) {
          return [
            { update_id: 1 },
            { update_id: 2, message: { message_id: 1, chat: { id: -1, type: 'group' }, text: 'group' } },
            { update_id: 3, message: { message_id: 2, chat: { id: 7, type: 'private' }, text: ' ' } },
            { update_id: 4, message: { message_id: 3, chat: { id: 8, type: 'private' }, text: 'wrong chat' } },
            { update_id: 5, message: { message_id: 4, chat: { id: 7, type: 'private' }, text: 'go' } },
          ]
        }
        lifetime.abort()
        return []
      },
      sendMessage,
    }

    await runGateway(harness.ctx, gatewayConfig({ maxMessageChars: 2 }), http, lifetime.signal)

    expect(harness.agent.followup).toHaveBeenCalledOnce()
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      '✅ 已连接。你可以让我记住、跟进，或执行一件当前事情。',
      'ab',
      'cd',
    ])
    expect((harness.services.sessions as { flush: ReturnType<typeof vi.fn> }).flush).toHaveBeenCalledOnce()
    expect(harness.setupContext.on).toHaveBeenCalledTimes(2)
  })

  it('resumes a persisted session and reports an Agent turn error to the configured chat', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'], persisted: true })
    const lifetime = new AbortController()
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = makeTurnEvents({ error: { code: 'E_AGENT', message: 'failed' } })
    })
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 1 }))
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 9 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, text: 'go' } }]
        }
        lifetime.abort()
        return []
      },
      sendMessage,
    }

    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal, vi.fn())

    expect(harness.agents.resume).toHaveBeenCalledOnce()
    expect(harness.agents.create).not.toHaveBeenCalled()
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      '✅ 已连接。你可以让我记住、跟进，或执行一件当前事情。',
      '⚠️ 任务出错：E_AGENT: failed',
    ])
  })

  it('reuses a live Agent without disposing it and reports an empty reply', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'], live: true })
    const lifetime = new AbortController()
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = makeTurnEvents()
    })
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 1 }))
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 9, username: 'bot' }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, text: 'go' } }]
        }
        lifetime.abort()
        return []
      },
      sendMessage,
    }

    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)

    expect(harness.agents.create).not.toHaveBeenCalled()
    expect(harness.agents.resume).not.toHaveBeenCalled()
    expect(harness.dispose).not.toHaveBeenCalled()
    // 空答复作为最终文本回复触发消息，并收尾为 👍。
    expect(sendMessage).toHaveBeenLastCalledWith(42, '（完成，但没有任何文本输出）', { replyToMessageId: 1 }, lifetime.signal)
  })

  it('reports execution exceptions and continues with later updates', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    const flush = (harness.services.sessions as { flush: ReturnType<typeof vi.fn> }).flush
    flush.mockRejectedValueOnce(new Error('flush failed')).mockRejectedValueOnce('string failure')
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 1 }))
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [
            { update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, text: 'one' } },
            { update_id: 2, message: { message_id: 2, chat: { id: 42, type: 'private' }, text: 'two' } },
          ]
        }
        lifetime.abort()
        return []
      },
      sendMessage,
    }

    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)

    expect(sendMessage.mock.calls.map(([, text]) => text)).toContain('⚠️ 执行失败：flush failed')
    expect(sendMessage.mock.calls.map(([, text]) => text)).toContain('⚠️ 执行失败：string failure')
  })

  it('stops a turn when disposal aborts the first idle wait', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    harness.agent.whenIdle.mockImplementationOnce(async () => {
      lifetime.abort()
    })
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => [
        { update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, text: 'go' } },
      ],
      sendMessage: async () => ({ messageId: 1 }),
    }

    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
    expect(harness.agent.followup).not.toHaveBeenCalled()
  })

  it('closes one presentation lifecycle when disposal aborts the first idle wait', async () => {
    vi.useFakeTimers()
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    const sendTyping = vi.fn(async () => {})
    const setReaction = vi.fn(async () => {})
    harness.agent.whenIdle.mockImplementationOnce(async () => {
      lifetime.abort()
    })
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => [
        { update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, text: 'go' } },
      ],
      sendMessage: async () => ({ messageId: 1 }),
      sendTyping,
      setReaction,
    }

    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
    await vi.advanceTimersByTimeAsync(4_001)

    expect(sendTyping).toHaveBeenCalledOnce()
    expect(setReaction).toHaveBeenLastCalledWith(42, 1, undefined, expect.any(AbortSignal))
  })

  it('stops a turn when followup aborts before the second idle wait', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    harness.agent.followup.mockImplementation(() => lifetime.abort())
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => [
        { update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, text: 'go' } },
      ],
      sendMessage: async () => ({ messageId: 1 }),
    }

    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
    expect((harness.services.sessions as { flush: ReturnType<typeof vi.fn> }).flush).not.toHaveBeenCalled()
  })

  it('stops a turn when the Session flush aborts the plugin', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    ;(harness.services.sessions as { flush: ReturnType<typeof vi.fn> }).flush
      .mockImplementationOnce(async () => lifetime.abort())
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => [
        { update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, text: 'go' } },
      ],
      sendMessage: async () => ({ messageId: 1 }),
    }

    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
    expect(harness.dispose).toHaveBeenCalledOnce()
  })

  it('rejects an invalid configured chat id', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['not-a-number'] })
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => [],
      sendMessage: async () => ({ messageId: 1 }),
    }
    await expect(runGateway(harness.ctx, gatewayConfig(), http, new AbortController().signal))
      .rejects.toThrow('invalid allowed chat id')
  })

  it('rejects a fatal getMe failure and warns on a transient one', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const fatalHarness = gatewayContext()
    const fatal = new TelegramApiError('fatal', 'bad token')
    const fatalHttp: TelegramHttp = {
      getMe: async () => { throw fatal },
      getUpdates: async () => [],
      sendMessage: async () => ({ messageId: 1 }),
    }
    await expect(runGateway(fatalHarness.ctx, gatewayConfig(), fatalHttp, new AbortController().signal))
      .rejects.toBe(fatal)

    const transientHarness = gatewayContext()
    const lifetime = new AbortController()
    const transientHttp: TelegramHttp = {
      getMe: async () => { throw new Error('offline') },
      getUpdates: async () => {
        lifetime.abort()
        return []
      },
      sendMessage: async () => ({ messageId: 1 }),
    }
    await runGateway(transientHarness.ctx, gatewayConfig(), transientHttp, lifetime.signal)
    expect(transientHarness.ctx.logger.warn).toHaveBeenCalledWith('telegram-gateway: getMe transient failure: offline')
  })

  it('formats a non-Error transient getMe failure', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext()
    const lifetime = new AbortController()
    const http: TelegramHttp = {
      getMe: async () => { throw 'offline' },
      getUpdates: async () => {
        lifetime.abort()
        return []
      },
      sendMessage: async () => ({ messageId: 1 }),
    }
    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
    expect(harness.ctx.logger.warn).toHaveBeenCalledWith('telegram-gateway: getMe transient failure: offline')
  })

  it('fails before Telegram access when a core service is absent', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext()
    delete harness.services.agents
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => [],
      sendMessage: async () => ({ messageId: 1 }),
    }
    await expect(runGateway(harness.ctx, gatewayConfig(), http, new AbortController().signal))
      .rejects.toThrow('core services unavailable')
  })

  it('can run without a credential service when authorization is omitted', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext()
    delete harness.services.credentials
    const lifetime = new AbortController()
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        lifetime.abort()
        return []
      },
      sendMessage: async () => ({ messageId: 1 }),
    }
    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
  })

  it('retries classified and transport failures with bounded delays', async () => {
    vi.useFakeTimers()
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext()
    const lifetime = new AbortController()
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        polls += 1
        if (polls === 1) throw new TelegramApiError('conflict', 'duplicate')
        if (polls === 2) throw new TelegramApiError('retry', 'rate limited')
        if (polls === 3) throw new TelegramApiError('retry', 'rate limited', 120)
        if (polls === 4) throw new Error('offline')
        lifetime.abort()
        return []
      },
      sendMessage: async () => ({ messageId: 1 }),
    }

    const running = runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
    await vi.runAllTimersAsync()
    await running

    expect(polls).toBe(5)
    expect(harness.ctx.logger.error).toHaveBeenCalledWith('telegram-gateway: duplicate')
  })

  it('ends a retry delay promptly when the plugin is disposed', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext()
    const lifetime = new AbortController()
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        setTimeout(() => lifetime.abort(), 0)
        throw new TelegramApiError('conflict', 'duplicate')
      },
      sendMessage: async () => ({ messageId: 1 }),
    }
    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
  })

  it.each([
    ['retry', new TelegramApiError('retry', 'rate limited')],
    ['transport', new Error('offline')],
  ])('ends a %s delay promptly when the plugin is disposed', async (_label, failure) => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext()
    const lifetime = new AbortController()
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        setTimeout(() => lifetime.abort(), 0)
        throw failure
      },
      sendMessage: async () => ({ messageId: 1 }),
    }
    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
  })

  it('propagates a fatal polling error and disposes the owned Agent', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext()
    const fatal = new TelegramApiError('fatal', 'revoked')
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => { throw fatal },
      sendMessage: async () => ({ messageId: 1 }),
    }
    await expect(runGateway(harness.ctx, gatewayConfig(), http, new AbortController().signal)).rejects.toBe(fatal)
    expect(harness.dispose).toHaveBeenCalledOnce()
  })

  it('returns directly when polling aborts while rejecting', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext()
    const lifetime = new AbortController()
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        lifetime.abort()
        throw new Error('aborted request')
      },
      sendMessage: async () => ({ messageId: 1 }),
    }
    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
  })

  it('returns directly when execution aborts and then rejects', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    ;(harness.services.sessions as { flush: ReturnType<typeof vi.fn> }).flush.mockImplementationOnce(async () => {
      lifetime.abort()
      throw new Error('aborted flush')
    })
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => [
        { update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, text: 'go' } },
      ],
      sendMessage: async () => ({ messageId: 1 }),
    }
    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
  })

  it('uses the default offset directory under DSH_HOME', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    vi.stubEnv('DSH_HOME', scratch)
    const harness = gatewayContext()
    const lifetime = new AbortController()
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) return [{ update_id: 8 }]
        lifetime.abort()
        return []
      },
      sendMessage: async () => ({ messageId: 1 }),
    }
    await runGateway(harness.ctx, gatewayConfig({ offsetDir: '' }), http, lifetime.signal)
    expect(readFileSync(join(scratch, 'storages', 'telegram', 'offset.txt'), 'utf8')).toBe('9')
  })

  it('arms 👀 and typing before the Agent runs and swaps to 👍 on success', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = makeTurnEvents({ text: 'done' })
    })
    const setReaction = vi.fn(async () => {})
    const sendTyping = vi.fn(async () => {})
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 1 }))
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{ update_id: 1, message: { message_id: 5, chat: { id: 42, type: 'private' }, text: 'go' } }]
        }
        lifetime.abort()
        return []
      },
      sendMessage,

      sendTyping,
      setReaction,
    }

    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)

    // 👀 与 typing 在 Agent 运行之前就绪，且顺序在 followup 之前。
    expect(setReaction.mock.invocationCallOrder[0]).toBeLessThan(harness.agent.followup.mock.invocationCallOrder[0]!)
    expect(sendTyping.mock.invocationCallOrder[0]).toBeLessThan(harness.agent.followup.mock.invocationCallOrder[0]!)
    expect(setReaction).toHaveBeenNthCalledWith(1, 42, 5, '👀', expect.any(AbortSignal))
    expect(setReaction).toHaveBeenNthCalledWith(2, 42, 5, '👍', expect.any(AbortSignal))
  })

  it('delivers only complete interim and final messages for a text+tool-call chain', async () => {
    vi.useFakeTimers()
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    let releaseIdle!: () => void
    const events: SessionEvent[] = [
      { seq: 1, type: 'turn/start', time: 1, data: { turn: 2 } },
      { seq: 2, type: 'step/start', time: 2, data: { turn: 2, step: 1 } },
      { seq: 3, type: 'assistant/chunk', time: 3, data: { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '半句' } } },
      {
        seq: 4,
        type: 'assistant/message',
        time: 4,
        data: {
          turn: 2,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'text', text: '完整说明' },
              { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{}' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      },
      { seq: 5, type: 'tool/call', time: 5, data: { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
      { seq: 6, type: 'tool/result', time: 6, data: { turn: 2, step: 1, callId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false } },
      {
        seq: 7,
        type: 'assistant/message',
        time: 7,
        data: {
          turn: 2,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: '最终结果' }],
            source: { provider: 'p', model: 'm' },
          }),
        },
      },
      { seq: 8, type: 'step/end', time: 8, data: { turn: 2, step: 1 } },
      { seq: 9, type: 'turn/end', time: 9, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = events
      for (const event of events) harness.emit(harness.agent.session, event)
    })
    harness.agent.whenIdle
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseIdle = resolve
      }))
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 200 }))
    const setReaction = vi.fn(async () => {})
    const sendTyping = vi.fn(async () => {})
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{ update_id: 1, message: { message_id: 5, chat: { id: 42, type: 'private' }, text: 'go' } }]
        }
        lifetime.abort()
        return []
      },
      sendMessage,
      sendTyping,
      setReaction,
    }

    const running = runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
    await vi.advanceTimersByTimeAsync(0)
    // 完整 text + tool-call 中途消息立即入队并发送，回复触发消息
    expect(sendMessage).toHaveBeenCalledTimes(2) // 已连接 + 完整说明
    expect(sendMessage.mock.calls[1]?.[1]).toBe('完整说明')
    expect(sendMessage.mock.calls[1]?.[2]).toEqual({ replyToMessageId: 5 })

    releaseIdle()
    await vi.advanceTimersByTimeAsync(0)
    await running

    // 可见正文只能是 完整说明 + 最终结果；绝无半句、编辑动作或重复终稿
    expect(sendMessage).toHaveBeenCalledTimes(3)
    expect(sendMessage.mock.calls[2]?.[1]).toBe('最终结果')
    expect(sendMessage.mock.calls[2]?.[2]).toBeUndefined() // 后续消息不层层引用
    const texts = sendMessage.mock.calls.map(call => call[1] as string)
    expect(texts).toEqual(['✅ 已连接。你可以让我记住、跟进，或执行一件当前事情。', '完整说明', '最终结果'])
    expect(texts).not.toContain('半句')
    expect(http).not.toHaveProperty('editMessage')
    expect(setReaction).toHaveBeenLastCalledWith(42, 5, '👍', expect.any(AbortSignal))
  })

  it('consumes only the exact session, events after firstSeq, and in-turn complete messages', async () => {
    vi.useFakeTimers()
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    let releaseIdle!: () => void
    harness.agent.session.seq = 100
    const events: SessionEvent[] = [
      { seq: 101, type: 'turn/start', time: 101, data: { turn: 3 } },
      { seq: 102, type: 'step/start', time: 102, data: { turn: 3, step: 1 } },
      { seq: 103, type: 'assistant/chunk', time: 103, data: { turn: 3, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'hidden' } } },
      { seq: 104, type: 'assistant/chunk', time: 104, data: { turn: 3, step: 1, chunk: { type: 'text-delta', index: 0, text: '半句' } } },
      {
        seq: 105,
        type: 'assistant/message',
        time: 105,
        data: {
          turn: 3,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'text', text: '完整说明' },
              { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{}' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      },
      {
        seq: 106,
        type: 'assistant/message',
        time: 106,
        data: {
          turn: 3,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: '最终结果' }],
            source: { provider: 'p', model: 'm' },
          }),
        },
      },
      { seq: 107, type: 'turn/end', time: 107, data: { turn: 3, reason: { kind: 'completed' } } },
    ]
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = events
      // 其他 Session 的增量必须被忽略。
      harness.emit({ unrelated: true } as never, {
        seq: 103, type: 'assistant/chunk', time: 103,
        data: { turn: 9, step: 9, chunk: { type: 'text-delta', index: 0, text: 'leak' } },
      } as SessionEvent)
      // firstSeq 之前的旧事件必须被忽略。
      harness.emit(harness.agent.session, {
        seq: 99, type: 'assistant/chunk', time: 99,
        data: { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'old-leak' } },
      } as SessionEvent)
      for (const event of events) harness.emit(harness.agent.session, event)
    })
    harness.agent.whenIdle
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseIdle = resolve
      }))
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 200 }))
    const setReaction = vi.fn(async () => {})
    const sendTyping = vi.fn(async () => {})
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{ update_id: 1, message: { message_id: 5, chat: { id: 42, type: 'private' }, text: 'go' } }]
        }
        lifetime.abort()
        return []
      },
      sendMessage,
      sendTyping,
      setReaction,
    }

    const running = runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
    await vi.advanceTimersByTimeAsync(0)
    // 只有完整说明 成为中途消息；半句/隐藏推理/外部会话/旧事件都不出现
    expect(sendMessage).toHaveBeenCalledTimes(2)
    const texts = sendMessage.mock.calls.map(call => call[1] as string)
    expect(texts).not.toContain('leak')
    expect(texts).not.toContain('old-leak')
    expect(texts).not.toContain('hidden')
    expect(texts).not.toContain('半句')
    expect(texts[1]).toBe('完整说明')

    releaseIdle()
    await vi.advanceTimersByTimeAsync(0)
    await running
    expect(sendMessage).toHaveBeenCalledTimes(3)
    expect(sendMessage.mock.calls[2]?.[1]).toBe('最终结果')
    expect(http).not.toHaveProperty('editMessage')
  })

  it('reports the Agent error text with 👎 and a reply to the trigger', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = makeTurnEvents({ error: { code: 'E_AGENT', message: 'failed' } })
    })
    const setReaction = vi.fn(async () => {})
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 1 }))
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, text: 'go' } }]
        }
        lifetime.abort()
        return []
      },
      sendMessage,

      sendTyping: async () => {},
      setReaction,
    }

    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)

    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      '✅ 已连接。你可以让我记住、跟进，或执行一件当前事情。',
      '⚠️ 任务出错：E_AGENT: failed',
    ])
    expect(sendMessage.mock.calls[1]?.[2]).toEqual({ replyToMessageId: 1 })
    expect(setReaction).toHaveBeenNthCalledWith(2, 42, 1, '👎', expect.any(AbortSignal))
  })

  it('delivers exactly one visible copy for duplicate interim texts and an identical final', async () => {
    vi.useFakeTimers()
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    let releaseIdle!: () => void
    const same = '同一个说明'
    const events: SessionEvent[] = [
      { seq: 1, type: 'turn/start', time: 1, data: { turn: 2 } },
      {
        seq: 2, type: 'assistant/message', time: 2,
        data: {
          turn: 2, step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'text', text: same },
              { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{}' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      },
      {
        seq: 3, type: 'assistant/message', time: 3,
        data: {
          turn: 2, step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'text', text: ` \r\n${same}\r\n ` },
              { type: 'tool-call', id: 'c2' as never, name: 'bash', arguments: '{}' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      },
      {
        seq: 4, type: 'assistant/message', time: 4,
        data: {
          turn: 2, step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: same }],
            source: { provider: 'p', model: 'm' },
          }),
        },
      },
      { seq: 5, type: 'turn/end', time: 5, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = events
      for (const event of events) harness.emit(harness.agent.session, event)
    })
    harness.agent.whenIdle
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseIdle = resolve
      }))
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 200 }))
    const setReaction = vi.fn(async () => {})
    const sendTyping = vi.fn(async () => {})
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{ update_id: 1, message: { message_id: 5, chat: { id: 42, type: 'private' }, text: 'go' } }]
        }
        lifetime.abort()
        return []
      },
      sendMessage,
      sendTyping,
      setReaction,
    }

    const running = runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
    await vi.advanceTimersByTimeAsync(0)
    // 两份规范化后完全相同的中途全文只发一份
    expect(sendMessage).toHaveBeenCalledTimes(2) // 已连接 + 一份 同一个说明

    releaseIdle()
    await vi.advanceTimersByTimeAsync(0)
    await running
    // 最终文本与已交付中途全文相同 → 不重复发送，仍标 👍
    expect(sendMessage).toHaveBeenCalledTimes(2)
    const texts = sendMessage.mock.calls.map(call => call[1] as string)
    expect(texts.filter(text => text === same)).toHaveLength(1)
    expect(setReaction).toHaveBeenLastCalledWith(42, 5, '👍', expect.any(AbortSignal))
  })

  it('keeps an interim message and appends a complete error after an Agent error, then 👎', async () => {
    vi.useFakeTimers()
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    let releaseIdle!: () => void
    const events: SessionEvent[] = [
      { seq: 1, type: 'turn/start', time: 1, data: { turn: 2 } },
      {
        seq: 2, type: 'assistant/message', time: 2,
        data: {
          turn: 2, step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'text', text: '我先核对配置。' },
              { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{}' },
            ],
            source: { provider: 'p', model: 'm' },
          }),
        },
      },
      {
        seq: 3, type: 'turn/end', time: 3,
        data: { turn: 2, reason: { kind: 'error', error: { code: 'E_BOOM', message: '远端连接失败' } } },
      },
    ]
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = events
      for (const event of events) harness.emit(harness.agent.session, event)
    })
    harness.agent.whenIdle
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseIdle = resolve
      }))
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 200 }))
    const setReaction = vi.fn(async () => {})
    const sendTyping = vi.fn(async () => {})
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{ update_id: 1, message: { message_id: 5, chat: { id: 42, type: 'private' }, text: 'go' } }]
        }
        lifetime.abort()
        return []
      },
      sendMessage,
      sendTyping,
      setReaction,
    }

    const running = runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(sendMessage.mock.calls[1]?.[1]).toBe('我先核对配置。')

    releaseIdle()
    await vi.advanceTimersByTimeAsync(0)
    await running
    // 已发出的完整中途消息保留；错误作为新的完整消息追加，收尾为 👎
    const texts = sendMessage.mock.calls.map(call => call[1] as string)
    expect(texts).toEqual(['✅ 已连接。你可以让我记住、跟进，或执行一件当前事情。', '我先核对配置。', '⚠️ 任务出错：E_BOOM: 远端连接失败'])
    expect(setReaction).toHaveBeenLastCalledWith(42, 5, '👎', expect.any(AbortSignal))
  })

  it('does not mark 👍 when the final Telegram delivery fails', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = makeTurnEvents({ text: 'final answer' })
    })
    const setReaction = vi.fn(async () => {})
    let sends = 0
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => {
      sends += 1
      if (sends === 2) throw new TelegramApiError('fatal', 'blocked by telegram')
      return { messageId: 1 }
    })
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, text: 'go' } }]
        }
        lifetime.abort()
        return []
      },
      sendMessage,

      sendTyping: async () => {},
      setReaction,
    }

    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)

    expect(setReaction).toHaveBeenCalledTimes(2) // 👀 → 👎
    expect(setReaction).not.toHaveBeenCalledWith(42, 1, '👍', expect.anything())
    expect(setReaction).toHaveBeenLastCalledWith(42, 1, '👎', expect.any(AbortSignal))
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      '✅ 已连接。你可以让我记住、跟进，或执行一件当前事情。',
      'final answer',
      '⚠️ 执行失败：blocked by telegram',
    ])
  })

  it('chunks an oversized final into ordered reply messages', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = makeTurnEvents({ text: 'abcd' })
    })
    const setReaction = vi.fn(async () => {})
    let nextId = 100
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => {
      return { messageId: nextId++ }
    })
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{ update_id: 1, message: { message_id: 5, chat: { id: 42, type: 'private' }, text: 'go' } }]
        }
        lifetime.abort()
        return []
      },
      sendMessage,

      sendTyping: async () => {},
      setReaction,
    }

    await runGateway(harness.ctx, gatewayConfig({ maxMessageChars: 2 }), http, lifetime.signal)

    // 首段回复触发消息，后续段回复前一段。
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      '✅ 已连接。你可以让我记住、跟进，或执行一件当前事情。',
      'ab',
      'cd',
    ])
    expect(sendMessage.mock.calls[1]?.[2]).toEqual({ replyToMessageId: 5 })
    expect(sendMessage.mock.calls[2]?.[2]).toEqual({ replyToMessageId: 101 }) // 'ab' 拿到 101，'cd' 引用它
    expect(setReaction).toHaveBeenLastCalledWith(42, 5, '👍', expect.any(AbortSignal))
  })

  it('clears an unfinished 👀 reaction when the gateway is disposed mid-turn', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    harness.agent.whenIdle
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>(() => {}))
    const setReaction = vi.fn(async () => {})
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{ update_id: 1, message: { message_id: 3, chat: { id: 42, type: 'private' }, text: 'go' } }]
        }
        return []
      },
      sendMessage: async () => ({ messageId: 1 }),

      sendTyping: async () => {},
      setReaction,
    }

    const running = runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
    await vi.waitFor(() => {
      expect(setReaction).toHaveBeenCalledWith(42, 3, '👀', expect.anything())
    })
    lifetime.abort()
    await running

    // 正常 dispose：用独立短超时信号清理未完成的 👀。
    expect(setReaction).toHaveBeenLastCalledWith(42, 3, undefined, expect.any(AbortSignal))
  })

  it('keeps the Agent and the final answer when reaction and typing fail', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-gateway-'))
    const harness = gatewayContext({ credentialValues: ['42'] })
    const lifetime = new AbortController()
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = makeTurnEvents({ text: 'done' })
    })
    const setReaction = vi.fn(async () => { throw new Error('reactions off') })
    const sendTyping = vi.fn(async () => { throw new Error('typing off') })
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 1 }))
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        if (polls++ === 0) {
          return [{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, text: 'go' } }]
        }
        lifetime.abort()
        return []
      },
      sendMessage,

      sendTyping,
      setReaction,
    }

    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)

    expect(harness.agent.followup).toHaveBeenCalledOnce()
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      '✅ 已连接。你可以让我记住、跟进，或执行一件当前事情。',
      'done',
    ])
    expect(sendMessage.mock.calls[1]?.[2]).toEqual({ replyToMessageId: 1 })
  })
})
