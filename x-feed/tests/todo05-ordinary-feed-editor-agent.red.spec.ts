import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOrdinaryFeedEditorAgent,
  type OrdinaryFeedEditorAgent,
  type OrdinaryFeedEditorAgentOptions,
  type OrdinaryFeedEditorAgentProposalPort,
  type OrdinaryFeedEditorAgentResult,
} from '../src/personal-feed/ordinary-feed-editor-agent.ts'

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value

type ExpectedAgentResult =
  | { readonly status: 'accepted'; readonly value: { readonly proposal: unknown } }
  | { readonly status: 'failed' }

type _Options = Assert<Equal<
  OrdinaryFeedEditorAgentOptions,
  {
    readonly ctx: Context
    readonly proposal: OrdinaryFeedEditorAgentProposalPort
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
  }
>>
type _OptionsKeys = Assert<Equal<
  keyof OrdinaryFeedEditorAgentOptions,
  'ctx' | 'proposal' | 'timeoutMs' | 'signal'
>>
type _ProposalKeys = Assert<Equal<
  keyof OrdinaryFeedEditorAgentProposalPort,
  'readModelMaterials' | 'validateProposal'
>>
type _RuntimeKeys = Assert<Equal<keyof OrdinaryFeedEditorAgent, 'formEditingProposal'>>
type _Result = Assert<Equal<OrdinaryFeedEditorAgentResult, ExpectedAgentResult>>
type _FactoryOptions = Assert<Equal<
  Parameters<typeof createOrdinaryFeedEditorAgent>,
  [OrdinaryFeedEditorAgentOptions]
>>
type _FactoryRuntime = Assert<Equal<
  ReturnType<typeof createOrdinaryFeedEditorAgent>,
  OrdinaryFeedEditorAgent
>>
type _MethodParameters = Assert<Equal<
  Parameters<OrdinaryFeedEditorAgent['formEditingProposal']>,
  []
>>
type _MethodResult = Assert<Equal<
  Awaited<ReturnType<OrdinaryFeedEditorAgent['formEditingProposal']>>,
  OrdinaryFeedEditorAgentResult
>>

const SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL = 'submit_x_ordinary_feed_editing_proposal'

const ORDINARY_FEED_EDITOR_SYSTEM_PROMPT = [
  '你是一次性的 X 普通 Feed 编辑 Agent。',
  '只能依据当前 user message 中的本期材料，为每个 itemId 做一次 selected 或 not_selected 决定。',
  `必须调用 ${SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL} 一次，提交严格结构化编辑提案；不要输出普通文本。`,
  'selected 项必须且只能在 sections 中出现一次；not_selected 项必须提供非空 semanticReason。',
  '不得创造 itemId，不得返回网址、候选身份、period、Raw/C37/C15/C19、探索、主题、planner 或 composer 字段，也不得调用其他工具。',
].join('\n')

const ORDINARY_FEED_EDITOR_TOOL_SCHEMA: ToolSchema = {
  name: SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL,
  description: '提交当前普通 Feed 的严格结构化编辑提案。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['highlight', 'timeline', 'wander', 'focus', 'source'] },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  itemId: { type: 'string' },
                  summary: { type: 'string' },
                },
                required: ['itemId', 'summary'],
              },
            },
          },
          required: ['kind', 'items'],
        },
      },
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            itemId: { type: 'string' },
            kind: { type: 'string', enum: ['selected', 'not_selected'] },
            semanticReason: { type: 'string' },
          },
          required: ['itemId', 'kind'],
        },
      },
    },
    required: ['title', 'sections', 'decisions'],
  },
}

const materials = [
  { itemId: 'item:x-status:1001', text: 'A target text', authorHandle: 'alice' },
  { itemId: 'item:x-status:1002', text: 'B target text', authorHandle: 'bob' },
] as const

