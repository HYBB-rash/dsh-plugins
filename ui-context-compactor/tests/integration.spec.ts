import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import * as CompactionBasicInvariant from '@deepseek-ai/dsh-compaction-basic/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import {
  CallId,
  createUserMessage,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as ToolSessionQuery from '@deepseek-ai/dsh-tool-session-query'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as ContextRoutePlugin from '../src/index.ts'
import * as RouteInvariant from '../src/invariant.ts'
import {
  assertRouteFreshForCompaction,
  completedTurnsSinceLastSuccessfulCompaction,
  foldRoute,
  ROUTE_CONTEXT_SOURCE,
  type Config as ContextRouteConfig,
  type RouteBody,
  type RouteSnapshot,
} from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallChunks(rawCallId: string, name: string, argumentsJson: string): StreamChunk[] {
  const callId = CallId(rawCallId)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name, arguments: argumentsJson },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function messageText(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content)
    .flatMap((block) => {
      if (block.type === 'text') return [block.text]
      if (block.type === 'tool-result') {
        return block.content.filter(item => item.type === 'text').map(item => item.text)
      }
      return []
    })
    .join('\n')
}

function modelInput(options: GenerateOptions): string {
  return messageText(options.messages)
}

function sourceSeqs(material: string, source: 'user' | 'assistant'): number[] {
  return [...material.matchAll(new RegExp(`\\[seq (\\d+) ${source}\\]`, 'g'))]
    .map(match => Number(match[1]))
}

function previousSnapshot(material: string): RouteSnapshot | undefined {
  const match = /^PREVIOUS_ROUTE_SNAPSHOT\n([\s\S]*?)\n\nNEW_OR_BOOTSTRAP_SOURCE_EVENTS\n/.exec(material)
  if (match?.[1] === undefined || match[1] === 'null') return undefined
  return JSON.parse(match[1]) as RouteSnapshot
}

function initialReducerBody(material: string): RouteBody {
  const users = sourceSeqs(material, 'user')
  const assistants = sourceSeqs(material, 'assistant')
  const root = users[0]
  const latestAssistant = assistants.at(-1)
  if (root === undefined || latestAssistant === undefined) throw new Error('test reducer lacks source seqs')
  return {
    rootGoal: { text: '让长会话在多次压缩后仍知道正确路线', sourceSeqs: [root] },
    successCriteria: [{ text: '压缩后保持当前路线并能找回原始细节', sourceSeqs: [root] }],
    currentRoute: {
      text: '路线 A',
      reason: '先用薄实现验证闭环',
      status: 'tentative',
      sourceSeqs: [latestAssistant],
    },
    decisions: [],
    retiredRoutes: [],
    currentNode: { text: '完成第一轮实现', sourceSeqs: [latestAssistant] },
    nextDecision: { text: '等待用户是否纠正路线', sourceSeqs: [latestAssistant] },
    reviewTriggers: [{ text: '用户明确纠正路线时立即更新', sourceSeqs: [root] }],
    detailRefs: [{
      label: '根目标原文',
      why: '核对会话边界',
      sourceSeqs: [root],
      preferredSourceKinds: ['user'],
    }],
  }
}

function reducerBody(material: string): RouteBody {
  const previous = previousSnapshot(material)
  if (previous === undefined) return initialReducerBody(material)
  if (!material.includes('确认改走路线 B')) {
    const { revision: _revision, asOfSeq: _asOfSeq, ...body } = previous
    return body
  }
  const correction = sourceSeqs(material, 'user').at(-1)
  if (correction === undefined) throw new Error('test reducer lacks correction seq')
  return {
    rootGoal: previous.rootGoal,
    successCriteria: previous.successCriteria,
    currentRoute: {
      text: '路线 B',
      reason: '用户明确纠正并确认了新路线',
      status: 'confirmed',
      sourceSeqs: [correction],
    },
    decisions: [{
      text: '确认使用路线 B',
      status: 'confirmed',
      sourceSeqs: [correction],
    }],
    retiredRoutes: [{
      text: previous.currentRoute.text,
      reason: '被用户的新明确决定替代',
      status: 'superseded',
      sourceSeqs: [correction],
    }],
    currentNode: { text: '验证路线 B 经连续压缩后仍保持当前', sourceSeqs: [correction] },
    nextDecision: null,
    reviewTriggers: previous.reviewTriggers,
    detailRefs: [{
      label: '路线纠正原文',
      why: '发生路线冲突时核对最新决定',
      sourceSeqs: [correction],
      preferredSourceKinds: ['user'],
    }],
  }
}

