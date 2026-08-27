import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import WebRuntime, { type WebSearchRequest } from '@deepseek-ai/dsh-web'
import { ManagedAwareBasicCompactionEngine } from '../src/managed-compaction.ts'
import * as ContextManager from '../src/index.ts'

type ObjectRecord = Record<string, unknown>
type DownstreamMode = 'normal' | 'reject-once' | 'clone-once'

const roots: string[] = []
const contexts: Context[] = []
const sessionId = ContextManager.FOCUS_CANARY_IDS[0]!
const focusDirect = '准备升级 DeepSeek Harness'
const evidenceDirect = '查一下 DeepSeek Harness 当前最新版本；确认后再决定是否升级。'
const updateDirect = '请更新当前背景'
const consumerDirect = '按刚核清的版本继续准备升级'
const rawDirect = '这条普通决定没有形成 C14/C15，不能被滚入。'
const closedText = '唯一背景未能安全换入，本轮未继续行动'

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function chunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function messagesText(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

function hasSchema(options: GenerateOptions, plugin: string): boolean {
  return options.messages.some(message => message.source.kind === 'plugin'
    && message.source.plugin === plugin)
}

function object(value: unknown, label: string): ObjectRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`expected ${label} object`)
  }
  return value as ObjectRecord
}

function field(value: unknown, key: string, label: string): ObjectRecord {
  return object(object(value, label)[key], `${label}.${key}`)
}

class Adapter extends LlmAdapter {
  readonly rootRequests: GenerateOptions[] = []
  focusCalls = 0
  actionCalls = 0
  evidenceCalls = 0
  version = '1.4.2'
  contextWindow = 16_384

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model,
      context: { contextWindow: this.contextWindow } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (hasSchema(options, 'ui-context-compactor:focus-canary-schema')) {
      this.focusCalls += 1
      yield* chunks(JSON.stringify({ kind: 'focus', subject: focusDirect, relation: 'new' }))
      return
    }
    if (hasSchema(options, 'ui-context-compactor:action-fact-need-schema')) {
      this.actionCalls += 1
      yield* chunks(JSON.stringify({
        actions: ['升级 DeepSeek Harness'],
        proposedRequirements: [{ fact: 'DeepSeek Harness 最新版本', neededFor: ['升级 DeepSeek Harness'] }],
        usableInputs: [],
        unresolvedInputs: [{
          fact: 'DeepSeek Harness 最新版本', meaning: '版本待核清', source: 'direct-user',
          degree: 'unknown', affected: '升级 DeepSeek Harness',
        }],
      }))
      return
    }
    if (hasSchema(options, 'ui-context-compactor:evidence-schema')) {
      this.evidenceCalls += 1
      const projection = object(JSON.parse(messagesText(options.messages.slice(1))), 'evidence projection')
      const material = field(projection, 'material', 'evidence projection')
      yield* chunks(JSON.stringify({
        kind: 'direct_fact', fact: projection.fact,
        conclusion: `DeepSeek Harness 当前最新稳定版本为 ${this.version}`,
        appliesWhen: 'stable channel', observedAt: material.observedAt,
        publishedAt: material.publishedAt ?? null,
        futureUse: '只用于本次升级前版本判断', source: material.source,
        degree: 'established', request: projection.request,
        material: material.ref, factNeeds: projection.factNeeds,
      }))
      return
    }
    this.rootRequests.push(options)
    yield* chunks('自然根回复')
  }
}

interface Harness {
  readonly root: string
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: Adapter
  readonly domain: Domain
  readonly errors: unknown[]
  readonly downstream: { mode: DownstreamMode }
}

interface RuntimeLedger {
  readonly generation: number
  readonly canonicalRef: string
  readonly candidateRef: string
  readonly body: string
  readonly directIds: readonly string[]
  readonly rootRequests: number
  readonly nativeEvents: number
}

function databasePath(root: string): string {
  return join(root, 'storages', 'context-manager-focus-canary.sqlite')
}

