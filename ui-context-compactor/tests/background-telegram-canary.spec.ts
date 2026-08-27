import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
import { createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type Message, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
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

function hasSchema(options: GenerateOptions, plugin: string): boolean {
  return options.messages.some(message => message.source.kind === 'plugin' && message.source.plugin === plugin)
}

function text(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

function object(value: unknown, label: string): ObjectRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`expected ${label} object`)
  const copy: ObjectRecord = {}
  for (const [key, child] of Object.entries(value)) copy[key] = child
  return copy
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
        unresolvedInputs: [{ fact: 'DeepSeek Harness 最新版本', meaning: '版本待核清', source: 'direct-user', degree: 'unknown', affected: '升级 DeepSeek Harness' }],
      }))
      return
    }
    if (hasSchema(options, 'ui-context-compactor:evidence-schema')) {
      this.evidenceCalls += 1
      const projection: unknown = JSON.parse(text(options.messages.slice(1)))
      const material = field(projection, 'material', 'evidence projection')
      const projectionRecord = object(projection, 'evidence projection')
      yield* chunks(JSON.stringify({
        kind: 'direct_fact', fact: projectionRecord.fact,
        conclusion: 'DeepSeek Harness 当前最新稳定版本为 1.4.2',
        appliesWhen: 'stable channel', observedAt: material.observedAt,
        publishedAt: material.publishedAt ?? null,
        futureUse: '只用于本次升级前版本判断', source: material.source,
        degree: 'established', request: projectionRecord.request,
        material: material.ref, factNeeds: projectionRecord.factNeeds,
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

async function mount(root: string, resume = false, adapter = new Adapter()): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mkdir(join(root, 'storages'), { recursive: true })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: databasePath(root) })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none', packChunks: false })
  await ctx.plugin(CommandRuntime)
  const managedRuntime = { mode: 'enforce' as const, safeUpdateMarginTokens: 64, allowlist: [...ContextManager.FOCUS_CANARY_IDS] }
  await ctx.plugin(ManagedAwareBasicCompactionEngine, { auto: true, thresholdRatio: .99, retainRatio: .1, managedRuntime })
  await ctx.plugin(commandCompact)
  await ctx.plugin(WebRuntime, { searchProvider: 'background-search' })
  ctx.web.registerSearchProvider({
    id: 'background-search', available: () => true,
    search: async (_request: WebSearchRequest) => ({
      content: 'raw provider envelope',
      sources: [{ url: 'https://example.test/releases/latest', snippet: 'DeepSeek Harness 当前最新稳定版本为 1.4.2。', publishedAt: '2026-08-25T09:30:00.000Z' }],
      truncated: false,
    }),
  })
  ctx.llm.registerAdapter(['background-test'], adapter)
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => errors.push(error))
  await ctx.plugin(ContextManager, {
    focusCanary: {
      ...managedRuntime,
      auxiliary: { provider: 'background-test', model: 'background-test', maxOutputTokens: 256,
        timeoutMs: 500, maxExpressionChars: 240, maxProjectionTokens: 2_048, safetyMarginTokens: 128 },
    },
    nativeWriterArbitration: { mode: 'enforce' }, evidenceCanary: { mode: 'enforce' },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = resume
    ? (await ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: { provider: 'background-test', model: 'background-test', maxTokens: 256 } })).agent
    : ctx.agentLoop.create(SessionId(sessionId), { provider: 'background-test', model: 'background-test', maxTokens: 256 })
  await agent.whenIdle()
  return { root, ctx, agent, adapter, errors }
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

async function establish(harness: Harness): Promise<UserMessage> {
  await send(harness.agent, focusDirect)
  await send(harness.agent, evidenceDirect)
  return await send(harness.agent, updateDirect)
}

function backgroundEvents(agent: Agent): SessionEvent<'user/message'>[] {
  return agent.session.events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && event.data.source.kind === 'context-manager-canonical'
      && event.data.source.machine.kind === 'background')
}