class RouteAwareAdapter extends LlmAdapter {
  readonly conversationRequests: GenerateOptions[] = []
  readonly reducerRequests: GenerateOptions[] = []
  secretReducerCall: number | undefined
  toolConversationSteps = 0
  toolConversationName = 'route_probe'

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 100_000 },
      reasoning: {
        efforts: [{ id: ReasoningEffortId('off'), name: 'off' }],
      },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.system?.includes('Return exactly one JSON object and nothing else.') === true) {
      this.reducerRequests.push(options)
      const call = this.reducerRequests.length
      const output = this.secretReducerCall === call
        ? '{"currentNode":{"text":"password=super-secret-value"}}'
        : JSON.stringify(reducerBody(modelInput(options)))
      yield* textChunks(output)
      return
    }
    this.conversationRequests.push(options)
    if (this.toolConversationSteps > 0) {
      this.toolConversationSteps -= 1
      const step = this.conversationRequests.length
      yield* toolCallChunks(
        `route-probe-${step}`,
        this.toolConversationName,
        JSON.stringify({ step }),
      )
      return
    }
    yield* textChunks(`conversation answer ${this.conversationRequests.length}`)
  }
}

class DeterministicCompactionEngine extends BasicCompactionEngine {
  summaries = 0
  summaryFailures = 0

  override async summarize(): Promise<{
    summary: [{ type: 'text'; text: string }]
    provider: string
    model: string
  }> {
    if (this.summaryFailures > 0) {
      this.summaryFailures -= 1
      throw new Error('deterministic summary failure')
    }
    this.summaries += 1
    return {
      summary: [{ type: 'text', text: `working-tail checkpoint ${this.summaries}` }],
      provider: 'test-summary',
      model: 'deterministic',
    }
  }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: RouteAwareAdapter
  readonly compaction: DeterministicCompactionEngine
}

async function harness(config: ContextRouteConfig = {}): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
  await ctx.plugin(CompactionInvariant)
  await ctx.plugin(CompactionBasicInvariant)
  await ctx.plugin(RouteInvariant)
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search' })
  await ctx.plugin(ToolSessionQuery)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(DeterministicCompactionEngine, { auto: false })
  const compaction = ctx.compaction as DeterministicCompactionEngine
  await ctx.plugin(ContextRoutePlugin, { reasoningEffort: 'off', ...config })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new RouteAwareAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId('route-integration'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, adapter, compaction }
}

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
}

