import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CandidateFactAssessmentAgentError,
  ProductionCandidateFactAssessmentPort,
  SUBMIT_X_CRON_ASSESSMENT,
  type AssessmentAgentPrimeSuccess,
  type AssessmentWireRequest,
} from '../src/x-cron/assessment-agent.ts'
import type { CandidateFactAssessmentRequest } from '../src/fact-projection/contracts.ts'
import type {
  NavigationItem,
  NavigationSnapshot,
  Sha256Digest,
} from '../src/trusted-facts/navigation-contract.ts'

const sourceRevision = 'sha256:revision-lane3' as Sha256Digest
const candidate = {
  id: 'target:relevant',
  content: 'candidate body',
  source: 'https://x.com/example/status/101',
} as const
const budget = {
  maxInlineFacts: 4,
  maxLookupTickets: 4,
  maxSerializedBytes: 20_000,
} as const
const contexts: Context[] = []

function navigationItem(
  locatorId: string,
  options: { readonly targetId?: string; readonly source?: string; readonly topic?: string } = {},
): NavigationItem {
  const targetId = options.targetId ?? locatorId
  const source = options.source ?? `https://x.com/other/status/${locatorId.replace(/\D/g, '') || '1'}`
  return {
    schemaVersion: 1,
    kind: 'trusted-fact-navigation',
    origin: 'machine-derived',
    derivation: { method: 'test', version: '1' },
    locator: {
      schemaVersion: 1,
      locatorId,
      persistence: {
        sourceKind: 'trusted-fact-repository',
        sourceKey: 'trusted-facts.jsonl',
        lineNumber: Number(locatorId.replace(/\D/g, '')) || 1,
        canonicalDigest: `sha256:digest-${locatorId.replace(/\D/g, '') || '1'}`,
      },
    },
    hints: {
      topics: [options.topic ?? `topic:${locatorId}`],
      targetRefs: [{ targetId, canonicalSource: source }],
      dimension: 'content_value',
      relations: [{ kind: 'about-target', targetId }],
    },
  }
}

function snapshot(items: readonly NavigationItem[]): NavigationSnapshot {
  return { schemaVersion: 1, sourceRevision, items }
}

function request(
  navigation: readonly NavigationItem[],
  overrides: Partial<CandidateFactAssessmentRequest> = {},
): CandidateFactAssessmentRequest {
  return { candidate, navigation, budget, ...overrides }
}

function decision(locatorId: string, reason = 'semantic assessment'): Record<string, unknown> {
  return {
    locatorId,
    relevance: 'high',
    essentiality: 'inline_priority',
    priority: 1,
    reason,
  }
}

function assessmentResponse(
  callId: string,
  locatorIds: readonly string[],
): StreamChunk[] {
  const args = JSON.stringify({ decisions: locatorIds.map(locatorId => decision(locatorId)) })
  const call = CallId(callId)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: call, name: SUBMIT_X_CRON_ASSESSMENT, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: call, name: SUBMIT_X_CRON_ASSESSMENT, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function parseSegmentLocatorIds(wire: GenerateOptions): readonly string[] {
  const message = wire.messages[0]
  if (message === undefined || message.content.length !== 1 || message.content[0]?.type !== 'text') {
    throw new Error('assessment wire message is not the expected JSON envelope')
  }
  const material = JSON.parse(message.content[0].text.slice(message.content[0].text.indexOf('\n') + 1)) as { navigation: readonly { locator: { locatorId: string } }[] }
  return material.navigation.map(item => item.locator.locatorId)
}

type WireScript = StreamChunk[] | ((request: GenerateOptions) => StreamChunk[]) | 'hang' | 'throw'

class WireAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly script: WireScript[]

  constructor(script: WireScript[]) {
    super()
    this.script = script
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const response = this.script.shift()
    if (response === undefined) throw new Error('wire adapter script exhausted')
    if (response === 'throw') throw new Error('wire adapter stream failed')
    if (response === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => reject(new Error('wire adapter aborted'))
        if (request.signal?.aborted) {
          abort()
          return
        }
        request.signal?.addEventListener('abort', abort, { once: true })
      })
      return
    }
    const chunks = typeof response === 'function' ? response(request) : response
    for (const chunk of chunks) yield chunk
  }
}

async function harness(adapter: WireAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'wire-test', model: 'wire-model' })
  ctx.llm.registerAdapter(['wire-test'], adapter)
  return ctx
}

