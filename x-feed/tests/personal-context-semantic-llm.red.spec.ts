import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {
  PersonalContextActiveFact,
  PersonalContextAttitude,
  PersonalContextCanonicalRevision,
  PersonalContextClassifierInput,
  PersonalContextEntailmentInput,
  PersonalContextFactProposal,
  PersonalContextNoFactInput,
  PersonalContextProtectedSpans,
  PersonalContextSemanticPorts,
  PersonalContextTerminalEvidence,
} from '@herman/personal-feed'
import { createPersonalContextOwner } from '@herman/personal-feed'

type SemanticPortsWithAbort = PersonalContextSemanticPorts & {
  readonly classifier: (input: PersonalContextClassifierInput, signal?: AbortSignal) => Promise<unknown> | unknown
  readonly entailmentValidator: (input: PersonalContextEntailmentInput, signal?: AbortSignal) => Promise<unknown> | unknown
  readonly noFactValidator: (input: PersonalContextNoFactInput, signal?: AbortSignal) => Promise<unknown> | unknown
}
type Factory = (options: {
  readonly ctx: { readonly llm: { readonly stream: (request: GenerateOptions) => AsyncIterable<StreamChunk> } }
  readonly provider: string
  readonly model: string
  readonly timeoutMs?: number
}) => SemanticPortsWithAbort

const authorization = Object.freeze({
  policyId: 'personal-feed-direct-telegram-v1' as const,
  purpose: 'personal_feed_context' as const,
  sourceKind: 'telegram_inbound' as const,
})
const attitude: PersonalContextAttitude = Object.freeze({
  speaker: 'user', polarity: 'affirmed', modality: 'committed', attribution: 'own_statement',
  temporal: 'current', qualification: 'unqualified',
})
const spans: PersonalContextProtectedSpans = Object.freeze({
  subject: [], polarity: [], conditions: [], modality: [], attribution: [], temporal: [], applicability: [],
})
const evidence: PersonalContextTerminalEvidence = Object.freeze({
  sourceKey: 'telegram:7:11',
  evidenceSpan: { startUtf16: 0, endUtf16: 28 },
  exactEvidenceText: '我长期关注可靠的软件设计，并且知道 SQLite 事务。',
  focusSpanWithinEvidence: { startUtf16: 5, endUtf16: 12 },
  protectedSpansWithinEvidence: spans,
  attitude,
})
const activeFacts: readonly PersonalContextActiveFact[] = Object.freeze([
  Object.freeze({
    factId: 'interest-1',
    fact: Object.freeze({ lane: 'long_term_interest', stance: 'include', evidence, useAuthorization: authorization }),
    basisRevisionIds: ['rev-1'],
  }),
  Object.freeze({
    factId: 'knowledge-1',
    fact: Object.freeze({ lane: 'existing_knowledge', epistemic: 'asserted', evidence, useAuthorization: authorization }),
    basisRevisionIds: ['rev-2'],
  }),
])
const classifierInput: PersonalContextClassifierInput = Object.freeze({
  sourceKey: 'telegram:7:11',
  rawText: '我长期关注可靠的软件设计，并且知道 SQLite 事务。',
  useAuthorization: authorization,
  activeFacts,
})
const canonicalFact = Object.freeze({ lane: 'long_term_interest' as const, stance: 'include' as const, attitude })
const revision: PersonalContextCanonicalRevision = Object.freeze({ operation: 'assert', targetFacts: [], priorActiveFacts: activeFacts })
const entailmentInput: PersonalContextEntailmentInput = Object.freeze({
  fullRawText: classifierInput.rawText,
  evidenceSpan: evidence.evidenceSpan,
  exactEvidenceText: evidence.exactEvidenceText,
  target: { focusSpanWithinEvidence: evidence.focusSpanWithinEvidence, exactFocusText: '可靠的软件设计', protectedSpansWithinEvidence: spans },
  canonicalFact,
  revision,
})
const noFactInput: PersonalContextNoFactInput = Object.freeze({
  fullRawText: classifierInput.rawText,
  proposedReason: 'not_personal_fact',
  useAuthorization: authorization,
})

const contexts: Array<{ readonly dispose?: () => unknown }> = []

async function loadFactory(): Promise<Factory> {
  const module = await import('../src/personal-feed/personal-context-semantic-llm.ts') as {
    readonly createPersonalContextSemanticLlmPorts?: Factory
  }
  if (typeof module.createPersonalContextSemanticLlmPorts !== 'function') {
    throw new Error('personal context semantic LLM ports are unavailable')
  }
  return module.createPersonalContextSemanticLlmPorts
}

