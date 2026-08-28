import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
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
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as ToolSessionQuery from '@deepseek-ai/dsh-tool-session-query'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import WebRuntime, { type WebSearchRequest } from '@deepseek-ai/dsh-web'
import * as ContextRoutePlugin from '../src/index.ts'
import { ManagedAwareBasicCompactionEngine } from '../src/managed-compaction.ts'
import * as RouteInvariant from '../src/invariant.ts'
import {
  assertRouteFreshForCompaction,
  completedTurnsSinceLastSuccessfulCompaction,
  createRouteRevisionMessage,
  foldRoute,
  P01_USER_WORDS_CONTEXT_NAME,
  parseRouteBody,
  ROUTE_CONTEXT_SOURCE,
  type Config as ContextRouteConfig,
  type RouteBody,
  type RouteSnapshot,
} from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []

const focusDirect = '准备升级 DeepSeek Harness'
const relatedFocusDirect = '继续整理 DeepSeek Harness 升级风险。'
const singleFactDirect = '查一下 DeepSeek Harness 当前最新版本；确认后再决定是否升级。'
const multiFactDirect = '查一下 DeepSeek Harness 当前最新版本和该版本要求的 Node.js 版本；分别确认后再决定是否升级。'
const multiSourceDirect = '查一下 DeepSeek Harness 当前最新版本的两个来源；如果结论冲突，说明冲突并只限制依赖版本结论的行动。'
const releaseFact = 'DeepSeek Harness 最新版本'
const nodeFact = 'DeepSeek Harness 最新版本的 Node.js 版本要求'
const upgradeAction = '升级 DeepSeek Harness'
const compatibilityAction = '核对当前 Node.js 是否兼容'
const readOnlyAction = '列出已确认的只读升级前检查'
const releaseQuery = 'DeepSeek Harness latest version'
const nodeQuery = 'DeepSeek Harness latest version Node.js requirements'
const releaseUrl = 'https://example.test/deepseek-harness/releases/latest'
const secondReleaseUrl = 'https://second.example.test/deepseek-harness/releases/latest'
const nodeUrl = 'https://example.test/deepseek-harness/releases/latest/node-requirements'
const rawMultiSourceEnvelope = 'PRIVATE-RAW-MULTI-SOURCE-ENVELOPE'
const updateBackgroundDirect = '请更新当前背景'
const qualifiedBackgroundSessionId = ContextRoutePlugin.FOCUS_CANARY_IDS[1]!
const unprovableCandidatePresentation = '尚未形成候选目前无法证明合格：完整候选超出已知安全余量。影响范围：候选资格整体。'
const p01SessionId = 'session-2ad8a3dd-1e0b-4126-aca8-4f129ad02b54'
const p01OldWords = 'P01-旧原话-蓝瓷杯：我把庭院钥匙放在蓝色瓷杯后面。'
const p01Config = Object.freeze({
  p01UserWordsView: Object.freeze({
    mode: 'enforce' as const,
    allowlist: Object.freeze([p01SessionId]),
  }),
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
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

function occurrenceCount(value: string, needle: string): number {
  return value.split(needle).length - 1
}

function p01ViewCarriers(options: GenerateOptions): string[] {
  return options.messages.flatMap((message) => {
    const source = message.source
    if (source.kind !== 'plugin'
      || source.plugin !== '@deepseek-ai/dsh-system-prompt'
      || source.form !== 'snapshot'
      || !source.sections.some(section => section.name === P01_USER_WORDS_CONTEXT_NAME)) return []
    return [messageText([message])]
  })
}

function hasSchema(options: GenerateOptions, plugin: string): boolean {
  return options.messages.some(message => message.source.kind === 'plugin'
    && message.source.plugin === plugin)
}

function candidateQualificationMessages(events: readonly SessionEvent[]): readonly Message[] {
  return events.flatMap(event => event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === 'ui-context-compactor:candidate-qualification'
    ? [event.data]
    : [])
}

function canonicalMessages(events: readonly SessionEvent[]): readonly Message[] {
  return events.flatMap(event => event.type === 'user/message'
    && event.data.source.kind === 'context-manager-canonical'
    ? [event.data]
    : [])
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function storedFocusRecord(path: string, key: string): Record<string, unknown> | undefined {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const row = object(database.prepare(
      'SELECT value FROM "u_context_manager_focus_precanonical" WHERE key = ?',
    ).get(key))
    if (row === undefined) return undefined
    if (typeof row.value !== 'string') throw new Error('stored focus record is not JSON text')
    return object(JSON.parse(row.value))
  } finally {
    database.close()
  }
}

class NaturalEvidenceAdapter extends LlmAdapter {
  readonly rootRequests: GenerateOptions[] = []
  focusCalls = 0
  relationCalls = 0
  actionCalls = 0
  evidenceCalls = 0
  singleVersion = '1.4.2'
  evidenceMode: 'single' | 'multi_fact' | 'multi_source' = 'single'

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 16_384 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (hasSchema(options, 'ui-context-compactor:focus-canary-schema')) {
      this.focusCalls += 1
      yield* textChunks(JSON.stringify({ kind: 'focus', subject: focusDirect, relation: 'new' }))
      return
    }
    if (hasSchema(options, 'ui-context-compactor:existing-focus-relation-schema')) {
      this.relationCalls += 1
      const projection = object(JSON.parse(messageText(options.messages.slice(1))))
      const focus = object(projection?.focus)
      yield* textChunks(JSON.stringify({
        kind: 'existing_focus_relation', focus: focus?.ref, relation: 'related',
      }))
      return
    }
    if (hasSchema(options, 'ui-context-compactor:action-fact-need-schema')) {
      this.actionCalls += 1
      const multi = modelInput(options).includes(multiFactDirect)
      const multiSource = modelInput(options).includes(multiSourceDirect)
      this.evidenceMode = multiSource ? 'multi_source' : multi ? 'multi_fact' : 'single'
      yield* textChunks(JSON.stringify(multiSource ? {
        actions: [upgradeAction, readOnlyAction],
        proposedRequirements: [{ fact: releaseFact, neededFor: [upgradeAction] }],
        usableInputs: [],
        unresolvedInputs: [
          { fact: releaseFact, meaning: '版本尚未核清', source: 'direct-user', degree: 'unknown', affected: upgradeAction },
        ],
      } : multi ? {
        actions: [upgradeAction, compatibilityAction, readOnlyAction],
        proposedRequirements: [
          { fact: releaseFact, neededFor: [upgradeAction] },
          { fact: nodeFact, neededFor: [upgradeAction, compatibilityAction] },
        ],
        usableInputs: [],
        unresolvedInputs: [
          { fact: releaseFact, meaning: '版本尚未核清', source: 'direct-user', degree: 'unknown', affected: upgradeAction },
          { fact: nodeFact, meaning: 'Node.js 要求尚未核清', source: 'direct-user', degree: 'unknown', affected: `${upgradeAction}|${compatibilityAction}` },
        ],
      } : {
        actions: [upgradeAction],
        proposedRequirements: [{ fact: releaseFact, neededFor: [upgradeAction] }],
        usableInputs: [],
        unresolvedInputs: [
          { fact: releaseFact, meaning: '版本尚未核清', source: 'direct-user', degree: 'unknown', affected: upgradeAction },
        ],
      }))
      return
    }
    if (hasSchema(options, 'ui-context-compactor:evidence-schema')) {
      this.evidenceCalls += 1
      const projectionMessage = options.messages[1]
      const projection = object(JSON.parse(messageText(
        projectionMessage === undefined ? options.messages : [projectionMessage],
      )))
      const material = object(projection?.material)
      const fact = projection?.fact
      if (this.evidenceMode === 'multi_source') {
        const second = material?.url === secondReleaseUrl
        yield* textChunks(JSON.stringify({
          kind: 'direct_fact',
          fact,
          conclusion: second ? 'DeepSeek Harness preview 当前版本为 1.5.0-beta' : 'DeepSeek Harness 当前稳定版本为 1.4.2',
          appliesWhen: second ? 'preview channel' : 'stable channel',
          observedAt: material?.observedAt,
          publishedAt: material?.publishedAt ?? null,
          futureUse: second ? '仅用于 preview 版本行动' : '仅用于 stable 版本行动',
          source: material?.source,
          degree: 'established',
          request: projection?.request,
          material: material?.ref,
          factNeeds: projection?.factNeeds,
        }))
        return
      }
      yield* textChunks(JSON.stringify({
        kind: 'direct_fact',
        fact,
        meaning: fact === releaseFact
          ? `DeepSeek Harness 当前最新稳定版本为 ${this.singleVersion}`
          : 'DeepSeek Harness 1.4.2 要求 Node.js 22 或更新版本',
        source: material?.source,
        degree: 'established',
        request: projection?.request,
        material: material?.ref,
        factNeeds: projection?.factNeeds,
      }))
      return
    }
    this.rootRequests.push(options)
    yield* textChunks('natural root response')
  }
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
    if (modelInput(options).includes('庭院钥匙在哪里？')) {
      yield* textChunks(modelInput(options).includes(p01OldWords)
        ? '庭院钥匙在蓝色瓷杯后面。'
        : '当前请求没有提供庭院钥匙位置。')
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
  await ctx.plugin(RouteInvariant, config.p01UserWordsView === undefined
    ? {}
    : { p01UserWordsView: config.p01UserWordsView })
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

interface PersistentP01Harness extends Harness {
  readonly root: string
  readonly sessionsRoot: string
  readonly sqlitePath: string
}

async function mountPersistentP01Harness(
  root: string,
  p01Expected: boolean,
  resume = false,
): Promise<PersistentP01Harness> {
  const sessionsRoot = join(root, 'sessions')
  const sqlitePath = join(root, 'session-query.sqlite')
  await mkdir(sessionsRoot, { recursive: true })

  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
  await ctx.plugin(CompactionInvariant)
  await ctx.plugin(CompactionBasicInvariant)
  await ctx.plugin(RouteInvariant, p01Expected ? p01Config : {})
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'none' })
  await ctx.plugin(SqliteSessionQueryEngine, { path: sqlitePath })
  await ctx.plugin(ToolSessionQuery)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(DeterministicCompactionEngine, { auto: false })
  const compaction = ctx.compaction as DeterministicCompactionEngine
  if (p01Expected) {
    await ctx.plugin(ContextRoutePlugin, {
      reasoningEffort: 'off',
      ...p01Config,
    })
  } else {
    await ctx.plugin(ContextRoutePlugin, { reasoningEffort: 'off' })
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new RouteAwareAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = resume
    ? (await ctx.agents.resume({
        resumeSessionId: SessionId(p01SessionId),
        agentOptions: { provider: 'mock', model: 'mock' },
      })).agent
    : ctx.agentLoop.create(SessionId(p01SessionId), { provider: 'mock', model: 'mock' })
  return { ctx, agent, adapter, compaction, root, sessionsRoot, sqlitePath }
}

async function persistentP01Harness(p01Expected = false): Promise<PersistentP01Harness> {
  const root = await mkdtemp(join(tmpdir(), 'context-manager-p01-'))
  roots.push(root)
  return mountPersistentP01Harness(root, p01Expected)
}

async function send(agent: Agent, text: string): Promise<UserMessage> {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  agent.followup(message)
  await agent.whenIdle()
  return message
}

async function exerciseInputRequeueProductionIntegration(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'context-manager-r1a-integration-'))
  roots.push(root)
  const sessionsRoot = join(root, 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  const target = ContextRoutePlugin.FOCUS_CANARY_IDS[0]
  const original = createUserMessage({
    content: [{ type: 'text', text: focusDirect }],
    source: { kind: 'user' },
  })

  const seed = new Context()
  contexts.push(seed)
  await mountAgentLoopTestDependencies(seed)
  const seedAdapter = new NaturalEvidenceAdapter()
  seed.llm.registerAdapter(['natural-evidence-test'], seedAdapter)
  await seed.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'none' })
  await seed.plugin(AgentLoop, { agents: [] })
  const seeded = seed.agentLoop.create(SessionId(target), {
    provider: 'natural-evidence-test', model: 'natural-evidence-test', maxTokens: 256,
  })
  seeded.inbox.append('next-turn', original)
  expect(seeded.inbox.claim('next-turn', 1)).toStrictEqual([original])
  expect(await seed.sessions.flush(seeded.session)).toBe(true)
  await seed.fiber.dispose()
  contexts.splice(contexts.indexOf(seed), 1)

  const live = new Context()
  contexts.push(live)
  await mountAgentLoopTestDependencies(live)
  const sqlitePath = join(root, 'context-manager.sqlite')
  await live.plugin(Storage)
  await live.plugin(StorageSqlite, { path: sqlitePath })
  await live.plugin(StorageDomain, { backend: 'sqlite' })
  await live.plugin(TokenMeter)
  await live.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'none' })
  const detachedFrom: number[] = []
  const readFrom = live.sessionPersistence.readFrom.bind(live.sessionPersistence)
  live.sessionPersistence.readFrom = async (id, fromSeq, signal) => {
    const detached = await readFrom(id, fromSeq, signal)
    detachedFrom.push(fromSeq)
    return detached
  }
  await live.plugin(CommandRuntime)
  const managedRuntime = {
    mode: 'enforce' as const,
    safeUpdateMarginTokens: 64,
    allowlist: [...ContextRoutePlugin.FOCUS_CANARY_IDS],
  }
  await live.plugin(ManagedAwareBasicCompactionEngine, {
    auto: true, thresholdRatio: .99, retainRatio: .1, managedRuntime,
  })
  await live.plugin(commandCompact)
  const adapter = new NaturalEvidenceAdapter()
  live.llm.registerAdapter(['natural-evidence-test'], adapter)
  await live.plugin(ContextRoutePlugin, {
    focusCanary: {
      ...managedRuntime,
      auxiliary: {
        provider: 'natural-evidence-test', model: 'natural-evidence-test',
        maxOutputTokens: 256, timeoutMs: 500, maxExpressionChars: 240,
        maxProjectionTokens: 2_048, safetyMarginTokens: 128,
      },
    },
    nativeWriterArbitration: { mode: 'enforce' },
  })
  await live.plugin(AgentLoop, { agents: [] })
  const recovered = (await live.agents.resume({
    resumeSessionId: SessionId(target),
    agentOptions: { provider: 'natural-evidence-test', model: 'natural-evidence-test', maxTokens: 256 },
  })).agent
  for (let pass = 0; pass < 4; pass += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
    await recovered.whenIdle()
  }
  const requests = adapter.rootRequests.filter(request => request.messages.some(message =>
    message.source.kind === 'user' && String(message.id) === String(original.id)))
  expect(requests).toHaveLength(1)
  expect(recovered.session.events.filter(event => event.type === 'user/message'
    && String(event.data.id) === String(original.id))).toHaveLength(1)
  expect(recovered.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
  const reinsert = recovered.session.events.findLast(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.length === 1
    && String(event.data.inserted[0]?.id) === String(original.id))
  expect(reinsert?.type).toBe('agent/inbox/spliced')
  expect(reinsert?.type === 'agent/inbox/spliced' ? reinsert.data.start : undefined).toBe(0)
  expect(detachedFrom).toContain(reinsert?.seq)
  const turn = recovered.session.events.find(event => event.type === 'turn/start')
  expect(turn?.seq).toBeGreaterThan(reinsert?.seq ?? Number.MAX_SAFE_INTEGER)
  expect(recovered.session.events.filter(event => event.type === 'user/message'
    && event.data.source.kind === 'context-manager-input-requeue-wake')).toHaveLength(0)
  expect(recovered.session.events.filter(event => event.type.startsWith('tool/')
    || event.type.startsWith('compaction/'))).toHaveLength(0)
  expect(recovered.inbox.nextStep).toStrictEqual([])
  expect(recovered.inbox.nextTurn).toStrictEqual([])
  expect(await readFile(sqlitePath)).not.toHaveLength(0)
}