function modelSelection(): { readonly provider: string; readonly model: string } {
  return { provider: 'wire-test', model: 'wire-model' }
}

function firstNavigation(): NavigationItem[] {
  return [navigationItem('locator:1', {
    targetId: candidate.id,
    source: candidate.source,
    topic: 'topic:relevant',
  }), navigationItem('locator:2')]
}

function twoRelevantNavigation(): NavigationItem[] {
  return [
    navigationItem('locator:1', {
      targetId: candidate.id,
      source: candidate.source,
      topic: 'first-segment-marker',
    }),
    navigationItem('locator:3', {
      targetId: candidate.id,
      source: candidate.source,
      topic: 'second-segment-marker',
    }),
  ]
}

function wireProjection(wire: AssessmentWireRequest): Omit<AssessmentWireRequest, 'sessionId'> {
  const { sessionId: _sessionId, ...projected } = wire
  return projected
}

function wireText(wire: AssessmentWireRequest): string {
  const block = wire.messages[0]?.content[0]
  if (block?.type !== 'text') throw new Error('assessment wire message is not text')
  return block.text
}

async function disposeContexts(): Promise<void> {
  while (contexts.length > 0) await contexts.pop()?.fiber.dispose()
}

afterEach(async () => {
  await disposeContexts()
})