const submission = {
  title: 'Ordinary target feed',
  sections: [{
    kind: 'highlight',
    items: [{ itemId: 'item:x-status:1001', summary: 'A target insight' }],
  }],
  decisions: [
    { itemId: 'item:x-status:1001', kind: 'selected' },
    {
      itemId: 'item:x-status:1002',
      kind: 'not_selected',
      semanticReason: 'Lower relevance for this period.',
    },
  ],
} as const

type LateStreamOutcome = 'complete' | 'tool-call' | 'reject'

interface NeverSettlingWireAdapterOptions {
  readonly respondToCancel?: boolean
  readonly lateOutcome?: LateStreamOutcome
}

function response(value: unknown): StreamChunk[] {
  const argumentsText = JSON.stringify(value)
  const callId = CallId('ordinary-feed-editor-1')
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta',
      index: 0,
      id: callId,
      name: SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL,
      argumentsDelta: argumentsText,
    },
    {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: callId,
        name: SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL,
        arguments: argumentsText,
      },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class WireAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<{
    readonly provider: string
    readonly id: string
    readonly name: string
  }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    for (const chunk of this.script.shift() ?? []) yield chunk
  }
}

class NeverSettlingWireAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly lateObserved: Promise<void>
  private releasePending: (() => void) | undefined
  private resolveLateObserved: (() => void) | undefined
  private readonly respondToCancel: boolean
  private readonly lateOutcome: LateStreamOutcome

  constructor(options: NeverSettlingWireAdapterOptions = {}) {
    super()
    this.respondToCancel = options.respondToCancel ?? false
    this.lateOutcome = options.lateOutcome ?? 'complete'
    this.lateObserved = new Promise(resolve => { this.resolveLateObserved = resolve })
  }

  override resolveModel(provider: string, model: string): Promise<{
    readonly provider: string
    readonly id: string
    readonly name: string
  }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    await new Promise<void>(resolve => {
      let settled = false
      let removeAbort: (() => void) | undefined
      const settle = (): void => {
        if (settled) return
        settled = true
        removeAbort?.()
        this.releasePending = undefined
        resolve()
      }
      this.releasePending = settle
      if (this.respondToCancel && request.signal !== undefined) {
        const onAbort = (): void => settle()
        request.signal.addEventListener('abort', onAbort, { once: true })
        removeAbort = () => request.signal?.removeEventListener('abort', onAbort)
      }
    })
    if (this.lateOutcome === 'tool-call') {
      this.resolveLateObserved?.()
      this.resolveLateObserved = undefined
      for (const chunk of response(submission).slice(1)) yield chunk
    } else if (this.lateOutcome === 'reject') {
      this.resolveLateObserved?.()
      this.resolveLateObserved = undefined
      throw new Error('late provider stream rejection')
    }
  }

  release(): void {
    this.releasePending?.()
    this.releasePending = undefined
  }
}

async function createHarness(adapter: LlmAdapter): Promise<Context> {
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

const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()?.fiber.dispose()
})

