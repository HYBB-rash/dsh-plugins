import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { summarizeTurn } from '@deepseek-ai/dsh-telegram-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import {
  XFeedFinalAgentSurface,
  X_CRON_FINAL_LOOKUP_TOOL,
  X_CRON_FINAL_PROJECT_TOOL,
  X_CRON_FINAL_SYSTEM_PROMPT,
} from '../src/x-cron/final-agent.ts'

const contexts: Context[] = []
const finalText = '📦 X 洞察\n\n⭐ 高优先级\n- 当前事实 (https://x.com/alice/status/1)'

class TwoStepWireAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private step = 0

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    this.step += 1
    if (this.step === 1) {
      yield* toolCall('project-call', X_CRON_FINAL_PROJECT_TOOL, { candidateId: 'x-status:1' })
      return
    }
    if (this.step === 2) {
      yield* toolCall('prepare-call', 'x_feed_prepare_delivery', { text: finalText, urls: ['https://x.com/alice/status/1'] })
      return
    }
    yield* textReply(finalText)
  }
}

type FinalFailureMode = 'no-prepare' | 'prepare-failure' | 'inconsistent' | 'format-failure'

class ScriptedFinalFailureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private step = 0

  constructor(readonly mode: FinalFailureMode) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    this.step += 1
    if (this.mode === 'no-prepare') {
      yield* textReply(finalText)
      return
    }
    if (this.step === 1) {
      const preparedText = this.mode === 'format-failure' ? 'not rich markdown' : finalText
      yield* toolCall('prepare-call', 'x_feed_prepare_delivery', {
        text: preparedText,
        urls: ['https://x.com/alice/status/1'],
      })
      return
    }
    yield* textReply(this.mode === 'inconsistent' ? `${finalText}\n额外正文` : finalText)
  }
}

class TwoRunIsolationAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly steps = new Map<string, number>()

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const material = requestMaterial(request)
    const step = (this.steps.get(request.sessionId) ?? 0) + 1
    this.steps.set(request.sessionId, step)
    const candidate = material.candidates[0]!
    const output = `📦 X 洞察\n\n⭐ 当前候选\n- ${candidate.content} (${candidate.source})`
    if (step === 1) {
      yield* toolCall(`project-${candidate.id}`, X_CRON_FINAL_PROJECT_TOOL, { candidateId: candidate.id })
      return
    }
    if (step === 2) {
      yield* toolCall(`prepare-${candidate.id}`, 'x_feed_prepare_delivery', { text: output, urls: [candidate.source] })
      return
    }
    yield* textReply(output)
  }
}

function requestMaterial(request: GenerateOptions): {
  readonly kind: 'x-cron-current-run-material'
  readonly candidates: readonly { readonly id: string; readonly content: string; readonly source: string }[]
} {
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type !== 'text' || !block.text.includes('x-cron-current-run-material')) continue
      const parsed = JSON.parse(block.text) as ReturnType<typeof requestMaterial>
      if (parsed.kind === 'x-cron-current-run-material') return parsed
    }
  }
  throw new Error(`fresh final request omitted run material for ${request.sessionId}`)
}

function toolCall(id: string, name: string, value: unknown): StreamChunk[] {
  const callId = CallId(id)
  const args = JSON.stringify(value)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textReply(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function harness(adapter: TwoStepWireAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'wire-test', model: 'wire-model' })
  ctx.llm.registerAdapter(['wire-test'], adapter)
  contexts.push(ctx)
  return ctx
}

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()?.fiber.dispose()
})