describe('production X cron candidate assessment adapter', () => {
  it('reports readiness failures without creating an Agent or sending a wire', async () => {
    const missingServices = new ProductionCandidateFactAssessmentPort(
      {} as Context,
      snapshot([]),
      { modelSelection: modelSelection() },
    )
    expect(missingServices.checkReadiness()).toMatchObject({
      ready: false,
      message: expect.stringContaining('agents'),
    })

    const noRouteContext = {
      agents: { create: vi.fn() },
      sessions: { flush: vi.fn() },
      systemPrompt: {
        section: vi.fn(),
        suppressRuntimeContext: vi.fn(),
        assemble: vi.fn(),
      },
      tools: {
        restrict: vi.fn(),
        presentAs: vi.fn(),
        register: vi.fn(),
        schemas: vi.fn(),
      },
      on: vi.fn(),
    } as unknown as Context
    const noRoute = new ProductionCandidateFactAssessmentPort(noRouteContext, snapshot([]))
    expect(noRoute.checkReadiness()).toMatchObject({
      ready: false,
      message: expect.stringContaining('model'),
    })

    const adapter = new WireAdapter([])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const ready = new ProductionCandidateFactAssessmentPort(ctx, snapshot([]), {
      modelSelection: modelSelection(),
    })
    expect(ready.checkReadiness()).toEqual({ ready: true })
    expect(adapter.requests).toHaveLength(0)
  })

  it('runs each segment in a fresh clean Agent and returns an exact audit cache', async () => {
    const adapter = new WireAdapter([request => assessmentResponse('assessment-1', parseSegmentLocatorIds(request))])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const lifecycle: string[] = []
    ctx.on('session/flush', session => { lifecycle.push(`flush:${session.id}`) })
    ctx.on('agent/disposed', ({ agent }) => { lifecycle.push(`dispose:${agent.id}`) })
    const port = new ProductionCandidateFactAssessmentPort(ctx, snapshot(firstNavigation()), {
      modelSelection: modelSelection(),
      maxItemsPerSegment: 1,
    })

    const result = await port.prime(request(firstNavigation()))

    expect(result.kind).toBe('ready')
    const ready = result as AssessmentAgentPrimeSuccess
    expect(ready.assessment.audit.decisions).toHaveLength(2)
    expect(ready.assessment.audit.decisions.find(item => item.locatorId === 'locator:2')).toMatchObject({
      relevance: 'unrelated',
      essentiality: 'lookup_only',
      priority: 0,
      reason: 'neutral-key-closure-miss',
    })
    expect(adapter.requests).toHaveLength(1)
    expect(ready.wires).toHaveLength(1)
    expect(ready.wires[0]?.sessionId).toMatch(/^session-x-assessment-/u)
    expect(ready.wires[0]?.system).toContain('两阶段')
    expect(ready.wires[0]?.tools?.map(tool => tool.name)).toEqual([SUBMIT_X_CRON_ASSESSMENT])
    expect(JSON.stringify(ready.wires[0])).not.toContain('ordinary-long-session')
    expect(lifecycle).toEqual([
      `flush:${ready.wires[0]?.sessionId}`,
      `dispose:${ready.wires[0]?.sessionId}`,
    ])
    expect(port.assess(request(firstNavigation()))).toEqual(ready.assessment)
    expect(adapter.requests).toHaveLength(1)
    expect(wireProjection(ready.wires[0]!)).toEqual(wireProjection(ready.wires[0]!))
  })

  it('continues segment failures and never publishes a partial cache', async () => {
    const items = [
      navigationItem('locator:1', { targetId: candidate.id, source: candidate.source }),
      navigationItem('locator:3', { targetId: candidate.id, source: candidate.source }),
    ]
    const adapter = new WireAdapter([
      () => assessmentResponse('bad-1', ['locator:1', 'locator:3']),
      request => assessmentResponse('good-2', parseSegmentLocatorIds(request)),
    ])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const port = new ProductionCandidateFactAssessmentPort(ctx, snapshot(items), {
      modelSelection: modelSelection(),
      maxItemsPerSegment: 1,
    })
    const invalid = await port.prime(request(items)).catch(error => error)
    expect(invalid).toBeInstanceOf(CandidateFactAssessmentAgentError)
    expect(invalid).toMatchObject({ code: 'invalid-submission' })
    expect(adapter.requests).toHaveLength(2)
    expect(port.assess(request(items))).toMatchObject({ kind: 'projection-failure' })
  })

  it('fails closed for text-only invalid output without creating a second wire', async () => {
    const adapter = new WireAdapter([[
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'not a structured assessment' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'not a structured assessment' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const port = new ProductionCandidateFactAssessmentPort(ctx, snapshot(firstNavigation()), { modelSelection: modelSelection() })

    await expect(port.prime(request(firstNavigation()))).rejects.toMatchObject({ code: 'invalid-submission' })
    expect(adapter.requests).toHaveLength(1)
  })

  it('cancels real hanging stream on timeout and on external abort, then disposes', async () => {
    const adapter = new WireAdapter(['hang', 'hang'])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const port = new ProductionCandidateFactAssessmentPort(ctx, snapshot(firstNavigation()), {
      modelSelection: modelSelection(),
      timeoutMs: 20,
    })

    await expect(port.prime(request(firstNavigation()))).rejects.toMatchObject({ code: 'timeout' })
    const controller = new AbortController()
    const aborted = port.prime(request(firstNavigation()), { signal: controller.signal })
    setTimeout(() => controller.abort(new Error('caller aborted')), 5)
    await expect(aborted).rejects.toMatchObject({ code: 'aborted' })
    expect(adapter.requests).toHaveLength(2)
  })

  it('stops after an external abort and never creates the next segment Agent', async () => {
    const navigation = twoRelevantNavigation()
    const adapter = new WireAdapter(['hang', request => assessmentResponse('never', parseSegmentLocatorIds(request))])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const create = vi.spyOn(ctx.agents, 'create')
    const port = new ProductionCandidateFactAssessmentPort(ctx, snapshot(navigation), {
      modelSelection: modelSelection(),
      maxItemsPerSegment: 1,
      timeoutMs: 1_000,
    })
    const controller = new AbortController()
    const pending = port.prime(request(navigation), { signal: controller.signal })

    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    controller.abort(new Error('caller aborted first segment'))

    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(adapter.requests).toHaveLength(1)
    expect(port.assess(request(navigation))).toMatchObject({ kind: 'projection-failure' })
  })

  it('stops after a real timeout and never creates the next segment Agent', async () => {
    const navigation = twoRelevantNavigation()
    const adapter = new WireAdapter(['hang', request => assessmentResponse('never', parseSegmentLocatorIds(request))])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const create = vi.spyOn(ctx.agents, 'create')
    const port = new ProductionCandidateFactAssessmentPort(ctx, snapshot(navigation), {
      modelSelection: modelSelection(),
      maxItemsPerSegment: 1,
      timeoutMs: 20,
    })

    await expect(port.prime(request(navigation))).rejects.toMatchObject({ code: 'timeout' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(adapter.requests).toHaveLength(1)
    expect(port.assess(request(navigation))).toMatchObject({ kind: 'projection-failure' })
  })

  it('keeps genuinely related segments isolated across fresh Agents', async () => {
    const navigation = twoRelevantNavigation()
    const adapter = new WireAdapter([
      request => assessmentResponse('segment-1', parseSegmentLocatorIds(request)),
      request => assessmentResponse('segment-2', parseSegmentLocatorIds(request)),
    ])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const lifecycle: string[] = []
    ctx.on('session/flush', session => { lifecycle.push(`flush:${session.id}`) })
    ctx.on('agent/disposed', ({ agent }) => { lifecycle.push(`dispose:${agent.id}`) })
    const port = new ProductionCandidateFactAssessmentPort(ctx, snapshot(navigation), {
      modelSelection: modelSelection(),
      maxItemsPerSegment: 1,
    })

    const result = await port.prime(request(navigation))

    expect(result.segments).toHaveLength(2)
    expect(result.wires).toHaveLength(2)
    const sessionIds = result.wires.map(wire => wire.sessionId)
    expect(new Set(sessionIds).size).toBe(2)
    expect(result.wires.every(wire => wire.messages.length === 1)).toBe(true)
    expect(wireText(result.wires[0]!)).toContain('first-segment-marker')
    expect(wireText(result.wires[0]!)).not.toContain('second-segment-marker')
    expect(wireText(result.wires[1]!)).toContain('second-segment-marker')
    expect(wireText(result.wires[1]!)).not.toContain('first-segment-marker')
    expect(lifecycle).toEqual([
      `flush:${sessionIds[0]}`,
      `dispose:${sessionIds[0]}`,
      `flush:${sessionIds[1]}`,
      `dispose:${sessionIds[1]}`,
    ])
  })

  it('keeps recalled wires invariant when irrelevant navigation grows 100x', async () => {
    const relevant = firstNavigation()[0]!
    const small = [relevant, firstNavigation()[1]!] as NavigationItem[]
    const large = [
      ...small,
      ...Array.from({ length: 198 }, (_, index) => navigationItem(`locator:noise-${index + 3}`)),
    ]
    const firstAdapter = new WireAdapter([request => assessmentResponse('same', parseSegmentLocatorIds(request))])
    const firstCtx = await harness(firstAdapter)
    contexts.push(firstCtx)
    const first = await new ProductionCandidateFactAssessmentPort(firstCtx, snapshot(small), {
      modelSelection: modelSelection(),
    }).prime(request(small))

    const secondAdapter = new WireAdapter([request => assessmentResponse('same', parseSegmentLocatorIds(request))])
    const secondCtx = await harness(secondAdapter)
    contexts.push(secondCtx)
    const second = await new ProductionCandidateFactAssessmentPort(secondCtx, snapshot(large), {
      modelSelection: modelSelection(),
    }).prime(request(large))

    expect(first.kind).toBe('ready')
    expect(second.kind).toBe('ready')
    if (first.kind !== 'ready' || second.kind !== 'ready') return
    expect(first.segments).toEqual(second.segments)
    expect(first.wires.map(wire => wireProjection(wire))).toEqual(second.wires.map(wire => wireProjection(wire)))
    expect(first.assessment.audit.decisions).toHaveLength(2)
    expect(second.assessment.audit.decisions).toHaveLength(200)
    expect(second.wires).toHaveLength(first.wires.length)
  })

  it('allows empty exact recall without opening an assessment Agent', async () => {
    const adapter = new WireAdapter([])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const port = new ProductionCandidateFactAssessmentPort(ctx, snapshot(firstNavigation()), {
      modelSelection: modelSelection(),
    })
    const noHit = request(firstNavigation(), {
      candidate: {
        ...candidate,
        id: 'target:absent',
        source: 'https://x.com/absent/status/999',
      },
    })

    const result = await port.prime(noHit)

    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    expect(result.wires).toEqual([])
    expect(result.segments).toEqual([])
    expect(result.assessment.audit.decisions.every(decision => decision.reason === 'neutral-key-closure-miss')).toBe(true)
    expect(adapter.requests).toHaveLength(0)
  })

  it('grows only when an exact neutral key recalls another locator', async () => {
    const related = navigationItem('locator:3', { targetId: candidate.id, source: candidate.source })
    const base = firstNavigation()
    const adapter = new WireAdapter([
      request => assessmentResponse('base', parseSegmentLocatorIds(request)),
      request => assessmentResponse('grown-1', parseSegmentLocatorIds(request)),
      request => assessmentResponse('grown-2', parseSegmentLocatorIds(request)),
    ])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const basePort = new ProductionCandidateFactAssessmentPort(ctx, snapshot(base), {
      modelSelection: modelSelection(),
      maxItemsPerSegment: 1,
    })
    const grownPort = new ProductionCandidateFactAssessmentPort(ctx, snapshot([...base, related]), {
      modelSelection: modelSelection(),
      maxItemsPerSegment: 1,
    })
    const first = await basePort.prime(request(base))
    const second = await grownPort.prime(request([...base, related]))

    expect(first.kind).toBe('ready')
    expect(second.kind).toBe('ready')
    expect(adapter.requests).toHaveLength(3)
    if (first.kind !== 'ready' || second.kind !== 'ready') return
    expect(second.segments.length).toBeGreaterThan(first.segments.length)
    expect(second.segments.flatMap(segment => segment.locatorIds)).toContain('locator:3')
  })

  it('rejects dimension-only or exact-cache-mismatched requests before any wire', async () => {
    const adapter = new WireAdapter([])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const port = new ProductionCandidateFactAssessmentPort(ctx, snapshot(firstNavigation()), { modelSelection: modelSelection() })
    const dimensionOnly = request(firstNavigation(), {
      candidate: { ...candidate, id: '\u0001', source: 'not-a-canonical-status-url' },
    })
    await expect(port.prime(dimensionOnly)).rejects.toMatchObject({
      code: 'recall-failure',
      failure: { recallCode: 'needs-explicit-recall-key' },
    })
    expect(adapter.requests).toHaveLength(0)

    const withNoHit = request(firstNavigation(), {
      candidate: { ...candidate, id: 'target:absent', source: 'https://x.com/absent/status/999' },
    })
    await port.prime(withNoHit)
    expect(port.assess(request(firstNavigation()))).toMatchObject({ kind: 'projection-failure' })
    expect(adapter.requests).toHaveLength(0)
  })

  it('fails before wire when a creation listener contaminates the clean surface', async () => {
    const adapter = new WireAdapter([request => assessmentResponse('never', parseSegmentLocatorIds(request))])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    ctx.on('agent/created', ({ agent }) => {
      agent.ctx.systemPrompt.section({ name: 'polluted-assessment-prompt', order: -2_000, text: 'pollution', complete: true })
      agent.ctx.tools.register({
        name: 'polluted_assessment_tool',
        description: 'pollution',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'pollution' }] },
        execute: async () => 'pollution',
      } satisfies ToolDefinition)
    })
    const port = new ProductionCandidateFactAssessmentPort(ctx, snapshot(firstNavigation()), { modelSelection: modelSelection() })

    await expect(port.prime(request(firstNavigation()))).rejects.toMatchObject({ code: 'surface-contaminated' })
    expect(adapter.requests).toHaveLength(0)
  })

  it('aggregates cleanup failures while still attempting cancel, idle, flush, and dispose', async () => {
    const adapter = new WireAdapter([request => assessmentResponse('cleanup', parseSegmentLocatorIds(request))])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const flush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('flush failed'))
    const originalCreate = ctx.agents.create.bind(ctx.agents)
    const dispose = vi.fn()
    const cancel = vi.fn(() => { throw new Error('cancel failed') })
    const idle = vi.fn()
    vi.spyOn(ctx.agents, 'create').mockImplementation(async options => {
      const handle = await originalCreate(options)
      const originalDispose = handle.dispose.bind(handle)
      const originalWhenIdle = handle.agent.whenIdle.bind(handle.agent)
      const cancelSpy = vi.spyOn(handle.agent, 'cancel').mockImplementation(cancel)
      const idleSpy = vi.spyOn(handle.agent, 'whenIdle').mockImplementation(async () => {
        if (idle.mock.calls.length === 0) {
          idle()
          return originalWhenIdle()
        }
        idle()
        throw new Error('idle failed')
      })
      const statusSpy = vi.spyOn(handle.agent, 'status', 'get').mockReturnValue('running')
      dispose.mockImplementationOnce(async () => {
        cancelSpy.mockRestore()
        idleSpy.mockRestore()
        statusSpy.mockRestore()
        await originalDispose()
        throw new Error('dispose failed')
      })
      return { agent: handle.agent, dispose: () => dispose() }
    })
    const port = new ProductionCandidateFactAssessmentPort(ctx, snapshot(firstNavigation()), { modelSelection: modelSelection() })

    await expect(port.prime(request(firstNavigation()))).rejects.toMatchObject({ code: 'cleanup-failed' })
    expect(flush).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(idle).toHaveBeenCalledTimes(2)
  })
})