async function mount(root: string, resume = false, adapter = new Adapter()): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mkdir(join(root, 'storages'), { recursive: true })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: databasePath(root) })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlSessionPersistence, {
    root: join(root, 'sessions'), compression: 'none', packChunks: false,
  })
  await ctx.plugin(CommandRuntime)
  const managedRuntime = {
    mode: 'enforce' as const,
    safeUpdateMarginTokens: 64,
    allowlist: [...ContextManager.FOCUS_CANARY_IDS],
  }
  await ctx.plugin(ManagedAwareBasicCompactionEngine, {
    auto: true, thresholdRatio: .99, retainRatio: .1, managedRuntime,
  })
  await ctx.plugin(commandCompact)
  await ctx.plugin(WebRuntime, { searchProvider: 'rolling-candidate-search' })
  ctx.web.registerSearchProvider({
    id: 'rolling-candidate-search',
    available: () => true,
    search: async (_request: WebSearchRequest) => ({
      content: 'private raw envelope',
      sources: [{
        url: 'https://example.test/releases/latest',
        snippet: `DeepSeek Harness 当前最新稳定版本为 ${adapter.version}。`,
        publishedAt: '2026-08-25T09:30:00.000Z',
      }],
      truncated: false,
    }),
  })
  ctx.llm.registerAdapter(['rolling-candidate-test'], adapter)
  let domain: Domain | undefined
  const facility: { open(spec: unknown): Promise<Domain> } = ctx.storageDomain
  const open = facility.open.bind(facility)
  facility.open = async spec => domain = await open(spec)
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => errors.push(error))
  await ctx.plugin(ContextManager, {
    focusCanary: {
      ...managedRuntime,
      auxiliary: {
        provider: 'rolling-candidate-test', model: 'rolling-candidate-test',
        maxOutputTokens: 256, timeoutMs: 500, maxExpressionChars: 240,
        maxProjectionTokens: 2_048, safetyMarginTokens: 128,
      },
    },
    nativeWriterArbitration: { mode: 'enforce' },
    evidenceCanary: { mode: 'enforce' },
  })
  if (domain === undefined) throw new Error('missing real SQLite storage domain')
  const downstream = { mode: 'normal' as DownstreamMode }
  ctx.on('agent/pre-step', async ({ messages }, next): Promise<PreStepDecision> => {
    if (downstream.mode === 'reject-once') {
      downstream.mode = 'normal'
      return { kind: 'reject' }
    }
    if (downstream.mode === 'clone-once') {
      downstream.mode = 'normal'
      const exact = messages[0]
      return exact === undefined
        ? { kind: 'reject' }
        : { kind: 'enter', messages: [structuredClone(exact)] }
    }
    return await next()
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  const options = {
    provider: 'rolling-candidate-test', model: 'rolling-candidate-test', maxTokens: 256,
  }
  const agent = resume
    ? (await ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: options })).agent
    : ctx.agentLoop.create(SessionId(sessionId), options)
  await agent.whenIdle()
  return Object.freeze({ root, ctx, agent, adapter, domain, errors, downstream })
}

async function fresh(prefix: string, adapter?: Adapter): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return await mount(root, false, adapter)
}

async function send(agent: Agent, messageOrText: string | UserMessage): Promise<UserMessage> {
  const message = typeof messageOrText === 'string'
    ? createUserMessage({ content: [{ type: 'text', text: messageOrText }], source: { kind: 'user' } })
    : messageOrText
  agent.send(message, 'next-turn', true)
  await agent.whenIdle()
  return message
}

async function establishFirst(harness: Harness): Promise<void> {
  await send(harness.agent, focusDirect)
  await send(harness.agent, evidenceDirect)
  await send(harness.agent, updateDirect)
}

async function stageProducer(harness: Harness, version: string): Promise<UserMessage> {
  harness.adapter.version = version
  return await send(harness.agent, evidenceDirect)
}

function readRecord(root: string): ObjectRecord {
  const database = new DatabaseSync(databasePath(root), { readOnly: true })
  try {
    const row = object(database.prepare(
      'SELECT value FROM "u_context_manager_focus_precanonical" WHERE key = ?',
    ).get(sessionId), 'database row')
    if (typeof row.value !== 'string') throw new Error('background row is not JSON text')
    return object(JSON.parse(row.value), 'background row')
  } finally {
    database.close()
  }
}

