import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {
  PersonalContextActiveFact,
  PersonalContextSnapshot,
  PersonalFeedV2R5Input,
  PersonalFeedV2R5Port,
} from '@herman/personal-feed'
import { describe, expect, it, vi } from 'vitest'

type JudgmentFactory = (options: {
  readonly ctx: { readonly llm: { readonly stream: (request: GenerateOptions) => AsyncIterable<StreamChunk> } }
  readonly provider: string
  readonly model: string
  readonly timeoutMs?: number
}) => PersonalFeedV2R5Port

const request = Object.freeze({
  requestId: 'telegram:7:11',
  cutoff: '2026-09-01T00:00:00.000Z',
  shanghaiDay: '2026-09-01',
})
const source = Object.freeze({ kind: 'telegram_inbound' as const, chatId: 7, messageId: 11 })
const activeFacts: readonly PersonalContextActiveFact[] = Object.freeze([
  Object.freeze({
    factId: 'telegram_inbound:7:1#0',
    lane: 'long_term_interest' as const,
    stance: 'include' as const,
    scope: Object.freeze({ verbatim: '可靠设计' }),
    evidence: Object.freeze([Object.freeze({
      source,
      occurredAt: '2026-08-31T23:00:00.000Z',
      verbatim: '我持续关注可靠设计',
    })]),
  }),
  Object.freeze({
    factId: 'telegram_inbound:7:2#0',
    lane: 'existing_knowledge' as const,
    epistemic: 'asserted' as const,
    scope: Object.freeze({ verbatim: '复杂度' }),
    evidence: Object.freeze([Object.freeze({
      source,
      occurredAt: '2026-08-31T23:01:00.000Z',
      verbatim: '我知道复杂度会转移',
    })]),
  }),
])
const snapshot: PersonalContextSnapshot = Object.freeze({
  schemaVersion: 1,
  cutoff: request.cutoff,
  longTermInterest: Object.freeze({
    activeFacts: Object.freeze([activeFacts[0]!]),
    sufficiency: Object.freeze({ status: 'sufficient' as const, basisFactIds: Object.freeze([activeFacts[0]!.factId]) }),
  }),
  existingKnowledge: Object.freeze({
    activeFacts: Object.freeze([activeFacts[1]!]),
    sufficiency: Object.freeze({ status: 'sufficient' as const, basisFactIds: Object.freeze([activeFacts[1]!.factId]) }),
  }),
})
const candidate = Object.freeze({
  stableId: 'x-status:101',
  canonicalUrl: 'https://x.com/alpha/status/101',
  body: '一条关于可靠设计的完整候选正文',
  provenance: Object.freeze([Object.freeze({
    capturedAt: '2026-09-01T00:00:00.400Z',
    surface: 'for_you' as const,
    surfaceOrdinal: 0,
    occurrenceOrdinal: 0,
    canonicalUrl: 'https://x.com/alpha/status/101',
    authorHandle: 'alpha',
    publishedAt: '2026-08-31T22:00:00.000Z',
  })]),
})

function input(overrides: Partial<PersonalFeedV2R5Input> = {}): PersonalFeedV2R5Input {
  return Object.freeze({ request, snapshot, candidate, signal: new AbortController().signal, ...overrides })
}

function toolCall(requestValue: GenerateOptions, value: unknown, name = requestValue.tools?.[0]?.name): readonly StreamChunk[] {
  const encoded = JSON.stringify(value)
  return rawToolCall(requestValue, encoded, name)
}