function toolCallChunks(request: GenerateOptions, values: readonly unknown[], finish = 'tool-calls'): StreamChunk[] {
  return values.flatMap((value, index) => {
    const name = request.tools?.[0]?.name ?? 'submit-personal-context'
    const encoded = JSON.stringify(value)
    const callId = CallId(`semantic-call-${index + 1}`)
    return [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: encoded },
      { type: 'block-end', index, block: { type: 'tool-call', id: callId, name, arguments: encoded } },
    ]
  }).concat({ type: 'finish', reason: { kind: finish } })
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function makeContext(script: (request: GenerateOptions) => readonly StreamChunk[]) {
  const requests: GenerateOptions[] = []
  const ctx = {
    llm: {
      stream: vi.fn(async function* (request: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(request)
        for (const chunk of script(request)) yield chunk
      }),
    },
  }
  contexts.push({ dispose: () => undefined })
  return { ctx, requests }
}

type JsonSchema = {
  readonly type?: string
  readonly additionalProperties?: boolean
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: readonly string[]
  readonly oneOf?: readonly JsonSchema[]
  readonly items?: JsonSchema
  readonly minItems?: number
  readonly uniqueItems?: boolean
  readonly const?: string
  readonly enum?: readonly string[]
}

function expectClosedObject(
  schema: JsonSchema | undefined,
  properties: readonly string[],
  required: readonly string[],
): Readonly<Record<string, JsonSchema>> {
  expect(schema?.type).toBe('object')
  expect(schema?.additionalProperties).toBe(false)
  expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([...properties].sort())
  expect([...(schema?.required ?? [])].sort()).toEqual([...required].sort())
  return schema?.properties ?? {}
}

function expectStringEnum(schema: JsonSchema | undefined, values: readonly string[]): void {
  expect(schema?.type).toBe('string')
  expect([...(schema?.enum ?? [])].sort()).toEqual([...values].sort())
}

function expectSpanSchema(schema: JsonSchema | undefined): void {
  const properties = expectClosedObject(schema, ['startUtf16', 'endUtf16'], ['startUtf16', 'endUtf16'])
  expect(properties.startUtf16?.type).toBe('integer')
  expect(properties.endUtf16?.type).toBe('integer')
}

function expectProtectedSpansSchema(schema: JsonSchema | undefined): void {
  const keys = ['subject', 'polarity', 'conditions', 'modality', 'attribution', 'temporal', 'applicability'] as const
  const properties = expectClosedObject(schema, keys, keys)
  for (const key of keys) {
    expect(properties[key]?.type).toBe('array')
    expectSpanSchema(properties[key]?.items)
  }
}

function expectAttitudeSchema(schema: JsonSchema | undefined): void {
  const keys = ['speaker', 'polarity', 'modality', 'attribution', 'temporal', 'qualification'] as const
  const properties = expectClosedObject(schema, keys, keys)
  expectStringEnum(properties.speaker, ['user', 'other', 'ambiguous'])
  expectStringEnum(properties.polarity, ['affirmed', 'denied'])
  expectStringEnum(properties.modality, ['committed', 'uncertain', 'hypothetical'])
  expectStringEnum(properties.attribution, ['own_statement', 'reported_statement', 'mere_mention'])
  expectStringEnum(properties.temporal, ['current', 'future', 'past', 'unspecified'])
  expectStringEnum(properties.qualification, ['unqualified', 'conditioned', 'scope_limited'])
}

function expectFactBranch(
  schema: JsonSchema | undefined,
  lane: 'long_term_interest' | 'existing_knowledge',
  laneField: 'stance' | 'epistemic',
  laneValues: readonly string[],
  activeFactId: string,
): void {
  const common = ['lane', 'focusSpan', 'protectedSpans', 'attitude', 'operation', 'targetFactIds'] as const
  const keys = [...common, laneField]
  const properties = expectClosedObject(schema, keys, keys)
  expect(properties.lane).toMatchObject({ type: 'string', const: lane })
  expectStringEnum(properties[laneField], laneValues)
  expectSpanSchema(properties.focusSpan)
  expectProtectedSpansSchema(properties.protectedSpans)
  expectAttitudeSchema(properties.attitude)
  expectStringEnum(properties.operation, ['assert', 'confirm', 'correct', 'replace', 'retract'])
  expect(properties.targetFactIds?.type).toBe('array')
  expect(properties.targetFactIds?.uniqueItems).toBe(true)
  expectStringEnum(properties.targetFactIds?.items, [activeFactId])
}