function ledger(harness: Harness): Readonly<RuntimeLedger> {
  const transaction = field(readRecord(harness.root), 'transaction', 'stored row')
  if (typeof transaction.generation !== 'number'
    || typeof transaction.canonicalRef !== 'string'
    || typeof transaction.body !== 'string') throw new Error('stored transaction identity is incomplete')
  const machine = field(transaction, 'machine', 'stored transaction')
  if (typeof machine.candidateRef !== 'string') throw new Error('stored candidate identity is incomplete')
  return Object.freeze({
    generation: transaction.generation,
    canonicalRef: transaction.canonicalRef,
    candidateRef: machine.candidateRef,
    body: transaction.body,
    directIds: Object.freeze(harness.agent.session.events.flatMap(event => event.type === 'user/message'
      && event.data.source.kind === 'user' ? [String(event.data.id)] : [])),
    rootRequests: harness.adapter.rootRequests.length,
    nativeEvents: harness.agent.session.events.filter(event => event.type.startsWith('compaction/')).length,
  })
}

async function dispose(harness: Harness): Promise<void> {
  await harness.ctx.sessions.flush(harness.agent.session)
  await harness.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(harness.ctx), 1)
}

function requestTexts(harness: Harness): readonly string[] {
  return harness.adapter.rootRequests.at(-1)?.messages.map(message => messagesText([message])) ?? []
}

function errors(harness: Harness): readonly string[] {
  return harness.errors.map(error => error instanceof Error ? error.message : String(error))
}