describe('X cron final Agent integration', () => {
  it('uses one current material message across a real two-step tool loop and finalizes exact prepared output', async () => {
    const adapter = new TwoStepWireAdapter()
    const ctx = await harness(adapter)
    const parentContaminationMarker = 'parent-pre-step-contamination-marker'
    ctx.on('agent/pre-step', ({ messages }) => ({
      kind: 'enter' as const,
      messages: [...messages, createUserMessage({
        content: [{ type: 'text', text: parentContaminationMarker }],
        source: { kind: 'plugin', plugin: 'parent-context' },
      })],
    }))
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: 'run-1',
        allowedTopics: ['agentic systems'],
        candidates: [{
          id: 'x-status:1',
          content: 'current candidate',
          source: 'https://x.com/alice/status/1',
          topics: ['agentic systems'],
        }],
      },
      runTools: {
        searchTopic: async () => ({ items: [] }),
        exploreCandidate: async () => ({ title: 'candidate', body: 'body', urls: [] }),
        setTheme: async theme => ({ theme }),
        prepareDelivery: async () => ({ ok: true, prepared: 1 }),
      },
      projection: {
        project: async () => ({ facts: [], tickets: [], serializedBytes: new Uint8Array() }),
        lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
      },
    })
    const sessionId = SessionId('session-cron-run-integration')
    surface.capture(ctx, sessionId)
    const handle = await ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'wire-test', model: 'wire-model' },
      setup: agentCtx => {
        installModelSelection(agentCtx, { current: { provider: 'wire-test', model: 'wire-model' }, assembled: undefined })
        surface.setupAgent(agentCtx)
      },
    })

    await surface.verifySurface(handle.agent)
    const firstSeq = handle.agent.session.seq
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'drive final X run' }],
      source: { kind: 'plugin', plugin: 'dsh-cron' },
    }))
    await handle.agent.whenIdle()
    const outcome = summarizeTurn(handle.agent.session.events, firstSeq)
    surface.finalizeOutcome(outcome)

    expect(adapter.requests.length).toBe(3)
    expect(adapter.requests.every(request => request.system === X_CRON_FINAL_SYSTEM_PROMPT)).toBe(true)
    const expectedToolNames = [
      'x_feed_search_topic',
      'x_feed_explore_candidate',
      'x_feed_set_run_theme',
      'x_feed_prepare_delivery',
      X_CRON_FINAL_PROJECT_TOOL,
      X_CRON_FINAL_LOOKUP_TOOL,
    ]
    for (const request of adapter.requests) {
      const names = request.tools?.map(tool => tool.name) ?? []
      expect(names).toHaveLength(expectedToolNames.length)
      expect(new Set(names)).toEqual(new Set(expectedToolNames))
    }
    const material = surface.materialText
    expect(adapter.requests[0]?.messages.filter(message => message.content.some(block => block.type === 'text' && block.text === material))).toHaveLength(1)
    expect(adapter.requests[1]?.messages.filter(message => message.content.some(block => block.type === 'text' && block.text === material))).toHaveLength(1)
    expect(adapter.requests[2]?.messages.filter(message => message.content.some(block => block.type === 'text' && block.text === material))).toHaveLength(1)
    expect(JSON.stringify(adapter.requests)).not.toContain(parentContaminationMarker)
    expect(JSON.stringify(adapter.requests)).not.toContain('old-session-marker')
    expect(outcome.text).toBe(finalText)
    expect(outcome.error).toBeUndefined()

    surface.dispose()
    await ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
  })

  it.each<FinalFailureMode>(['no-prepare', 'prepare-failure', 'inconsistent', 'format-failure'])
    ('fails closed before delivery for %s while retaining a real Agent wire', async mode => {
      const adapter = new ScriptedFinalFailureAdapter(mode)
      const ctx = await harness(adapter)
      const surface = new XFeedFinalAgentSurface({
        material: {
          runId: `run-${mode}`,
          allowedTopics: ['agentic systems'],
          candidates: [{
            id: 'x-status:1',
            content: 'current candidate',
            source: 'https://x.com/alice/status/1',
            topics: ['agentic systems'],
          }],
        },
        runTools: {
          searchTopic: async () => ({ items: [] }),
          exploreCandidate: async () => ({ title: 'candidate', body: 'body', urls: [] }),
          setTheme: async theme => ({ theme }),
          prepareDelivery: async () => mode === 'prepare-failure'
            ? { ok: false, code: 'prepare-failed', message: 'fixed Python prepare failed' }
            : { ok: true, prepared: 1 },
        },
        projection: {
          project: async () => ({ facts: [], tickets: [], serializedBytes: new Uint8Array() }),
          lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
        },
      })
      const sessionId = SessionId(`session-cron-run-failure-${mode}`)
      surface.capture(ctx, sessionId)
      const handle = await ctx.agents.create({
        sessionId,
        agentOptions: { provider: 'wire-test', model: 'wire-model' },
        setup: agentCtx => {
          installModelSelection(agentCtx, { current: { provider: 'wire-test', model: 'wire-model' }, assembled: undefined })
          surface.setupAgent(agentCtx)
        },
      })
      try {
        await surface.verifySurface(handle.agent)
        const firstSeq = handle.agent.session.seq
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: `run failure case ${mode}` }],
          source: { kind: 'plugin', plugin: 'dsh-cron' },
        }))
        await handle.agent.whenIdle()
        const outcome = summarizeTurn(handle.agent.session.events, firstSeq)
        expect(adapter.requests.length).toBeGreaterThan(0)
        expect(() => surface.finalizeOutcome(outcome)).toThrow()
        if (mode === 'no-prepare') expect(surface.prepareAttempts).toBe(0)
        else expect(surface.prepareAttempts).toBe(1)
        expect(outcome.error).toBeUndefined()
      } finally {
        surface.dispose()
        await ctx.sessions.flush(handle.agent.session)
        await handle.dispose()
      }
    })

  it('rejects final prompt/tool contamination after setup before any final wire', async () => {
    const adapter = new TwoStepWireAdapter()
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: 'run-contaminated',
        allowedTopics: ['agentic systems'],
        candidates: [{
          id: 'x-status:1',
          content: 'current candidate',
          source: 'https://x.com/alice/status/1',
          topics: ['agentic systems'],
        }],
      },
      runTools: {
        searchTopic: async () => ({ items: [] }),
        exploreCandidate: async () => ({ title: 'candidate', body: 'body', urls: [] }),
        setTheme: async theme => ({ theme }),
        prepareDelivery: async () => ({ ok: true, prepared: 1 }),
      },
      projection: {
        project: async () => ({ facts: [], tickets: [], serializedBytes: new Uint8Array() }),
        lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
      },
    })
    const sessionId = SessionId('session-cron-run-contaminated')
    surface.capture(ctx, sessionId)
    const handle = await ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'wire-test', model: 'wire-model' },
      setup: agentCtx => {
        installModelSelection(agentCtx, { current: { provider: 'wire-test', model: 'wire-model' }, assembled: undefined })
        surface.setupAgent(agentCtx)
      },
    })
    try {
      handle.agent.ctx.tools.register({
        name: 'contaminated_final_tool',
        description: 'must not reach the final Agent surface',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'contamination' }] },
        execute: async () => 'contamination',
      } satisfies ToolDefinition)
      handle.agent.ctx.systemPrompt.section({
        name: 'contaminated-final-prompt',
        order: -2_000,
        text: 'contamination',
        complete: true,
      })

      await expect(surface.verifySurface(handle.agent)).rejects.toThrow(/contaminated|sole complete/u)
      expect(adapter.requests).toHaveLength(0)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('keeps two real final Agents on separate sessions with bounded material and no old-session carryover', async () => {
    const adapter = new TwoRunIsolationAdapter()
    const ctx = await harness(adapter)
    const oldSessionMarker = 'ordinary-long-session-marker'

    const runSpecs = [
      { id: 'run-one', candidateId: 'x-status:1', source: 'https://x.com/alice/status/1', content: 'same-candidate-package' },
      { id: 'run-two', candidateId: 'x-status:1', source: 'https://x.com/alice/status/1', content: 'same-candidate-package' },
    ] as const
    const surfaces: XFeedFinalAgentSurface[] = []
    const handles: Array<{ dispose(): Promise<unknown> }> = []
    try {
      for (const [index, spec] of runSpecs.entries()) {
        if (index === 1) {
          const ordinary = ctx.sessions.create(SessionId('ordinary-long-session'))
          ordinary.append('assistant/message', {
            turn: 1,
            step: 1,
            message: createAssistantMessage({
              content: [{ type: 'text', text: `${oldSessionMarker.repeat(10_000)} old history` }],
              source: { provider: 'wire-test', model: 'wire-model' },
            }),
          }, { surfaceOp: 'append', sourceEventSeqs: [] })
        }
        const surface = new XFeedFinalAgentSurface({
          material: {
            runId: spec.id,
            allowedTopics: ['agentic systems'],
            candidates: [{ id: spec.candidateId, content: spec.content, source: spec.source, topics: ['agentic systems'] }],
          },
          runTools: {
            searchTopic: async () => ({ items: [] }),
            exploreCandidate: async () => ({ title: 'candidate', body: 'body', urls: [] }),
            setTheme: async theme => ({ theme }),
            prepareDelivery: async () => ({ ok: true, prepared: 1 }),
          },
          projection: {
            project: async () => ({ facts: [], tickets: [], serializedBytes: new Uint8Array() }),
            lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
          },
        })
        const sessionId = SessionId(`session-cron-run-isolation-${spec.id}`)
        surface.capture(ctx, sessionId)
        const handle = await ctx.agents.create({
          sessionId,
          agentOptions: { provider: 'wire-test', model: 'wire-model' },
          setup: agentCtx => {
            installModelSelection(agentCtx, { current: { provider: 'wire-test', model: 'wire-model' }, assembled: undefined })
            surface.setupAgent(agentCtx)
          },
        })
        surfaces.push(surface)
        handles.push(handle)
        await surface.verifySurface(handle.agent)
        const firstSeq = handle.agent.session.seq
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: `drive ${spec.id}` }],
          source: { kind: 'plugin', plugin: 'dsh-cron' },
        }))
        await handle.agent.whenIdle()
        surface.finalizeOutcome(summarizeTurn(handle.agent.session.events, firstSeq))
        surface.dispose()
        await ctx.sessions.flush(handle.agent.session)
        await handle.dispose()
      }

      expect(surfaces).toHaveLength(2)
      expect(surfaces[0]?.wires).toHaveLength(3)
      expect(surfaces[1]?.wires).toHaveLength(3)
      expect(new Set(adapter.requests.map(request => request.sessionId)).size).toBe(2)
      const firstWireJson = JSON.stringify(surfaces[0]?.wires)
      const secondWireJson = JSON.stringify(surfaces[1]?.wires)
      expect(firstWireJson).toContain('same-candidate-package')
      expect(secondWireJson).toContain('same-candidate-package')
      expect(surfaces[0]?.materialText).toBe(surfaces[1]?.materialText)
      const requestProjection = (wire: typeof adapter.requests[number]) => JSON.stringify({
        provider: wire.provider,
        model: wire.model,
        // Message ids belong to each fresh session's lineage; compare the
        // actual model-facing content and tool/result correlation instead.
        messages: wire.messages.map(({ id: _id, ...message }) => message),
        system: wire.system,
        tools: wire.tools,
      })
      for (let index = 0; index < 3; index += 1) {
        const firstProjection = requestProjection(surfaces[0]!.wires[index]!)
        const secondProjection = requestProjection(surfaces[1]!.wires[index]!)
        expect(secondProjection).toBe(firstProjection)
        expect(Buffer.from(secondProjection, 'utf8')).toEqual(Buffer.from(firstProjection, 'utf8'))
      }
      expect(firstWireJson).not.toContain(oldSessionMarker)
      expect(secondWireJson).not.toContain(oldSessionMarker)
      expect(Buffer.byteLength(secondWireJson, 'utf8')).toBe(Buffer.byteLength(firstWireJson, 'utf8'))
    } finally {
      for (const surface of surfaces) surface.dispose()
      for (const handle of handles) await handle.dispose()
    }
  })
})
