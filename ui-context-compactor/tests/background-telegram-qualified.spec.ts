import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import WebRuntime, { type WebSearchRequest } from '@deepseek-ai/dsh-web'
import { ManagedAwareBasicCompactionEngine } from '../src/managed-compaction.ts'
import * as ContextManager from '../src/index.ts'

type ObjectRecord = Record<string, unknown>

const roots: string[] = []
const contexts: Context[] = []
const sessionId = ContextManager.FOCUS_CANARY_IDS[0]!
const focusDirect = '准备升级 DeepSeek Harness'
const evidenceDirect = '查一下 DeepSeek Harness 当前最新版本；确认后再决定是否升级。'
const updateDirect = '请更新当前背景'
const unrolledDirect = '这条临时决定还没有经过事实核清，先不要丢。'
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

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 16_384 } })
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
        conclusion: 'DeepSeek Harness 当前最新稳定版本为 1.4.2',
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
  readonly errors: unknown[]
}

interface RuntimeLedger {
  readonly generation: number
  readonly canonicalRef: string
  readonly candidateRef: string
  readonly body: string
  readonly visibleCanonical: readonly string[]
  readonly directIds: readonly string[]
  readonly rootRequests: number
  readonly nativeEvents: number
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
  await ctx.plugin(WebRuntime, { searchProvider: 'qualified-background-search' })
  ctx.web.registerSearchProvider({
    id: 'qualified-background-search',
    available: () => true,
    search: async (_request: WebSearchRequest) => ({
      content: 'private raw envelope',
      sources: [{
        url: 'https://example.test/releases/latest',
        snippet: 'DeepSeek Harness 当前最新稳定版本为 1.4.2。',
        publishedAt: '2026-08-25T09:30:00.000Z',
      }],
      truncated: false,
    }),
  })
  ctx.llm.registerAdapter(['qualified-background-test'], adapter)
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => errors.push(error))
  await ctx.plugin(ContextManager, {
    focusCanary: {
      ...managedRuntime,
      auxiliary: {
        provider: 'qualified-background-test', model: 'qualified-background-test',
        maxOutputTokens: 256, timeoutMs: 500, maxExpressionChars: 240,
        maxProjectionTokens: 2_048, safetyMarginTokens: 128,
      },
    },
    nativeWriterArbitration: { mode: 'enforce' },
    evidenceCanary: { mode: 'enforce' },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  const options = {
    provider: 'qualified-background-test', model: 'qualified-background-test', maxTokens: 256,
  }
  const agent = resume
    ? (await ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: options })).agent
    : ctx.agentLoop.create(SessionId(sessionId), options)
  await agent.whenIdle()
  return Object.freeze({ root, ctx, agent, adapter, errors })
}

async function fresh(prefix: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return await mount(root)
}

async function send(agent: Agent, messageOrText: string | UserMessage): Promise<UserMessage> {
  const message = typeof messageOrText === 'string'
    ? createUserMessage({ content: [{ type: 'text', text: messageOrText }], source: { kind: 'user' } })
    : messageOrText
  agent.followup(message)
  await agent.whenIdle()
  return message
}

async function establishFirst(harness: Harness): Promise<void> {
  await send(harness.agent, focusDirect)
  await send(harness.agent, evidenceDirect)
  await send(harness.agent, updateDirect)
}

async function establishSecond(harness: Harness): Promise<UserMessage> {
  await send(harness.agent, evidenceDirect)
  return await send(harness.agent, updateDirect)
}