function rawToolCall(requestValue: GenerateOptions, encoded: string, name = requestValue.tools?.[0]?.name): readonly StreamChunk[] {
  const callId = ToolCallId('personal-feed-candidate-judgment')
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: name ?? '', argumentsDelta: encoded },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: name ?? '', arguments: encoded } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function reasoningAndToolCall(requestValue: GenerateOptions, value: unknown): readonly StreamChunk[] {
  const encoded = JSON.stringify(value)
  const callId = ToolCallId('personal-feed-candidate-judgment')
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'internal reasoning' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'internal reasoning' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: callId, name: requestValue.tools?.[0]?.name ?? '', argumentsDelta: encoded },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: requestValue.tools?.[0]?.name ?? '', arguments: encoded } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textResponse(): readonly StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'free text is forbidden' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'free text is forbidden' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function twoToolCalls(requestValue: GenerateOptions): readonly StreamChunk[] {
  const first = toolCall(requestValue, {
    kind: 'judgment', longTermValue: 'pass', longTermInterestMatch: 'pass', informationIncrement: 'pass',
  })
  const second = toolCall(requestValue, {
    kind: 'judgment', longTermValue: 'pass', longTermInterestMatch: 'pass', informationIncrement: 'pass',
  }).slice(0, 3).map(chunk => 'index' in chunk ? { ...chunk, index: 1 } as StreamChunk : chunk)
  return [...first.slice(0, 3), ...second, { type: 'finish', reason: { kind: 'tool-calls' } }]
}

function harness(script: (requestValue: GenerateOptions) => readonly StreamChunk[] | 'throw' | 'hang') {
  const requests: GenerateOptions[] = []
  let observedSignal: AbortSignal | undefined
  const ctx = {
    llm: {
      stream: vi.fn(async function* (requestValue: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(requestValue)
        observedSignal = requestValue.signal
        const response = script(requestValue)
        if (response === 'throw') throw new Error('stream failed')
        if (response === 'hang') {
          await new Promise<void>(resolve => requestValue.signal?.addEventListener('abort', () => resolve(), { once: true }))
          return
        }
        for (const chunk of response) yield chunk
      }),
    },
  }
  return { ctx, requests, signal: () => observedSignal }
}

async function loadFactory(): Promise<JudgmentFactory> {
  const module = await import('../src/personal-feed/personal-feed-judgment-llm.ts') as {
    readonly createPersonalFeedJudgmentLlmPort?: JudgmentFactory
  }
  if (typeof module.createPersonalFeedJudgmentLlmPort !== 'function') {
    throw new Error('CAPABILITY_ASSERTION: personal-feed judgment LLM port is unavailable')
  }
  return module.createPersonalFeedJudgmentLlmPort
}

