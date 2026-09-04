import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  createPersonalContextOwner,
  type PersonalContextActiveFact,
  type PersonalContextSemanticInput,
  type PersonalContextSemanticPort,
} from '@herman/personal-feed'
import { describe, expect, it, vi } from 'vitest'

type Factory = (options: {
  readonly ctx: {
    readonly llm: { readonly stream: (request: GenerateOptions) => AsyncIterable<StreamChunk> }
    readonly logger?: { readonly warn: (message: string) => void }
  }
  readonly provider: string
  readonly model: string
  readonly timeoutMs?: number
}) => PersonalContextSemanticPort

const source = Object.freeze({ kind: 'telegram_inbound' as const, chatId: -7001, messageId: 42 })
const authorization = Object.freeze({
  policy: 'direct_user_statement' as const,
  purpose: 'personal_feed_context' as const,
})
const evidence = Object.freeze([Object.freeze({
  source,
  occurredAt: '2026-09-01T00:00:00.000Z',
  verbatim: '我持续关注可靠设计',
})])
const activeFacts: readonly PersonalContextActiveFact[] = Object.freeze([
  Object.freeze({
    factId: 'telegram_inbound:-7001:1#0',
    lane: 'long_term_interest' as const,
    stance: 'include' as const,
    scope: Object.freeze({ verbatim: '可靠设计' }),
    evidence,
  }),
  Object.freeze({
    factId: 'telegram_inbound:-7001:2#0',
    lane: 'existing_knowledge' as const,
    epistemic: 'asserted' as const,
    scope: Object.freeze({ verbatim: '复杂度' }),
    evidence,
  }),
])
const input: PersonalContextSemanticInput = Object.freeze({
  source,
  rawText: '我以后研究系统边界，也知道复杂度会转移。',
  authorization,
  activeFacts,
})

async function loadFactory(): Promise<Factory> {
  const module = await import('../src/personal-feed/personal-context-semantic-llm.ts') as {
    readonly createPersonalContextSemanticLlmPort?: Factory
  }
  if (typeof module.createPersonalContextSemanticLlmPort !== 'function') {
    throw new Error('CAPABILITY_ASSERTION: single personal-context semantic port is unavailable')
  }
  return module.createPersonalContextSemanticLlmPort
}

function toolCall(request: GenerateOptions, value: unknown, name = request.tools?.[0]?.name): readonly StreamChunk[] {
  const encoded = JSON.stringify(value)
  const callId = ToolCallId('personal-context-revisions')
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: name ?? '', argumentsDelta: encoded },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: name ?? '', arguments: encoded } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function context(script: (request: GenerateOptions) => readonly StreamChunk[]) {
  const requests: GenerateOptions[] = []
  return {
    requests,
    ctx: {
      llm: {
        stream: vi.fn(async function* (request: GenerateOptions): AsyncIterable<StreamChunk> {
          requests.push(request)
          for (const chunk of script(request)) yield chunk
        }),
      },
    },
  }
}

function collectSpanSchemas(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) collectSpanSchemas(item, found)
    return found
  }
  if (value === null || typeof value !== 'object') return found
  const record = value as Record<string, unknown>
  const properties = record.properties
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const fields = properties as Record<string, unknown>
    if (fields.startUtf16 !== undefined && fields.endUtf16 !== undefined) found.push(fields)
  }
  for (const nested of Object.values(record)) collectSpanSchemas(nested, found)
  return found
}

function expectBoundedRequest(request: GenerateOptions, rawText: string, utf16Length: number): void {
  const textBlock = request.messages[0]?.content.find(block => block.type === 'text')
  expect(textBlock?.type).toBe('text')
  if (textBlock?.type !== 'text') throw new Error('expected one personal-context text material')
  expect(JSON.parse(textBlock.text)).toMatchObject({ rawText, rawTextUtf16Length: utf16Length })

  const parameters = request.tools?.[0]?.parameters
  const encodedSchema = JSON.stringify(parameters)
  expect(encodedSchema).toContain('evidenceSpan')
  expect(encodedSchema).toContain('scopeSpan')
  const spans = collectSpanSchemas(parameters)
  expect(spans.length).toBeGreaterThan(0)
  for (const fields of spans) {
    expect(fields.startUtf16).toMatchObject({ maximum: utf16Length })
    expect(fields.endUtf16).toMatchObject({ maximum: utf16Length })
  }
}

