import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  createUserMessage,
  LlmAdapter,
  MessageId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as ContextManager from '../src/index.ts'
import { directExpressionHash } from '../src/managed-runtime.ts'
import {
  ManagedAwareBasicCompactionEngine,
  type ManagedAwareBasicCompactionConfig,
  type ManagedCompactionRuntimeConfig,
} from '../src/managed-compaction.ts'

const roots: string[] = []
const contexts: Context[] = []
const closeText = '这件事结束了'
const managedFailure = '唯一背景未能安全换入，本轮未继续行动'
const safeUpdateMarginTokens = 64

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

function text(options: GenerateOptions): string {
  return options.messages.flatMap(message => message.content)
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text).join('\n')
}

function auxiliary(options: GenerateOptions): boolean {
  return options.messages.some(message => message.source.kind === 'plugin'
    && message.source.plugin === 'ui-context-compactor:focus-canary-schema')
}

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  rootCalls = 0
  auxiliaryCalls = 0
  auxiliaryOutput = '{"kind":"focus","subject":"untrusted proposal","relation":"new"}'
  onRootDispatch: (() => void) | undefined

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 8_192 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (auxiliary(options)) {
      this.auxiliaryCalls += 1
      yield* chunks(this.auxiliaryOutput)
      return
    }
    this.rootCalls += 1
    this.onRootDispatch?.()
    if (options.messages.some(message => message.source.kind === 'plugin'
      && message.source.plugin === 'ui-context-compactor:no-focus')) {
      yield* chunks('当前事项已结束，请告诉我下一件事')
      return
    }
    const advice = text(options).match(/已记录当前焦点：([^\n]+)/)?.[1]
    yield* chunks(advice === undefined ? '继续处理：未成立焦点' : `继续处理：${advice}`)
  }
}

type CanaryConfig = Extract<NonNullable<ContextManager.Config['focusCanary']>, { readonly mode: 'enforce' }>
const config: CanaryConfig = {
  mode: 'enforce', safeUpdateMarginTokens, allowlist: [...ContextManager.FOCUS_CANARY_IDS],
  auxiliary: { provider: 'no-focus-test', model: 'no-focus-test-model', maxOutputTokens: 64, timeoutMs: 500,
    maxExpressionChars: 240, maxProjectionTokens: 1_024, safetyMarginTokens: 128 },
}

interface DomainTable { put(key: string, value: unknown): Promise<void> }
interface CapturedDomain { table(name: string): DomainTable }
interface Harness { readonly ctx: Context; readonly agent: Agent; readonly adapter: Adapter; readonly root: string; readonly domain: CapturedDomain }

async function mount(root: string, sessionId = ContextManager.FOCUS_CANARY_IDS[0]): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mkdir(join(root, 'storages'), { recursive: true })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: join(root, 'storages', 'context-manager-focus-canary.sqlite') })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(CommandRuntime)
  const managedRuntime: ManagedCompactionRuntimeConfig = {
    mode: 'enforce',
    safeUpdateMarginTokens,
    allowlist: config.allowlist,
  }
  const compaction: ManagedAwareBasicCompactionConfig = {
    auto: true, thresholdRatio: 0.99, retainRatio: 0.1, managedRuntime,
  }
  await ctx.plugin(ManagedAwareBasicCompactionEngine, compaction)
  await ctx.plugin(commandCompact)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['no-focus-test'], adapter)
  let domain: CapturedDomain | undefined
  const storageDomain = ctx.get('storageDomain') as unknown as { open(spec: unknown): Promise<CapturedDomain> }
  const open = storageDomain.open.bind(storageDomain)
  storageDomain.open = async spec => {
    const opened = await open(spec)
    domain = opened
    return opened
  }
  await ctx.plugin(ContextManager, { focusCanary: config, nativeWriterArbitration: { mode: 'enforce' } })
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = ctx.agentLoop.create(SessionId(sessionId), { provider: 'no-focus-test', model: 'no-focus-test-model' })
  if (domain === undefined) throw new Error('expected the public canary storage domain')
  return { ctx, agent, adapter, root, domain }
}

async function send(agent: Agent, body: string): Promise<UserMessage> {
  const message = createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } })
  agent.send(message, 'next-turn', true)
  await agent.whenIdle()
  return message
}