describe('F01-T4 rolling candidate through the common managed pre-step consumer', () => {
  it('P1 stages producer evidence, then a distinct direct consumes changed C28 and applies generation plus one', async () => {
    const harness = await fresh('f01-t4-p1-')
    await establishFirst(harness)
    const first = ledger(harness)
    const producer = await stageProducer(harness, '1.5.0')
    expect(ledger(harness).generation).toBe(first.generation)
    const consumer = await send(harness.agent, consumerDirect)
    const second = ledger(harness)
    expect(second.generation).toBe(first.generation + 1)
    expect(second.canonicalRef).not.toBe(first.canonicalRef)
    expect(second.candidateRef).not.toBe(first.candidateRef)
    expect(second.body).toContain('1.5.0')
    expect(second.directIds.filter(id => id === String(producer.id))).toHaveLength(1)
    expect(second.directIds.filter(id => id === String(consumer.id))).toHaveLength(1)
    expect(requestTexts(harness)).toHaveLength(2)
    expect(requestTexts(harness)[1]).toBe(consumerDirect)
  })

  it('P2 lets the managed compact followup consume pending evidence with generation plus one and native zero', async () => {
    const harness = await fresh('f01-t4-p2-')
    await establishFirst(harness)
    const first = ledger(harness)
    await stageProducer(harness, '1.5.0')
    const result = await harness.ctx.commands.execute(
      harness.agent, '/compact', [], new AbortController().signal,
    )
    const second = ledger(harness)
    expect(result?.result).toStrictEqual({
      kind: 'success', text: '当前背景已通过同一受管更新事务换入。',
    })
    expect(second.generation).toBe(first.generation + 1)
    expect(second.nativeEvents).toBe(0)
  })

  it('P3 owner-qualifies body and machine equality, discards the C28 handoff and never applies', async () => {
    const harness = await fresh('f01-t4-p3-')
    await establishFirst(harness)
    const first = ledger(harness)
    await stageProducer(harness, '1.4.2')
    const consumer = await send(harness.agent, '继续按相同已核事实执行')
    const identical = ledger(harness)
    expect(identical.body).toBe(first.body)
    expect(identical.generation).toBe(first.generation)
    expect(identical.canonicalRef).toBe(first.canonicalRef)
    expect(identical.directIds.filter(id => id === String(consumer.id))).toHaveLength(1)
    expect(requestTexts(harness)).toHaveLength(2)
  })

  it('N1 has no self-consumption or no-pending apply, and cold restart drops memory pending fail closed', async () => {
    const harness = await fresh('f01-t4-n1-')
    await establishFirst(harness)
    const first = ledger(harness)
    const producer = await stageProducer(harness, '1.5.0')
    expect(ledger(harness).generation).toBe(first.generation)
    expect(ledger(harness).directIds.filter(id => id === String(producer.id))).toHaveLength(1)
    await dispose(harness)
    const resumed = await mount(harness.root, true, harness.adapter)
    const providerBefore = resumed.adapter.rootRequests.length
    await send(resumed.agent, consumerDirect)
    const retained = ledger(resumed)
    expect(retained.generation).toBe(first.generation)
    expect(retained.canonicalRef).toBe(first.canonicalRef)
    expect(resumed.adapter.rootRequests).toHaveLength(providerBefore)
    expect(errors(resumed)).toContain(closedText)
  })

  it('N2 rejects mismatched persisted C41 generation before consumer formation or apply', async () => {
    const harness = await fresh('f01-t4-n2-')
    await establishFirst(harness)
    const first = ledger(harness)
    await stageProducer(harness, '1.5.0')
    const record = readRecord(harness.root)
    const transaction = field(record, 'transaction', 'stored row')
    await harness.domain.table('focus_precanonical').put(
      sessionId,
      { ...record, transaction: { ...transaction, generation: first.generation + 1 } },
    )
    const providerBefore = harness.adapter.rootRequests.length
    await send(harness.agent, consumerDirect)
    expect(harness.adapter.rootRequests).toHaveLength(providerBefore)
    expect(errors(harness)).toContain(closedText)
  })

  it('N3 rejects downstream reject, mixed batch and nonexact consumer objects without applying', async () => {
    for (const variant of ['reject', 'mixed', 'clone'] as const) {
      const harness = await fresh(`f01-t4-n3-${variant}-`)
      await establishFirst(harness)
      const first = ledger(harness)
      await stageProducer(harness, '1.5.0')
      if (variant === 'reject') {
        harness.downstream.mode = 'reject-once'
        await send(harness.agent, consumerDirect)
      } else if (variant === 'clone') {
        harness.downstream.mode = 'clone-once'
        await send(harness.agent, consumerDirect)
      } else {
        const firstDirect = createUserMessage({ content: [{ type: 'text', text: consumerDirect }], source: { kind: 'user' } })
        const secondDirect = createUserMessage({ content: [{ type: 'text', text: '并发第二条' }], source: { kind: 'user' } })
        harness.agent.send(firstDirect, 'next-step', false)
        harness.agent.send(secondDirect, 'next-turn', true)
        await harness.agent.whenIdle()
      }
      expect(ledger(harness).generation, variant).toBe(first.generation)
    }
  })

  it('N4 preserves the raw-direct guard and refuses to hide unrelated post-canonical work', async () => {
    const harness = await fresh('f01-t4-n4-')
    await establishFirst(harness)
    const first = ledger(harness)
    await send(harness.agent, rawDirect)
    await stageProducer(harness, '1.5.0')
    const providerBefore = harness.adapter.rootRequests.length
    await send(harness.agent, consumerDirect)
    const retained = ledger(harness)
    expect(retained.generation).toBe(first.generation)
    expect(retained.canonicalRef).toBe(first.canonicalRef)
    expect(harness.adapter.rootRequests).toHaveLength(providerBefore)
    expect(errors(harness)).toContain(closedText)
  })

  it('N5 reports an exact C42 and keeps provider zero when the frozen candidate budget becomes unknown', async () => {
    const adapter = new Adapter()
    adapter.contextWindow = 2_048
    const harness = await fresh('f01-t4-n5-', adapter)
    await establishFirst(harness)
    const first = ledger(harness)
    await stageProducer(harness, `1.5.0-${'x'.repeat(3_500)}`)
    const providerBefore = harness.adapter.rootRequests.length
    await send(harness.agent, consumerDirect)
    const retained = ledger(harness)
    expect(retained.generation).toBe(first.generation)
    expect(harness.adapter.rootRequests).toHaveLength(providerBefore)
    expect(harness.agent.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'ui-context-compactor:candidate-qualification')).toBe(true)
  })

  it('N6 consumes pending once, rejects replay and never calls identical when only body-like meaning matches', async () => {
    const harness = await fresh('f01-t4-n6-')
    await establishFirst(harness)
    const first = ledger(harness)
    const producer = await stageProducer(harness, '1.5.0')
    await send(harness.agent, consumerDirect)
    const second = ledger(harness)
    expect(second.generation).toBe(first.generation + 1)
    const providerBefore = harness.adapter.rootRequests.length
    await send(harness.agent, '第二个 consumer 不能重放已消费 pending')
    await send(harness.agent, producer)
    const retained = ledger(harness)
    expect(retained.generation).toBe(second.generation)
    expect(retained.canonicalRef).toBe(second.canonicalRef)
    expect(retained.directIds.filter(id => id === String(producer.id))).toHaveLength(1)
    expect(harness.adapter.rootRequests.length).toBeGreaterThanOrEqual(providerBefore + 1)
  })
})