describe('TODO05 ordinary-feed editor one-shot Agent bootstrap', () => {
  it('exposes the exact frozen runtime without touching collaborators during construction', () => {
    const contextAccess = vi.fn()
    const ctx = new Proxy({}, {
      get: () => {
        contextAccess()
        throw new Error('bootstrap runtime must not use the Agent context')
      },
    }) as Context
    const proposal: OrdinaryFeedEditorAgentProposalPort = {
      readModelMaterials: vi.fn<OrdinaryFeedEditorAgentProposalPort['readModelMaterials']>(),
      validateProposal: vi.fn<OrdinaryFeedEditorAgentProposalPort['validateProposal']>(),
    }

    const runtime = createOrdinaryFeedEditorAgent({
      ctx,
      proposal,
      timeoutMs: 1,
      signal: new AbortController().signal,
    })

    expect(Object.isFrozen(runtime)).toBe(true)
    expect(Reflect.ownKeys(runtime)).toEqual(['formEditingProposal'])
    expect(contextAccess).not.toHaveBeenCalled()
    expect(proposal.readModelMaterials).not.toHaveBeenCalled()
    expect(proposal.validateProposal).not.toHaveBeenCalled()
  })

  it('forms one validated editing proposal through one isolated structured Agent request', async () => {
    const adapter = new WireAdapter([response(submission)])
    const ctx = await createHarness(adapter)
    contexts.push(ctx)
    let validatedSubmission: unknown
    const proposal: OrdinaryFeedEditorAgentProposalPort = {
      readModelMaterials: vi.fn<OrdinaryFeedEditorAgentProposalPort['readModelMaterials']>(() => ({
        status: 'accepted',
        value: { materials },
      })),
      validateProposal: vi.fn<OrdinaryFeedEditorAgentProposalPort['validateProposal']>(input => {
        validatedSubmission = input
        return {
          status: 'accepted',
          value: {
            content: { body: 'validated proposal body' },
            decisions: { candidatesInJudgment: [], decisions: [] },
          },
        }
      }),
    }

    const result = await createOrdinaryFeedEditorAgent({ ctx, proposal }).formEditingProposal()

    expect(result.status).toBe('accepted')
    if (result.status !== 'accepted') throw new Error('ordinary-feed editor Agent did not accept its proposal')
    expect(result).toEqual({ status: 'accepted', value: { proposal: submission } })
    expect(result.value.proposal).toBe(validatedSubmission)
    expect(proposal.readModelMaterials).toHaveBeenCalledTimes(1)
    expect(proposal.validateProposal).toHaveBeenCalledTimes(1)
    expect(proposal.validateProposal).toHaveBeenCalledWith(validatedSubmission)
    expect(validatedSubmission).toEqual(submission)
    expect(adapter.requests).toHaveLength(1)
    const wire = adapter.requests[0]
    expect(wire?.system).toBe(ORDINARY_FEED_EDITOR_SYSTEM_PROMPT)
    expect(wire?.tools).toEqual([ORDINARY_FEED_EDITOR_TOOL_SCHEMA])
    expect(wire?.tools?.map(tool => tool.name)).toEqual([SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL])
    expect(wire?.messages).toHaveLength(1)
    const messageContent = wire?.messages[0]?.content
    const materialText = Array.isArray(messageContent) && messageContent[0]?.type === 'text'
      ? messageContent[0].text
      : undefined
    expect(materialText).toBe(`当前普通 Feed 编辑材料\n${JSON.stringify(materials)}`)
    expect(materialText).not.toMatch(/https?:\/\/|canonicalUrl|candidate|period|exploration|theme|planner|composer/iu)
    expect(JSON.stringify(wire?.tools)).not.toMatch(/submit_x_cron_planner|submit_x_cron_composer/iu)
  })

  it('fails before creating an Agent when the current model materials are unavailable', async () => {
    const adapter = new WireAdapter([])
    const ctx = await createHarness(adapter)
    contexts.push(ctx)
    const createAgent = vi.spyOn(ctx.agents, 'create')
    const proposal: OrdinaryFeedEditorAgentProposalPort = {
      readModelMaterials: vi.fn<OrdinaryFeedEditorAgentProposalPort['readModelMaterials']>(() => ({
        status: 'failed',
      })),
      validateProposal: vi.fn<OrdinaryFeedEditorAgentProposalPort['validateProposal']>(),
    }

    const result = await createOrdinaryFeedEditorAgent({ ctx, proposal }).formEditingProposal()

    expect(result).toEqual({ status: 'failed' })
    expect(proposal.readModelMaterials).toHaveBeenCalledTimes(1)
    expect(proposal.validateProposal).not.toHaveBeenCalled()
    expect(createAgent).not.toHaveBeenCalled()
    expect(adapter.requests).toHaveLength(0)
  })

  it('bounds a never-settling stream before cleanup waits for Agent idle', async () => {
    vi.useFakeTimers()
    const adapter = new NeverSettlingWireAdapter()
    const ctx = await createHarness(adapter)
    contexts.push(ctx)
    const proposal: OrdinaryFeedEditorAgentProposalPort = {
      readModelMaterials: vi.fn(() => ({ status: 'accepted' as const, value: { materials } })),
      validateProposal: vi.fn(),
    }
    let settled = false
    let disposed = false
    ctx.on('agent/disposed', () => { disposed = true })
    const resultPromise = createOrdinaryFeedEditorAgent({ ctx, proposal, timeoutMs: 10 })
      .formEditingProposal()
      .then(value => {
        settled = true
        return value
      })
    let settledBeforeRelease = false
    let result: Awaited<typeof resultPromise> | undefined
    try {
      await vi.waitFor(() => expect(adapter.requests).toHaveLength(1), { timeout: 100, interval: 1 })
      await vi.advanceTimersByTimeAsync(10)
      await Promise.resolve()
      settledBeforeRelease = settled
    } finally {
      adapter.release()
      result = await resultPromise
      vi.useRealTimers()
    }
    expect(result).toEqual({ status: 'failed' })
    expect(proposal.readModelMaterials).toHaveBeenCalledTimes(1)
    expect(proposal.validateProposal).not.toHaveBeenCalled()
    expect(disposed).toBe(true)
    expect(ctx.agents.list()).toHaveLength(0)
    expect(settledBeforeRelease).toBe(true)
  })

  it('returns failed and disposes when the stream responds to Agent cancellation', async () => {
    vi.useFakeTimers()
    const adapter = new NeverSettlingWireAdapter({ respondToCancel: true })
    const ctx = await createHarness(adapter)
    contexts.push(ctx)
    let disposed = false
    ctx.on('agent/disposed', () => { disposed = true })
    const proposal: OrdinaryFeedEditorAgentProposalPort = {
      readModelMaterials: vi.fn(() => ({ status: 'accepted' as const, value: { materials } })),
      validateProposal: vi.fn(),
    }
    const resultPromise = createOrdinaryFeedEditorAgent({ ctx, proposal, timeoutMs: 10 }).formEditingProposal()
    try {
      await vi.waitFor(() => expect(adapter.requests).toHaveLength(1), { timeout: 100, interval: 1 })
      await vi.advanceTimersByTimeAsync(10)
      await expect(resultPromise).resolves.toEqual({ status: 'failed' })
    } finally {
      adapter.release()
      await resultPromise.catch(() => undefined)
      vi.useRealTimers()
    }
    expect(disposed).toBe(true)
    expect(ctx.agents.list()).toHaveLength(0)
    expect(proposal.readModelMaterials).toHaveBeenCalledTimes(1)
    expect(proposal.validateProposal).not.toHaveBeenCalled()
  })

  it.each(['tool-call', 'reject'] as const)('isolates a late %s after timeout cleanup', async lateOutcome => {
    vi.useFakeTimers()
    const adapter = new NeverSettlingWireAdapter({ lateOutcome })
    const ctx = await createHarness(adapter)
    contexts.push(ctx)
    let disposed = false
    ctx.on('agent/disposed', () => { disposed = true })
    const proposal: OrdinaryFeedEditorAgentProposalPort = {
      readModelMaterials: vi.fn(() => ({ status: 'accepted' as const, value: { materials } })),
      validateProposal: vi.fn(),
    }
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    const resultPromise = createOrdinaryFeedEditorAgent({ ctx, proposal, timeoutMs: 10 }).formEditingProposal()
    try {
      await vi.waitFor(() => expect(adapter.requests).toHaveLength(1), { timeout: 100, interval: 1 })
      await vi.advanceTimersByTimeAsync(10)
      await expect(resultPromise).resolves.toEqual({ status: 'failed' })
      expect(disposed).toBe(true)
      expect(ctx.agents.list()).toHaveLength(0)
      adapter.release()
      await adapter.lateObserved
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      adapter.release()
      await resultPromise.catch(() => undefined)
      process.off('unhandledRejection', onUnhandled)
      vi.useRealTimers()
    }
    expect(proposal.validateProposal).not.toHaveBeenCalled()
    expect(unhandled).toHaveLength(0)
    expect(ctx.agents.list()).toHaveLength(0)
  })
})