function direct(agent: Agent): Array<Extract<SessionEvent, { type: 'user/message' }>> {
  return agent.session.events.filter((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
    event.type === 'user/message' && event.data.source.kind === 'user')
}

function errors(ctx: Context, agent: Agent): unknown[] {
  const seen: unknown[] = []
  ctx.on('agent/error', ({ agent: subject, error }) => { if (subject === agent) seen.push(error) })
  return seen
}

function readRecord(root: string, sessionId = ContextManager.FOCUS_CANARY_IDS[0]): unknown {
  const database = new DatabaseSync(join(root, 'storages', 'context-manager-focus-canary.sqlite'), { readOnly: true })
  try {
    const row = database.prepare('SELECT value FROM "u_context_manager_focus_precanonical" WHERE key = ?')
      .get(sessionId) as { value: string } | undefined
    if (row === undefined) throw new Error('missing natural focus sidecar row')
    return JSON.parse(row.value)
  } finally { database.close() }
}

function assertNoNativeWriter(agent: Agent): void {
  expect(agent.session.events.filter(event => event.type.startsWith('compaction/'))).toHaveLength(0)
  expect(agent.session.events.filter(event => event.type === 'user/message'
    && isCompactCheckpointSource(event.data.source))).toHaveLength(0)
}

function assertCloseOnce(agent: Agent, close: UserMessage): void {
  const event = direct(agent).filter(candidate => String(candidate.data.id) === String(close.id))
  expect(event).toHaveLength(1)
  expect(event[0]?.data.source.kind).toBe('user')
  expect(event[0]?.data.content).toEqual([{ type: 'text', text: closeText }])
  expect(directExpressionHash(String(close.id), closeText)).toBe(directExpressionHash(String(event[0]!.data.id), closeText))
}

function assertSilentFailure(h: Harness, close: UserMessage, seen: readonly unknown[]): void {
  expect(h.adapter.rootCalls).toBe(1)
  expect(h.adapter.auxiliaryCalls).toBe(2)
  // This public F07 error is emitted only after H2's same-id proof; the
  // physical close assertion immediately below prevents an early-error fake.
  expect(seen.map(value => value instanceof Error ? value.message : String(value))).toEqual([managedFailure])
  assertCloseOnce(h.agent, close)
  expect(h.agent.session.events.filter(event => event.type.startsWith('tool/'))).toHaveLength(0)
  assertNoNativeWriter(h.agent)
}

async function establishA(h: Harness): Promise<void> {
  await send(h.agent, '帮我审这份方案')
  expect(h.adapter.auxiliaryCalls).toBe(1)
  expect(h.adapter.rootCalls).toBe(1)
  h.adapter.auxiliaryOutput = '{"kind":"close","relation":"current"}'
}

function transactionPhase(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || !('transaction' in value)) return undefined
  const transaction = value.transaction
  if (transaction === null || typeof transaction !== 'object' || !('phase' in transaction)) return undefined
  return typeof transaction.phase === 'string' ? transaction.phase : undefined
}

interface PendingTransactionAttempt {
  readonly transaction: {
    readonly phase: 'pending'
    readonly pendingRef: string
    readonly c29: { readonly kind: string; readonly identity: { readonly subject: string }; readonly value: { readonly state: string } }
    readonly c30?: unknown
    readonly c33?: unknown
    readonly firstReplaceSeq?: unknown
    readonly finalizedReplaceSeq?: unknown
  }
}

function isPendingTransactionAttempt(value: unknown): value is PendingTransactionAttempt {
  if (value === null || typeof value !== 'object' || !('transaction' in value)) return false
  const transaction = value.transaction
  return transaction !== null && typeof transaction === 'object'
    && 'phase' in transaction && transaction.phase === 'pending'
    && 'pendingRef' in transaction && typeof transaction.pendingRef === 'string'
    && 'c29' in transaction && transaction.c29 !== null && typeof transaction.c29 === 'object'
    && 'kind' in transaction.c29 && typeof transaction.c29.kind === 'string'
    && 'identity' in transaction.c29 && transaction.c29.identity !== null && typeof transaction.c29.identity === 'object'
    && 'subject' in transaction.c29.identity && typeof transaction.c29.identity.subject === 'string'
    && 'value' in transaction.c29 && transaction.c29.value !== null && typeof transaction.c29.value === 'object'
    && 'state' in transaction.c29.value && typeof transaction.c29.value.state === 'string'
}

