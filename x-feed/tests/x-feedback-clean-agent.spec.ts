import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId, createAssistantMessage, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLEAN_FEEDBACK_SYSTEM_PROMPT,
  CLEAN_FEEDBACK_REQUEST_PREFIX,
  SUBMIT_X_FEEDBACK_INTERPRETATION,
  SUBMIT_X_FEEDBACK_INTERPRETATION_SCHEMA,
} from '../src/x-feedback/clean-prompt.ts'
import {
  runCleanFeedback,
  type CleanFeedbackWireRequest,
} from '../src/x-feedback/clean-agent.ts'
import type { CleanFeedbackRequest, FeedbackInterpretation } from '../src/x-feedback/contract.ts'

const legacyMarker = 'LEGACY-TELEGRAM-HISTORY-MARKER-should-never-cross'
const firstRunMarker = 'FIRST-RUN-ASSISTANT-REASONING-MARKER'

const target = {
  id: 'item:11',
  content: '一段当前内容',
  source: 'https://x.com/example/status/11',
  scope: 'current message',
} as const

const request: CleanFeedbackRequest = {
  currentMessage: { id: 11, text: '我喜欢这条，因为论证清楚。', targets: [target] },
  targetCatalog: { currentMessage: [target], reference: [] },
  trustedFactsByTarget: {},
}

function toolCallResponse(
  callId: string,
  name: string,
  args: unknown,
  text?: string,
  reasoning?: string,
): StreamChunk[] {
  const call = ToolCallId(callId)
  const encoded = JSON.stringify(args)
  const blocks: StreamChunk[] = []
  if (text !== undefined) {
    blocks.push(
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
    )
  }
  let index = text === undefined ? 0 : 1
  if (reasoning !== undefined) {
    blocks.push(
      { type: 'block-start', index, blockType: 'reasoning' },
      { type: 'reasoning-delta', index, text: reasoning },
      { type: 'block-end', index, block: { type: 'reasoning', text: reasoning } },
    )
    index += 1
  }
  blocks.push(
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: call, name, argumentsDelta: encoded },
    { type: 'block-end', index, block: { type: 'tool-call', id: call, name, arguments: encoded } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return blocks
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function duplicateToolCallResponse(
  first: { callId: string; args: unknown },
  second: { callId: string; args: unknown },
): StreamChunk[] {
  const calls = [first, second].map(({ callId, args }, index) => {
    const id = ToolCallId(callId)
    const encoded = JSON.stringify(args)
    return [
      { type: 'block-start', index, blockType: 'tool-call' as const },
      { type: 'tool-call-delta', index, id, name: SUBMIT_X_FEEDBACK_INTERPRETATION, argumentsDelta: encoded },
      { type: 'block-end', index, block: { type: 'tool-call' as const, id, name: SUBMIT_X_FEEDBACK_INTERPRETATION, arguments: encoded } },
    ] satisfies StreamChunk[]
  }).flat()
  return [...calls, { type: 'finish', reason: { kind: 'tool-calls' } }]
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
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'wire-test', model: 'wire-model' })
  ctx.llm.registerAdapter(['wire-test'], adapter)
  return ctx
}

function addLegacyGlobalSurface(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'legacy-global-marker', order: 10, text: legacyMarker })
  ctx.systemPrompt.context({ name: 'legacy-runtime-marker', order: 10, text: legacyMarker })
  ctx.tools.register({
    name: 'legacy_global_tool',
    description: legacyMarker,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'string' },
      render: () => [{ type: 'text', text: 'legacy' }],
    },
    execute: async () => 'legacy',
  } satisfies ToolDefinition)
}

function wireProjection(request: GenerateOptions): CleanFeedbackWireRequest {
  return {
    provider: request.provider,
    model: request.model,
    messages: request.messages,
    ...(request.system === undefined ? {} : { system: request.system }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
  }
}

async function disposeContext(ctx: Context | undefined): Promise<void> {
  await ctx?.fiber.dispose()
}

const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await disposeContext(contexts.pop())
})