async function portFor(
  script: (requestValue: GenerateOptions) => readonly StreamChunk[] | 'throw' | 'hang',
  timeoutMs?: number,
) {
  const fixture = harness(script)
  const create = await loadFactory()
  const port = create({
    ctx: fixture.ctx,
    provider: 'test-provider',
    model: 'test-model',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
  return { ...fixture, port }
}

describe('single Personal Feed candidate judgment LLM boundary', () => {
  it('submits one untrusted-facts request with the exact gates and returns qualified', async () => {
    const fixture = await portFor(requestValue => reasoningAndToolCall(requestValue, {
      kind: 'judgment', longTermValue: 'pass', longTermInterestMatch: 'pass', informationIncrement: 'pass',
    }))
    await expect(fixture.port.judgeOne(input())).resolves.toStrictEqual({ kind: 'qualified' })
    expect(Object.keys(fixture.port)).toEqual(['judgeOne'])
    expect(fixture.requests).toHaveLength(1)
    const wire = fixture.requests[0]!
    expect(wire).toMatchObject({ provider: 'test-provider', model: 'test-model', temperature: 0, reasoningEffort: 'off' })
    expect(Object.hasOwn(wire, 'sessionId')).toBe(false)
    expect(Object.hasOwn(wire, 'agent')).toBe(false)
    expect(wire.messages).toHaveLength(1)
    expect(wire.tools).toHaveLength(1)
    expect(wire.tools?.[0]?.name).toBe('submit-personal-feed-candidate-judgment')
    expect(wire.system).toMatch(/candidate.*untrusted|untrusted.*candidate/i)
    expect(wire.system).toMatch(/personal facts.*untrusted|untrusted.*personal facts/i)
    expect(wire.system).toMatch(/longTermValue.*longTermInterestMatch.*informationIncrement/s)
    expect(wire.system).toMatch(/longTermValue[\s\S]*(?:sustained|durable|long[- ]?term)[\s\S]*(?:actual|practical|cognitive|epistemic|knowledge)[\s\S]*(?:value|worth)|longTermValue[\s\S]*持续[\s\S]*(?:实际|认知)[\s\S]*(?:价值|意义)/i)
    expect(wire.system).toMatch(/longTermInterestMatch[\s\S]*(?:include|exclude)[\s\S]*(?:scope|applicab|范围|适用)|longTermInterestMatch[\s\S]*(?:当前长期关注|长期关注)[\s\S]*(?:include|exclude|范围)/i)
    expect(wire.system).toMatch(/informationIncrement[\s\S]*(?:existing knowledge|已有知识|现有认识)|(?:existing knowledge|已有知识|现有认识)[\s\S]*informationIncrement/i)
    expect(wire.system).toMatch(/(?:update|updating)[\s\S]*(?:specific|concrete)[\s\S]*(?:knowledge|understanding)|更新[\s\S]*具体认识/i)
    expect(wire.system).toMatch(/(?:effective )?(?:evidence|constraint)[\s\S]*(?:real|reality|judg|判断)|有效证据|约束/i)
    expect(wire.system).toMatch(/(?:specific|concrete)[\s\S]*(?:direction|follow[- ]?up)[\s\S]*(?:continue|pursue|追)|具体方向[\s\S]*(?:继续|追)/i)
    expect(wire.system).toMatch(/(?:topic relevance|relevance of the topic|话题相关性|主题相关性)/i)
    expect(wire.system).toMatch(/popularity|受欢迎度|热度/i)
    expect(wire.system).toMatch(/writing quality|quality of writing|写作质量/i)
    expect(wire.system).toMatch(/user liking|user likes|用户喜欢|用户喜好/i)
    expect(wire.system).toMatch(/(?:merely )?(?:repeating|confirming)[\s\S]*(?:known views|known|已知观点|已知认识)|重复或确认已知/i)
    expect(wire.system).toMatch(/(?:topic relevance|话题相关性)[\s\S]*(?:popularity|受欢迎度|热度)[\s\S]*(?:writing quality|写作质量)[\s\S]*(?:user liking|用户喜欢|用户喜好)[\s\S]*(?:repeating|confirming|重复或确认)[\s\S]*(?:alone|by itself|not sufficient|insufficient|不足)/i)
    expect(wire.system).toMatch(/unknown[\s\S]*(?:cannot|unable|determine|judge|判断)|(?:cannot|unable)[\s\S]*(?:determine|judge)[\s\S]*unknown|无法判断[\s\S]*unknown/i)
    expect(wire.system).toMatch(/(?:do not|never).*(?:score|rank|compar|summar|reason|url)/is)
    const serialized = JSON.stringify(wire)
    expect(serialized).toContain('可靠设计')
    expect(serialized).toContain('一条关于可靠设计的完整候选正文')
    expect(serialized).toContain(candidate.canonicalUrl)
    expect(serialized).toContain(request.cutoff)
    expect(serialized).toContain(request.shanghaiDay)
    expect(serialized).not.toContain(request.requestId)
    expect(serialized).not.toContain('chatId')
    expect(serialized).not.toContain('messageId')
    expect(serialized).not.toContain('telegram_inbound:7:')
    expect(JSON.stringify(wire.tools?.[0]?.parameters)).toContain('not_reached')
  })

  it.each([
    ['first fail / later not reached', 'fail', 'not_reached', 'not_reached', 'not_qualified'],
    ['first fail / illegal interest pass', 'fail', 'pass', 'not_reached', 'incomplete'],
    ['first fail / illegal information pass', 'fail', 'not_reached', 'pass', 'incomplete'],
    ['first unknown / later not reached', 'unknown', 'not_reached', 'not_reached', 'incomplete'],
    ['first unknown / illegal interest fail', 'unknown', 'fail', 'not_reached', 'incomplete'],
    ['first unknown / illegal information pass', 'unknown', 'not_reached', 'pass', 'incomplete'],
    ['interest fail', 'pass', 'fail', 'not_reached', 'not_qualified'],
    ['interest unknown', 'pass', 'unknown', 'not_reached', 'incomplete'],
    ['information pass', 'pass', 'pass', 'pass', 'qualified'],
    ['information fail', 'pass', 'pass', 'fail', 'not_qualified'],
    ['information unknown', 'pass', 'pass', 'unknown', 'incomplete'],
  ] as const)('decodes %s', async (_label, longTermValue, longTermInterestMatch, informationIncrement, result) => {
    const fixture = await portFor(requestValue => toolCall(requestValue, {
      kind: 'judgment', longTermValue, longTermInterestMatch, informationIncrement,
    }))
    await expect(fixture.port.judgeOne(input())).resolves.toStrictEqual({ kind: result })
  })

  it.each([
    ['extra property', requestValue => toolCall(requestValue, {
      kind: 'judgment', longTermValue: 'pass', longTermInterestMatch: 'pass', informationIncrement: 'pass', extra: true,
    })],
    ['free text', () => textResponse()],
    ['wrong tool', requestValue => toolCall(requestValue, {
      kind: 'judgment', longTermValue: 'pass', longTermInterestMatch: 'pass', informationIncrement: 'pass',
    }, 'other-tool')],
    ['multiple tools', requestValue => twoToolCalls(requestValue)],
    ['invalid JSON', requestValue => rawToolCall(requestValue, '{not-json}')],
    ['no tool finish', () => [{ type: 'finish', reason: { kind: 'stop' } }] as readonly StreamChunk[]],
    ['stream throw', () => 'throw' as const],
  ] as const)('returns incomplete for %s without throwing', async (_label, script) => {
    const fixture = await portFor(script)
    await expect(fixture.port.judgeOne(input())).resolves.toStrictEqual({ kind: 'incomplete' })
  })

  it.each([
    ['wrong cutoff', 'snapshot', Object.freeze({ ...snapshot, cutoff: '2026-08-31T00:00:00.000Z' })],
    ['interest lane insufficient', 'snapshot', Object.freeze({
      ...snapshot,
      longTermInterest: Object.freeze({ ...snapshot.longTermInterest, sufficiency: Object.freeze({ status: 'insufficient' }) }),
    })],
    ['malformed fact', 'snapshot', Object.freeze({
      ...snapshot,
      existingKnowledge: Object.freeze({
        ...snapshot.existingKnowledge,
        activeFacts: Object.freeze([{ ...activeFacts[1], scope: Object.freeze({}) }]),
      }),
    })],
    ['malformed candidate', 'candidate', Object.freeze({ ...candidate, body: '' })],
  ] as const)('prevalidates %s before stream', async (_label, target, value) => {
    const fixture = await portFor(requestValue => toolCall(requestValue, {
      kind: 'judgment', longTermValue: 'pass', longTermInterestMatch: 'pass', informationIncrement: 'pass',
    }))
    const badInput = target === 'candidate' ? input({ candidate: value as never }) : input({ snapshot: value as never })
    await expect(fixture.port.judgeOne(badInput)).resolves.toStrictEqual({ kind: 'incomplete' })
    expect(fixture.ctx.llm.stream).not.toHaveBeenCalled()
  })

  it('prevalidates an aborted caller signal before stream', async () => {
    const fixture = await portFor(requestValue => toolCall(requestValue, {
      kind: 'judgment', longTermValue: 'pass', longTermInterestMatch: 'pass', informationIncrement: 'pass',
    }))
    const controller = new AbortController()
    controller.abort(new Error('caller aborted'))
    await expect(fixture.port.judgeOne(input({ signal: controller.signal }))).resolves.toStrictEqual({ kind: 'incomplete' })
    expect(fixture.ctx.llm.stream).not.toHaveBeenCalled()
  })

  it('returns incomplete on timeout and aborts the one model request', async () => {
    const fixture = await portFor(() => 'hang', 10)
    await expect(fixture.port.judgeOne(input())).resolves.toStrictEqual({ kind: 'incomplete' })
    expect(fixture.ctx.llm.stream).toHaveBeenCalledOnce()
    expect(fixture.signal()?.aborted).toBe(true)
  })
})