interface FailureTimeline {
  readonly entries: string[]
  readonly restore: () => void
}

function tracePhysicalProof(h: Harness): FailureTimeline {
  const entries: string[] = []
  const sessions = h.ctx.sessions as unknown as { flush(session: typeof h.agent.session): Promise<boolean> }
  const flush = sessions.flush.bind(sessions)
  let flushes = 0
  sessions.flush = async session => {
    const result = await flush(session)
    flushes += 1
    entries.push(`flush:${flushes}:${result}`)
    return result
  }
  const persistence = (h.ctx as unknown as {
    get(name: 'sessionPersistence'): { readFrom(sessionId: string, fromSeq: number): Promise<{ events: readonly SessionEvent[] }> }
  }).get('sessionPersistence')
  const readFrom = persistence.readFrom.bind(persistence)
  let reads = 0
  persistence.readFrom = async (id, seq) => {
    const result = await readFrom(id, seq)
    reads += 1
    entries.push(`read:${reads}:${result.events.length}`)
    return result
  }
  const table = h.domain.table('focus_precanonical')
  const put = table.put.bind(table)
  table.put = async (key, value) => {
    const result = await put(key, value)
    if (value !== null && typeof value === 'object'
      && (value as { closure?: { phase?: unknown } }).closure?.phase === 'physically_proved') entries.push('proved-put')
    return result
  }
  h.ctx.on('agent/error', ({ agent, error }) => {
    if (agent === h.agent) entries.push(`error:${error instanceof Error ? error.message : String(error)}`)
  })
  return { entries, restore: () => { sessions.flush = flush; persistence.readFrom = readFrom; table.put = put } }
}

function assertProofPrecedesFailure(trace: FailureTimeline): void {
  const flush = trace.entries.indexOf('flush:1:true')
  const read = trace.entries.findIndex(entry => entry.startsWith('read:1:'))
  const proved = trace.entries.indexOf('proved-put')
  const error = trace.entries.findIndex(entry => entry.startsWith('error:'))
  expect(flush).toBeGreaterThanOrEqual(0)
  expect(read).toBeGreaterThan(flush)
  expect(proved).toBeGreaterThan(read)
  expect(error).toBeGreaterThan(proved)
}