describe('one-shot clean X feedback Agent', () => {
  it('captures a real llm/stream request without long-session or global surfaces', async () => {
    const adapter = new WireAdapter([toolCallResponse('feedback-1', SUBMIT_X_FEEDBACK_INTERPRETATION, {
      kind: 'rating',
      sentiment: 'like',
      targetId: target.id,
      dimension: 'argument_quality',
      reason: '论证清楚。',
    })])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    addLegacyGlobalSurface(ctx)

    const ordinary = ctx.sessions.create(SessionId('ordinary-long-session'))
    ordinary.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `${legacyMarker.repeat(20)}\nordinary history` }],
        source: { provider: 'wire-test', model: 'wire-model' },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [] })

    const preSteps: string[] = []
    ctx.on('agent/pre-step', ({ agent }, next) => {
      preSteps.push(agent.id)
      return next()
    })
    const lifecycle: string[] = []
    ctx.on('session/flush', (session) => { lifecycle.push(`flush:${session.id}`) })
    ctx.on('agent/disposed', ({ agent }) => { lifecycle.push(`dispose:${agent.id}`) })

    const result = await runCleanFeedback(ctx, request, { timeoutMs: 1_000 })

    const interpretation: FeedbackInterpretation = {
      kind: 'rating',
      sentiment: 'like',
      targetId: target.id,
      dimension: 'argument_quality',
      reason: '论证清楚。',
    }
    expect(result.interpretation).toEqual(interpretation)
    expect(result.sessionId).toMatch(/^session-x-feedback-/u)
    expect(result.wire.provider).toBe('wire-test')
    expect(result.wire.model).toBe('wire-model')
    expect(result.wire.messages[0]?.content).toEqual([{
      type: 'text',
      text: `${CLEAN_FEEDBACK_REQUEST_PREFIX}\n${JSON.stringify(request)}`,
    }])
    expect(result.wire.tools).toHaveLength(1)
    expect(result.wire.tools?.map(tool => tool.name)).toEqual([SUBMIT_X_FEEDBACK_INTERPRETATION])
    expect(result.wire.tools?.[0]?.parameters).toEqual(SUBMIT_X_FEEDBACK_INTERPRETATION_SCHEMA.parameters)
    expect(result.wire.system).toBe(CLEAN_FEEDBACK_SYSTEM_PROMPT)
    expect(JSON.stringify(result.wire)).not.toContain(legacyMarker)
    expect(adapter.requests).toHaveLength(1)
    expect(wireProjection(adapter.requests[0]!)).toEqual(result.wire)
    expect(adapter.requests[0]?.messages).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain(legacyMarker)
    expect(preSteps).not.toContain(result.sessionId)
    expect(lifecycle).toEqual([`flush:${result.sessionId}`, `dispose:${result.sessionId}`])
  })

  it('uses a new session and no prior assistant/tool/reasoning marker for every run', async () => {
    const adapter = new WireAdapter([
      toolCallResponse('feedback-1', SUBMIT_X_FEEDBACK_INTERPRETATION, {
        kind: 'rating',
        sentiment: 'like',
        targetId: target.id,
        dimension: 'argument_quality',
        reason: firstRunMarker,
      }, firstRunMarker, firstRunMarker),
      toolCallResponse('feedback-2', SUBMIT_X_FEEDBACK_INTERPRETATION, {
        kind: 'pass', reason: 'not_feedback',
      }),
    ])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const createCalls: unknown[] = []
    const originalCreate = ctx.agents.create.bind(ctx.agents)
    vi.spyOn(ctx.agents, 'create').mockImplementation(async options => {
      createCalls.push(options)
      return originalCreate(options)
    })
    const created: { id: string; seedLength?: number; parentSession?: string }[] = []
    ctx.on('session/created', session => {
      if (session.id.startsWith('session-x-feedback-')) {
        created.push({
          id: session.id,
          ...session.header.seedLength === undefined ? {} : { seedLength: session.header.seedLength },
          ...session.header.parentSession === undefined ? {} : { parentSession: session.header.parentSession },
        })
      }
    })

    const first = await runCleanFeedback(ctx, request)
    const second = await runCleanFeedback(ctx, request)

    expect(second.sessionId).not.toBe(first.sessionId)
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1])).not.toContain(firstRunMarker)
    expect(adapter.requests[1]?.messages).toHaveLength(1)
    expect(adapter.requests[1]?.messages[0]?.role).toBe('user')
    expect(second.interpretation).toEqual({ kind: 'pass', reason: 'not_feedback' })
    expect(createCalls).toHaveLength(2)
    expect(createCalls.every(value => !Object.hasOwn(value as object, 'seed'))).toBe(true)
    expect(createCalls.every(value => !Object.hasOwn(value as object, 'resumeSessionId'))).toBe(true)
    expect(created).toHaveLength(2)
    expect(created.every(value => value.seedLength === undefined && value.parentSession === undefined)).toBe(true)
  })

  it('fails closed for text-only model output', async () => {
    const adapter = new WireAdapter([textResponse('我认为这条不错。')])
    const ctx = await harness(adapter)
    contexts.push(ctx)

    await expect(runCleanFeedback(ctx, request)).rejects.toThrow(/no valid interpretation/u)
  })

  it('fails closed for unknown fields in the submitted DTO', async () => {
    const adapter = new WireAdapter([toolCallResponse('feedback-bad', SUBMIT_X_FEEDBACK_INTERPRETATION, {
      kind: 'pass', reason: 'ordinary', unexpected: legacyMarker,
    })])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    let disposedAgent: Agent | undefined
    ctx.on('agent/disposed', ({ agent }) => { disposedAgent = agent })

    await expect(runCleanFeedback(ctx, request)).rejects.toThrow(/invalid|unknown|submitted|second pre-step/u)
    expect(JSON.stringify(disposedAgent?.session.snapshotEvents())).toContain('unknown fields')
  })

  it('fails closed before followup when a global creation listener pollutes prompt and tools', async () => {
    const adapter = new WireAdapter([toolCallResponse('never-used', SUBMIT_X_FEEDBACK_INTERPRETATION, {
      kind: 'pass', reason: 'ordinary',
    })])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    let disposed = false
    ctx.on('agent/disposed', () => { disposed = true })
    ctx.on('agent/created', ({ agent }) => {
      agent.ctx.tools.register({
        name: 'polluted_created_tool',
        description: 'pollution',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'pollution' }] },
        execute: async () => 'pollution',
      } satisfies ToolDefinition)
      agent.ctx.systemPrompt.section({
        name: 'polluted-created-prompt',
        order: -2_000,
        text: 'pollution',
        complete: true,
      })
    })

    await expect(runCleanFeedback(ctx, request)).rejects.toThrow(/contaminated|multiple complete|sole complete/u)
    expect(adapter.requests).toHaveLength(0)
    expect(disposed).toBe(true)
  })

  it('does not report success when the required flush fails, and still disposes', async () => {
    const adapter = new WireAdapter([toolCallResponse('flush-1', SUBMIT_X_FEEDBACK_INTERPRETATION, {
      kind: 'pass', reason: 'ordinary',
    })])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const lifecycle: string[] = []
    ctx.on('session/flush', session => {
      lifecycle.push(`flush:${session.id}`)
      throw new Error('disk unavailable')
    })
    ctx.on('agent/disposed', ({ agent }) => { lifecycle.push(`dispose:${agent.id}`) })

    await expect(runCleanFeedback(ctx, request)).rejects.toThrow('disk unavailable')
    expect(lifecycle).toHaveLength(2)
    expect(lifecycle[0]).toMatch(/^flush:session-x-feedback-/u)
    expect(lifecycle[1]).toBe(`dispose:${lifecycle[0]?.slice('flush:'.length)}`)
  })

  it('cancels and disposes when the real stream does not become idle before timeout', async () => {
    const adapter = new WireAdapter(['hang'])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    let disposed = false
    ctx.on('agent/disposed', () => { disposed = true })

    await expect(runCleanFeedback(ctx, request, { timeoutMs: 20 })).rejects.toThrow(/timed out|aborted/u)
    expect(adapter.requests).toHaveLength(1)
    expect(disposed).toBe(true)
  })

  it('rejects duplicate submissions and never keeps the first as success', async () => {
    const adapter = new WireAdapter([duplicateToolCallResponse(
      { callId: 'duplicate-1', args: { kind: 'pass', reason: 'ordinary' } },
      { callId: 'duplicate-2', args: { kind: 'pass', reason: 'ordinary' } },
    )])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    let disposedAgent: Agent | undefined
    ctx.on('agent/disposed', ({ agent }) => { disposedAgent = agent })

    await expect(runCleanFeedback(ctx, request)).rejects.toThrow(/duplicate|second pre-step|aborted/u)
    expect(JSON.stringify(disposedAgent?.session.snapshotEvents())).toContain('duplicate X feedback interpretation submission')
  })

  it('fails closed when the real llm/stream seam reports an error', async () => {
    const adapter = new WireAdapter(['throw'])
    const ctx = await harness(adapter)
    contexts.push(ctx)

    await expect(runCleanFeedback(ctx, request)).rejects.toThrow(/stream failed|turn ended as error|second pre-step/u)
    expect(adapter.requests).toHaveLength(1)
  })
})