describe('single-session context route through the real loop', () => {
  it('keeps the implementation-before baseline explicit: a legacy-route session cannot recover old words after real compaction', async () => {
    const h = await persistentP01Harness()
    await send(h.agent, p01OldWords)
    await send(h.agent, '继续增长会话：先核对院门是否已经上锁。')
    await send(h.agent, '继续增长会话：再确认明早浇花。')

    const oldEvent = h.agent.session.events.find(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      && messageText([event.data]).includes(p01OldWords))
    expect(oldEvent?.type).toBe('user/message')
    expect(() => assertRouteFreshForCompaction(h.agent.session.events)).not.toThrow()

    const signal = new AbortController().signal
    expect(await h.compaction.compactNow(h.agent, signal)).not.toBeNull()
    const compactionEvents = h.agent.session.events.filter(event => event.type.startsWith('compaction/'))
    expect(compactionEvents.map(event => event.type)).toStrictEqual([
      'compaction/start',
      'compaction/summary',
      'compaction/end',
    ])
    expect(compactionEvents[0]?.seq).toBeLessThan(compactionEvents[1]?.seq ?? -1)
    expect(compactionEvents[1]?.seq).toBeLessThan(compactionEvents[2]?.seq ?? -1)
    const compactionEnd = compactionEvents[2]
    expect(compactionEnd?.type).toBe('compaction/end')
    expect(compactionEnd?.type === 'compaction/end' ? compactionEnd.data.error ?? null : 'missing')
      .toBeNull()
    expect(h.agent.session.surface.nodes).not.toContain(oldEvent?.seq)

    const summaryEvent = h.agent.session.events.findLast(event => event.type === 'compaction/summary')
    expect(summaryEvent?.type).toBe('compaction/summary')
    expect(JSON.stringify(summaryEvent?.data)).not.toContain(p01OldWords)

    expect(await h.ctx.sessions.flush(h.agent.session)).toBe(true)
    const persisted = await h.ctx.sessionPersistence.readFrom(SessionId(p01SessionId), 0, signal)
    const rawOldEvents = persisted.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      && messageText([event.data]).includes(p01OldWords))
    expect(rawOldEvents).toHaveLength(1)
    expect(rawOldEvents[0]?.seq).toBe(oldEvent?.seq)
    expect(await readFile(h.sqlitePath)).not.toHaveLength(0)

    const current = '钥匙具体放在哪里？'
    await send(h.agent, current)
    const ordinaryRequest = h.adapter.conversationRequests.at(-1)
    expect(ordinaryRequest).toBeDefined()
    const ordinaryInput = `${ordinaryRequest?.system ?? ''}\n${modelInput(ordinaryRequest!)}`
    expect(ordinaryInput.split(current).length - 1).toBe(1)
    expect(ordinaryInput.split(p01OldWords).length - 1).toBe(0)
    expect(foldRoute(h.agent.session.events)).toBeDefined()
    const targetCarriers = ordinaryRequest!.messages.filter(message => message.source.kind !== 'user'
      && messageText([message]).includes(p01OldWords))
    expect(targetCarriers).toHaveLength(0)

    expect(ordinaryInput.split(p01OldWords).length - 1).toBe(0)
  })

  it('runs real P01 compaction without an old route and adds the old words only through one P01 view', async () => {
    const h = await persistentP01Harness(true)
    await send(h.agent, p01OldWords)
    await send(h.agent, `P01 增长消息一。${'甲'.repeat(600)}`)
    await send(h.agent, `P01 增长消息二。${'乙'.repeat(600)}`)
    expect(foldRoute(h.agent.session.events)).toBeUndefined()

    const signal = new AbortController().signal
    expect(await h.compaction.compactNow(h.agent, signal)).not.toBeNull()
    const lifecycle = h.agent.session.events.filter(event => event.type.startsWith('compaction/'))
    expect(lifecycle.map(event => event.type)).toStrictEqual([
      'compaction/start', 'compaction/summary', 'compaction/end',
    ])
    expect(lifecycle[2]?.type === 'compaction/end' ? lifecycle[2].data.error ?? null : 'missing')
      .toBeNull()

    const oldEvent = h.agent.session.events.find(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      && messageText([event.data]).includes(p01OldWords))
    expect(oldEvent?.type).toBe('user/message')
    expect(h.agent.session.surface.nodes).not.toContain(oldEvent?.seq)
    expect(JSON.stringify(h.agent.session.events.findLast(event => event.type === 'compaction/summary')?.data))
      .not.toContain(p01OldWords)

    const current = '庭院钥匙在哪里？'
    await send(h.agent, current)
    const request = h.adapter.conversationRequests.at(-1)!
    const input = `${request.system ?? ''}\n${modelInput(request)}`
    const views = p01ViewCarriers(request)
    expect(views).toHaveLength(1)
    expect(occurrenceCount(views[0]!, p01OldWords)).toBe(1)
    expect(occurrenceCount(input, p01OldWords)).toBe(1)
    expect(occurrenceCount(input, current)).toBe(1)
    const withoutView = input.replace(views[0]!, '')
    expect(occurrenceCount(withoutView, p01OldWords)).toBe(0)
    expect(h.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === ROUTE_CONTEXT_SOURCE)).toHaveLength(0)
    expect(request.system ?? '').not.toContain('当前会话路线管理（内部政策）')
    expect(h.adapter.reducerRequests).toHaveLength(0)
    const answer = h.agent.session.events.findLast(event => event.type === 'assistant/message')
    expect(answer?.type === 'assistant/message' ? messageText([answer.data.message]) : '')
      .toContain('庭院钥匙在蓝色瓷杯后面')
  })

  it('silently omits the P01 view on history-read failure while the current ordinary turn continues', async () => {
    const h = await persistentP01Harness(true)
    let reads = 0
    vi.spyOn(h.agent.session, 'events', 'get').mockImplementationOnce(() => {
      reads += 1
      throw new Error('deterministic P01 history read failure')
    })

    const current = '读取失败时仍要处理这条当前消息。'
    await send(h.agent, current)
    expect(reads).toBeGreaterThan(0)
    expect(foldRoute(h.agent.session.events)).toBeUndefined()
    const request = h.adapter.conversationRequests.at(-1)!
    const input = `${request.system ?? ''}\n${modelInput(request)}`
    expect(occurrenceCount(input, current)).toBe(1)
    expect(p01ViewCarriers(request)).toHaveLength(0)
    expect(h.agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
  })

  it('rejects a newly appended old-route snapshot in the allowlisted P01 session', async () => {
    const h = await persistentP01Harness(true)
    await send(h.agent, 'P01 route-free seed。')
    expect(foldRoute(h.agent.session.events)).toBeUndefined()
    const user = h.agent.session.events.find(event => event.type === 'user/message'
      && event.data.source.kind === 'user')
    const assistant = h.agent.session.events.find(event => event.type === 'assistant/message')
    if (user === undefined || assistant === undefined) throw new Error('missing route-free seed events')
    const material = `[seq ${user.seq} user] P01 route-free seed\n[seq ${assistant.seq} assistant] answer`
    const route = parseRouteBody(
      JSON.stringify(initialReducerBody(material)),
      undefined,
      assistant.seq,
      h.agent.session.events,
    )

    expect(() => h.agent.session.append(
      'user/message',
      createRouteRevisionMessage(p01SessionId, route),
      { surfaceOp: 'append' },
    )).toThrow(/P01.*route|route.*P01/i)
    expect(foldRoute(h.agent.session.events)).toBeUndefined()
  })

  it('rejects P01 activation when the persisted allowlisted session already has an old route', async () => {
    const seed = await persistentP01Harness(false)
    await send(seed.agent, '先建立一份现有旧 route。')
    expect(foldRoute(seed.agent.session.events)).toBeDefined()
    expect(await seed.ctx.sessions.flush(seed.agent.session)).toBe(true)
    await seed.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(seed.ctx), 1)

    await expect(mountPersistentP01Harness(seed.root, true, true))
      .rejects.toThrow(/P01.*route|route.*P01/i)
  })

  it('renders the same P01 view byte-for-byte after a real JSONL cold resume', async () => {
    const live = await persistentP01Harness(true)
    await send(live.agent, p01OldWords)
    await send(live.agent, `冷恢复增长消息一。${'甲'.repeat(600)}`)
    await send(live.agent, `冷恢复增长消息二。${'乙'.repeat(600)}`)
    expect(foldRoute(live.agent.session.events)).toBeUndefined()
    expect(await live.compaction.compactNow(live.agent, new AbortController().signal)).not.toBeNull()
    await send(live.agent, '热态探测。')
    const hotViews = p01ViewCarriers(live.adapter.conversationRequests.at(-1)!)
    expect(hotViews).toHaveLength(1)
    expect(await live.ctx.sessions.flush(live.agent.session)).toBe(true)
    await live.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(live.ctx), 1)

    const cold = await mountPersistentP01Harness(live.root, true, true)
    await cold.agent.whenIdle()
    await send(cold.agent, '冷态探测。')
    const coldViews = p01ViewCarriers(cold.adapter.conversationRequests.at(-1)!)
    expect(coldViews).toHaveLength(1)
    expect(coldViews[0]).toBe(hotViews[0])
  })

  it('keeps legacy route freshness unchanged for a non-allowlisted session under P01 config', async () => {
    const h = await persistentP01Harness(true)
    const other = h.ctx.agentLoop.create(SessionId('p01-nontrial-route-control'), {
      provider: 'mock', model: 'mock',
    })
    await send(other, '非试用会话继续使用现有 route。')
    expect(foldRoute(other.session.events)).toBeDefined()
    expect(() => assertRouteFreshForCompaction(other.session.events, other.session.surface.nodes))
      .not.toThrow()

    other.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '制造一个尚未被 route 覆盖的新事实。' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(() => assertRouteFreshForCompaction(other.session.events, other.session.surface.nodes))
      .toThrow(/latest semantic seq is/)
  })

  it('uses the public web service and keeps the evidence canary subordinate to focus enforce', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(WebRuntime, { searchProvider: 'integration-search' })
    const requests: WebSearchRequest[] = []
    ctx.web.registerSearchProvider({
      id: 'integration-search',
      available: () => true,
      search: async (request) => {
        requests.push(request)
        return { sources: [{ url: 'https://example.com/release' }], truncated: false }
      },
    })

    expect(typeof ctx.get('web')?.search).toBe('function')
    await expect(ctx.web.search({ query: 'release', maxResults: 1 }))
      .resolves.toEqual({ sources: [{ url: 'https://example.com/release' }], truncated: false })
    expect(requests).toEqual([{ query: 'release', maxResults: 1 }])
    await expect(ctx.plugin(ContextRoutePlugin, { evidenceCanary: { mode: 'enforce' } }))
      .rejects.toThrow('evidence canary requires focus canary enforce mode')

    const packageMetadata = object(JSON.parse(await readFile(
      new URL('../package.json', import.meta.url), 'utf8',
    )))
    const publicExports = object(packageMetadata?.exports)
    expect(Object.keys(publicExports ?? {}).sort()).toStrictEqual([
      '.', './invariant', './managed-compaction', './package.json', './src/*',
    ])
    expect(publicExports?.['./multi-fact-resolution']).toBeUndefined()
    expect(publicExports?.['./fact-resolution']).toBeUndefined()
    expect(publicExports?.['./action-boundary']).toBeUndefined()
    expect(publicExports?.['./future-critical-candidate']).toBeUndefined()
    expect(publicExports?.['./candidate']).toBeUndefined()

    const root = await mkdtemp(join(tmpdir(), 'context-manager-f03-loader-'))
    roots.push(root)
    const configPath = join(root, 'cordis.yml')
    const sqlitePath = join(root, 'context-manager.sqlite')
    const sessionRoot = join(root, 'sessions')
    await mkdir(sessionRoot, { recursive: true })
    await writeFile(configPath, [
      '- name: cordis:context-manager',
      '  config:',
      '    focusCanary:',
      '      mode: enforce',
      '      safeUpdateMarginTokens: 64',
      '      allowlist:',
      `        - ${ContextRoutePlugin.FOCUS_CANARY_IDS[0]}`,
      `        - ${ContextRoutePlugin.FOCUS_CANARY_IDS[1]}`,
      '      auxiliary:',
      '        provider: natural-evidence-test',
      '        model: natural-evidence-test',
      '        maxOutputTokens: 256',
      '        timeoutMs: 500',
      '        maxExpressionChars: 240',
      '        maxProjectionTokens: 2048',
      '        safetyMarginTokens: 128',
      '    nativeWriterArbitration:',
      '      mode: enforce',
      '    evidenceCanary:',
      '      mode: enforce',
      '',
    ].join('\n'))

    const natural = new Context()
    contexts.push(natural)
    await mountAgentLoopTestDependencies(natural)
    await natural.plugin(Storage)
    await natural.plugin(StorageSqlite, { path: sqlitePath })
    await natural.plugin(StorageDomain, { backend: 'sqlite' })
    await natural.plugin(TokenMeter)
    await natural.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
    await natural.plugin(CommandRuntime)
    const managedRuntime = {
      mode: 'enforce' as const,
      safeUpdateMarginTokens: 64,
      allowlist: [...ContextRoutePlugin.FOCUS_CANARY_IDS],
    }
    await natural.plugin(ManagedAwareBasicCompactionEngine, {
      auto: true, thresholdRatio: .99, retainRatio: .1, managedRuntime,
    })
    await natural.plugin(commandCompact)
    await natural.plugin(WebRuntime, { searchProvider: 'natural-evidence-search' })
    const naturalSearches: WebSearchRequest[] = []
    natural.web.registerSearchProvider({
      id: 'natural-evidence-search',
      available: () => true,
      search: async request => {
        naturalSearches.push(request)
        return request.query === releaseQuery
          ? request.maxResults === 2
            ? {
                content: rawMultiSourceEnvelope,
                sources: [
                  {
                    url: releaseUrl,
                    snippet: 'RAW-STABLE-MATERIAL DeepSeek Harness 当前稳定版本为 1.4.2。',
                    publishedAt: '2026-08-25T09:30:00.000Z',
                  },
                  {
                    url: secondReleaseUrl,
                    snippet: 'RAW-PREVIEW-MATERIAL DeepSeek Harness preview 当前版本为 1.5.0-beta。',
                    publishedAt: '2026-08-25T10:30:00.000Z',
                  },
                ],
                truncated: false,
              }
            : {
                content: 'raw release provider answer',
                sources: [{
                  url: releaseUrl,
                  snippet: 'DeepSeek Harness 当前最新稳定版本为 1.4.2。',
                  publishedAt: '2026-08-25T09:30:00.000Z',
                }],
                truncated: false,
              }
          : request.query === nodeQuery
            ? {
                content: 'raw Node.js provider answer',
                sources: [{
                  url: nodeUrl,
                  snippet: 'DeepSeek Harness 1.4.2 要求 Node.js 22 或更新版本。',
                  publishedAt: '2026-08-25T09:35:00.000Z',
                }],
                truncated: false,
              }
            : { content: 'foreign query', sources: [], truncated: false }
      },
    })
    const naturalAdapter = new NaturalEvidenceAdapter()
    natural.llm.registerAdapter(['natural-evidence-test'], naturalAdapter)
    natural.baseUrl = pathToFileURL(root).href + '/'
    await natural.plugin(Loader)
    natural.loader.builtins.include = Include
    natural.loader.builtins['context-manager'] = ContextRoutePlugin
    await natural.loader.create({
      name: 'cordis:include', config: { path: pathToFileURL(configPath).href },
    })
    await natural.loader.await()
    await natural.plugin(AgentLoop, { agents: [] })
    const agent = natural.agentLoop.create(
      SessionId(ContextRoutePlugin.FOCUS_CANARY_IDS[0]),
      { provider: 'natural-evidence-test', model: 'natural-evidence-test', maxTokens: 256 },
    )

    await send(agent, focusDirect)
    const focusStateBeforeRelated = storedFocusRecord(sqlitePath, String(agent.session.id))
    await send(agent, relatedFocusDirect)
    const relatedPresentation = modelInput(naturalAdapter.rootRequests.at(-1)!)
    const afterFocusRoot = naturalAdapter.rootRequests.length
    expect(storedFocusRecord(sqlitePath, String(agent.session.id))).toStrictEqual(focusStateBeforeRelated)
    expect(relatedPresentation).toContain(`继续当前焦点：${focusDirect}`)
    expect(naturalAdapter.relationCalls).toBe(1)
    await send(agent, singleFactDirect)
    const afterSingle = {
      action: naturalAdapter.actionCalls,
      evidence: naturalAdapter.evidenceCalls,
      search: naturalSearches.length,
      root: naturalAdapter.rootRequests.length,
    }
    const singlePresentation = modelInput(naturalAdapter.rootRequests.at(-1)!)
    const unprovableProviderBefore = {
      focus: naturalAdapter.focusCalls,
      action: naturalAdapter.actionCalls,
      evidence: naturalAdapter.evidenceCalls,
      root: naturalAdapter.rootRequests.length,
    }
    const unprovableStateBefore = storedFocusRecord(sqlitePath, String(agent.session.id))
    const overBudget = vi.spyOn(TokenMeter.prototype, 'estimateMessage').mockReturnValue(100_000)
    await send(agent, updateBackgroundDirect)
    overBudget.mockRestore()
    await natural.sessions.flush(agent.session)
    const unprovableDetached = await natural.sessionPersistence.readFrom(agent.session.id, 0)
    const unprovableProviderAfter = {
      focus: naturalAdapter.focusCalls,
      action: naturalAdapter.actionCalls,
      evidence: naturalAdapter.evidenceCalls,
      root: naturalAdapter.rootRequests.length,
    }
    const unprovableSessionMessages = candidateQualificationMessages(agent.session.events)
    const unprovableDetachedMessages = candidateQualificationMessages(unprovableDetached.events)
    expect(unprovableProviderAfter).toStrictEqual(unprovableProviderBefore)
    expect(unprovableSessionMessages.map(message => messageText([message])))
      .toStrictEqual([unprovableCandidatePresentation])
    expect(unprovableDetachedMessages.map(message => messageText([message])))
      .toStrictEqual([unprovableCandidatePresentation])
    expect(String(unprovableSessionMessages[0]?.id)).toBe(String(unprovableDetachedMessages[0]?.id))
    expect(canonicalMessages(agent.session.events)).toHaveLength(0)
    expect(canonicalMessages(unprovableDetached.events)).toHaveLength(0)
    expect(storedFocusRecord(sqlitePath, String(agent.session.id))).toStrictEqual(unprovableStateBefore)

    await send(agent, multiFactDirect)
    const afterMulti = {
      action: naturalAdapter.actionCalls,
      evidence: naturalAdapter.evidenceCalls,
      search: naturalSearches.length,
      root: naturalAdapter.rootRequests.length,
    }
    const multiPresentation = modelInput(naturalAdapter.rootRequests.at(-1)!)
    await send(agent, multiSourceDirect)
    const afterMultiSource = {
      action: naturalAdapter.actionCalls,
      evidence: naturalAdapter.evidenceCalls,
      search: naturalSearches.length,
      root: naturalAdapter.rootRequests.length,
    }
    const multiSourcePresentation = modelInput(naturalAdapter.rootRequests.at(-1)!)
    await send(agent, '只记录一句普通备注，不查询版本。')
    await natural.sessions.flush(agent.session)
    const persisted = await natural.sessionPersistence.readFrom(agent.session.id, 0)
    const qualifiedAgent = natural.agentLoop.create(
      SessionId(qualifiedBackgroundSessionId),
      { provider: 'natural-evidence-test', model: 'natural-evidence-test', maxTokens: 256 },
    )
    await send(qualifiedAgent, focusDirect)
    await send(qualifiedAgent, singleFactDirect)
    const qualifiedProviderBefore = {
      focus: naturalAdapter.focusCalls,
      action: naturalAdapter.actionCalls,
      evidence: naturalAdapter.evidenceCalls,
      root: naturalAdapter.rootRequests.length,
    }
    const qualifiedStateBefore = storedFocusRecord(sqlitePath, qualifiedBackgroundSessionId)
    const qualifiedDirect = createUserMessage({
      content: [{ type: 'text', text: updateBackgroundDirect }],
      source: { kind: 'user' },
    })
    qualifiedAgent.followup(qualifiedDirect)
    await qualifiedAgent.whenIdle()
    await natural.sessions.flush(qualifiedAgent.session)
    const qualifiedDetached = await natural.sessionPersistence.readFrom(qualifiedAgent.session.id, 0)
    const sqliteBytes = await readFile(sqlitePath)
    const qualifiedProviderAfter = {
      focus: naturalAdapter.focusCalls,
      action: naturalAdapter.actionCalls,
      evidence: naturalAdapter.evidenceCalls,
      root: naturalAdapter.rootRequests.length,
    }
    const qualifiedRequest = naturalAdapter.rootRequests.at(-1)!
    const qualifiedSessionMessages = candidateQualificationMessages(qualifiedAgent.session.events)
    const qualifiedDetachedMessages = candidateQualificationMessages(qualifiedDetached.events)
    const qualifiedSessionCanonical = canonicalMessages(qualifiedAgent.session.events)
    const qualifiedDetachedCanonical = canonicalMessages(qualifiedDetached.events)

    expect(naturalAdapter.focusCalls).toBe(2)
    expect(afterFocusRoot).toBe(2)
    expect(afterSingle).toStrictEqual({ action: 1, evidence: 1, search: 1, root: 3 })
    expect(afterMulti).toStrictEqual({ action: 2, evidence: 3, search: 3, root: 4 })
    expect(afterMultiSource).toStrictEqual({ action: 3, evidence: 5, search: 4, root: 5 })
    expect(naturalSearches.map(request => request.query)).toStrictEqual([
      releaseQuery, releaseQuery, nodeQuery, releaseQuery, releaseQuery,
    ])
    expect(naturalSearches[3]).toStrictEqual({ query: releaseQuery, maxResults: 2 })
    expect(singlePresentation).toContain(`fact: ${releaseFact}`)
    expect(singlePresentation).not.toContain('fact[1]:')
    expect(singlePresentation).toContain(`url: ${releaseUrl}`)
    expect(multiPresentation).toContain(`fact[1]: ${releaseFact}`)
    expect(multiPresentation).toContain(`fact[2]: ${nodeFact}`)
    expect(multiPresentation.indexOf(`url[1]: ${releaseUrl}`))
      .toBeLessThan(multiPresentation.indexOf(`url[2]: ${nodeUrl}`))
    expect(multiSourcePresentation).toContain('多来源事实核对：conditional')
    expect(multiSourcePresentation).toContain(`fact: ${releaseFact}`)
    expect(multiSourcePresentation).toContain(`url: ${releaseUrl}`)
    expect(multiSourcePresentation).toContain(`url: ${secondReleaseUrl}`)
    expect(multiSourcePresentation).toContain('appliesWhen: stable channel')
    expect(multiSourcePresentation).toContain('appliesWhen: preview channel')
    expect(multiSourcePresentation).toContain('safeActions: 升级 DeepSeek Harness、列出已确认的只读升级前检查')
    expect(naturalAdapter.actionCalls).toBe(afterMultiSource.action + 1)
    expect(naturalAdapter.evidenceCalls).toBe(afterMultiSource.evidence + 1)
    expect(naturalSearches).toHaveLength(afterMultiSource.search + 1)
    expect(qualifiedProviderAfter).toStrictEqual({
      ...qualifiedProviderBefore,
      root: qualifiedProviderBefore.root + 1,
    })
    expect(qualifiedSessionMessages).toHaveLength(0)
    expect(qualifiedDetachedMessages).toHaveLength(0)
    expect(qualifiedSessionCanonical.map(message => message.source.kind === 'context-manager-canonical'
      ? message.source.phase : undefined)).toStrictEqual(['current', 'finalized'])
    expect(qualifiedDetachedCanonical.map(message => message.source.kind === 'context-manager-canonical'
      ? message.source.phase : undefined)).toStrictEqual(['current', 'finalized'])
    expect(qualifiedRequest.messages).toHaveLength(2)
    expect(qualifiedRequest.messages[0]?.source.kind).toBe('context-manager-canonical')
    expect(qualifiedRequest.messages[0]?.source.kind === 'context-manager-canonical'
      ? qualifiedRequest.messages[0].source.machine.kind : undefined).toBe('background')
    expect(qualifiedRequest.messages[1]).toStrictEqual(qualifiedDirect)
    expect(qualifiedAgent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      && String(event.data.id) === String(qualifiedDirect.id))).toHaveLength(1)
    expect(qualifiedDetached.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      && String(event.data.id) === String(qualifiedDirect.id))).toHaveLength(1)
    expect(persisted.events.flatMap(event => event.type === 'user/message'
      && event.data.source.kind === 'user' ? [messageText([event.data])] : [])).toEqual([
      focusDirect, relatedFocusDirect, singleFactDirect, updateBackgroundDirect, multiFactDirect, multiSourceDirect,
      '只记录一句普通备注，不查询版本。',
    ])
    expect(qualifiedDetached.events.flatMap(event => event.type === 'user/message'
      && event.data.source.kind === 'user' ? [messageText([event.data])] : [])).toEqual([
      focusDirect, singleFactDirect, updateBackgroundDirect,
    ])
    expect(sqliteBytes.byteLength).toBeGreaterThan(0)
    expect(qualifiedStateBefore?.family).not.toBe('background')
    const qualifiedStateAfter = storedFocusRecord(sqlitePath, qualifiedBackgroundSessionId)
    expect(qualifiedStateAfter?.family).toBe('background')
    expect(object(qualifiedStateAfter?.transaction)?.phase).toBe('finalized')
    expect(singlePresentation).not.toContain(releaseQuery)
    expect(multiPresentation).not.toContain(releaseQuery)
    expect(multiPresentation).not.toContain(nodeQuery)
    expect(multiSourcePresentation).not.toContain(releaseQuery)
    expect(multiSourcePresentation).not.toContain(rawMultiSourceEnvelope)
    expect(multiSourcePresentation).not.toContain('RAW-STABLE-MATERIAL')
    expect(multiSourcePresentation).not.toContain('RAW-PREVIEW-MATERIAL')
    expect(multiSourcePresentation).not.toMatch(/preferred|rank|score|winner|trusted/i)
    expect(JSON.stringify(agent.session.events)).not.toContain(nodeQuery)

    const firstQualifiedTransaction = object(qualifiedStateAfter?.transaction)
    expect(firstQualifiedTransaction?.generation).toBe(1)
    naturalAdapter.singleVersion = '1.5.0'
    const rollingProducerDirect = await send(qualifiedAgent, singleFactDirect)
    const pendingQualifiedState = storedFocusRecord(sqlitePath, qualifiedBackgroundSessionId)
    expect(object(pendingQualifiedState?.transaction)?.generation).toBe(1)
    const rollingQualifiedDirect = await send(
      qualifiedAgent, '按刚核清的版本继续准备升级。',
    )
    await natural.sessions.flush(qualifiedAgent.session)
    const secondQualifiedDetached = await natural.sessionPersistence.readFrom(qualifiedAgent.session.id, 0)
    const secondQualifiedState = storedFocusRecord(sqlitePath, qualifiedBackgroundSessionId)
    const secondQualifiedTransaction = object(secondQualifiedState?.transaction)
    const secondQualifiedRequest = naturalAdapter.rootRequests.at(-1)!
    const visibleQualifiedCanonical = qualifiedAgent.session.deriveMessages().filter(message =>
      message.source.kind === 'context-manager-canonical'
      && message.source.machine.kind === 'background')
    expect(secondQualifiedState?.family).toBe('background')
    expect(secondQualifiedTransaction?.phase).toBe('finalized')
    expect(secondQualifiedTransaction?.generation).toBe(2)
    expect(secondQualifiedTransaction?.canonicalRef).not.toBe(firstQualifiedTransaction?.canonicalRef)
    expect(visibleQualifiedCanonical).toHaveLength(1)
    expect(visibleQualifiedCanonical[0]?.source.kind === 'context-manager-canonical'
      ? visibleQualifiedCanonical[0].source.generation : undefined).toBe(2)
    expect(secondQualifiedRequest.messages).toHaveLength(2)
    expect(secondQualifiedRequest.messages[0]?.source.kind).toBe('context-manager-canonical')
    expect(secondQualifiedRequest.messages[1]).toStrictEqual(rollingQualifiedDirect)
    expect(qualifiedAgent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      && String(event.data.id) === String(rollingQualifiedDirect.id))).toHaveLength(1)
    expect(qualifiedAgent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      && String(event.data.id) === String(rollingProducerDirect.id))).toHaveLength(1)
    expect(secondQualifiedDetached.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      && String(event.data.id) === String(rollingQualifiedDirect.id))).toHaveLength(1)
    expect(secondQualifiedDetached.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      && String(event.data.id) === String(rollingProducerDirect.id))).toHaveLength(1)
    expect(qualifiedAgent.session.events.filter(event => event.type.startsWith('compaction/'))).toHaveLength(0)
    const canonicalBeforeRelated = storedFocusRecord(sqlitePath, qualifiedBackgroundSessionId)
    const relationCallsBeforeCanonical = naturalAdapter.relationCalls
    await send(qualifiedAgent, relatedFocusDirect)
    expect(storedFocusRecord(sqlitePath, qualifiedBackgroundSessionId)).toStrictEqual(canonicalBeforeRelated)
    expect(naturalAdapter.relationCalls).toBe(relationCallsBeforeCanonical + 1)
    expect(modelInput(naturalAdapter.rootRequests.at(-1)!)).toContain(`继续当前焦点：${focusDirect}`)
    await exerciseInputRequeueProductionIntegration()
  })

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