function expectStrictClassifierTool(request: GenerateOptions): void {
  expect(request.tools).toHaveLength(1)
  const parameters = request.tools?.[0]?.parameters as JsonSchema
  expect(parameters.oneOf).toHaveLength(2)
  const factsBranch = parameters.oneOf?.find(schema => schema.properties?.kind?.const === 'facts')
  const noFactBranch = parameters.oneOf?.find(schema => schema.properties?.kind?.const === 'no_fact')

  const factsProperties = expectClosedObject(factsBranch, ['kind', 'facts'], ['kind', 'facts'])
  expect(factsProperties.kind).toMatchObject({ type: 'string', const: 'facts' })
  expect(factsProperties.facts?.type).toBe('array')
  expect(factsProperties.facts?.minItems).toBe(1)
  expect(factsProperties.facts?.items?.oneOf).toHaveLength(2)
  const interestBranch = factsProperties.facts?.items?.oneOf?.find(schema => schema.properties?.lane?.const === 'long_term_interest')
  const knowledgeBranch = factsProperties.facts?.items?.oneOf?.find(schema => schema.properties?.lane?.const === 'existing_knowledge')
  expectFactBranch(interestBranch, 'long_term_interest', 'stance', ['include', 'exclude'], 'interest-1')
  expectFactBranch(knowledgeBranch, 'existing_knowledge', 'epistemic', ['asserted', 'uncertain'], 'knowledge-1')

  const noFactProperties = expectClosedObject(noFactBranch, ['kind', 'reason'], ['kind', 'reason'])
  expect(noFactProperties.kind).toMatchObject({ type: 'string', const: 'no_fact' })
  expectStringEnum(noFactProperties.reason, [
    'not_personal_fact',
    'insufficient_long_term_signal',
    'object_feedback_without_long_term_scope',
    'not_concrete_proposition',
    'reported_or_mentioned',
    'hypothetical_only',
  ])
}

function expectSingleUserText(request: GenerateOptions): string {
  expect(request.messages).toHaveLength(1)
  const message = request.messages[0] as { readonly role?: unknown; readonly content?: readonly unknown[] } | undefined
  expect(message?.role).toBe('user')
  expect(message?.content).toHaveLength(1)
  const block = message?.content?.[0] as { readonly type?: unknown; readonly text?: unknown } | undefined
  expect(block?.type).toBe('text')
  expect(typeof block?.text).toBe('string')
  if (typeof block?.text !== 'string') throw new Error('user text block is unavailable')
  return block.text
}

function expectStrictSubmissionTool(request: GenerateOptions, properties: readonly string[], required: readonly string[]): void {
  expect(request.tools).toHaveLength(1)
  const parameters = request.tools?.[0]?.parameters as {
    readonly type?: unknown
    readonly additionalProperties?: unknown
    readonly properties?: Record<string, unknown>
    readonly required?: readonly string[]
  }
  expect(parameters.type).toBe('object')
  expect(parameters.additionalProperties).toBe(false)
  expect(Object.keys(parameters.properties ?? {}).sort()).toEqual([...properties].sort())
  expect([...(parameters.required ?? [])].sort()).toEqual([...required].sort())
}

afterEach(() => {
  vi.restoreAllMocks()
  contexts.splice(0)
})