describe('F07-H1 natural no-focus live transaction', () => {
  it('naturally replaces the final real loop request with finalized canonical context plus one plugin receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'no-focus-live-'))
    roots.push(root)
    const h = await mount(root)
    await establishA(h)
    const seen = errors(h.ctx, h.agent)
    const dispatchedPhases: Array<string | undefined> = []
    h.adapter.onRootDispatch = () => dispatchedPhases.push(transactionPhase(readRecord(root)))
    const assistantBeforeClose = h.agent.session.events.filter(event => event.type === 'assistant/message').length
    const close = await send(h.agent, closeText)

    expect(seen).toEqual([])
    expect(h.adapter.auxiliaryCalls).toBe(2)
    expect(h.adapter.rootCalls).toBe(2)
    expect(dispatchedPhases).toEqual(['finalized'])
    assertCloseOnce(h.agent, close)
    const record = readRecord(root) as {
      closure: { phase: string; decision: { ref: string } }
      transaction?: {
        phase?: string; pendingRef: string; canonicalRef: string; material: { ref: string }
        c06: { identity: { subject: string }; value: { value: { ref: string } } }
        c07: { identity: { subject: string }; value: { value: { ref: string } } }
        c29: { identity: { subject: string }; value: { state: string } }
        c30: { identity: { subject: string }; value: { state: string } }
        c33: { identity: { subject: string }; value: { material: string } }
        firstC31: { identity: { subject: string }; value: { state: string } }
        finalizedC31: { identity: { subject: string }; value: { state: string } }
        firstC32: { identity: { subject: { state: string } }; value: { state: { state: { ref: string } } } }
        finalizedC32: { identity: { subject: { state: string } }; value: { state: { state: { ref: string } } } }
      }
    }
    expect(record.closure.phase).toBe('physically_proved')
    expect(record.transaction?.phase).toBe('finalized')
    const transaction = record.transaction
    if (transaction === undefined) throw new Error('missing finalized no-focus transaction')
    expect(transaction.c06.identity.subject).toBe(record.closure.decision.ref)
    expect(transaction.c06.value.value.ref).toBe(record.closure.decision.ref)
    expect(transaction.c07.identity.subject).toBe(record.closure.decision.ref)
    expect(transaction.c07.value.value.ref).toBe(record.closure.decision.ref)
    expect(transaction.c29.identity.subject).toBe(transaction.pendingRef)
    expect(transaction.c29.value.state).toBe(transaction.pendingRef)
    expect(transaction.c30.identity.subject).toBe(transaction.pendingRef)
    expect(transaction.c30.value.state).toBe(transaction.pendingRef)
    expect(transaction.c33.identity.subject).toBe(transaction.material.ref)
    expect(transaction.c33.value.material).toBe(transaction.material.ref)
    for (const report of [transaction.firstC31, transaction.finalizedC31]) {
      expect(report.identity.subject).toBe(transaction.pendingRef)
      expect(report.value.state).toBe(transaction.pendingRef)
    }
    for (const report of [transaction.firstC32, transaction.finalizedC32]) {
      expect(report.identity.subject.state).toBe(transaction.canonicalRef)
      expect(report.value.state.state.ref).toBe(transaction.canonicalRef)
    }
    const request = h.adapter.requests.at(-1)!
    expect(request.messages).toHaveLength(2)
    expect(request.messages.map(message => message.source)).toEqual([
      expect.objectContaining({ kind: 'context-manager-canonical', phase: 'finalized' }),
      expect.objectContaining({ kind: 'plugin', plugin: 'ui-context-compactor:no-focus', form: 'notice' }),
    ])
    expect(request.messages.map(message => message.role)).toEqual(['user', 'user'])
    expect(request.messages.some(message => message.source.kind === 'context-route'
      || message.source.kind === 'user'
      || (message.source.kind === 'plugin' && message.source.plugin !== 'ui-context-compactor:no-focus'))).toBe(false)
    const currentTurnAssistants = h.agent.session.events.filter(event => event.type === 'assistant/message').slice(assistantBeforeClose)
    expect(currentTurnAssistants).toHaveLength(1)
    expect(currentTurnAssistants[0]?.data.message.content).toEqual([{ type: 'text', text: '当前事项已结束，请告诉我下一件事' }])
    expect(h.agent.session.events.filter(event => event.type.startsWith('tool/'))).toHaveLength(0)
    assertNoNativeWriter(h.agent)
    expect(h.agent.session.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'context-manager-canonical')).toHaveLength(2)
  })

  it('fails before C30 when the public C33 sidecar put rejects after a natural C29', async () => {
    const root = await mkdtemp(join(tmpdir(), 'no-focus-c33-'))
    roots.push(root)
    const h = await mount(root)
    await establishA(h)
    const trace = tracePhysicalProof(h)
    const table = h.domain.table('focus_precanonical')
    const put = table.put.bind(table)
    let attemptedPending: PendingTransactionAttempt | undefined
    table.put = async (key, value) => {
      if (isPendingTransactionAttempt(value)) {
        attemptedPending = value
        if (attemptedPending === undefined) throw new Error('expected pending transaction attempt')
        const transaction = attemptedPending.transaction
        // The natural F07 transaction has already obtained C29, but the
        // public C33 storage write is still its first irreversible action.
        expect(transaction.c29.kind).toBe('business_result')
        expect(transaction.c29.identity.subject).toBe(transaction.pendingRef)
        expect(transaction.c29.value.state).toBe(transaction.pendingRef)
        expect(Object.hasOwn(transaction, 'c30')).toBe(false)
        expect(Object.hasOwn(transaction, 'c33')).toBe(false)
        expect(Object.hasOwn(transaction, 'firstReplaceSeq')).toBe(false)
        expect(Object.hasOwn(transaction, 'finalizedReplaceSeq')).toBe(false)
        throw new Error('forced C33 write rejection')
      }
      return await put(key, value)
    }
    const seen = errors(h.ctx, h.agent)
    const close = await send(h.agent, closeText)
    table.put = put
    assertSilentFailure(h, close, seen)
    assertProofPrecedesFailure(trace)
    trace.restore()
    expect(attemptedPending).toBeDefined()
    const record = readRecord(root) as { closure: { phase: string }; transaction?: unknown }
    expect(record.closure.phase).toBe('physically_proved')
    expect(record.transaction).toBeUndefined()
  })

  it('fails closed when the first public full-surface replace throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'no-focus-first-replace-'))
    roots.push(root)
    const h = await mount(root)
    await establishA(h)
    const trace = tracePhysicalProof(h)
    const session = h.agent.session as unknown as { append: (...args: unknown[]) => { seq: number } }
    const append = session.append.bind(session)
    session.append = (...args) => {
      const options = args[2] as { surfaceOp?: { op?: string } } | undefined
      if (options?.surfaceOp?.op === 'replace') throw new Error('forced first replace failure')
      return append(...args)
    }
    const seen = errors(h.ctx, h.agent)
    const close = await send(h.agent, closeText)
    session.append = append
    assertSilentFailure(h, close, seen)
    assertProofPrecedesFailure(trace)
    trace.restore()
    expect(transactionPhase(readRecord(root))).toBe('pending')
  })

  it('fails closed when the finalized second replace cannot become the unique visible surface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'no-focus-final-replace-'))
    roots.push(root)
    const h = await mount(root)
    await establishA(h)
    const trace = tracePhysicalProof(h)
    const session = h.agent.session as unknown as { append: (...args: unknown[]) => { seq: number } }
    const append = session.append.bind(session)
    let replaces = 0
    session.append = (...args) => {
      const options = args[2] as { surfaceOp?: { op?: string } } | undefined
      if (options?.surfaceOp?.op === 'replace' && ++replaces === 2) throw new Error('forced finalized replace failure')
      return append(...args)
    }
    const seen = errors(h.ctx, h.agent)
    const close = await send(h.agent, closeText)
    session.append = append
    assertSilentFailure(h, close, seen)
    assertProofPrecedesFailure(trace)
    trace.restore()
    expect(transactionPhase(readRecord(root))).toBe('current')
  })

  it('fails closed when finalized flush or detached readback throws or changes seq, id, source, text, or hash', async () => {
    const variants = ['flush', 'throw', 'seq', 'id', 'source', 'text', 'hash'] as const
    for (const variant of variants) {
      const root = await mkdtemp(join(tmpdir(), `no-focus-publication-${variant}-`))
      roots.push(root)
      const h = await mount(root)
      await establishA(h)
      const trace = tracePhysicalProof(h)
      const sessions = h.ctx.sessions as unknown as { flush(session: typeof h.agent.session): Promise<boolean> }
      const flush = sessions.flush.bind(sessions)
      let flushes = 0
      sessions.flush = async session => {
        flushes += 1
        if (variant === 'flush' && flushes === 2) return false
        return await flush(session)
      }
      const persistence = (h.ctx as unknown as {
        get(name: 'sessionPersistence'): { readFrom(sessionId: string, fromSeq: number): Promise<{ events: readonly SessionEvent[] }> }
      }).get('sessionPersistence')
      const readFrom = persistence.readFrom.bind(persistence)
      let reads = 0
      persistence.readFrom = async (id, seq) => {
        reads += 1
        if (variant === 'throw' && reads === 2) throw new Error('forced finalized detached read failure')
        const result = await readFrom(id, seq)
        if (variant === 'flush' || reads !== 2) return result
        const event = result.events[0]
        if (event?.type !== 'user/message') return result
        const original = event.data
        let data = original
        if (variant === 'id') {
          data = { ...original, id: MessageId(`${String(original.id)}-wrong`) }
        } else if (variant === 'source') {
          data = { ...original, source: { kind: 'user' } }
        } else if (variant === 'text') {
          data = { ...original, content: [{ type: 'text', text: 'wrong canonical text' }] }
        } else if (variant === 'hash') {
          if (original.source.kind !== 'context-manager-canonical') return result
          data = { ...original, source: { ...original.source, bodyHash: '0'.repeat(64) } }
        }
        const replacement: SessionEvent<'user/message'> = {
          ...event,
          ...(variant === 'seq' ? { seq: event.seq + 1 } : {}),
          data,
        }
        return { events: [replacement] }
      }
      const seen = errors(h.ctx, h.agent)
      const close = await send(h.agent, closeText)
      sessions.flush = flush
      persistence.readFrom = readFrom
      assertSilentFailure(h, close, seen)
      assertProofPrecedesFailure(trace)
      trace.restore()
      expect(transactionPhase(readRecord(root))).toBe('current')
    }
  })
})