function databasePath(root: string): string {
  return join(root, 'storages', 'context-manager-focus-canary.sqlite')
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

function writeRecord(root: string, record: ObjectRecord): void {
  const database = new DatabaseSync(databasePath(root))
  try {
    database.prepare(
      'UPDATE "u_context_manager_focus_precanonical" SET value = ? WHERE key = ?',
    ).run(JSON.stringify(record), sessionId)
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
    visibleCanonical: Object.freeze(harness.agent.session.deriveMessages().flatMap(message =>
      message.source.kind === 'context-manager-canonical'
        && message.source.machine.kind === 'background' ? [String(message.source.canonicalStateRef)] : [])),
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

async function sessionLog(root: string): Promise<string> {
  const files = await readdir(join(root, 'sessions'), { recursive: true })
  const relative = files.find(file => file.endsWith('session.jsonl'))
  if (relative === undefined) throw new Error('session log not found')
  return join(root, 'sessions', relative)
}

async function rewriteSession(
  root: string,
  transform: (event: ObjectRecord) => ObjectRecord | undefined,
): Promise<void> {
  const path = await sessionLog(root)
  const output = (await readFile(path, 'utf8')).split('\n').flatMap(line => {
    if (line.length === 0) return []
    const event = object(JSON.parse(line), 'session event')
    if (typeof event.seq !== 'number') return [line]
    const next = transform(event)
    return next === undefined ? [] : [JSON.stringify(next)]
  })
  await writeFile(path, `${output.join('\n')}\n`)
}

function pendingRecord(finalized: ObjectRecord): ObjectRecord {
  const transaction = field(finalized, 'transaction', 'finalized row')
  return {
    family: 'background',
    transaction: {
      family: 'background', phase: 'pending', pendingRef: transaction.pendingRef,
      canonicalRef: transaction.canonicalRef, generation: transaction.generation,
      machine: transaction.machine, body: transaction.body, bodyHash: transaction.bodyHash,
      material: transaction.material, c28: transaction.c28, c06: transaction.c06,
      c20: transaction.c20, c29: transaction.c29,
    },
  }
}

async function prepareCleanPending(root: string): Promise<void> {
  const finalized = readRecord(root)
  const transaction = field(finalized, 'transaction', 'finalized row')
  const firstReplaceSeq = transaction.firstReplaceSeq
  if (typeof firstReplaceSeq !== 'number') throw new Error('missing first replace seq')
  writeRecord(root, pendingRecord(finalized))
  await rewriteSession(root, event => typeof event.seq === 'number'
    && event.seq >= firstReplaceSeq ? undefined : event)
}

async function expectClosed(root: string): Promise<void> {
  const resumed = await mount(root, true)
  const baseline = resumed.adapter.rootRequests.length
  await send(resumed.agent, '继续')
  expect(resumed.adapter.rootRequests).toHaveLength(baseline)
  expect(resumed.errors.map(error => error instanceof Error ? error.message : String(error)))
    .toContain(closedText)
}

function canonicalText(harness: Harness): string {
  const request = harness.adapter.rootRequests.at(-1)
  const canonical = request?.messages[0]
  if (canonical === undefined || canonical.source.kind !== 'context-manager-canonical') {
    throw new Error('root request has no canonical background')
  }
  return messagesText([canonical])
}

describe('F06-T3 qualified subsequent background through public Harness surfaces', () => {
  it('P1 forms C41 plus a fresh basis through a natural second C38 and replaces generation one', async () => {
    const harness = await fresh('f06-t3-p1-')
    await establishFirst(harness)
    const first = ledger(harness)
    const direct = await establishSecond(harness)
    const second = ledger(harness)
    expect(second.generation).toBe(first.generation + 1)
    expect(second.canonicalRef).not.toBe(first.canonicalRef)
    expect(second.candidateRef).not.toBe(first.candidateRef)
    expect(second.visibleCanonical).toStrictEqual([second.canonicalRef])
    expect(second.directIds.filter(id => id === String(direct.id))).toHaveLength(1)
    expect(harness.adapter.rootRequests.at(-1)?.messages).toHaveLength(2)
    expect(second.nativeEvents).toBe(0)
  })

  it('P2 routes managed scoped compact through the same C38/C41/C28/apply black box', async () => {
    const harness = await fresh('f06-t3-p2-')
    await establishFirst(harness)
    const first = ledger(harness)
    await send(harness.agent, evidenceDirect)
    const result = await harness.ctx.commands.execute(
      harness.agent, '/compact', [], new AbortController().signal,
    )
    const second = ledger(harness)
    expect(result?.result).toStrictEqual({
      kind: 'success', text: '当前背景已通过同一受管更新事务换入。',
    })
    expect(second.generation).toBe(first.generation + 1)
    expect(second.visibleCanonical).toStrictEqual([second.canonicalRef])
    expect(second.nativeEvents).toBe(0)
    expect(harness.adapter.rootRequests.at(-1)?.messages).toHaveLength(2)
  })

  it('P3 restores finalized and clean-pending generation two to the same original meaning', async () => {
    const seed = await fresh('f06-t3-p3-seed-')
    await establishFirst(seed)
    await establishSecond(seed)
    const expected = ledger(seed)
    await dispose(seed)
    const meanings: string[] = []
    for (const variant of ['finalized', 'clean-pending'] as const) {
      const root = await mkdtemp(join(tmpdir(), `f06-t3-p3-${variant}-`))
      roots.push(root)
      await cp(seed.root, root, { recursive: true })
      if (variant === 'clean-pending') await prepareCleanPending(root)
      const resumed = await mount(root, true)
      await send(resumed.agent, '继续')
      const recovered = ledger(resumed)
      expect(recovered.generation).toBe(expected.generation)
      expect(recovered.body).toBe(expected.body)
      expect(recovered.visibleCanonical).toStrictEqual([recovered.canonicalRef])
      meanings.push(canonicalText(resumed))
    }
    expect(meanings[0]).toBe(meanings[1])
  })

  it('N1 keeps generation one when a second update has no fresh complete basis', async () => {
    const harness = await fresh('f06-t3-n1-')
    await establishFirst(harness)
    const first = ledger(harness)
    const providerBefore = harness.adapter.rootRequests.length
    const direct = await send(harness.agent, updateDirect)
    const retained = ledger(harness)
    expect(retained.generation).toBe(first.generation)
    expect(retained.canonicalRef).toBe(first.canonicalRef)
    expect(retained.visibleCanonical).toStrictEqual([first.canonicalRef])
    expect(retained.directIds.filter(id => id === String(direct.id))).toHaveLength(1)
    expect(harness.adapter.rootRequests).toHaveLength(providerBefore)
    await send(harness.agent, evidenceDirect)
    const retry = await send(harness.agent, updateDirect)
    const advanced = ledger(harness)
    expect(advanced.generation).toBe(first.generation + 1)
    expect(advanced.canonicalRef).not.toBe(first.canonicalRef)
    expect(advanced.visibleCanonical).toStrictEqual([advanced.canonicalRef])
    expect(advanced.directIds.filter(id => id === String(retry.id))).toHaveLength(1)
  })

  it('N2 refuses to erase post-canonical raw work that is absent from the new qualified basis', async () => {
    const harness = await fresh('f06-t3-n2-')
    await establishFirst(harness)
    const first = ledger(harness)
    await send(harness.agent, unrolledDirect)
    await send(harness.agent, evidenceDirect)
    const providerBefore = harness.adapter.rootRequests.length
    await send(harness.agent, updateDirect)
    const retained = ledger(harness)
    expect(retained.generation).toBe(first.generation)
    expect(retained.canonicalRef).toBe(first.canonicalRef)
    expect(harness.adapter.rootRequests).toHaveLength(providerBefore)
    expect(harness.errors.map(error => error instanceof Error ? error.message : String(error)))
      .toContain(closedText)
  })

  it('N3 rejects an old current record after generation two instead of applying a mismatched generation', async () => {
    const harness = await fresh('f06-t3-n3-')
    await establishFirst(harness)
    const old = structuredClone(readRecord(harness.root))
    await establishSecond(harness)
    const second = ledger(harness)
    await dispose(harness)
    writeRecord(harness.root, old)
    const resumed = await mount(harness.root, true)
    const providerBefore = resumed.adapter.rootRequests.length
    await send(resumed.agent, '继续')
    const visible = resumed.agent.session.deriveMessages().flatMap(message =>
      message.source.kind === 'context-manager-canonical'
        && message.source.machine.kind === 'background' ? [message.source.generation] : [])
    expect(visible).toStrictEqual([second.generation])
    expect(resumed.adapter.rootRequests).toHaveLength(providerBefore)
    expect(resumed.errors.map(error => error instanceof Error ? error.message : String(error)))
      .toContain(closedText)
  })

  it('N4 rejects corrupted replace and detached publication evidence on cold generation-two recovery', async () => {
    const seed = await fresh('f06-t3-n4-seed-')
    await establishFirst(seed)
    await establishSecond(seed)
    await dispose(seed)
    for (const variant of ['replace', 'detached'] as const) {
      const root = await mkdtemp(join(tmpdir(), `f06-t3-n4-${variant}-`))
      roots.push(root)
      await cp(seed.root, root, { recursive: true })
      const record = readRecord(root)
      const transaction = field(record, 'transaction', 'stored row')
      if (variant === 'replace') {
        if (typeof transaction.finalizedReplaceSeq !== 'number') throw new Error('missing finalized seq')
        writeRecord(root, {
          ...record,
          transaction: { ...transaction, finalizedReplaceSeq: transaction.finalizedReplaceSeq + 1 },
        })
      } else {
        const finalizedSeq = transaction.finalizedReplaceSeq
        if (typeof finalizedSeq !== 'number') throw new Error('missing detached seq')
        await rewriteSession(root, event => {
          if (event.seq !== finalizedSeq || event.type !== 'user/message') return event
          const data = field(event, 'data', 'finalized event')
          const source = field(data, 'source', 'finalized message')
          return {
            ...event,
            data: { ...data, source: { ...source, kind: 'plugin', plugin: 'detached-spoof' } },
          }
        })
      }
      await expectClosed(root)
    }
  })

  it('N5 keeps one same-id direct and one proved generation when a completed update is replayed', async () => {
    const harness = await fresh('f06-t3-n5-')
    await establishFirst(harness)
    await send(harness.agent, evidenceDirect)
    const direct = createUserMessage({
      content: [{ type: 'text', text: updateDirect }], source: { kind: 'user' },
    })
    await send(harness.agent, direct)
    const completed = ledger(harness)
    const providerBefore = harness.adapter.rootRequests.length
    await send(harness.agent, direct)
    const retained = ledger(harness)
    expect(retained.generation).toBe(completed.generation)
    expect(retained.canonicalRef).toBe(completed.canonicalRef)
    expect(retained.directIds.filter(id => id === String(direct.id))).toHaveLength(1)
    expect(harness.adapter.rootRequests).toHaveLength(providerBefore)
    expect(retained.nativeEvents).toBe(0)
  })
})