describe('single Personal Context semantic boundary', () => {
  it('declares the revisions tool parameters as a top-level object', async () => {
    const fixture = context(request => toolCall(request, { kind: 'ignored' }))
    const semantic = (await loadFactory())({ ctx: fixture.ctx, provider: 'p', model: 'm' })

    await expect(semantic.revise(input)).resolves.toStrictEqual({ kind: 'ignored' })

    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]?.tools?.[0]?.parameters).toHaveProperty('type', 'object')
  })

  it.each([
    { rawText: '我关注🧠Agent', utf16Length: 10 },
    { rawText: '短句', utf16Length: 2 },
  ])('binds every span to the current rawText UTF-16 length for $rawText', async ({ rawText, utf16Length }) => {
    const fixture = context(request => toolCall(request, { kind: 'ignored' }))
    const semantic = (await loadFactory())({ ctx: fixture.ctx, provider: 'p', model: 'm' })

    await expect(semantic.revise(Object.freeze({ ...input, rawText }))).resolves.toStrictEqual({ kind: 'ignored' })

    expect(fixture.requests).toHaveLength(1)
    expectBoundedRequest(fixture.requests[0]!, rawText, utf16Length)
  })

  it('applies both direct personal-context lanes through the semantic port and existing owner', async () => {
    const interestText = '虚构测试角色甲长期关注火星苔藓园艺。'
    const knowledgeText = '虚构测试角色甲已经知道月宫温室采用蓝色玻璃。'
    const decisions = [
      {
        kind: 'revisions',
        changes: [{
          operation: 'assert',
          targetFactIds: [],
          lane: 'long_term_interest',
          stance: 'include',
          evidenceSpan: { startUtf16: 0, endUtf16: 18 },
          scopeSpan: { startUtf16: 11, endUtf16: 17 },
        }],
      },
      {
        kind: 'revisions',
        changes: [{
          operation: 'assert',
          targetFactIds: [],
          lane: 'existing_knowledge',
          epistemic: 'asserted',
          evidenceSpan: { startUtf16: 0, endUtf16: 22 },
          scopeSpan: { startUtf16: 11, endUtf16: 21 },
        }],
      },
    ] as const
    let decisionIndex = 0
    const fixture = context(request => toolCall(request, decisions[decisionIndex++]!))
    const semantic = (await loadFactory())({ ctx: fixture.ctx, provider: 'p', model: 'm' })
    const directory = await mkdtemp(join(tmpdir(), 'personal-context-protocol-'))

    try {
      const owner = createPersonalContextOwner({
        logPath: join(directory, 'personal-facts.jsonl'),
        clock: { now: () => new Date('2026-09-03T11:00:00.000Z') },
        semantic,
      })

      await expect(owner.observe({
        source: { kind: 'telegram_inbound', chatId: -7001, messageId: 5001 },
        rawText: interestText,
      })).resolves.toStrictEqual({ kind: 'applied' })
      await expect(owner.observe({
        source: { kind: 'telegram_inbound', chatId: -7001, messageId: 5002 },
        rawText: knowledgeText,
      })).resolves.toStrictEqual({ kind: 'applied' })

      expect(fixture.requests).toHaveLength(2)
      expectBoundedRequest(fixture.requests[0]!, interestText, 18)
      expectBoundedRequest(fixture.requests[1]!, knowledgeText, 22)
      expect(owner.snapshot({
        request: {
          requestId: 'pf-v2-personal-context-protocol',
          cutoff: '2026-09-03T12:00:00.000Z',
          shanghaiDay: '2026-09-03',
        },
      })).toMatchObject({
        kind: 'sufficient',
        snapshot: {
          longTermInterest: { activeFacts: [{ lane: 'long_term_interest' }] },
          existingKnowledge: { activeFacts: [{ lane: 'existing_knowledge' }] },
        },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('submits one span-and-enum-only revisions tool and returns its exact decoded decision', async () => {
    const decision = {
      kind: 'revisions',
      changes: [
        {
          operation: 'correct',
          targetFactIds: ['telegram_inbound:-7001:1#0'],
          lane: 'long_term_interest',
          stance: 'include',
          evidenceSpan: { startUtf16: 0, endUtf16: 10 },
          scopeSpan: { startUtf16: 5, endUtf16: 9 },
        },
        {
          operation: 'confirm',
          targetFactIds: ['telegram_inbound:-7001:2#0'],
          evidenceSpan: { startUtf16: 11, endUtf16: 20 },
        },
      ],
    }
    const fixture = context(request => toolCall(request, decision))
    const create = await loadFactory()
    const semantic = create({ ctx: fixture.ctx, provider: 'test-provider', model: 'test-model' })

    await expect(semantic.revise(input)).resolves.toStrictEqual(decision)
    expect(Object.keys(semantic)).toEqual(['revise'])
    expect(fixture.requests).toHaveLength(1)
    const request = fixture.requests[0]!
    expect(request).toMatchObject({ provider: 'test-provider', model: 'test-model', temperature: 0 })
    expect(request.tools).toHaveLength(1)
    expect(request.tools?.[0]?.name).toBe('submit-personal-context-revisions')
    expect(request.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.stringify(request.messages)).toContain(input.rawText)
    const schema = JSON.stringify(request.tools?.[0]?.parameters)
    expect(schema).toContain('telegram_inbound:-7001:1#0')
    expect(schema).toContain('telegram_inbound:-7001:2#0')
    expect(schema).toContain('startUtf16')
    expect(schema).toContain('scopeSpan')
    expect(schema).not.toMatch(/summary|proposition|reasoning|verbatim|rawText/)
  })

  it('returns the only body-free ignored decision without a validation or history call', async () => {
    const fixture = context(request => toolCall(request, { kind: 'ignored' }))
    const semantic = (await loadFactory())({ ctx: fixture.ctx, provider: 'p', model: 'm' })
    await expect(semantic.revise(input)).resolves.toStrictEqual({ kind: 'ignored' })
    expect(fixture.ctx.llm.stream).toHaveBeenCalledTimes(1)
  })

  it('uses the sole revisions tool call when the provider also emits non-authoritative text', async () => {
    const decision = {
      kind: 'revisions',
      changes: [{
        operation: 'assert',
        targetFactIds: [],
        lane: 'long_term_interest',
        stance: 'include',
        evidenceSpan: { startUtf16: 0, endUtf16: 20 },
        scopeSpan: { startUtf16: 5, endUtf16: 9 },
      }],
    }
    const fixture = context(request => {
      const [start, delta, end, finish] = toolCall(request, decision)
      return [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'I will submit the structured result.' },
        { ...start, index: 1 } as StreamChunk,
        { ...delta, index: 1 } as StreamChunk,
        { type: 'block-end', index: 0, block: { type: 'text', text: 'I will submit the structured result.' } },
        { ...end, index: 1 } as StreamChunk,
        finish,
      ]
    })
    const semantic = (await loadFactory())({ ctx: fixture.ctx, provider: 'p', model: 'm' })

    await expect(semantic.revise(input)).resolves.toStrictEqual(decision)
    expect(fixture.ctx.llm.stream).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      label: 'free text',
      chunks: (): readonly StreamChunk[] => [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'not a tool call' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'not a tool call' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
    {
      label: 'two tool calls',
      chunks: (request: GenerateOptions): readonly StreamChunk[] => [
        ...toolCall(request, { kind: 'ignored' }).slice(0, -1),
        ...toolCall(request, { kind: 'ignored' }).slice(0, -1).map(chunk => (
          'index' in chunk ? { ...chunk, index: 1 } as StreamChunk : chunk
        )),
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
    },
    {
      label: 'wrong tool',
      chunks: (request: GenerateOptions): readonly StreamChunk[] => toolCall(request, { kind: 'ignored' }, 'other-tool'),
    },
  ])('fails closed on $label instead of returning a semantic decision', async ({ chunks }) => {
    const fixture = context(chunks)
    const semantic = (await loadFactory())({ ctx: fixture.ctx, provider: 'p', model: 'm' })
    await expect(semantic.revise(input)).rejects.toThrow('personal context semantic response is invalid')
  })

  it('logs only a body-free failure category when the live semantic protocol is invalid', async () => {
    const fixture = context(() => [{ type: 'finish', reason: { kind: 'stop' } }])
    const warn = vi.fn()
    const semantic = (await loadFactory())({
      ctx: { ...fixture.ctx, logger: { warn } },
      provider: 'p',
      model: 'm',
    })

    await expect(semantic.revise(Object.freeze({ ...input, rawText: 'PRIVATE_BODY_CANARY' })))
      .rejects.toThrow('personal context semantic response is invalid')
    expect(warn).toHaveBeenCalledWith('x-feed: personal context semantic failed (unexpected-finish)')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_BODY_CANARY')
  })

  it('passes a caller abort through the one model request and returns no fallback decision', async () => {
    const reason = new Error('caller aborted')
    const controller = new AbortController()
    controller.abort(reason)
    const requests: GenerateOptions[] = []
    const ctx = {
      llm: {
        stream: vi.fn(async function* (request: GenerateOptions): AsyncIterable<StreamChunk> {
          requests.push(request)
          if (request.signal?.aborted === true) throw request.signal.reason
          yield* []
        }),
      },
    }
    const semantic = (await loadFactory())({ ctx, provider: 'p', model: 'm' })
    await expect(semantic.revise(input, controller.signal)).rejects.toBe(reason)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.signal?.aborted).toBe(true)
  })
})