function directEvents(agent: Agent, id?: string): SessionEvent<'user/message'>[] {
  return agent.session.events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && event.data.source.kind === 'user'
      && (id === undefined || String(event.data.id) === id))
}

function databasePath(root: string): string {
  return join(root, 'storages', 'context-manager-focus-canary.sqlite')
}

function readRecord(root: string): ObjectRecord {
  const database = new DatabaseSync(databasePath(root), { readOnly: true })
  try {
    const row = database.prepare('SELECT value FROM "u_context_manager_focus_precanonical" WHERE key = ?').get(sessionId)
    const value = object(row, 'database row').value
    if (typeof value !== 'string') throw new Error('background row is not JSON text')
    const parsed: unknown = JSON.parse(value)
    return object(parsed, 'background row')
  } finally { database.close() }
}

function writeRecord(root: string, record: ObjectRecord): void {
  const database = new DatabaseSync(databasePath(root))
  try {
    database.prepare('UPDATE "u_context_manager_focus_precanonical" SET value = ? WHERE key = ?')
      .run(JSON.stringify(record), sessionId)
  } finally { database.close() }
}

function mutateRecord(root: string, mutate: (record: ObjectRecord) => ObjectRecord): void {
  writeRecord(root, mutate(readRecord(root)))
}

async function dispose(harness: Harness): Promise<void> {
  await harness.ctx.sessions.flush(harness.agent.session)
  await harness.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(harness.ctx), 1)
}

async function establishDurable(root: string): Promise<ObjectRecord> {
  const live = await mount(root)
  await establish(live)
  const record = readRecord(root)
  await dispose(live)
  return record
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

async function findSessionLog(directory: string): Promise<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      try { return await findSessionLog(path) } catch (error) {
        if (!(error instanceof Error) || error.message !== 'session log not found') throw error
      }
    } else if (entry.name === 'session.jsonl') return path
  }
  throw new Error('session log not found')
}

async function rewriteSession(root: string, transform: (event: ObjectRecord) => ObjectRecord | undefined): Promise<void> {
  const path = await findSessionLog(join(root, 'sessions'))
  const output: string[] = []
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (line.length === 0) continue
    const parsed: unknown = JSON.parse(line)
    const record = object(parsed, 'JSONL line')
    if (typeof record.seq !== 'number') output.push(line)
    else {
      const next = transform(record)
      if (next !== undefined) output.push(JSON.stringify(next))
    }
  }
  await writeFile(path, `${output.join('\n')}\n`)
}

async function prepareCleanPending(root: string): Promise<void> {
  const finalized = readRecord(root)
  const transaction = field(finalized, 'transaction', 'finalized row')
  const firstReplaceSeq = transaction.firstReplaceSeq
  if (typeof firstReplaceSeq !== 'number') throw new Error('finalized row has no first replace seq')
  writeRecord(root, pendingRecord(finalized))
  await rewriteSession(root, event => typeof event.seq === 'number' && event.seq >= firstReplaceSeq ? undefined : event)
}

async function expectClosed(root: string, label = root): Promise<void> {
  const resumed = await mount(root, true)
  const baseline = resumed.adapter.rootRequests.length
  const direct = await send(resumed.agent, '继续')
  expect(resumed.adapter.rootRequests, label).toHaveLength(baseline)
  expect(directEvents(resumed.agent, String(direct.id)), label).toHaveLength(1)
  expect(resumed.errors.map(error => error instanceof Error ? error.message : String(error)), label).toContain(closedText)
}

async function expectSchemaClosed(root: string, label: string, invalid: ObjectRecord): Promise<void> {
  writeRecord(root, invalid)
  const adapter = new Adapter()
  await expect(mount(root, true, adapter), label).rejects.toThrow(
    "stored record 'session-context-manager-focus-canary-a' in table 'focus_precanonical' does not match its schema",
  )
  expect(adapter.rootRequests, label).toHaveLength(0)
}

function backgroundRequest(harness: Harness): GenerateOptions {
  const request = harness.adapter.rootRequests.at(-1)
  if (request === undefined) throw new Error('missing background root request')
  return request
}

