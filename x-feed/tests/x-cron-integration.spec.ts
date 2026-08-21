import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry, { installModelSelection, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, type GenerateOptions, LlmAdapter, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { summarizeTurn } from '@deepseek-ai/dsh-telegram-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import {
  XFeedFinalAgentSurface,
  XFeedModelResultBudget,
  X_CRON_FINAL_LOOKUP_TOOL,
  X_CRON_FINAL_PROJECT_TOOL,
  X_CRON_FINAL_SYSTEM_PROMPT,
} from '../src/x-cron/final-agent.ts'
import { projectSearchToolResult } from '../src/x-cron/run-tools.ts'

const contexts: Context[] = []
const finalText = '📦 X 洞察\n\n⭐ 高优先级\n- 当前事实 (https://x.com/alice/status/1)'

describe('X final model-result budget ledger', () => {
  function exactResultBytes(target: number) {
    const base = Buffer.byteLength(JSON.stringify({ ok: true, result: { text: '' } }), 'utf8')
    return { ok: true as const, result: { text: 'x'.repeat(target - base) } }
  }

  it('enforces exact accepted model-result content budgets per partition', () => {
    for (const [partition, limit] of [['optional', 7_000], ['fact', 16_000], ['control', 1_000]] as const) {
      const directOverflow = new XFeedModelResultBudget()
      const directRejected = directOverflow.admit(partition, exactResultBytes(limit + 1))
      expect(directRejected).toMatchObject({ ok: false, code: 'tool-result-budget-exhausted' })
      expect(directOverflow.admit(partition, { ok: true, result: {} })).toBe(directRejected)
      const ledger = new XFeedModelResultBudget()
      const accepted = exactResultBytes(limit)
      expect(ledger.admit(partition, accepted)).toBe(accepted)
      expect(ledger.snapshot()[partition]).toBe(limit)
      const rejected = ledger.admit(partition, exactResultBytes(limit + 1))
      expect(rejected).toMatchObject({ ok: false, code: 'tool-result-budget-exhausted' })
      const afterFirstReject = ledger.snapshot()
      expect(ledger.admit(partition, accepted)).toMatchObject({ ok: false, code: 'tool-result-budget-exhausted' })
      expect(ledger.snapshot()).toEqual(afterFirstReject)
      expect(ledger.canInvoke(partition)).toBe(false)
    }

    const independent = new XFeedModelResultBudget()
    const failure = { ok: false as const, code: 'invalid-output', message: 'fix format' }
    expect(independent.admit('control', failure)).toBe(failure)
    expect(independent.snapshot().control).toBe(Buffer.byteLength(JSON.stringify(failure), 'utf8'))
    expect(independent.admit('optional', exactResultBytes(7_000))).toMatchObject({ ok: true })
    expect(independent.snapshot().total).toBeLessThanOrEqual(24_000)
  })

  it('charges final JSON bytes per partition, supports concurrent admits, and fails closed', async () => {
    const ledger = new XFeedModelResultBudget()
    const admitted = await Promise.all([
      ledger.admit('fact', { ok: true, result: { text: '🙂'.repeat(1_000) } }),
      ledger.admit('fact', { ok: true, result: { text: '🙂'.repeat(1_000) } }),
    ])
    expect(admitted.every(result => result.ok)).toBe(true)
    expect(ledger.snapshot().fact).toBe(
      admitted.reduce((sum, result) => sum + Buffer.byteLength(JSON.stringify(result), 'utf8'), 0),
    )
    const optional = ledger.admit('optional', { ok: true, result: { text: 'x'.repeat(6_900) } })
    expect(optional.ok).toBe(true)
    expect(ledger.canInvoke('fact')).toBe(true)
    const exhausted = ledger.admit('fact', { ok: true, result: { text: 'x'.repeat(20_000) } })
    expect(exhausted).toMatchObject({ ok: false, code: 'tool-result-budget-exhausted' })
    expect(ledger.canInvoke('fact')).toBe(false)
    expect(ledger.snapshot().total).toBeLessThanOrEqual(24_000)
    expect(ledger.snapshot().fact).toBeLessThanOrEqual(16_000)
  })
})

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

class CountingFinalWireAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield* textReply(finalText)
  }
}

class OversizeToolLoopAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private step = 0

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    this.step += 1
    if (this.step === 1) {
      yield* toolCall('oversize-prepare-call', 'x_feed_prepare_delivery', {
        text: 'x'.repeat(100_000),
        urls: ['https://x.com/alice/status/1'],
      })
      return
    }
    yield* textReply(finalText)
  }
}

type ScriptedToolCall = { readonly id: string; readonly name: string; readonly value: unknown }

class ScriptedToolBatchAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private step = 0

  constructor(private readonly script: readonly (readonly ScriptedToolCall[])[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const calls = this.script[this.step++]
    if (calls !== undefined) {
      yield* toolCalls(calls)
      return
    }
    yield* textReply(finalText)
  }
}

class SixteenRequestLoopAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield* toolCall(`loop-${this.requests.length}`, X_CRON_FINAL_PROJECT_TOOL, { candidateId: 'x-status:1' })
  }
}

class FifteenStepReplayAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private step = 0

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    this.step += 1
    if (this.step <= 12) {
      yield* toolCall(`lookup-${this.step}`, X_CRON_FINAL_LOOKUP_TOOL, {
        ticketId: `unissued-${this.step}-${'x'.repeat(3_620 + (this.step === 1 ? 3 : 0))}`,
      })
      return
    }
    if (this.step === 13) {
      yield* toolCall('prepare-invalid', 'x_feed_prepare_delivery', {
        text: 'invalid-output-'.concat('x'.repeat(5_000)),
        urls: ['https://x.com/alice/status/1'],
      })
      return
    }
    if (this.step === 14) {
      yield* toolCall('prepare-correction', 'x_feed_prepare_delivery', {
        text: finalText,
        urls: ['https://x.com/alice/status/1'],
      })
      return
    }
    yield* textReply(finalText)
  }
}

class FortyEightKilobyteToolHistoryAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private step = 0

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    this.step += 1
    if (this.step <= 12) {
      yield* toolCall(`lookup-${this.step}`, X_CRON_FINAL_LOOKUP_TOOL, {
        ticketId: `unissued-${this.step}-${'x'.repeat(3_620 + (this.step === 1 ? 3 : 0))}`,
      })
      return
    }
    if (this.step === 13) {
      yield* toolCall('prepare-oversized-history', 'x_feed_prepare_delivery', {
        text: 'invalid-output-'.concat('x'.repeat(48_000)),
        urls: ['https://x.com/alice/status/1'],
      })
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

function toolCalls(calls: readonly ScriptedToolCall[]): StreamChunk[] {
  const blocks: StreamChunk[] = []
  for (const [index, call] of calls.entries()) {
    const callId = CallId(call.id)
    const args = JSON.stringify(call.value)
    blocks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id: callId, name: call.name, argumentsDelta: args },
      { type: 'block-end', index, block: { type: 'tool-call', id: callId, name: call.name, arguments: args } },
    )
  }
  blocks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  return blocks
}

function textReply(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function wireWithSyntheticToolHistory<T extends { readonly provider: string; readonly model: string; readonly messages: readonly Message[] }>(wire: T, targetAddedBytes: number): T {
  const callId = CallId(`synthetic-wire-${targetAddedBytes}`)
  const append = (resultText: string): readonly Message[] => [
    ...wire.messages,
    createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'synthetic_tool', arguments: '{}' }],
      source: { provider: wire.provider, model: wire.model },
    }),
    createToolResultMessage({ callId, content: [{ type: 'text', text: resultText }], isError: false }),
  ]
  const wireBytes = (messages: readonly Message[]) => Buffer.byteLength(JSON.stringify({ ...wire, messages }), 'utf8')
  const baseBytes = Buffer.byteLength(JSON.stringify(wire), 'utf8')
  const emptyPairOverhead = wireBytes(append('')) - baseBytes
  const filler = 'z'.repeat(Math.max(0, targetAddedBytes - emptyPairOverhead))
  return { ...wire, messages: append(filler) } as T
}