describe('single-session context route through the real loop', () => {
  it('updates on progress and correction, survives two real compactions, and retrieves shadowed detail by seq', async () => {
    const h = await harness()
    await send(h.agent, '根目标：让长会话在多次压缩后仍知道正确路线。')
    const first = foldRoute(h.agent.session.events)?.snapshot
    expect(first).toMatchObject({ revision: 1, currentRoute: { text: '路线 A' } })
    expect(h.adapter.reducerRequests[0]?.reasoningEffort).toBe('off')
    const firstRequest = messageText(h.adapter.conversationRequests[0]?.messages ?? [])
    expect(firstRequest).toContain('当前会话路线管理（内部政策）')
    expect(firstRequest).toContain('不要仅为了保存、续接或压缩本 Session 的路线而创建外部路线文件')

    await send(h.agent, '不要继续路线 A，确认改走路线 B。')
    const second = foldRoute(h.agent.session.events)?.snapshot
    expect(second).toMatchObject({ revision: 2, currentRoute: { text: '路线 B', status: 'confirmed' } })
    expect(second?.retiredRoutes).toContainEqual(expect.objectContaining({ text: '路线 A' }))
    expect(messageText(h.adapter.conversationRequests[1]?.messages ?? [])).toContain('当前路线：[tentative] 路线 A')

    await send(h.agent, '继续当前节点。')
    const beforeFirstCompaction = foldRoute(h.agent.session.events)?.snapshot
    expect(beforeFirstCompaction?.revision).toBe(3)
    expect(messageText(h.adapter.conversationRequests[2]?.messages ?? [])).toContain('当前路线：[confirmed] 路线 B')
    expect(() => assertRouteFreshForCompaction(h.agent.session.events)).not.toThrow()

    const rootEvent = h.agent.session.events.find(event =>
      event.type === 'user/message' && event.data.source.kind === 'user')
    if (rootEvent === undefined) {
      throw new Error('expected three real conversation turns')
    }

    const signal = new AbortController().signal
    expect(await h.compaction.compactNow(h.agent, signal)).not.toBeNull()
    expect(foldRoute(h.agent.session.events)?.snapshot).toEqual(beforeFirstCompaction)

    await send(h.agent, '第一次压缩后继续当前节点。')
    const beforeSecondCompaction = foldRoute(h.agent.session.events)?.snapshot
    expect(beforeSecondCompaction?.revision).toBe(4)
    expect(beforeSecondCompaction?.currentRoute.text).toBe('路线 B')
    expect(await h.compaction.compactNow(h.agent, signal)).not.toBeNull()

    expect(h.compaction.summaries).toBe(2)
    expect(foldRoute(h.agent.session.events)?.snapshot).toEqual(beforeSecondCompaction)
    expect(h.agent.session.surface.nodes).not.toContain(rootEvent.seq)
    expect(h.agent.session.events.filter(event => event.type === 'compaction/summary')).toHaveLength(2)
    expect(h.ctx.tools.get('session_event_read', h.agent)).toBeDefined()

    const read = await h.ctx.tools.execute({
      name: 'session_event_read',
      arguments: { seq: rootEvent.seq },
      callId: CallId('read-shadowed-root'),
      signal,
      agent: h.agent,
    })
    const readText = read.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(read.isError).toBe(false)
    expect(readText).toContain('根目标：让长会话在多次压缩后仍知道正确路线。')
    expect(readText).toContain(`seq ${rootEvent.seq}`)
  })

  it('reduces one multi-step tool turn only once after its final conversation step', async () => {
    const h = await harness()
    h.adapter.toolConversationSteps = 2
    h.ctx.tools.register(defineContentToolFixture({
      name: 'route_probe',
      description: 'Return one deterministic route probe result.',
      parameters: { step: { type: 'number', required: true } },
      async execute({ step }) {
        return [{ type: 'text', text: `probe result ${step}` }]
      },
    }))

    await send(h.agent, '根目标：验证一个工具型多步骤轮次只归并一次路线。')

    expect(h.adapter.conversationRequests).toHaveLength(3)
    expect(h.agent.session.events.filter(event => event.type === 'tool/result')).toHaveLength(2)
    expect(h.adapter.reducerRequests).toHaveLength(1)
    expect(h.agent.session.events.filter(event =>
      event.type === 'user/message'
      && event.data.source.kind === ROUTE_CONTEXT_SOURCE)).toHaveLength(1)
    const latestAssistant = [...h.agent.session.events].reverse()
      .find(event => event.type === 'assistant/message')
    expect(foldRoute(h.agent.session.events)?.snapshot.asOfSeq).toBe(latestAssistant?.seq)
  })

  it('keeps the previous route and all raw facts when a secret-like reducer output is rejected', async () => {
    const h = await harness()
    await send(h.agent, '根目标：验证更新失败不会丢历史。')
    const first = foldRoute(h.agent.session.events)?.snapshot
    expect(first?.revision).toBe(1)

    h.adapter.secretReducerCall = 2
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await send(h.agent, '这是新的用户纠正，必须先保留原文。')

    const after = foldRoute(h.agent.session.events)?.snapshot
    expect(after).toEqual(first)
    expect(h.agent.session.events.some(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'user'
      && messageText([event.data]).includes('新的用户纠正'))).toBe(true)
    expect(h.agent.session.events.filter(event =>
      event.type === 'user/message'
      && event.data.source.kind === ROUTE_CONTEXT_SOURCE)).toHaveLength(1)
    expect(JSON.stringify(h.agent.session.events)).not.toContain('super-secret-value')
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('route update failed (secret-like-output)'))
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('super-secret-value')
    expect(() => assertRouteFreshForCompaction(h.agent.session.events)).toThrow(/compaction is blocked/)
  })

  it('feeds the reducer a seq-only placeholder for a large mechanical tool result when enabled', async () => {
    const h = await harness({
      largeToolResultPreprocessing: { enabled: true, minChars: 2_500 },
    })
    h.adapter.toolConversationSteps = 1
    h.adapter.toolConversationName = 'bash'
    h.ctx.tools.register(defineContentToolFixture({
      name: 'bash',
      description: 'Return deterministic long output.',
      parameters: { step: { type: 'number', required: true } },
      async execute() {
        return [{ type: 'text', text: `stdout ${'x'.repeat(4_000)}` }]
      },
    }))

    await send(h.agent, '根目标：验证大型工具结果预处理。')

    const reducerInput = modelInput(h.adapter.reducerRequests[0]!)
    const toolResultSeq = h.agent.session.events.find(event =>
      event.type === 'tool/result'
      && event.data.message.source.kind === 'tool')?.seq

    expect(toolResultSeq).toBeDefined()
    expect(reducerInput).toContain(`[tool result bash elided; original seq ${toolResultSeq}`)
    expect(reducerInput).not.toContain(`stdout ${'x'.repeat(200)}`)
  })

  it('repairs a stale failed revision during the next pre-step before the conversation model runs', async () => {
    const h = await harness()
    await send(h.agent, '根目标：验证失败后可以在下一请求前恢复。')
    h.adapter.secretReducerCall = 2
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await send(h.agent, '不要继续路线 A，确认改走路线 B。')
    expect(foldRoute(h.agent.session.events)?.snapshot.revision).toBe(1)

    h.adapter.secretReducerCall = undefined
    await send(h.agent, '按已确认的新路线继续。')

    expect(messageText(h.adapter.conversationRequests[2]?.messages ?? []))
      .toContain('当前路线：[confirmed] 路线 B')
    expect(foldRoute(h.agent.session.events)?.snapshot).toMatchObject({
      revision: 3,
      currentRoute: { text: '路线 B', status: 'confirmed' },
    })
  })

  it('forces one idle safe compaction after each configured number of completed root turns', async () => {
    const h = await harness({ compactEveryTurns: 3 })
    const compactNow = vi.spyOn(h.compaction, 'compactNow')

    await send(h.agent, '根目标：每三个完整轮次压缩一次。')
    expect(h.compaction.summaries).toBe(0)
    expect(completedTurnsSinceLastSuccessfulCompaction(h.agent.session.events)).toBe(1)

    await send(h.agent, '完成第二个完整轮次。')
    expect(h.compaction.summaries).toBe(0)
    await send(h.agent, '完成第三个完整轮次。')
    expect(compactNow).toHaveBeenCalledTimes(1)
    await expect(compactNow.mock.results[0]!.value).resolves.not.toBeNull()
    expect(h.compaction.summaries).toBe(1)
    expect(completedTurnsSinceLastSuccessfulCompaction(h.agent.session.events)).toBe(0)
    expect(h.agent.session.events.filter(event => event.type === 'compaction/summary')).toHaveLength(1)
    expect(() => assertRouteFreshForCompaction(
      h.agent.session.events,
      h.agent.session.surface.nodes,
    )).not.toThrow()

    await send(h.agent, '完成第四个完整轮次。')
    expect(h.compaction.summaries).toBe(1)
    await send(h.agent, '完成第五个完整轮次。')
    expect(h.compaction.summaries).toBe(1)
    await send(h.agent, '完成第六个完整轮次。')
    expect(h.compaction.summaries).toBe(2)
    expect(h.agent.session.events.filter(event => event.type === 'compaction/summary')).toHaveLength(2)
  })

  it('keeps periodic compaction disabled when compactEveryTurns is omitted', async () => {
    const h = await harness()
    for (let turn = 1; turn <= 5; turn += 1) {
      await send(h.agent, `完成默认关闭验证的第 ${turn} 个轮次。`)
    }
    expect(h.compaction.summaries).toBe(0)
    expect(h.agent.session.events.some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('retains raw history after a periodic summary failure and retries after the next completed turn', async () => {
    const h = await harness({ compactEveryTurns: 3 })
    h.compaction.summaryFailures = 1
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => undefined)

    await send(h.agent, '根目标：验证周期压缩失败后保留原始历史。')
    await send(h.agent, '完成第二个轮次。')
    await send(h.agent, '第三轮会触发一次确定性压缩失败。')

    expect(h.compaction.summaries).toBe(0)
    expect(h.agent.session.events.filter(event => event.type === 'compaction/summary')).toHaveLength(0)
    expect(h.agent.session.events.findLast(event => event.type === 'compaction/end')?.data)
      .toEqual(expect.objectContaining({ error: expect.any(String) }))
    const directUserEvents = h.agent.session.events.filter(event =>
      event.type === 'user/message' && event.data.source.kind === 'user')
    expect(directUserEvents).toHaveLength(3)
    expect(directUserEvents.every(event => h.agent.session.surface.nodes.includes(event.seq))).toBe(true)
    expect(completedTurnsSinceLastSuccessfulCompaction(h.agent.session.events)).toBe(3)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('periodic compaction failed (backend-call)'))

    await send(h.agent, '第四轮完成后只重试一次。')
    expect(h.compaction.summaries).toBe(1)
    expect(completedTurnsSinceLastSuccessfulCompaction(h.agent.session.events)).toBe(0)
    expect(h.agent.session.events.filter(event => event.type === 'compaction/start')).toHaveLength(2)
    expect(h.agent.session.events.filter(event => event.type === 'compaction/summary')).toHaveLength(1)
  })
})