describe('F06-T1 owner-qualified background through real Telegram-style roots', () => {
  it('P1 applies the first qualified background as the only visible background on a bounded surface', async () => {
    const harness = await fresh('f06-background-p1-')
    await establish(harness)
    const visible = harness.agent.session.deriveMessages()
    expect(visible.filter(message => message.source.kind === 'context-manager-canonical'
      && message.source.machine.kind === 'background')).toHaveLength(1)
    expect(backgroundEvents(harness.agent).map(event => event.data.source.kind === 'context-manager-canonical'
      ? event.data.source.phase : undefined)).toEqual(['current', 'finalized'])
    expect(field(readRecord(harness.root), 'transaction', 'stored row').phase).toBe('finalized')
  })

  it('P2 releases the exact direct once and makes one root request from canonical plus direct only', async () => {
    const harness = await fresh('f06-background-p2-')
    const direct = await establish(harness)
    const request = backgroundRequest(harness)
    expect(directEvents(harness.agent, String(direct.id))).toHaveLength(1)
    expect(request.messages).toHaveLength(2)
    expect(request.messages[0]?.source.kind).toBe('context-manager-canonical')
    expect(request.messages[0]?.source.kind === 'context-manager-canonical'
      ? request.messages[0].source.machine.kind : undefined).toBe('background')
    expect(String(request.messages[1]?.id)).toBe(String(direct.id))
    expect(request.messages[1]).toStrictEqual(direct)
    expect(text([request.messages[0]!])).not.toContain(updateDirect)
  })

  it('P3 restores finalized cold state and clean pending repair to the same canonical meaning', async () => {
    const seed = await mkdtemp(join(tmpdir(), 'f06-background-p3-seed-'))
    roots.push(seed)
    await establishDurable(seed)
    const meanings: string[] = []
    for (const variant of ['finalized', 'clean-pending'] as const) {
      const root = await mkdtemp(join(tmpdir(), `f06-background-p3-${variant}-`))
      roots.push(root)
      await cp(seed, root, { recursive: true })
      if (variant === 'clean-pending') await prepareCleanPending(root)
      const resumed = await mount(root, true)
      const direct = await send(resumed.agent, '继续')
      const request = resumed.adapter.rootRequests.at(-1)
      expect(request, `${variant}:${resumed.errors.map(error => error instanceof Error ? error.message : String(error)).join('|')}`).toBeDefined()
      if (request === undefined) throw new Error(`missing ${variant} background root request`)
      expect(request.messages).toHaveLength(2)
      expect(request.messages[1]?.id).toBe(direct.id)
      expect(request.messages[1]).toStrictEqual(direct)
      meanings.push(text([request.messages[0]!]))
      expect(field(readRecord(root), 'transaction', 'stored row').phase).toBe('finalized')
    }
    expect(meanings[0]).toBe(meanings[1])
  })

  it('N1 rejects C33-only and C28-pending identity mismatches without a provider request', async () => {
    for (const variant of ['c33-only', 'c28-mismatch'] as const) {
      const root = await mkdtemp(join(tmpdir(), `f06-background-n1-${variant}-`)); roots.push(root)
      const finalized = await establishDurable(root)
      const invalid = (() => {
        const record = readRecord(root)
        const pending = pendingRecord(record)
        const transaction = field(pending, 'transaction', 'pending row')
        if (variant === 'c33-only') return {
          ...pending,
          transaction: { ...transaction, c33: field(finalized, 'transaction', 'finalized row').c33 },
        }
        const c28 = field(transaction, 'c28', 'pending transaction')
        const identity = field(c28, 'identity', 'pending c28')
        return {
          ...pending,
          transaction: { ...transaction, c28: { ...c28, identity: { ...identity, call: 'C28:foreign' } } },
        }
      })()
      await expectSchemaClosed(root, variant, invalid)
    }
  })

  it('N2 rejects first/finalized replacement mismatches and retains no fake recovered success', async () => {
    for (const key of ['firstReplaceSeq', 'finalizedReplaceSeq'] as const) {
      const root = await mkdtemp(join(tmpdir(), `f06-background-n2-${key}-`)); roots.push(root)
      await establishDurable(root)
      mutateRecord(root, record => {
        const transaction = field(record, 'transaction', 'stored row')
        const value = transaction[key]
        if (typeof value !== 'number') throw new Error(`missing ${key}`)
        return { ...record, transaction: { ...transaction, [key]: key === 'firstReplaceSeq' ? value - 1 : value + 1 } }
      })
      await expectClosed(root, key)
    }
  })

  it('N3 rejects detached readFrom seq/id corruption instead of treating flush as publication proof', async () => {
    for (const variant of ['wrong-seq', 'wrong-id'] as const) {
      const root = await mkdtemp(join(tmpdir(), `f06-background-n3-${variant}-`)); roots.push(root)
      await establishDurable(root)
      mutateRecord(root, record => {
        const transaction = field(record, 'transaction', 'stored row')
        const finalizedSeq = transaction.finalizedReplaceSeq
        if (typeof finalizedSeq !== 'number') throw new Error('missing finalized replace seq')
        const finalizedId = transaction.repair === undefined ? 'unrepaired-finalized-id' : undefined
        return {
          ...record,
          transaction: {
            ...transaction,
            repair: {
              phase: 'repair_finalized',
              targetMessageId: variant === 'wrong-seq' && finalizedId !== undefined
                ? finalizedId : 'foreign-finalized-id',
              targetReplaceSeq: finalizedSeq + 100,
            },
          },
        }
      })
      await expectClosed(root, variant)
    }
  })

  it('N4 rejects an already-appended direct and a source-spoofed finalized event without overwriting background', async () => {
    const live = await fresh('f06-background-n4-direct-')
    await send(live.agent, focusDirect); await send(live.agent, evidenceDirect)
    const direct = createUserMessage({ content: [{ type: 'text', text: updateDirect }], source: { kind: 'user' } })
    live.agent.session.append('user/message', direct, { surfaceOp: 'append' })
    const baseline = live.adapter.rootRequests.length
    await send(live.agent, direct)
    expect(live.adapter.rootRequests).toHaveLength(baseline)
    expect(backgroundEvents(live.agent)).toHaveLength(0)
    expect(directEvents(live.agent, String(direct.id))).toHaveLength(1)

    const root = await mkdtemp(join(tmpdir(), 'f06-background-n4-source-')); roots.push(root)
    const finalized = await establishDurable(root)
    const targetSeq = field(finalized, 'transaction', 'stored row').finalizedReplaceSeq
    await rewriteSession(root, event => {
      if (event.seq !== targetSeq || event.type !== 'user/message') return event
      const data = field(event, 'data', 'finalized event')
      const source = field(data, 'source', 'finalized message')
      source.kind = 'plugin'; source.plugin = 'spoof'; delete source.machine
      return { ...event, data: { ...data, source } }
    })
    await expectClosed(root, 'source-spoof')
  })

  it('N5 exposes expected-missing and forged-C28 cold state without a fake provider success', async () => {
    for (const variant of ['expected-missing', 'forged-c28'] as const) {
      const root = await mkdtemp(join(tmpdir(), `f06-background-n5-${variant}-`)); roots.push(root)
      await establishDurable(root)
      if (variant === 'expected-missing') {
        const database = new DatabaseSync(databasePath(root))
        try { database.prepare('DELETE FROM "u_context_manager_focus_precanonical" WHERE key = ?').run(sessionId) }
        finally { database.close() }
      } else {
        const forged = (() => {
          const record = readRecord(root)
          const transaction = field(record, 'transaction', 'stored row')
          const c28 = field(transaction, 'c28', 'stored transaction')
          const identity = field(c28, 'identity', 'stored c28')
          return {
            ...record,
            transaction: { ...transaction, c28: { ...c28, identity: { ...identity, call: 'C28:forged' } } },
          }
        })()
        await expectSchemaClosed(root, variant, forged)
        continue
      }
      await expectClosed(root, variant)
    }
  })
})