async function harness(adapter: LlmAdapter): Promise<Context> {
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
  it('charges the final optional projections and makes later search/explore calls zero-port', async () => {
    const rawSearch = {
      items: [{ id: 'post-1', url: 'https://x.com/alice/status/1', text: '🙂'.repeat(3_000) }],
    }
    const projectedSearch = projectSearchToolResult(rawSearch)
    const budgetFailure = {
      ok: false as const,
      code: 'tool-result-budget-exhausted',
      message: 'This model-result partition has exhausted its byte budget.',
    }
    const adapter = new ScriptedToolBatchAdapter([
      [{ id: 'search-1', name: 'x_feed_search_topic', value: { topic: 'topic-1' } }],
      [{ id: 'search-2', name: 'x_feed_search_topic', value: { topic: 'topic-2' } }],
      [
        { id: 'search-3', name: 'x_feed_search_topic', value: { topic: 'topic-3' } },
        { id: 'explore-1', name: 'x_feed_explore_candidate', value: { candidateId: 'candidate-1' } },
      ],
      [{ id: 'prepare', name: 'x_feed_prepare_delivery', value: { text: finalText, urls: ['https://x.com/alice/status/1'] } }],
    ])
    const searchCalls: string[] = []
    const exploreCalls: string[] = []
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: 'run-result-budget-optional',
        allowedTopics: ['topic-1', 'topic-2', 'topic-3'],
        candidates: [{ id: 'candidate-1', content: 'candidate', source: 'https://x.com/alice/status/1', topics: ['topic-1'] }],
      },
      runTools: {
        searchTopic: async topic => { searchCalls.push(topic); return rawSearch },
        exploreCandidate: async candidateId => { exploreCalls.push(candidateId); return { title: 'title', body: 'body', urls: [] } },
        setTheme: async theme => ({ theme }),
        prepareDelivery: async () => ({ ok: true, prepared: 1 }),
      },
      projection: {
        project: async () => ({ facts: [], tickets: [], serializedBytes: new Uint8Array() }),
        lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
      },
    })
    const sessionId = SessionId('session-cron-run-result-budget-optional')
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
      const firstSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run optional result budget probe' }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
      await handle.agent.whenIdle()
      surface.finalizeOutcome(summarizeTurn(handle.agent.session.events, firstSeq))
      expect(searchCalls).toEqual(['topic-1', 'topic-2'])
      expect(exploreCalls).toEqual([])
      expect(surface.resultBudget.snapshot().optional).toBe(
        Buffer.byteLength(JSON.stringify(projectedSearch), 'utf8')
        + Buffer.byteLength(JSON.stringify(budgetFailure), 'utf8'),
      )
      expect(surface.resultBudget.canInvoke('optional')).toBe(false)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('does not sign project tickets when the final fact DTO is rejected by the shared budget', async () => {
    const adapter = new ScriptedToolBatchAdapter([
      [{ id: 'project-overflow', name: X_CRON_FINAL_PROJECT_TOOL, value: { candidateId: 'x-status:1' } }],
      [{ id: 'lookup-rejected-project', name: X_CRON_FINAL_LOOKUP_TOOL, value: { ticketId: 'ticket:overflow' } }],
      [{ id: 'prepare', name: 'x_feed_prepare_delivery', value: { text: finalText, urls: ['https://x.com/alice/status/1'] } }],
    ])
    const lookupCalls: string[] = []
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: 'run-fact-project-overflow',
        allowedTopics: [],
        candidates: [{ id: 'x-status:1', content: 'candidate', source: 'https://x.com/alice/status/1', topics: [] }],
      },
      runTools: {
        searchTopic: async () => ({ items: [] }),
        exploreCandidate: async () => ({ title: 'title', body: 'body', urls: [] }),
        setTheme: async theme => ({ theme }),
        prepareDelivery: async () => ({ ok: true, prepared: 1 }),
      },
      projection: {
        project: async () => ({
          facts: [{ oversized: 'x'.repeat(20_000) } as never],
          tickets: [{ ticketId: 'ticket:overflow' } as never],
          serializedBytes: new Uint8Array(),
        }),
        lookup: ticketId => { lookupCalls.push(ticketId); return { kind: 'lookup-success', facts: [] } },
      },
    })
    const sessionId = SessionId('session-cron-run-fact-project-overflow')
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
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run project overflow ticket probe' }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
      await handle.agent.whenIdle()
      expect(lookupCalls).toEqual([])
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('charges accepted project and lookup DTOs exactly in the shared fact partition', async () => {
    const projectView = {
      facts: [],
      tickets: [{ ticketId: 'ticket:1' } as never],
      serializedBytes: new Uint8Array(),
    }
    const projectResult = { ok: true as const, result: { facts: projectView.facts, tickets: projectView.tickets } }
    const lookupResult = { ok: true as const, result: { kind: 'lookup-success' as const, facts: [] } }
    const adapter = new ScriptedToolBatchAdapter([
      [{ id: 'project', name: X_CRON_FINAL_PROJECT_TOOL, value: { candidateId: 'x-status:1' } }],
      [{ id: 'lookup', name: X_CRON_FINAL_LOOKUP_TOOL, value: { ticketId: 'ticket:1' } }],
      [{ id: 'prepare', name: 'x_feed_prepare_delivery', value: { text: finalText, urls: ['https://x.com/alice/status/1'] } }],
    ])
    const projectCalls: string[] = []
    const lookupCalls: string[] = []
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: 'run-fact-project-lookup-exact',
        allowedTopics: [],
        candidates: [{ id: 'x-status:1', content: 'candidate', source: 'https://x.com/alice/status/1', topics: [] }],
      },
      runTools: {
        searchTopic: async () => ({ items: [] }),
        exploreCandidate: async () => ({ title: 'title', body: 'body', urls: [] }),
        setTheme: async theme => ({ theme }),
        prepareDelivery: async () => ({ ok: true, prepared: 1 }),
      },
      projection: {
        project: async candidateId => { projectCalls.push(candidateId); return projectView },
        lookup: ticketId => { lookupCalls.push(ticketId); return { kind: 'lookup-success', facts: [] } },
      },
    })
    const sessionId = SessionId('session-cron-run-fact-project-lookup-exact')
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
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run exact fact charge probe' }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
      await handle.agent.whenIdle()
      expect(projectCalls).toEqual(['x-status:1'])
      expect(lookupCalls).toEqual(['ticket:1'])
      expect(JSON.stringify(surface.wires)).toContain('\\"kind\\":\\"lookup-success\\"')
      expect(surface.resultBudget.snapshot().fact).toBe(
        Buffer.byteLength(JSON.stringify(projectResult), 'utf8')
        + Buffer.byteLength(JSON.stringify(lookupResult), 'utf8'),
      )
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('stops both fact ports after a lookup exhausts the shared 16K budget', async () => {
    const largeFacts = [{ oversized: 'x'.repeat(20_000) } as never]
    const adapter = new ScriptedToolBatchAdapter([
      [{ id: 'project-1', name: X_CRON_FINAL_PROJECT_TOOL, value: { candidateId: 'x-status:1' } }],
      [{ id: 'lookup-large', name: X_CRON_FINAL_LOOKUP_TOOL, value: { ticketId: 'ticket:1' } }],
      [
        { id: 'project-after-exhaustion', name: X_CRON_FINAL_PROJECT_TOOL, value: { candidateId: 'x-status:2' } },
        { id: 'lookup-after-exhaustion', name: X_CRON_FINAL_LOOKUP_TOOL, value: { ticketId: 'ticket:1' } },
      ],
      [{ id: 'prepare', name: 'x_feed_prepare_delivery', value: { text: finalText, urls: ['https://x.com/alice/status/1'] } }],
    ])
    const projectCalls: string[] = []
    const lookupCalls: string[] = []
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: 'run-fact-lookup-exhaustion',
        allowedTopics: [],
        candidates: [
          { id: 'x-status:1', content: 'one', source: 'https://x.com/alice/status/1', topics: [] },
          { id: 'x-status:2', content: 'two', source: 'https://x.com/alice/status/2', topics: [] },
        ],
      },
      runTools: {
        searchTopic: async () => ({ items: [] }),
        exploreCandidate: async () => ({ title: 'title', body: 'body', urls: [] }),
        setTheme: async theme => ({ theme }),
        prepareDelivery: async () => ({ ok: true, prepared: 1 }),
      },
      projection: {
        project: async candidateId => {
          projectCalls.push(candidateId)
          return { facts: [], tickets: [{ ticketId: 'ticket:1' } as never], serializedBytes: new Uint8Array() }
        },
        lookup: ticketId => { lookupCalls.push(ticketId); return { kind: 'lookup-success', facts: largeFacts } },
      },
    })
    const sessionId = SessionId('session-cron-run-fact-lookup-exhaustion')
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
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run fact exhaustion probe' }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
      await handle.agent.whenIdle()
      expect(projectCalls).toEqual(['x-status:1'])
      expect(lookupCalls).toEqual(['ticket:1'])
      expect(surface.resultBudget.canInvoke('fact')).toBe(false)
      expect(surface.resultBudget.snapshot().fact).toBeLessThanOrEqual(16_000)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('charges control exhaustion and makes later theme/prepare calls zero-port without attempts', async () => {
    const giantTheme = 'theme-'.concat('x'.repeat(1_500))
    const budgetFailure = {
      ok: false as const,
      code: 'tool-result-budget-exhausted',
      message: 'This model-result partition has exhausted its byte budget.',
    }
    const adapter = new ScriptedToolBatchAdapter([
      [{ id: 'theme-1', name: 'x_feed_set_run_theme', value: { theme: giantTheme } }],
      [{ id: 'prepare-1', name: 'x_feed_prepare_delivery', value: { text: finalText, urls: ['https://x.com/alice/status/1'] } }],
    ])
    const themeCalls: string[] = []
    const prepareCalls: string[] = []
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: 'run-result-budget-control',
        allowedTopics: [giantTheme],
        candidates: [{ id: 'candidate-1', content: 'candidate', source: 'https://x.com/alice/status/1', topics: [giantTheme] }],
      },
      runTools: {
        searchTopic: async () => ({ items: [] }),
        exploreCandidate: async () => ({ title: 'title', body: 'body', urls: [] }),
        setTheme: async theme => { themeCalls.push(theme); return { theme } },
        prepareDelivery: async () => { prepareCalls.push('port'); return { ok: true, prepared: 1 } },
      },
      projection: {
        project: async () => ({ facts: [], tickets: [], serializedBytes: new Uint8Array() }),
        lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
      },
    })
    const sessionId = SessionId('session-cron-run-result-budget-control')
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
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run control result budget probe' }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
      await handle.agent.whenIdle()
      expect(themeCalls).toHaveLength(1)
      expect(prepareCalls).toEqual([])
      expect(surface.prepareAttempts).toBe(0)
      expect(surface.resultBudget.snapshot().control).toBe(Buffer.byteLength(JSON.stringify(budgetFailure), 'utf8'))
      expect(surface.resultBudget.canInvoke('control')).toBe(false)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it.each([
    ['tool contamination', (agent: Agent) => {
      agent.ctx.tools.register({
        name: 'contaminated_final_tool',
        description: 'must not reach the final Agent adapter',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'contamination' }] },
        execute: async () => 'contamination',
      } satisfies ToolDefinition)
    }],
  ] as const)('rejects %s in the real llm/stream seam before invoking the adapter', async (_mode, contaminate) => {
    const adapter = new CountingFinalWireAdapter()
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: 'run-wire-guard',
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
    const sessionId = SessionId('session-cron-run-wire-guard')
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
      contaminate(handle.agent)
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'drive contaminated final wire' }],
        source: { kind: 'plugin', plugin: 'dsh-cron' },
      }))
      await handle.agent.whenIdle()
      expect(adapter.requests, 'first assertion: contaminated request must not reach downstream adapter').toHaveLength(0)
      expect(surface.wires).toHaveLength(1)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('rejects an oversize second wire after a normal first request, before the second adapter call', async () => {
    const adapter = new OversizeToolLoopAdapter()
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: 'run-wire-oversize',
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
    const sessionId = SessionId('session-cron-run-wire-oversize')
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
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'drive oversize final wire' }],
        source: { kind: 'plugin', plugin: 'dsh-cron' },
      }))
      await handle.agent.whenIdle()
      expect(adapter.requests, 'first assertion: only the normal first request reaches downstream adapter').toHaveLength(1)
      expect(surface.wires).toHaveLength(2)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('replays fifteen real Agent requests with correction at step fourteen and final text at step fifteen', async () => {
    const adapter = new FifteenStepReplayAdapter()
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      id: `x-status:${index + 1}`,
      content: 'candidate-content-'.concat('c'.repeat(430)),
      source: `https://x.com/alice/status/${index + 1}`,
      topics: ['agentic systems'],
    }))
    const prepareCalls: string[] = []
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: { runId: 'run-fifteen-step-replay', allowedTopics: ['agentic systems'], candidates },
      runTools: {
        searchTopic: async () => ({ items: [] }),
        exploreCandidate: async () => ({ title: 'candidate', body: 'body', urls: [] }),
        setTheme: async theme => ({ theme }),
        prepareDelivery: async text => {
          prepareCalls.push(text)
          if (prepareCalls.length === 1) return { ok: false, code: 'invalid-output', message: 'correction required' }
          return { ok: true, prepared: 1 }
        },
      },
      projection: {
        project: async () => ({ facts: [], tickets: [], serializedBytes: new Uint8Array() }),
        lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
      },
    })
    const sessionId = SessionId('session-cron-run-fifteen-step-replay')
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
      const firstSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run fifteen-step replay' }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
      await handle.agent.whenIdle()
      const outcome = summarizeTurn(handle.agent.session.events, firstSeq)
      surface.finalizeOutcome(outcome)
      const finalWire = surface.wires[14]!
      const requestBytes = Buffer.byteLength(JSON.stringify(finalWire), 'utf8')
      const assistantHistoryBytes = Buffer.byteLength(JSON.stringify(finalWire.messages.filter(message => !message.content.some(block => block.type === 'text' && block.text === surface.materialText))), 'utf8')
      const synthetic24kWire = wireWithSyntheticToolHistory(finalWire, 24_000)
      const synthetic48kWire = wireWithSyntheticToolHistory(finalWire, 48_000)
      const synthetic24kBytes = Buffer.byteLength(JSON.stringify(synthetic24kWire), 'utf8')
      const synthetic48kBytes = Buffer.byteLength(JSON.stringify(synthetic48kWire), 'utf8')
      expect(adapter.requests).toHaveLength(15)
      expect(surface.wires).toHaveLength(15)
      expect(prepareCalls).toEqual(['invalid-output-'.concat('x'.repeat(5_000)), finalText])
      expect(outcome.text).toBe(finalText)
      expect(surface.resultBudget.snapshot()).toEqual({ optional: 0, fact: 1_296, control: 108, total: 1_404 })
      expect(requestBytes).toBe(71_771)
      expect(requestBytes).toBeLessThan(96_000)
      expect(Buffer.byteLength(surface.materialText, 'utf8')).toBeGreaterThan(10_000)
      expect(Buffer.byteLength(surface.materialText, 'utf8')).toBeLessThan(12_000)
      expect(assistantHistoryBytes).toBe(56_947)
      expect(synthetic24kBytes).toBe(95_771)
      expect(synthetic48kBytes).toBe(119_771)
      expect(synthetic24kBytes).toBeLessThan(96_000)
      expect(synthetic48kBytes).toBeGreaterThan(96_000)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('rejects a 48KB model-visible tool-history replay before adapter dispatch', async () => {
    const adapter = new FortyEightKilobyteToolHistoryAdapter()
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      id: `x-status:${index + 1}`,
      content: 'candidate-content-'.concat('c'.repeat(430)),
      source: `https://x.com/alice/status/${index + 1}`,
      topics: ['agentic systems'],
    }))
    const prepareCalls: string[] = []
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: { runId: 'run-forty-eight-kilobyte-history', allowedTopics: ['agentic systems'], candidates },
      runTools: {
        searchTopic: async () => ({ items: [] }),
        exploreCandidate: async () => ({ title: 'candidate', body: 'body', urls: [] }),
        setTheme: async theme => ({ theme }),
        prepareDelivery: async text => {
          prepareCalls.push(text)
          return { ok: false, code: 'invalid-output', message: 'correction required' }
        },
      },
      projection: {
        project: async () => ({ facts: [], tickets: [], serializedBytes: new Uint8Array() }),
        lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
      },
    })
    const sessionId = SessionId('session-cron-run-forty-eight-kilobyte-history')
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
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run 48KB history counterexample' }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
      await handle.agent.whenIdle()
      const oversizedWire = surface.wires[13]!
      const oversizedBytes = Buffer.byteLength(JSON.stringify(oversizedWire), 'utf8')
      expect(oversizedBytes).toBe(114_142)
      expect(Buffer.byteLength(JSON.stringify(oversizedWire), 'utf8')).toBeGreaterThan(96_000)
      expect(adapter.requests).toHaveLength(13)
      expect(surface.wires).toHaveLength(14)
      expect(prepareCalls).toHaveLength(1)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

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

  it('allows exactly one prepare correction after invalid-output and finalizes the corrected success', async () => {
    const adapter = new (class extends LlmAdapter {
      readonly requests: GenerateOptions[] = []
      private step = 0

      override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
        return Promise.resolve({ provider, id: model, name: model })
      }

      override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        this.requests.push(request)
        this.step += 1
        if (this.step === 1 || this.step === 2) {
          yield* toolCall(`prepare-correction-${this.step}`, 'x_feed_prepare_delivery', {
            text: finalText,
            urls: ['https://x.com/alice/status/1'],
          })
          return
        }
        yield* textReply(finalText)
      }
    })()
    const prepareCalls: Array<{ text: string; urls: readonly string[] }> = []
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: 'run-prepare-correction',
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
        prepareDelivery: async (text, urls) => {
          prepareCalls.push({ text, urls })
          return prepareCalls.length === 1
            ? { ok: false, code: 'invalid-output', message: 'output lists need correction' }
            : { ok: true, prepared: 1 }
        },
      },
      projection: {
        project: async () => ({ facts: [], tickets: [], serializedBytes: new Uint8Array() }),
        lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
      },
    })
    const sessionId = SessionId('session-cron-run-prepare-correction')
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
        content: [{ type: 'text', text: 'run prepare correction' }],
        source: { kind: 'plugin', plugin: 'dsh-cron' },
      }))
      await handle.agent.whenIdle()
      const outcome = summarizeTurn(handle.agent.session.events, firstSeq)
      surface.finalizeOutcome(outcome)
      expect(surface.prepareAttempts).toBe(2)
      expect(surface.prepared).toHaveLength(1)
      expect(prepareCalls).toHaveLength(2)
      expect(outcome.text).toBe(finalText)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('allows one prepare correction after a narrow invalid-output throw and bounds its message', async () => {
    const adapter = new (class extends LlmAdapter {
      private step = 0

      override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
        return Promise.resolve({ provider, id: model, name: model })
      }

      override async *stream(): AsyncIterable<StreamChunk> {
        this.step += 1
        if (this.step <= 2) {
          yield* toolCall(`prepare-invalid-throw-${this.step}`, 'x_feed_prepare_delivery', {
            text: finalText,
            urls: ['https://x.com/alice/status/1'],
          })
          return
        }
        yield* textReply(finalText)
      }
    })()
    const prepareCalls: Array<{ text: string; urls: readonly string[] }> = []
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: 'run-prepare-invalid-throw',
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
        prepareDelivery: async (text, urls) => {
          prepareCalls.push({ text, urls })
          if (prepareCalls.length === 1) {
            throw Object.assign(new Error('x'.repeat(1_000)), { code: 'invalid-output' })
          }
          return { ok: true, prepared: 1 }
        },
      },
      projection: {
        project: async () => ({ facts: [], tickets: [], serializedBytes: new Uint8Array() }),
        lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
      },
    })
    const sessionId = SessionId('session-cron-run-prepare-invalid-throw')
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
      const firstSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'run prepare invalid throw' }],
        source: { kind: 'plugin', plugin: 'dsh-cron' },
      }))
      await handle.agent.whenIdle()
      const outcome = summarizeTurn(handle.agent.session.events, firstSeq)
      surface.finalizeOutcome(outcome)
      expect(surface.prepareAttempts).toBe(2)
      expect(surface.prepareFailed).toBe(false)
      expect(surface.prepared).toHaveLength(1)
      expect(prepareCalls).toHaveLength(2)
      const invalidFailure = surface.wires
        .flatMap(wire => wire.messages)
        .find(message => message !== undefined && JSON.stringify(message).includes('invalid-output'))
      expect(invalidFailure).toBeDefined()
      expect(JSON.stringify(invalidFailure)).toContain('invalid-output')
      const boundedMessage = JSON.stringify(invalidFailure).match(/x{10,}/)?.[0] ?? ''
      expect(new TextEncoder().encode(boundedMessage).length).toBeLessThanOrEqual(256)
      expect(outcome.text).toBe(finalText)
      expect(surface.resultBudget.snapshot().control).toBeGreaterThan(0)
      expect(surface.resultBudget.snapshot().control).toBeLessThanOrEqual(1_000)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('covers twenty candidates through legal batched tools in six model requests', async () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      id: `x-status:${index + 1}`,
      content: `candidate ${index + 1}`,
      source: `https://x.com/alice/status/${index + 1}`,
      topics: ['agentic systems'],
    }))
    const adapter = new ScriptedToolBatchAdapter([
      candidates.map(candidate => ({ id: `project-${candidate.id}`, name: X_CRON_FINAL_PROJECT_TOOL, value: { candidateId: candidate.id } })),
      candidates.map(candidate => ({ id: `explore-${candidate.id}`, name: 'x_feed_explore_candidate', value: { candidateId: candidate.id } })),
      [{ id: 'search-topic', name: 'x_feed_search_topic', value: { topic: 'agentic systems' } }],
      [{ id: 'set-theme', name: 'x_feed_set_run_theme', value: { theme: 'agentic systems' } }],
      [{ id: 'prepare-batch', name: 'x_feed_prepare_delivery', value: { text: finalText, urls: ['https://x.com/alice/status/1'] } }],
    ])
    const projectCalls: string[] = []
    const exploreCalls: string[] = []
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: { runId: 'run-batch-20', allowedTopics: ['agentic systems'], candidates },
      runTools: {
        searchTopic: async () => ({ items: [] }),
        exploreCandidate: async candidateId => {
          exploreCalls.push(candidateId)
          return { title: candidateId, body: 'body', urls: [] }
        },
        setTheme: async theme => ({ theme }),
        prepareDelivery: async () => ({ ok: true, prepared: 1 }),
      },
      projection: {
        project: async candidateId => {
          projectCalls.push(candidateId)
          return { facts: [], tickets: [], serializedBytes: new Uint8Array() }
        },
        lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
      },
    })
    const sessionId = SessionId('session-cron-run-batch-20')
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
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run twenty candidate batch' }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
      await handle.agent.whenIdle()
      const outcome = summarizeTurn(handle.agent.session.events, firstSeq)
      surface.finalizeOutcome(outcome)
      expect(adapter.requests.length).toBeLessThanOrEqual(8)
      expect(adapter.requests).toHaveLength(6)
      expect(projectCalls).toHaveLength(20)
      expect(exploreCalls).toHaveLength(20)
      expect(new Set(projectCalls).size).toBe(20)
      expect(new Set(exploreCalls).size).toBe(20)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('fails closed and avoids ports for repeated or unallowlisted keyed calls', async () => {
    const adapter = new ScriptedToolBatchAdapter([
      [
        { id: 'search-1', name: 'x_feed_search_topic', value: { topic: 'agentic systems' } },
        { id: 'search-repeat', name: 'x_feed_search_topic', value: { topic: 'agentic systems' } },
        { id: 'search-other', name: 'x_feed_search_topic', value: { topic: 'not-allowed' } },
      ],
      [
        { id: 'explore-1', name: 'x_feed_explore_candidate', value: { candidateId: 'x-status:1' } },
        { id: 'explore-repeat', name: 'x_feed_explore_candidate', value: { candidateId: 'x-status:1' } },
        { id: 'explore-other', name: 'x_feed_explore_candidate', value: { candidateId: 'x-status:2' } },
      ],
      [
        { id: 'project-1', name: X_CRON_FINAL_PROJECT_TOOL, value: { candidateId: 'x-status:1' } },
        { id: 'project-repeat', name: X_CRON_FINAL_PROJECT_TOOL, value: { candidateId: 'x-status:1' } },
        { id: 'project-other', name: X_CRON_FINAL_PROJECT_TOOL, value: { candidateId: 'x-status:2' } },
      ],
      [{ id: 'lookup-other', name: X_CRON_FINAL_LOOKUP_TOOL, value: { ticketId: 'ticket:other' } }],
      [
        { id: 'lookup-1', name: X_CRON_FINAL_LOOKUP_TOOL, value: { ticketId: 'ticket:1' } },
        { id: 'lookup-repeat', name: X_CRON_FINAL_LOOKUP_TOOL, value: { ticketId: 'ticket:1' } },
      ],
      [{ id: 'theme-other', name: 'x_feed_set_run_theme', value: { theme: 'not-allowed' } }],
      [{ id: 'theme-1', name: 'x_feed_set_run_theme', value: { theme: 'agentic systems' } }],
      [{ id: 'theme-2', name: 'x_feed_set_run_theme', value: { theme: 'agentic systems' } }],
      [{ id: 'theme-repeat', name: 'x_feed_set_run_theme', value: { theme: 'agentic systems' } }],
    ])
    const calls = { search: [] as string[], explore: [] as string[], project: [] as string[], lookup: [] as string[], theme: [] as string[] }
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: 'run-keyed-budgets',
        allowedTopics: ['agentic systems'],
        candidates: [{ id: 'x-status:1', content: 'one', source: 'https://x.com/alice/status/1', topics: ['agentic systems'] }],
      },
      runTools: {
        searchTopic: async topic => { calls.search.push(topic); return { items: [] } },
        exploreCandidate: async candidateId => { calls.explore.push(candidateId); return { title: candidateId, body: 'body', urls: [] } },
        setTheme: async theme => {
          calls.theme.push(theme)
          return calls.theme.length === 1
            ? { ok: false, code: 'theme-failed', message: 'first theme attempt needs correction' }
            : { theme }
        },
        prepareDelivery: async () => ({ ok: true, prepared: 1 }),
      },
      projection: {
        project: async candidateId => {
          calls.project.push(candidateId)
          return { facts: [], tickets: [{ ticketId: 'ticket:1' } as never], serializedBytes: new Uint8Array() }
        },
        lookup: ticketId => { calls.lookup.push(ticketId); return { kind: 'lookup-success', facts: [] } },
      },
    })
    const sessionId = SessionId('session-cron-run-keyed-budgets')
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
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run keyed budget probe' }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
      await handle.agent.whenIdle()
      expect(calls.search).toEqual(['agentic systems'])
      expect(calls.explore).toEqual(['x-status:1'])
      expect(calls.project).toEqual(['x-status:1'])
      expect(calls.lookup).toEqual(['ticket:1'])
      expect(calls.theme).toEqual(['agentic systems', 'agentic systems'])
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it.each(['non-invalid failure', 'success', 'raw throw', 'invalid twice'] as const)('locks prepare after %s and makes the rejected repeat a zero-port call', async mode => {
    const prepareCallsScript = [
      [{ id: 'prepare-first', name: 'x_feed_prepare_delivery', value: { text: finalText, urls: ['https://x.com/alice/status/1'] } }],
      [{ id: 'prepare-repeat', name: 'x_feed_prepare_delivery', value: { text: finalText, urls: ['https://x.com/alice/status/1'] } }],
      ...(mode === 'invalid twice' ? [[{ id: 'prepare-third', name: 'x_feed_prepare_delivery', value: { text: finalText, urls: ['https://x.com/alice/status/1'] } }]] : []),
    ] as const
    const adapter = new ScriptedToolBatchAdapter(prepareCallsScript)
    const prepareCalls: string[] = []
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: `run-prepare-lock-${mode}`,
        allowedTopics: ['agentic systems'],
        candidates: [{ id: 'x-status:1', content: 'one', source: 'https://x.com/alice/status/1', topics: ['agentic systems'] }],
      },
      runTools: {
        searchTopic: async () => ({ items: [] }),
        exploreCandidate: async () => ({ title: 'one', body: 'body', urls: [] }),
        setTheme: async theme => ({ theme }),
        prepareDelivery: async () => {
          prepareCalls.push(mode)
          if (mode === 'raw throw') throw new Error('raw prepare crash')
          if (mode === 'invalid twice') return { ok: false, code: 'invalid-output', message: 'output lists need correction' }
          return mode === 'non-invalid failure'
            ? { ok: false, code: 'prepare-failed', message: 'fixed Python port failed' }
            : { ok: true, prepared: 1 }
        },
      },
      projection: {
        project: async () => ({ facts: [], tickets: [], serializedBytes: new Uint8Array() }),
        lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
      },
    })
    const sessionId = SessionId(`session-cron-run-prepare-lock-${mode.replaceAll(' ', '-')}`)
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
      const firstSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: `run prepare ${mode}` }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
      await handle.agent.whenIdle()
      expect(prepareCalls).toHaveLength(mode === 'invalid twice' ? 2 : 1)
      expect(surface.prepareAttempts).toBe(mode === 'invalid twice' ? 2 : 1)
      if (mode === 'success') expect(surface.prepared).toHaveLength(1)
      else expect(surface.prepareFailed).toBe(true)
      expect(() => surface.finalizeOutcome(summarizeTurn(handle.agent.session.events, firstSeq))).toThrow()
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('keeps a concurrent theme call zero-port while allowing the next request after the first failure', async () => {
    const adapter = new ScriptedToolBatchAdapter([
      [
        { id: 'theme-first', name: 'x_feed_set_run_theme', value: { theme: 'agentic systems' } },
        { id: 'theme-concurrent', name: 'x_feed_set_run_theme', value: { theme: 'agentic systems' } },
      ],
      [{ id: 'theme-retry', name: 'x_feed_set_run_theme', value: { theme: 'agentic systems' } }],
    ])
    const themeCalls: string[] = []
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: 'run-theme-in-flight',
        allowedTopics: ['agentic systems'],
        candidates: [{ id: 'x-status:1', content: 'one', source: 'https://x.com/alice/status/1', topics: ['agentic systems'] }],
      },
      runTools: {
        searchTopic: async () => ({ items: [] }),
        exploreCandidate: async () => ({ title: 'one', body: 'body', urls: [] }),
        setTheme: async theme => {
          themeCalls.push(theme)
          await new Promise(resolve => setTimeout(resolve, 20))
          return themeCalls.length === 1
            ? { ok: false, code: 'theme-failed', message: 'first theme attempt needs correction' }
            : { theme }
        },
        prepareDelivery: async () => ({ ok: true, prepared: 1 }),
      },
      projection: {
        project: async () => ({ facts: [], tickets: [], serializedBytes: new Uint8Array() }),
        lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
      },
    })
    const sessionId = SessionId('session-cron-run-theme-in-flight')
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
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run theme in-flight probe' }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
      await handle.agent.whenIdle()
      expect(themeCalls).toHaveLength(2)
      expect(themeCalls).toEqual(['agentic systems', 'agentic systems'])
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('locks a concurrent prepare call and never sends it to the underlying port', async () => {
    const adapter = new ScriptedToolBatchAdapter([[
      { id: 'prepare-first-in-flight', name: 'x_feed_prepare_delivery', value: { text: finalText, urls: ['https://x.com/alice/status/1'] } },
      { id: 'prepare-concurrent', name: 'x_feed_prepare_delivery', value: { text: finalText, urls: ['https://x.com/alice/status/1'] } },
    ]])
    const prepareCalls: string[] = []
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: 'run-prepare-in-flight',
        allowedTopics: ['agentic systems'],
        candidates: [{ id: 'x-status:1', content: 'one', source: 'https://x.com/alice/status/1', topics: ['agentic systems'] }],
      },
      runTools: {
        searchTopic: async () => ({ items: [] }),
        exploreCandidate: async () => ({ title: 'one', body: 'body', urls: [] }),
        setTheme: async theme => ({ theme }),
        prepareDelivery: async () => {
          prepareCalls.push('port')
          await new Promise(resolve => setTimeout(resolve, 20))
          return { ok: true, prepared: 1 }
        },
      },
      projection: {
        project: async () => ({ facts: [], tickets: [], serializedBytes: new Uint8Array() }),
        lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
      },
    })
    const sessionId = SessionId('session-cron-run-prepare-in-flight')
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
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run prepare in-flight probe' }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
      await handle.agent.whenIdle()
      expect(prepareCalls).toHaveLength(1)
      expect(surface.prepareAttempts).toBe(1)
      expect(surface.prepareFailed).toBe(true)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('rejects the seventeenth model request before downstream adapter dispatch', async () => {
    const adapter = new SixteenRequestLoopAdapter()
    const ctx = await harness(adapter)
    const surface = new XFeedFinalAgentSurface({
      material: {
        runId: 'run-request-budget',
        allowedTopics: ['agentic systems'],
        candidates: [{ id: 'x-status:1', content: 'one', source: 'https://x.com/alice/status/1', topics: ['agentic systems'] }],
      },
      runTools: {
        searchTopic: async () => ({ items: [] }),
        exploreCandidate: async () => ({ title: 'one', body: 'body', urls: [] }),
        setTheme: async theme => ({ theme }),
        prepareDelivery: async () => ({ ok: true, prepared: 1 }),
      },
      projection: {
        project: async () => ({ facts: [], tickets: [], serializedBytes: new Uint8Array() }),
        lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
      },
    })
    const sessionId = SessionId('session-cron-run-request-budget')
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
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run request budget probe' }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
      await handle.agent.whenIdle()
      expect(adapter.requests).toHaveLength(16)
      expect(surface.wires).toHaveLength(17)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
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