describe('Personal Context semantic LLM adapter (RED)', () => {
  it('uses one direct stream per classifier call with one system, one user, and one strict submission tool', async () => {
    const factory = await loadFactory()
    const { ctx, requests } = makeContext(request => toolCallChunks(request, [{ kind: 'no_fact', reason: 'not_personal_fact' }]))
    const ports = factory({ ctx, provider: 'wire-test', model: 'wire-model' })

    await expect(ports.classifier(classifierInput)).resolves.toEqual({ kind: 'no_fact', reason: 'not_personal_fact' })
    expect(ctx.llm.stream).toHaveBeenCalledOnce()
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.sessionId).toBeUndefined()
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]).toMatchObject({ role: 'user' })
    expect(request.system).toEqual(expect.any(String))
    expectStrictClassifierTool(request)
    const userText = expectSingleUserText(request)
    expect(userText).toBe(JSON.stringify(classifierInput))
    expect(JSON.parse(userText)).toEqual(classifierInput)
  })

  it('returns exact facts/no_fact DTOs and rejects extra keys, generated fact strings, bad spans, and non-active or cross-lane targets', async () => {
    const factory = await loadFactory()
    const validFact: PersonalContextFactProposal = {
      lane: 'long_term_interest', stance: 'include', focusSpan: { startUtf16: 5, endUtf16: 12 },
      protectedSpans: spans, attitude, operation: 'assert', targetFactIds: [],
    }
    const validSameLaneConfirmation: PersonalContextFactProposal = {
      lane: 'long_term_interest', stance: 'include', focusSpan: { startUtf16: 5, endUtf16: 12 },
      protectedSpans: spans, attitude, operation: 'confirm', targetFactIds: ['interest-1'],
    }
    const structurallyValidCrossLaneTarget: PersonalContextFactProposal = {
      lane: 'existing_knowledge', epistemic: 'asserted', focusSpan: { startUtf16: 5, endUtf16: 12 },
      protectedSpans: spans, attitude, operation: 'confirm', targetFactIds: ['interest-1'],
    }
    const cases: Array<{ readonly value: unknown; readonly accepted: boolean }> = [
      { value: { kind: 'facts', facts: [validFact] }, accepted: true },
      { value: { kind: 'facts', facts: [validSameLaneConfirmation] }, accepted: true },
      { value: { kind: 'no_fact', reason: 'not_personal_fact' }, accepted: true },
      { value: { kind: 'no_fact', reason: 'not_personal_fact', extra: 'reject' }, accepted: false },
      { value: { kind: 'facts', facts: [{ ...validFact, fact: 'generated string' }] }, accepted: false },
      { value: { kind: 'facts', facts: [{ ...validFact, focusSpan: { startUtf16: -1, endUtf16: 4 } }] }, accepted: false },
      { value: { kind: 'facts', facts: [{ ...validFact, operation: 'confirm', targetFactIds: ['not-active'] }] }, accepted: false },
      { value: { kind: 'facts', facts: [structurallyValidCrossLaneTarget] }, accepted: false },
    ]
    for (const testCase of cases) {
      const { ctx } = makeContext(request => toolCallChunks(request, [testCase.value]))
      const ports = factory({ ctx, provider: 'wire-test', model: 'wire-model' })
      if (testCase.accepted) await expect(ports.classifier(classifierInput)).resolves.toEqual(testCase.value)
      else await expect(ports.classifier(classifierInput)).rejects.toThrow()
    }
  })

  it('maps strict entailment/no-fact decisions to exact owner-facing results while preserving every owner input field', async () => {
    const factory = await loadFactory()
    const cases: Array<{ readonly port: 'entailmentValidator' | 'noFactValidator'; readonly input: PersonalContextEntailmentInput | PersonalContextNoFactInput; readonly decision: unknown; readonly result: unknown }> = [
      { port: 'entailmentValidator', input: entailmentInput, decision: { decision: 'confirmed' }, result: { kind: 'target_and_revision_confirmed' } },
      { port: 'entailmentValidator', input: entailmentInput, decision: { decision: 'not_confirmed' }, result: { kind: 'not_confirmed' } },
      { port: 'noFactValidator', input: noFactInput, decision: { decision: 'confirmed' }, result: { kind: 'confirmed_no_fact' } },
      { port: 'noFactValidator', input: noFactInput, decision: { decision: 'not_confirmed' }, result: { kind: 'not_confirmed' } },
    ]
    for (const testCase of cases) {
      const { ctx, requests } = makeContext(request => toolCallChunks(request, [testCase.decision]))
      const ports = factory({ ctx, provider: 'wire-test', model: 'wire-model' })
      const actual = await ports[testCase.port](testCase.input as never)
      expect(actual).toEqual(testCase.result)
      expect(ctx.llm.stream).toHaveBeenCalledOnce()
      expect(requests).toHaveLength(1)
      expectStrictSubmissionTool(requests[0]!, ['decision'], ['decision'])
      const userText = expectSingleUserText(requests[0]!)
      expect(userText).toBe(JSON.stringify(testCase.input))
      expect(JSON.parse(userText)).toEqual(testCase.input)
    }
  })

  it('rejects extra keys, old approval values, extra tool, text, wrong finish, and wrong tool on every port', async () => {
    const factory = await loadFactory()
    const malformed: readonly ((request: GenerateOptions) => readonly StreamChunk[])[] = [
      request => toolCallChunks(request, [{ decision: 'confirmed', extra: true }]),
      request => toolCallChunks(request, [{ kind: 'target_and_revision_confirmed' }]),
      request => toolCallChunks(request, [{ decision: 'confirmed' }, { decision: 'confirmed' }]),
      () => textChunks('自由文本'),
      request => toolCallChunks(request, [{ decision: 'confirmed' }], 'stop'),
      () => [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: CallId('wrong'), name: 'wrong-tool', argumentsDelta: JSON.stringify({ decision: 'confirmed' }) },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('wrong'), name: 'wrong-tool', arguments: JSON.stringify({ decision: 'confirmed' }) } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
    ]
    for (const port of ['classifier', 'entailmentValidator', 'noFactValidator'] as const) {
      for (const script of malformed) {
        const { ctx } = makeContext(script)
        const ports = factory({ ctx, provider: 'wire-test', model: 'wire-model' })
        const portInput = port === 'classifier' ? classifierInput : port === 'entailmentValidator' ? entailmentInput : noFactInput
        await expect(ports[port](portInput as never)).rejects.toThrow()
        expect(ctx.llm.stream).toHaveBeenCalledOnce()
      }
    }
  })

  it('passes caller abort to the actual wire and aborts a hanging stream at an injected short timeout', async () => {
    const factory = await loadFactory()
    let wireSignal: AbortSignal | undefined
    let wireAbortObserved = false
    const caller = new AbortController()
    const ctx = {
      llm: {
        stream: vi.fn(async function* (request: GenerateOptions): AsyncIterable<StreamChunk> {
          wireSignal = request.signal
          await new Promise<void>((_resolve, reject) => {
            const abort = (): void => {
              wireAbortObserved = true
              reject(request.signal?.reason ?? new Error('wire aborted'))
            }
            if (request.signal?.aborted) abort()
            else request.signal?.addEventListener('abort', abort, { once: true })
          })
        }),
      },
    }
    const ports = factory({ ctx, provider: 'wire-test', model: 'wire-model', timeoutMs: 1_000 })
    const pending = ports.classifier(classifierInput, caller.signal)
    await Promise.resolve()
    caller.abort(new Error('caller aborted'))
    await expect(pending).rejects.toThrow()
    expect(ctx.llm.stream).toHaveBeenCalledOnce()
    expect(wireSignal).toBeDefined()
    expect(wireSignal?.aborted).toBe(true)
    expect(wireAbortObserved).toBe(true)

    let timeoutSignal: AbortSignal | undefined
    const timeoutCtx = {
      llm: {
        stream: vi.fn(async function* (request: GenerateOptions): AsyncIterable<StreamChunk> {
          timeoutSignal = request.signal
          await new Promise<void>((_resolve, reject) => {
            const abort = (): void => reject(request.signal?.reason ?? new Error('wire timeout'))
            if (request.signal?.aborted) abort()
            else request.signal?.addEventListener('abort', abort, { once: true })
          })
        }),
      },
    }
    const timeoutPorts = factory({ ctx: timeoutCtx, provider: 'wire-test', model: 'wire-model', timeoutMs: 5 })
    await expect(timeoutPorts.classifier(classifierInput)).rejects.toThrow()
    expect(timeoutSignal?.aborted).toBe(true)
  }, 2_000)

  it('keeps a real owner source pending with raw text intact when the semantic wire rejects, without partial terminal or revision state', async () => {
    const factory = await loadFactory()
    const { ctx } = makeContext(request => toolCallChunks(request, [{ kind: 'no_fact', reason: 'not_personal_fact', extra: 'reject' }]))
    const ports = factory({ ctx, provider: 'wire-test', model: 'wire-model' })
    const directory = mkdtempSync(join(tmpdir(), 'personal-context-semantic-owner-'))
    const owner = createPersonalContextOwner({
      databasePath: join(directory, 'personal-context.sqlite'),
      clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
      semantics: ports,
    })
    try {
      const captured = owner.capture({
        locator: { kind: 'telegram_inbound', chatId: 7, messageId: 11 },
        rawText: classifierInput.rawText,
        reference: null,
      })
      const settled = await owner.settle({ sourceKey: captured.source.sourceKey })
      expect(settled).toMatchObject({ sourceKey: captured.source.sourceKey, status: 'pending' })
      const snapshot = owner.read()
      expect(snapshot.sources[0]?.rawText).toBe(classifierInput.rawText)
      expect(snapshot.sources[0]?.reference).toBeNull()
      expect(snapshot.coverage[0]).toMatchObject({ sourceKey: captured.source.sourceKey, status: 'pending' })
      expect(snapshot.coverage[0]).not.toHaveProperty('terminalTransactionSequence')
      expect(snapshot.coverage[0]).not.toHaveProperty('dispositionDigest')
      expect(snapshot.coverage[0]).not.toHaveProperty('revisionDigest')
      expect(snapshot).toMatchObject({
        sources: [{ rawText: classifierInput.rawText, reference: null }],
        coverage: [{ sourceKey: captured.source.sourceKey, status: 'pending' }],
      })
    } finally {
      owner.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
