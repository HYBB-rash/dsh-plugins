import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionEventMap, type SessionEventType, type SurfaceEventType, type SurfaceIntent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as ContextManager from '../src/index.ts'
import { ActionFactBoundaryAuthority, type C20Result, type C21Result, type C22Result, type C36Result } from '../src/action-boundary.ts'
import { FocusAuthority, type C35Result } from '../src/focus.ts'
import { UserInteractionAdvice } from '../src/local-restriction.ts'
import { ManagedAwareBasicCompactionEngine } from '../src/managed-compaction.ts'
import {
  CanonicalContextAuthority,
  EffectiveStatePreservation,
  UniqueVisibleContextReplacement,
  parseCanonicalLocalRestrictionStateRecord,
  type C30Result,
  type C31Result,
  type C34Result,
  type C37Result,
  type LocalRestrictionStateRecord,
} from '../src/state-transaction.ts'

const roots: string[] = []
const contexts: Context[] = []
const sessionId = ContextManager.FOCUS_CANARY_IDS[0]
const tracer = '环境名还没确定；先把已经确认的只读检查列出来。'
const stableFailure = '唯一背景未能安全换入，本轮未继续行动'
const validLocal = JSON.stringify({ actions: ['部署B', '列出只读检查'],
  proposedRequirements: [{ fact: '环境名', neededFor: ['部署B'] }], usableInputs: [],
  unresolvedInputs: [{ fact: '环境名', meaning: '环境名尚未确定', source: 'direct-user', degree: 'unknown', affected: '部署B' }] })
const allBlocked = JSON.stringify({ actions: ['部署B', '列出只读检查'],
  proposedRequirements: [{ fact: '环境名', neededFor: ['部署B', '列出只读检查'] }], usableInputs: [],
  unresolvedInputs: [{ fact: '环境名', meaning: '环境名尚未确定', source: 'direct-user', degree: 'unknown', affected: '全部行动' }] })
const actionable = JSON.stringify({ actions: ['列出只读检查'], proposedRequirements: [], usableInputs: [], unresolvedInputs: [] })

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function chunks(text: string): StreamChunk[] { return [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
] }
function toolChunks(id: string, name: string): StreamChunk[] { const callId = CallId(id); return [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: '{}' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: '{}' } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
] }
function schema(options: GenerateOptions, name: string): boolean { return options.messages.some(message =>
  message.source.kind === 'plugin' && message.source.plugin === name) }

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  focusCalls = 0; actionCalls = 0; rootCalls = 0
  focusOutput = '{"kind":"focus","subject":"部署B","relation":"new"}'
  actionOutput = validLocal
  beforeActionOutput: (() => void) | undefined
  observeRootDispatch: ((request: GenerateOptions) => void) | undefined
  toolSteps = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 8_192 } })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (schema(options, 'ui-context-compactor:focus-canary-schema')) {
      this.focusCalls += 1; yield* chunks(this.focusOutput); return
    }
    if (schema(options, 'ui-context-compactor:action-fact-need-schema')) {
      this.actionCalls += 1; this.beforeActionOutput?.(); yield* chunks(this.actionOutput); return
    }
    this.rootCalls += 1
    this.observeRootDispatch?.(options)
    if (this.toolSteps > 0) { this.toolSteps -= 1; yield* toolChunks(`f08-tool-${this.rootCalls}`, 'f08_tail_probe'); return }
    yield* chunks(options.messages[0]?.source.kind === 'context-manager-local-restriction'
      ? '部署已暂停；可以先做只读检查' : '已建立部署B焦点')
  }
}

type ObservationStage = 'P1-live' | 'P2-cold1' | 'P3-cold1' | 'P3-cold2'
interface ReceiverReportMap {
  readonly C34: C34Result
  readonly C35: C35Result
  readonly C36: C36Result
  readonly C30: C30Result
  readonly C31: C31Result
  readonly C37: C37Result
}
type ReceiverContract = keyof ReceiverReportMap
type ReceiverObservation = { [Contract in ReceiverContract]: {
  readonly stage: ObservationStage
  readonly contract: Contract
  readonly invocation: number
  readonly report: ReceiverReportMap[Contract]
} }[ReceiverContract]
interface DispatchObservation {
  readonly stage: 'P1-live'
  readonly rawSidecar: unknown
  readonly request: GenerateOptions
}
interface ObservationLedger {
  readonly receivers: ReceiverObservation[]
  readonly dispatches: DispatchObservation[]
}

type AVariant = 'missing-focus' | 'malformed' | 'wrong-focus' | 'mixed'
type BVariant = 'all-actions-blocked' | 'invalid-neededFor' | 'actionable-proposal'
type CVariant = 'pending-put' | 'first-replace' | 'second-replace' | 'flush' | 'read'
  | 'exact-race' | 'mismatch-race' | 'duplicate-race'
type EVariant = 'schema-invalid-body' | 'schema-invalid-body-hash' | 'schema-invalid-c20-subject'
  | 'valid-foreign-no-focus' | 'extra-direct' | 'tool-tail'
type FlowActor = 'runtime' | 'race'
interface ReadEventObservation {
  readonly seq: number
  readonly type: SessionEventType
  readonly id?: string
  readonly source?: UserMessage['source']
  readonly text?: string
  readonly hash?: string
}
type FlowEvent =
  | { readonly kind: 'table-put-attempt'; readonly value: unknown; readonly family?: string; readonly phase?: string }
  | { readonly kind: 'table-put-committed'; readonly value: unknown; readonly family?: string; readonly phase?: string }
  | { readonly kind: 'append-attempt' | 'append-committed' | 'append-error'; readonly actor: FlowActor;
      readonly id?: string; readonly seq?: number; readonly source?: string; readonly text?: string;
      readonly hash?: string; readonly operation?: 'append' | 'replace'; readonly phase?: string; readonly message?: UserMessage }
  | { readonly kind: 'preserve'; readonly mode: 'append' | 'reuse'; readonly id: string; readonly seq: number;
      readonly source: string; readonly text: string; readonly hash: string }
  | { readonly kind: 'flush-attempt' }
  | { readonly kind: 'flush-result'; readonly result: boolean }
  | { readonly kind: 'flush-error'; readonly error: string }
  | { readonly kind: 'read-attempt'; readonly sessionId: string; readonly fromSeq: number }
  | { readonly kind: 'read-result'; readonly sessionId: string; readonly fromSeq: number; readonly events: readonly ReadEventObservation[] }
  | { readonly kind: 'read-error'; readonly sessionId: string; readonly fromSeq: number; readonly error: string }
  | { readonly kind: 'agent-error'; readonly error: string }
interface FailureLedger<Variant extends AVariant | BVariant | CVariant | EVariant> {
  readonly variant: Variant
  readonly events: FlowEvent[]
  actor: FlowActor
  readonly expectedMessages: ReadonlyMap<string, UserMessage>
  readonly preserved: Set<string>
}
interface CallDelta { readonly focus: number; readonly action: number; readonly root: number; readonly provider: number }

function expressionHash(id: string, text: string): string {
  return createHash('sha256').update(id).update('\0').update(text).digest('hex')
}
function messageText(message: UserMessage): string | undefined {
  return message.content.length === 1 && message.content[0]?.type === 'text' ? message.content[0].text : undefined
}
function createFailureLedger<Variant extends AVariant | BVariant | CVariant | EVariant>(
  variant: Variant,
  messages: readonly UserMessage[],
): FailureLedger<Variant> {
  return { variant, events: [], actor: 'runtime', expectedMessages: new Map(messages.map(message => [String(message.id), message])), preserved: new Set() }
}
function calls(adapter: Adapter): CallDelta {
  return { focus: adapter.focusCalls, action: adapter.actionCalls, root: adapter.rootCalls, provider: adapter.requests.length }
}
function callDelta(after: CallDelta, before: CallDelta): CallDelta {
  return { focus: after.focus - before.focus, action: after.action - before.action,
    root: after.root - before.root, provider: after.provider - before.provider }
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function observeReadEvent(event: SessionEvent): ReadEventObservation {
  if (event.type !== 'user/message') return { seq: event.seq, type: event.type }
  const text = messageText(event.data)
  if (text === undefined) return { seq: event.seq, type: event.type, id: String(event.data.id), source: event.data.source }
  return { seq: event.seq, type: event.type, id: String(event.data.id), source: event.data.source,
    text, hash: expressionHash(String(event.data.id), text) }
}
function findFlowEvent(
  ledger: FailureLedger<AVariant | BVariant | CVariant | EVariant>,
  after: number,
  predicate: (event: FlowEvent) => boolean,
): number {
  const offset = ledger.events.slice(after + 1).findIndex(predicate)
  return offset < 0 ? -1 : after + 1 + offset
}
function expectPreservationFlow(
  ledger: FailureLedger<AVariant | BVariant | CVariant | EVariant>,
  messages: readonly { readonly message: UserMessage; readonly mode: 'append' | 'reuse' }[],
  error: string,
): void {
  let cursor = -1
  for (const expected of messages) {
    const id = String(expected.message.id), text = messageText(expected.message)
    if (text === undefined) throw new Error('expected direct message has no exact text')
    const physical = findFlowEvent(ledger, cursor, event => event.kind === 'append-committed' && event.id === id)
    const preserved = findFlowEvent(ledger, physical, event => event.kind === 'preserve' && event.id === id)
    const flushAttempt = findFlowEvent(ledger, preserved, event => event.kind === 'flush-attempt')
    const flushResult = findFlowEvent(ledger, flushAttempt, event => event.kind === 'flush-result' && event.result)
    const readAttempt = findFlowEvent(ledger, flushResult, event => event.kind === 'read-attempt')
    const readResult = findFlowEvent(ledger, readAttempt, event => event.kind === 'read-result')
    expect(Object.values({ physical, preserved, flushAttempt, flushResult, readAttempt, readResult })
      .every(index => index >= 0)).toBe(true)
    const preservation = ledger.events[preserved]
    expect(preservation).toEqual({ kind: 'preserve', mode: expected.mode, id,
      seq: directEventSeq(ledger.events[physical]), source: 'user', text, hash: expressionHash(id, text) })
    const chosenSeq = directEventSeq(ledger.events[physical])
    expect(ledger.events[readAttempt]).toEqual({ kind: 'read-attempt', sessionId, fromSeq: chosenSeq })
    const productionRead = ledger.events[readResult]
    if (productionRead?.kind !== 'read-result') throw new Error('missing production detached read result')
    expect({ sessionId: productionRead.sessionId, fromSeq: productionRead.fromSeq }).toEqual({ sessionId, fromSeq: chosenSeq })
    expect(productionRead.events.filter(event => event.seq === chosenSeq || event.id === id)).toEqual([{
      seq: chosenSeq, type: 'user/message', id, source: { kind: 'user' }, text, hash: expressionHash(id, text),
    }])
    cursor = readResult
  }
  const errorIndex = findFlowEvent(ledger, cursor, event => event.kind === 'agent-error' && event.error === error)
  expect(errorIndex).toBeGreaterThan(cursor)
}
function directEventSeq(event: FlowEvent | undefined): number {
  if (event?.kind !== 'append-committed' || event.seq === undefined) throw new Error('missing physical direct append')
  return event.seq
}
interface RecordedSpy {
  readonly mock: {
    readonly invocationCallOrder: readonly number[]
    readonly results: readonly { readonly type: string; readonly value?: unknown }[]
  }
}

function createObservationLedger(): ObservationLedger { return { receivers: [], dispatches: [] } }
function installReceiverSpies() { return {
  c34: vi.spyOn(EffectiveStatePreservation.prototype, 'acceptStoredStateReadout'),
  c35: vi.spyOn(FocusAuthority.prototype, 'acceptRestoredFocusFact'),
  c36: vi.spyOn(ActionFactBoundaryAuthority.prototype, 'acceptRestoredActionBoundary'),
  c30Live: vi.spyOn(EffectiveStatePreservation.prototype, 'establishRecoverablePreservation'),
  c30Retained: vi.spyOn(EffectiveStatePreservation.prototype, 'establishRetainedRecoverablePreservation'),
  c31: vi.spyOn(UniqueVisibleContextReplacement.prototype, 'replaceVisibleContext'),
  c37: vi.spyOn(CanonicalContextAuthority.prototype, 'acceptCanonicalRestoration'),
} }
type ReceiverSpies = ReturnType<typeof installReceiverSpies>
function clearReceiverSpies(spies: ReceiverSpies): void {
  for (const spy of Object.values(spies)) spy.mockClear()
}
async function observationsFrom<Contract extends ReceiverContract>(
  stage: ObservationStage,
  contract: Contract,
  rawSpy: unknown,
): Promise<ReceiverObservation[]> {
  const spy = rawSpy as RecordedSpy
  const observations: ReceiverObservation[] = []
  for (const [index, invocation] of spy.mock.invocationCallOrder.entries()) {
    const result = spy.mock.results[index]
    if (result?.type !== 'return') throw new Error(`${contract} receiver did not return normally`)
    const report = await Promise.resolve(result.value) as ReceiverReportMap[Contract]
    observations.push({ stage, contract, invocation, report } as ReceiverObservation)
  }
  return observations
}
async function recordReceiverObservations(
  ledger: ObservationLedger,
  stage: ObservationStage,
  spies: ReceiverSpies,
): Promise<readonly ReceiverObservation[]> {
  const observed = (await Promise.all([
    observationsFrom(stage, 'C34', spies.c34),
    observationsFrom(stage, 'C35', spies.c35),
    observationsFrom(stage, 'C36', spies.c36),
    observationsFrom(stage, 'C30', spies.c30Live),
    observationsFrom(stage, 'C30', spies.c30Retained),
    observationsFrom(stage, 'C31', spies.c31),
    observationsFrom(stage, 'C37', spies.c37),
  ])).flat().sort((left, right) => left.invocation - right.invocation)
  ledger.receivers.push(...observed)
  return observed
}

interface Table { get(key: string): unknown; put(key: string, value: unknown): Promise<void> }
interface Domain { table(name: string): Table }
interface Harness { ctx: Context; agent: Agent; adapter: Adapter; domain: Domain; root: string }

async function mount(root: string, resume = false,
  beforeAgent?: (ctx: Context, domain: Domain, adapter: Adapter) => void | Promise<void>,
  targetSessionId: string = sessionId): Promise<Harness> {
  const ctx = new Context(); contexts.push(ctx); await mountAgentLoopTestDependencies(ctx)
  await mkdir(join(root, 'storages'), { recursive: true })
  await ctx.plugin(Storage); await ctx.plugin(StorageSqlite, { path: join(root, 'storages', 'context-manager-focus-canary.sqlite') })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' }); await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' }); await ctx.plugin(CommandRuntime)
  const managedRuntime = { mode: 'enforce' as const, safeUpdateMarginTokens: 64, allowlist: [...ContextManager.FOCUS_CANARY_IDS] }
  await ctx.plugin(ManagedAwareBasicCompactionEngine, { auto: true, thresholdRatio: .99, retainRatio: .1, managedRuntime })
  await ctx.plugin(commandCompact)
  const adapter = new Adapter(); ctx.llm.registerAdapter(['local-test'], adapter)
  let domain: Domain | undefined
  const facility: { open(spec: unknown): Promise<Domain> } = ctx.storageDomain
  const open = facility.open.bind(facility); facility.open = async spec => domain = await open(spec)
  await ctx.plugin(ContextManager, { focusCanary: { ...managedRuntime, auxiliary: { provider: 'local-test', model: 'local-test',
    maxOutputTokens: 64, timeoutMs: 500, maxExpressionChars: 240, maxProjectionTokens: 1_024, safetyMarginTokens: 128 } },
    nativeWriterArbitration: { mode: 'enforce' } })
  await ctx.plugin(AgentLoop, { agents: [] }); if (domain === undefined) throw new Error('missing context-manager domain')
  await beforeAgent?.(ctx, domain, adapter)
  const agent = resume
    ? (await ctx.agents.resume({ resumeSessionId: SessionId(targetSessionId), agentOptions: { provider: 'local-test', model: 'local-test' } })).agent
    : ctx.agentLoop.create(SessionId(targetSessionId), { provider: 'local-test', model: 'local-test' })
  return { ctx, agent, adapter, domain, root }
}
async function fresh(prefix: string): Promise<Harness> { const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); return await mount(root) }
async function dispose(h: Harness): Promise<void> { await h.ctx.sessions.flush(h.agent.session); await h.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(h.ctx), 1) }
async function send(agent: Agent, text: string): Promise<UserMessage> { const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }); agent.send(message, 'next-turn', true); await agent.whenIdle(); return message }
async function establishFocus(h: Harness): Promise<void> { await send(h.agent, '帮我准备部署B'); expect(h.adapter.focusCalls).toBe(1); expect(h.adapter.rootCalls).toBe(1) }
async function establishTail(root: string): Promise<readonly SessionEvent<'user/message'>[]> {
  const h = await mount(root); await establishFocus(h); await send(h.agent, tracer)
  const beforeCold = [...canonical(h.agent)]
  await dispose(h)
  return beforeCold
}
function direct(agent: Agent, id?: UserMessage['id']): SessionEvent<'user/message'>[] { return agent.session.events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'user' && (id === undefined || String(event.data.id) === String(id))) }
function canonical(agent: Agent): SessionEvent<'user/message'>[] { return agent.session.events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'context-manager-local-restriction') }
function assistants(agent: Agent): SessionEvent<'assistant/message'>[] { return agent.session.events.filter((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message') }
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function storedPhase(value: unknown): string | undefined { const root = object(value), state = object(root?.transaction); return typeof state?.phase === 'string' ? state.phase : undefined }
function readRawSidecar(root: string, targetSessionId: string = sessionId): unknown {
  const db = new DatabaseSync(join(root, 'storages', 'context-manager-focus-canary.sqlite'), { readOnly: true })
  try {
    const row = object(db.prepare('SELECT value FROM "u_context_manager_focus_precanonical" WHERE key=?').get(targetSessionId))
    return typeof row?.value === 'string' ? JSON.parse(row.value) as unknown : undefined
  } finally { db.close() }
}
function readLocalSidecar(root: string, targetSessionId: string = sessionId): LocalRestrictionStateRecord {
  const parsed = parseCanonicalLocalRestrictionStateRecord(readRawSidecar(root, targetSessionId))
  if (parsed === undefined) throw new Error('missing or invalid local record')
  return parsed
}
function rawSnapshot(value: unknown) {
  const root = object(value), t = object(root?.transaction), material = object(t?.material), canonical = object(material?.canonicalState)
  return { generation: t?.generation, boundary: canonical?.boundary, canonicalRef: t?.canonicalRef, bodyHash: t?.bodyHash }
}
function tablePutEvent(kind: 'table-put-attempt' | 'table-put-committed', value: unknown): FlowEvent {
  const raw = object(value)
  const family = typeof raw?.family === 'string' ? raw.family : undefined
  const phase = storedPhase(value)
  if (family !== undefined && phase !== undefined) return { kind, value, family, phase }
  if (family !== undefined) return { kind, value, family }
  if (phase !== undefined) return { kind, value, phase }
  return { kind, value }
}
function installFlowLedger<Variant extends AVariant | BVariant | CVariant | EVariant>(
  h: Harness,
  ledger: FailureLedger<Variant>,
): void {
  const table = h.domain.table('focus_precanonical')
  const put = table.put.bind(table)
  table.put = async (key, value) => {
    ledger.events.push(tablePutEvent('table-put-attempt', value))
    await put(key, value)
    ledger.events.push(tablePutEvent('table-put-committed', value))
  }

  const append = h.agent.session.append
  h.agent.session.append = function observedAppend<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...options: T extends SurfaceEventType ? [SurfaceIntent] : []
  ): SessionEvent<T> {
    const intent = options[0]
    const operation: 'append' | 'replace' | undefined = intent?.surfaceOp === 'append' ? 'append'
      : intent?.surfaceOp !== undefined ? 'replace' : undefined
    const rawMessage = type === 'user/message' ? data as SessionEventMap['user/message'] : undefined
    const text = rawMessage === undefined ? undefined : messageText(rawMessage)
    const details = {
      actor: ledger.actor,
      ...(rawMessage === undefined ? {} : { id: String(rawMessage.id), source: rawMessage.source.kind, message: rawMessage }),
      ...(text === undefined || rawMessage === undefined ? {} : { text, hash: expressionHash(String(rawMessage.id), text) }),
      ...(operation === undefined ? {} : { operation }),
      ...(rawMessage?.source.kind === 'context-manager-local-restriction' ? { phase: rawMessage.source.phase } : {}),
    }
    if (rawMessage !== undefined) ledger.events.push({ kind: 'append-attempt', ...details })
    try {
      const event = Reflect.apply(append, this, [type, data, ...options]) as SessionEvent<T>
      if (rawMessage !== undefined) ledger.events.push({ kind: 'append-committed', ...details, seq: event.seq })
      return event
    } catch (error: unknown) {
      if (rawMessage !== undefined) ledger.events.push({ kind: 'append-error', ...details })
      throw error
    }
  }

  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions)
  h.ctx.sessions.flush = async session => {
    for (const [id, expected] of ledger.expectedMessages) {
      if (ledger.preserved.has(id)) continue
      const expectedText = messageText(expected)
      const matching = direct(h.agent, expected.id)
      const actual = matching.length === 1 ? matching[0] : undefined
      const actualText = actual === undefined ? undefined : messageText(actual.data)
      if (expectedText === undefined || actual === undefined || actualText !== expectedText) continue
      const runtimeAppend = ledger.events.some(event => event.kind === 'append-committed'
        && event.actor === 'runtime' && event.id === id)
      ledger.events.push({ kind: 'preserve', mode: runtimeAppend ? 'append' : 'reuse', id,
        seq: actual.seq, source: actual.data.source.kind, text: actualText, hash: expressionHash(id, actualText) })
      ledger.preserved.add(id)
    }
    ledger.events.push({ kind: 'flush-attempt' })
    try {
      const result = await flush(session)
      ledger.events.push({ kind: 'flush-result', result })
      return result
    } catch (error: unknown) {
      ledger.events.push({ kind: 'flush-error', error: errorText(error) })
      throw error
    }
  }

  const readFrom = h.ctx.sessionPersistence.readFrom.bind(h.ctx.sessionPersistence)
  h.ctx.sessionPersistence.readFrom = async (id, fromSeq) => {
    const readSessionId = String(id)
    ledger.events.push({ kind: 'read-attempt', sessionId: readSessionId, fromSeq })
    try {
      const result = await readFrom(id, fromSeq)
      ledger.events.push({ kind: 'read-result', sessionId: readSessionId, fromSeq,
        events: result.events.map(observeReadEvent) })
      return result
    } catch (error: unknown) {
      ledger.events.push({ kind: 'read-error', sessionId: readSessionId, fromSeq, error: errorText(error) })
      throw error
    }
  }

  h.ctx.on('agent/error', ({ agent, error }) => {
    if (agent === h.agent) ledger.events.push({ kind: 'agent-error', error: errorText(error) })
  })
}
function work(agent: Agent): number { return agent.session.events.filter(event => event.type.startsWith('tool/') || event.type.startsWith('compaction/') || event.type === 'user/message' && event.data.source.kind === 'context-route').length }
function transaction(row: LocalRestrictionStateRecord) { if (row.transaction === undefined) throw new Error('missing local transaction'); return row.transaction }
function snapshot(row: LocalRestrictionStateRecord) { const t = transaction(row); return { generation: t.generation, boundary: t.material.canonicalState.boundary, canonicalRef: t.canonicalRef, bodyHash: t.bodyHash, repair: t.repair } }
function expectBusinessReport(report: unknown, contract: string, subject: unknown, value: unknown): void {
  const raw = object(report), identity = object(raw?.identity)
  expect(Object.keys(raw ?? {}).sort()).toEqual(['identity', 'kind', 'value'])
  expect(raw?.kind).toBe('business_result')
  expect(Object.keys(identity ?? {}).sort()).toEqual(['call', 'contract', 'subject'])
  expect(identity?.contract).toBe(contract)
  expect(identity?.call).toMatch(new RegExp(`^${contract}:`))
  expect(identity?.subject).toEqual(subject)
  expect(raw?.value).toEqual(value)
}
function spyReports<Report>(spy: RecordedSpy): readonly Report[] {
  return spy.mock.results.map(result => {
    if (result.type !== 'return') throw new Error('receiver spy did not return normally')
    return result.value as Report
  })
}
interface T3EventCounts {
  readonly localWriter: number
  readonly nativeWriter: number
  readonly checkpoint: number
  readonly route: number
  readonly compaction: number
  readonly tool: number
}
function t3EventCounts(events: readonly SessionEvent[]): T3EventCounts {
  return {
    localWriter: events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'context-manager-local-restriction').length,
    nativeWriter: events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'context-manager-canonical').length,
    checkpoint: events.filter(event => event.type === 'user/message'
      && isCompactCheckpointSource(event.data.source)).length,
    route: events.filter(event => event.type === 'user/message'
      && (event.data.source.kind === 'context-route'
        || event.data.source.kind === 'plugin' && event.data.source.plugin === 'context-route')).length,
    compaction: events.filter(event => event.type.startsWith('compaction/')).length,
    tool: events.filter(event => event.type.startsWith('tool/')).length,
  }
}
function expectLocalCanonicalPhysical(
  h: Harness,
  row: LocalRestrictionStateRecord,
  expectedId: string,
  expectedSeq: number,
): SessionEvent<'user/message'> {
  const t = transaction(row), visible = h.agent.session.deriveMessages(), only = visible[0]
  if (only === undefined || only.source.kind !== 'context-manager-local-restriction') throw new Error('missing visible local canonical')
  expect(String(only.id)).toBe(expectedId)
  const physical = canonical(h.agent).filter(event => String(event.data.id) === String(only.id))
  expect(physical).toHaveLength(1)
  const event = physical[0]!
  expect(String(event.data.id)).toBe(expectedId)
  expect(event.seq).toBe(expectedSeq)
  expect(event.data).toEqual(only)
  expect(event.data).toEqual({
    id: only.id,
    role: 'user',
    content: [{ type: 'text', text: t.body }],
    source: {
      kind: 'context-manager-local-restriction', phase: 'finalized', pendingStateRef: t.pendingRef,
      canonicalStateRef: t.canonicalRef, generation: t.generation, chat: sessionId, bodyHash: t.bodyHash,
      machine: t.machine,
    },
  })
  expect(createHash('sha256').update(t.body).digest('hex')).toBe(t.bodyHash)
  return event
}
function expectCanonicalPhysical(h: Harness, row: LocalRestrictionStateRecord): SessionEvent<'user/message'> {
  const repair = transaction(row).repair
  if (repair?.phase !== 'repair_finalized') throw new Error('repaired canonical lacks finalized target')
  return expectLocalCanonicalPhysical(h, row, repair.targetMessageId, repair.targetReplaceSeq)
}
function expectLiveCanonicalPhysical(h: Harness, row: LocalRestrictionStateRecord): SessionEvent<'user/message'> {
  const t = transaction(row), visible = h.agent.session.deriveMessages()[0]
  if (visible === undefined || t.finalizedReplaceSeq === undefined) throw new Error('live canonical lacks finalized target')
  return expectLocalCanonicalPhysical(h, row, String(visible.id), t.finalizedReplaceSeq)
}
function reportsFor<Contract extends ReceiverContract>(
  observations: readonly ReceiverObservation[],
  contract: Contract,
): readonly ReceiverReportMap[Contract][] {
  return observations.filter(observation => observation.contract === contract)
    .map(observation => observation.report as ReceiverReportMap[Contract])
}
function normalizeProofs(value: unknown, key = ''): unknown {
  if (key.toLowerCase().includes('proof')) return typeof value === 'string' ? '<proof>' : value
  if (Array.isArray(value)) return value.map(item => normalizeProofs(item))
  const raw = object(value)
  if (raw === undefined) return value
  return Object.fromEntries(Object.entries(raw).map(([entryKey, entryValue]) => [entryKey, normalizeProofs(entryValue, entryKey)]))
}
function receiverBusinessOracle(observations: readonly ReceiverObservation[]) { return observations.map(observation => ({
  contract: observation.contract,
  subject: normalizeProofs(observation.report.identity.subject),
  value: normalizeProofs(object(observation.report)?.value),
})) }
function expectRecoveryReceivers(observations: readonly ReceiverObservation[], row: LocalRestrictionStateRecord): void {
  const t = transaction(row), readout = { kind: 'existing_material', material: t.material }
  expect(observations.map(observation => observation.contract)).toEqual(['C34', 'C35', 'C36', 'C30', 'C31', 'C37'])
  expect(observations.every(observation => observation.report.kind === 'business_result')).toBe(true)
  const c34 = reportsFor(observations, 'C34')[0], c35 = reportsFor(observations, 'C35')[0]
  const c36 = reportsFor(observations, 'C36')[0], c30 = reportsFor(observations, 'C30')[0]
  const c31 = reportsFor(observations, 'C31')[0], c37 = reportsFor(observations, 'C37')[0]
  expectBusinessReport(c34, 'C34', readout, { kind: 'accepted_for_contract', value: readout })
  expectBusinessReport(c35, 'C35', t.material.canonicalState.focus.ref, { kind: 'accepted_for_contract',
    value: { target: sessionId, focus: t.material.canonicalState.focus } })
  expectBusinessReport(c36, 'C36', t.material.canonicalState.boundary.ref, { kind: 'accepted_for_contract',
    value: { target: sessionId, boundary: t.material.canonicalState.boundary } })
  const c30Value = object(c30)?.value, c31Value = object(c31)?.value
  const recoverableProof = object(c30Value)?.proof, visibleProof = object(c31Value)?.proof
  expect(recoverableProof).toMatch(/^recoverable:/); expect(visibleProof).toMatch(/^visible:/)
  expectBusinessReport(c30, 'C30', t.pendingRef, c30Value)
  expect(c30Value).toEqual({ kind: 'same_complete_state_already_recoverable', state: t.pendingRef, proof: recoverableProof })
  expectBusinessReport(c31, 'C31', t.pendingRef, c31Value)
  expect(c31Value).toEqual({ kind: 'same_state_already_uniquely_visible', state: t.pendingRef, proof: visibleProof })
  const restoration = object(object(c37)?.value)?.value
  const restorationRaw = object(restoration)
  expect(restorationRaw?.restorationProof).toMatch(/^restoration:/)
  expect(restorationRaw?.recoverableProof).toBe(recoverableProof)
  expect(restorationRaw?.visibleProof).toBe(visibleProof)
  expectBusinessReport(c37, 'C37', sessionId, { kind: 'accepted_for_contract', value: restoration })
  expect(restoration).toEqual({ kind: 'local_restriction_restored', material: t.material,
    restorationProof: restorationRaw?.restorationProof, recoverableProof, visibleProof })
}
function expectRepairedCanonical(h: Harness, row: LocalRestrictionStateRecord): void {
  const t = transaction(row)
  const visible = h.agent.session.deriveMessages()
  const only = visible[0]
  const source = only?.source.kind === 'context-manager-local-restriction' ? only.source : undefined
  const text = only?.content.length === 1 && only.content[0]?.type === 'text' ? only.content[0].text : undefined
  expect({
    family: row.family,
    phase: t.phase,
    repair: t.repair?.phase,
    generation: t.generation,
    materialKind: t.material.kind,
    canonicalKind: t.material.canonicalState.kind,
    visibleCount: visible.length,
    role: only?.role,
    sourceKind: source?.kind,
    sourcePhase: source?.phase,
    body: text,
    blocked: source?.machine.preciselyBlockedActions,
    safe: source?.machine.safelyContinuableActions,
  }).toEqual({
    family: 'local_restriction',
    phase: 'finalized',
    repair: 'repair_finalized',
    generation: 1,
    materialKind: 'local_restriction_material',
    canonicalKind: 'local_restriction',
    visibleCount: 1,
    role: 'user',
    sourceKind: 'context-manager-local-restriction',
    sourcePhase: 'finalized',
    body: '受限行动：部署B。可继续：列出只读检查。',
    blocked: ['部署B'],
    safe: ['列出只读检查'],
  })
  expect(t.pendingRef).toMatch(/^pending:[0-9a-f]{64}$/)
  expect(t.canonicalRef).toMatch(/^canonical:local-restriction:[0-9a-f]{64}$/)
  expect(t.bodyHash).toMatch(/^[0-9a-f]{64}$/)
  expect(source?.pendingStateRef).toBe(t.pendingRef)
  expect(source?.canonicalStateRef).toBe(t.canonicalRef)
  expect(source?.bodyHash).toBe(t.bodyHash)
  expect(source?.machine.boundaryRef).toBe(t.material.canonicalState.boundary.ref)
  expect(source?.machine.originMessageId).toBe(t.machine.originMessageId)
  expect(source?.machine.originHash).toBe(t.machine.originHash)
}
function replaceFault(agent: Agent, failAt: number): void { const append = agent.session.append; let replaces = 0; agent.session.append = function typedReplaceFault<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...options: T extends SurfaceEventType ? [SurfaceIntent] : []): SessionEvent<T> { if (options[0]?.surfaceOp !== 'append' && options[0]?.surfaceOp.op === 'replace' && ++replaces === failAt) throw new Error('replace'); return Reflect.apply(append, this, [type, data, ...options]) } }
async function assertContinue(h: Harness): Promise<void> {
  const before = h.adapter.rootCalls
  const canonicalMessage = h.agent.session.deriveMessages()[0]
  if (canonicalMessage?.source.kind !== 'context-manager-local-restriction') throw new Error('continuation lacks canonical input')
  const message = await send(h.agent, '继续')
  expect(h.adapter.rootCalls).toBe(before + 1)
  const request = h.adapter.requests.at(-1)!
  expect(request.messages).toEqual([canonicalMessage, message])
  expect(request.messages.map(item => item.role)).toEqual(['user', 'user'])
  expect(request.messages.map(item => ({ id: String(item.id), text: messageText(item as UserMessage), source: item.source }))).toEqual([
    { id: String(canonicalMessage.id), text: messageText(canonicalMessage as UserMessage), source: canonicalMessage.source },
    { id: String(message.id), text: '继续', source: { kind: 'user' } },
  ])
  expect(createHash('sha256').update(messageText(canonicalMessage as UserMessage) ?? '').digest('hex'))
    .toBe(canonicalMessage.source.bodyHash)
  expect(canonicalMessage.source.machine.originHash).toBe(expressionHash(
    canonicalMessage.source.machine.originMessageId, tracer,
  ))
  expect(direct(h.agent, message.id).map(event => event.data)).toEqual([message])
  expect(request.messages.some(item => item.source.kind === 'plugin' || item.role === 'assistant')).toBe(false)
  expect(request.messages.flatMap(item => item.content).some(block => block.type === 'text'
    && (block.text === tracer || block.text === '已建立部署B焦点' || block.text === '部署已暂停；可以先做只读检查'))).toBe(false)
}

type DVariant = 'replace' | 'flush' | 'read' | 'final-marker'
type RepairEvent =
  | { readonly kind: 'put-attempt' | 'put-committed'; readonly phase?: string; readonly target?: string; readonly seq?: number }
  | { readonly kind: 'replace-attempt' | 'replace-committed' | 'replace-error'; readonly id?: string; readonly seq?: number; readonly body?: string; readonly bodyHash?: string }
  | { readonly kind: 'direct-append-attempt' | 'direct-append-committed'; readonly id: string; readonly seq?: number; readonly body: string; readonly bodyHash: string }
  | { readonly kind: 'flush-attempt' | 'flush-fault' | 'flush-committed' }
  | { readonly kind: 'read-attempt'; readonly sessionId: string; readonly fromSeq: number }
  | { readonly kind: 'read-fault'; readonly sessionId: string; readonly fromSeq: number }
  | { readonly kind: 'read-committed'; readonly sessionId: string; readonly fromSeq: number; readonly events: readonly ReadEventObservation[] }
  | { readonly kind: 'fault-hit'; readonly seam: DVariant }
  | { readonly kind: 'pre-step'; readonly requestCount: number }
  | { readonly kind: 'agent-error'; readonly error: string }
interface RepairLedger { readonly variant: DVariant; readonly events: RepairEvent[]; hits: number }

function repairDetails(value: unknown): { phase?: string; target?: string; seq?: number } {
  const raw = object(value), state = object(raw?.transaction), repair = object(state?.repair)
  return {
    ...(typeof repair?.phase === 'string' ? { phase: repair.phase } : {}),
    ...(typeof repair?.targetMessageId === 'string' ? { target: repair.targetMessageId } : {}),
    ...(typeof repair?.targetReplaceSeq === 'number' ? { seq: repair.targetReplaceSeq } : {}),
  }
}

function installRepairFault(
  ctx: Context,
  domain: Domain,
  adapter: Adapter,
  ledger: RepairLedger,
): void {
  const table = domain.table('focus_precanonical'), put = table.put.bind(table)
  table.put = async (key, value) => {
    const details = repairDetails(value)
    ledger.events.push({ kind: 'put-attempt', ...details })
    if (ledger.variant === 'final-marker' && details.phase === 'repair_finalized' && ledger.hits++ === 0) {
      ledger.events.push({ kind: 'fault-hit', seam: 'final-marker' })
      throw new Error('f08 final-marker fault')
    }
    await put(key, value)
    ledger.events.push({ kind: 'put-committed', ...details })
  }
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  ctx.sessions.flush = async session => {
    ledger.events.push({ kind: 'flush-attempt' })
    if (ledger.variant === 'flush' && ledger.hits++ === 0) {
      ledger.events.push({ kind: 'fault-hit', seam: 'flush' }, { kind: 'flush-fault' })
      return false
    }
    const result = await flush(session)
    ledger.events.push({ kind: result ? 'flush-committed' : 'flush-fault' })
    return result
  }
  const readFrom = ctx.sessionPersistence.readFrom.bind(ctx.sessionPersistence)
  ctx.sessionPersistence.readFrom = async (id, fromSeq) => {
    const readSessionId = String(id)
    ledger.events.push({ kind: 'read-attempt', sessionId: readSessionId, fromSeq })
    if (ledger.variant === 'read' && ledger.hits++ === 0) {
      ledger.events.push({ kind: 'fault-hit', seam: 'read' }, { kind: 'read-fault', sessionId: readSessionId, fromSeq })
      throw new Error('f08 read fault')
    }
    const result = await readFrom(id, fromSeq)
    ledger.events.push({ kind: 'read-committed', sessionId: readSessionId, fromSeq,
      events: result.events.map(observeReadEvent) })
    return result
  }
  ctx.on('agent/created', ({ agent }) => {
    const append = agent.session.append
    agent.session.append = function repairObservedAppend<T extends SessionEventType>(
      type: T,
      data: SessionEventMap[T],
      ...options: T extends SurfaceEventType ? [SurfaceIntent] : []
    ): SessionEvent<T> {
      const intent = options[0]
      const isReplace = intent?.surfaceOp !== undefined && intent.surfaceOp !== 'append' && intent.surfaceOp.op === 'replace'
      const message = type === 'user/message' ? data as SessionEventMap['user/message'] : undefined
      const text = message === undefined ? undefined : messageText(message)
      const details = message === undefined ? {} : {
        id: String(message.id), ...(text === undefined ? {} : { body: text, bodyHash: createHash('sha256').update(text).digest('hex') }),
      }
      const isDirectAppend = message?.source.kind === 'user' && intent?.surfaceOp === 'append' && text !== undefined
      if (isReplace) ledger.events.push({ kind: 'replace-attempt', ...details })
      if (isDirectAppend) ledger.events.push({ kind: 'direct-append-attempt', id: String(message.id), body: text!,
        bodyHash: expressionHash(String(message.id), text!) })
      if (isReplace && ledger.variant === 'replace' && ledger.hits++ === 0) {
        ledger.events.push({ kind: 'fault-hit', seam: 'replace' }, { kind: 'replace-error', ...details })
        throw new Error('f08 replace fault')
      }
      const event = Reflect.apply(append, this, [type, data, ...options]) as SessionEvent<T>
      if (isReplace) ledger.events.push({ kind: 'replace-committed', ...details, seq: event.seq })
      if (isDirectAppend) ledger.events.push({ kind: 'direct-append-committed', id: String(message.id), seq: event.seq,
        body: text!, bodyHash: expressionHash(String(message.id), text!) })
      return event
    }
  }, { prepend: true })
  ctx.on('agent/pre-step', async (_event, next) => {
    ledger.events.push({ kind: 'pre-step', requestCount: adapter.requests.length })
    return await next()
  }, { prepend: true })
  ctx.on('agent/error', ({ error }) => { ledger.events.push({ kind: 'agent-error', error: errorText(error) }) })
}

async function establishToolTail(root: string): Promise<void> {
  const h = await mount(root)
  await establishFocus(h)
  h.ctx.tools.register(defineContentToolFixture({
    name: 'f08_tail_probe',
    description: 'Return one deterministic tail observation.',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'formal tool lifecycle result' }] },
  }))
  h.adapter.toolSteps = 1
  await send(h.agent, tracer)
  expect(h.agent.session.events.filter(event => event.type === 'tool/call')).toHaveLength(1)
  expect(h.agent.session.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
  expect(readLocalSidecar(root).family).toBe('local_restriction')
  await dispose(h)
}

async function naturalForeignNoFocus(root: string): Promise<{ readonly session: string; readonly record: unknown }> {
  const foreignSession = ContextManager.FOCUS_CANARY_IDS[1]
  const h = await mount(root, false, undefined, foreignSession)
  await establishFocus(h)
  h.adapter.focusOutput = '{"kind":"close","relation":"current"}'
  await send(h.agent, '这件事结束了')
  const record = readRawSidecar(root, foreignSession)
  const closure = object(object(record)?.closure), decision = object(closure?.decision)
  expect({ kind: decision?.kind, chat: decision?.chat }).toEqual({ kind: 'no_focus', chat: foreignSession })
  await dispose(h)
  return { session: foreignSession, record }
}

function postWork(events: readonly SessionEvent[]): number {
  return events.filter(event => event.type.startsWith('tool/') || event.type.startsWith('compaction/')
    || event.type === 'user/message' && event.data.source.kind === 'context-route').length
}

describe('F08-T1 local restriction through the natural Agent lifecycle', () => {
  it('P1 live exact tracer preserves one focus, blocks deployment, keeps read-only work, and reaches one honest root request', async () => {
    const ledger = createObservationLedger(), spies = installReceiverSpies()
    const h = await fresh('f08-live-'); await send(h.agent, '部署B')
    expect(h.adapter.focusCalls).toBe(1); expect(h.adapter.rootCalls).toBe(1)
    const preLocalFocusRow = object(readRawSidecar(h.root)), preLocalDecision = object(preLocalFocusRow?.decision)
    expect(Object.keys(preLocalDecision ?? {}).sort()).toEqual(['chat', 'currentMatter', 'kind', 'latestCorrections', 'ref'])
    expect(preLocalDecision?.ref).toMatch(/^focus:[0-9a-f]{64}$/)
    const verifiedFocusDecision = {
      kind: 'focus_established', ref: preLocalDecision?.ref, chat: sessionId,
      currentMatter: '部署B', latestCorrections: '',
    }
    expect(preLocalDecision).toEqual(verifiedFocusDecision)
    const beforeAssistants = assistants(h.agent).length
    h.adapter.observeRootDispatch = request => ledger.dispatches.push({
      stage: 'P1-live', rawSidecar: readRawSidecar(h.root), request,
    })
    const message = await send(h.agent, tracer); const row = readLocalSidecar(h.root), t = transaction(row)
    const observed = await recordReceiverObservations(ledger, 'P1-live', spies)
    expect(h.adapter.focusCalls).toBe(1); expect(h.adapter.actionCalls).toBe(1); expect(h.adapter.rootCalls).toBe(2)
    const actionRequest = h.adapter.requests.find(request =>
      schema(request, 'ui-context-compactor:action-fact-need-schema'))
    expect(actionRequest?.reasoningEffort).toBeUndefined()
    expect(t.phase).toBe('finalized'); expect(t.generation).toBe(1)
    const expectedPreservedFocus = {
      kind: 'focus_established', ref: verifiedFocusDecision.ref,
      currentMatter: '部署B', latestCorrections: '',
    }
    expect(t.material.canonicalState.focus).toEqual(expectedPreservedFocus)
    expect(t.material.canonicalState.boundary.ref).toMatch(/^action-boundary:[0-9a-f]{64}$/)
    expect(t.material.canonicalState.boundary.requiredFacts.ref).toMatch(/^fact-needs:[0-9a-f]{64}$/)
    const expectedBoundary = {
      kind: 'local_restriction', ref: t.material.canonicalState.boundary.ref,
      requiredFacts: { ref: t.material.canonicalState.boundary.requiredFacts.ref,
        requirements: [{ fact: '环境名', neededFor: ['部署B'] }] },
      usableFacts: [],
      unresolvedFacts: [{ fact: '环境名', meaning: '环境名尚未确定', source: 'direct-user',
        degree: 'unknown', affected: '部署B' }],
      preciselyBlockedActions: ['部署B'], safelyContinuableActions: ['列出只读检查'],
    }
    expect(t.material.canonicalState.boundary).toEqual(expectedBoundary)
    const fullFocus = verifiedFocusDecision
    const fullBoundary = { ...expectedBoundary, chat: sessionId }
    expectBusinessReport(t.c06, 'C06', fullFocus.ref, { kind: 'accepted_for_contract', value: fullFocus })
    expectBusinessReport(t.c02, 'C02', fullFocus.ref, { kind: 'accepted_for_contract', value: fullFocus })
    expectBusinessReport(t.c20, 'C20', fullBoundary.ref, { kind: 'accepted_for_contract', value: fullBoundary })
    expectBusinessReport(t.c21, 'C21', fullBoundary.ref, { kind: 'accepted_for_contract', value: fullBoundary })
    expectBusinessReport(t.c22, 'C22', fullBoundary.ref, { kind: 'accepted_for_contract', value: fullBoundary })
    expectBusinessReport(t.c29, 'C29', t.pendingRef, { kind: 'eligible', state: t.pendingRef })
    expectBusinessReport(t.c33, 'C33', t.material.ref, { kind: 'saved', material: t.material.ref })
    expectBusinessReport(t.c30, 'C30', t.pendingRef, { kind: 'established', state: t.pendingRef })
    expectBusinessReport(t.firstC31, 'C31', t.pendingRef, { kind: 'uniquely_replaced', state: t.pendingRef })
    expectBusinessReport(t.firstC32, 'C32', { kind: 'canonical_state', state: t.canonicalRef }, {
      kind: 'current_context_accepted', state: { kind: 'canonical', state: {
        kind: 'local_restriction', ref: t.canonicalRef, focus: expectedPreservedFocus,
        boundary: expectedBoundary, target: sessionId,
      } },
    })
    expectBusinessReport(t.finalizedC31, 'C31', t.pendingRef, { kind: 'uniquely_replaced', state: t.pendingRef })
    expectBusinessReport(t.finalizedC32, 'C32', { kind: 'canonical_state', state: t.canonicalRef }, {
      kind: 'current_context_accepted', state: { kind: 'canonical', state: {
        kind: 'local_restriction', ref: t.canonicalRef, focus: expectedPreservedFocus,
        boundary: expectedBoundary, target: sessionId,
      } },
    })
    expect(object(t.c06)?.value).toEqual(object(t.c02)?.value)
    expect(object(t.c20)?.value).toEqual(object(t.c21)?.value); expect(object(t.c21)?.value).toEqual(object(t.c22)?.value)
    expect(object(t.firstC31)?.value).toEqual(object(t.finalizedC31)?.value)
    expect(t.firstC32?.value).toEqual(t.finalizedC32?.value)
    expect(observed.map(observation => observation.contract)).toEqual(['C30', 'C31', 'C31'])
    expect(reportsFor(observed, 'C30')).toEqual([t.c30])
    expect(reportsFor(observed, 'C31')).toEqual([t.firstC31, t.finalizedC31])
    expect(ledger.dispatches).toHaveLength(1)
    const dispatch = ledger.dispatches[0]!, dispatchRow = parseCanonicalLocalRestrictionStateRecord(dispatch.rawSidecar)
    expect(dispatchRow).toEqual(row)
    expect(dispatch.request).toBe(h.adapter.requests.at(-1))
    const physicalCanonical = expectLiveCanonicalPhysical(h, row)
    const request = dispatch.request
    expect(request.messages).toEqual([physicalCanonical.data, message])
    expect(request.messages.map(item => item.role)).toEqual(['user', 'user'])
    expect(request.messages[0]).toEqual(physicalCanonical.data)
    expect(request.messages[1]).toEqual(message)
    expect({ id: String(message.id), role: message.role, content: message.content, source: message.source,
      text: messageText(message), hash: expressionHash(String(message.id), tracer) }).toEqual({
      id: String(message.id), role: 'user', content: [{ type: 'text', text: tracer }], source: { kind: 'user' },
      text: tracer, hash: t.machine.originHash,
    })
    expect(direct(h.agent, message.id).map(event => event.data)).toEqual([message])
    expect(assistants(h.agent).slice(beforeAssistants).at(-1)?.data.message.content).toEqual([{ type: 'text', text: '部署已暂停；可以先做只读检查' }])
    expect(t3EventCounts(h.agent.session.events)).toEqual({
      localWriter: 2, nativeWriter: 0, checkpoint: 0, route: 0, compaction: 0, tool: 0,
    })
  })

  it('P2 repairs one exact normal tail, restores the local association, then accepts exactly one continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f08-cold1-')); roots.push(root)
    const beforeColdCanonical = await establishTail(root)
    const ledger = createObservationLedger(), spies = installReceiverSpies()
    const h = await mount(root, true); await h.agent.whenIdle(); expect(h.adapter.rootCalls + h.adapter.actionCalls + h.adapter.focusCalls).toBe(0)
    const observed = await recordReceiverObservations(ledger, 'P2-cold1', spies)
    const row = readLocalSidecar(root), t = transaction(row)
    expectRecoveryReceivers(observed, row)
    expect(reportsFor(observed, 'C35')[0]?.identity.subject).toBe(t.c06.identity.subject)
    expectRepairedCanonical(h, row)
    const repaired = expectCanonicalPhysical(h, row), allCanonical = canonical(h.agent)
    const beforeKeys = new Set(beforeColdCanonical.map(event => `${event.seq}:${String(event.data.id)}`))
    const added = allCanonical.filter(event => !beforeKeys.has(`${event.seq}:${String(event.data.id)}`))
    const repair = t.repair
    if (repair?.phase !== 'repair_finalized') throw new Error('P2 repair marker was not finalized')
    expect(allCanonical).toHaveLength(beforeColdCanonical.length + 1)
    expect(added).toHaveLength(1)
    expect(added[0]).toEqual(repaired)
    expect({ id: String(added[0]?.data.id), seq: added[0]?.seq }).toEqual({
      id: repair.targetMessageId, seq: repair.targetReplaceSeq,
    })
    await assertContinue(h); expect(work(h.agent)).toBe(0)
  })

  it('P3 cold-reopens a repaired canonical-only state without changing identity, then accepts its sole continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f08-cold2-')); roots.push(root)
    const beforeColdCanonical = await establishTail(root)
    const ledger = createObservationLedger(), spies = installReceiverSpies()
    const first = await mount(root, true); await first.agent.whenIdle()
    const cold1Receivers = await recordReceiverObservations(ledger, 'P3-cold1', spies)
    const cold1 = {
      rawSidecar: readRawSidecar(root),
      row: readLocalSidecar(root),
      visible: first.agent.session.deriveMessages(),
      canonicalEvents: canonical(first.agent),
    }
    expectRecoveryReceivers(cold1Receivers, cold1.row)
    expectRepairedCanonical(first, cold1.row)
    const repaired = expectCanonicalPhysical(first, cold1.row)
    const beforeKeys = new Set(beforeColdCanonical.map(event => `${event.seq}:${String(event.data.id)}`))
    const added = cold1.canonicalEvents.filter(event => !beforeKeys.has(`${event.seq}:${String(event.data.id)}`))
    const cold1Repair = transaction(cold1.row).repair
    if (cold1Repair?.phase !== 'repair_finalized') throw new Error('P3 cold1 repair marker was not finalized')
    expect(cold1.canonicalEvents).toHaveLength(beforeColdCanonical.length + 1)
    expect(added).toHaveLength(1)
    expect(added[0]).toEqual(repaired)
    expect({ id: String(added[0]?.data.id), seq: added[0]?.seq }).toEqual({
      id: cold1Repair.targetMessageId, seq: cold1Repair.targetReplaceSeq,
    })
    expect(first.adapter.rootCalls + first.adapter.actionCalls + first.adapter.focusCalls).toBe(0)
    await dispose(first); clearReceiverSpies(spies)
    const second = await mount(root, true); await second.agent.whenIdle()
    const cold2Receivers = await recordReceiverObservations(ledger, 'P3-cold2', spies)
    expectRecoveryReceivers(cold2Receivers, readLocalSidecar(root))
    expect(receiverBusinessOracle(cold2Receivers)).toEqual(receiverBusinessOracle(cold1Receivers))
    expect({
      rawSidecar: readRawSidecar(root),
      row: readLocalSidecar(root),
      visible: second.agent.session.deriveMessages(),
      canonicalEvents: canonical(second.agent),
    }).toEqual(cold1)
    expectRepairedCanonical(second, readLocalSidecar(root))
    expectCanonicalPhysical(second, readLocalSidecar(root))
    expect(second.adapter.rootCalls + second.adapter.actionCalls + second.adapter.focusCalls).toBe(0); await assertContinue(second)
  })

  it('A rejects missing focus, malformed schema, wrong focus identity, and mixed admission only after physical input proof', async () => {
    const expected: Record<AVariant, { readonly calls: CallDelta; readonly error: string; readonly preserved: 1 | 2 }> = {
      'missing-focus': { calls: { focus: 0, action: 0, root: 0, provider: 0 }, error: stableFailure, preserved: 1 },
      malformed: { calls: { focus: 0, action: 1, root: 0, provider: 1 }, error: stableFailure, preserved: 1 },
      'wrong-focus': { calls: { focus: 0, action: 0, root: 0, provider: 0 }, error: stableFailure, preserved: 1 },
      mixed: { calls: { focus: 0, action: 0, root: 0, provider: 0 }, error: 'focus-canary', preserved: 2 },
    }
    for (const variant of ['missing-focus', 'malformed', 'wrong-focus', 'mixed'] as const) {
      const h = await fresh(`f08-a-${variant}-`); if (variant !== 'missing-focus') await establishFocus(h)
      if (variant === 'malformed') h.adapter.actionOutput = '{}'
      if (variant === 'wrong-focus') { const row = object(readRawSidecar(h.root)); if (row === undefined) throw new Error('missing focus sidecar'); await h.domain.table('focus_precanonical').put(sessionId, { ...row, decision: { ...object(row.decision), chat: 'foreign-chat' } }) }
      const baseline = readRawSidecar(h.root)
      const first = createUserMessage({ content: [{ type: 'text', text: tracer }], source: { kind: 'user' } })
      const messages = variant === 'mixed'
        ? [first, createUserMessage({ content: [{ type: 'text', text: 'extra' }], source: { kind: 'user' } })]
        : [first]
      const ledger = createFailureLedger(variant, messages); installFlowLedger(h, ledger); const before = calls(h.adapter)
      if (variant === 'mixed') {
        h.agent.send(messages[0]!, 'next-step', false); h.agent.send(messages[1]!, 'next-turn', true)
      } else h.agent.send(first, 'next-turn', true)
      await h.agent.whenIdle()
      const oracle = expected[variant]
      expect(callDelta(calls(h.adapter), before), variant).toEqual(oracle.calls)
      expect(ledger.events.filter(event => event.kind === 'agent-error').map(event => event.error), variant)
        .toEqual([oracle.error])
      expect(ledger.events.filter(event => event.kind === 'preserve'), variant).toHaveLength(oracle.preserved)
      expectPreservationFlow(ledger, messages.map(message => ({ message, mode: 'append' })), oracle.error)
      for (const message of messages) expect(direct(h.agent, message.id), variant).toHaveLength(1)
      const raw = object(readRawSidecar(h.root))
      expect(readRawSidecar(h.root), variant).toEqual(baseline)
      if (variant === 'missing-focus') expect(raw, variant).toBeUndefined()
      else {
        expect({ family: raw?.family, transaction: raw?.transaction }, variant)
          .toEqual({ family: undefined, transaction: undefined })
      }
      if (variant === 'malformed') expect(h.adapter.actionCalls - before.action, variant).toBe(1)
      if (variant === 'wrong-focus') {
        expect(object(raw?.decision)?.chat, variant).toBe('foreign-chat')
        expect(h.adapter.actionCalls - before.action, variant).toBe(0)
      }
      expect(canonical(h.agent), variant).toHaveLength(0)
      expect(ledger.events.filter(event => event.kind === 'append-committed' && event.operation === 'replace'), variant).toHaveLength(0)
      expect(work(h.agent), variant).toBe(0)
    }
  })

  it('B observes no-safe-action, invalid-neededFor pre-receiver failure, and actionable boundaries with zero local transaction', async () => {
    const variants: readonly { readonly variant: BVariant; readonly output: string }[] = [
      { variant: 'all-actions-blocked', output: allBlocked },
      { variant: 'invalid-neededFor', output: JSON.stringify({ actions: ['部署B'],
        proposedRequirements: [{ fact: '环境名', neededFor: ['其他'] }], usableInputs: [],
        unresolvedInputs: [{ fact: '环境名', meaning: '未知', source: 'direct', degree: 'unknown', affected: '部署B' }] }) },
      { variant: 'actionable-proposal', output: actionable },
    ]
    const c20Spy = vi.spyOn(EffectiveStatePreservation.prototype, 'acceptActionBoundaryToPreserve')
    const c21Spy = vi.spyOn(CanonicalContextAuthority.prototype, 'acceptActionSafetyBoundary')
    const c22Spy = vi.spyOn(UserInteractionAdvice.prototype, 'acceptFactDecisionNeeds')
    for (const { variant, output } of variants) {
      c20Spy.mockClear(); c21Spy.mockClear(); c22Spy.mockClear()
      const h = await fresh(`f08-b-${variant}-`); await establishFocus(h); h.adapter.actionOutput = output
      const message = createUserMessage({ content: [{ type: 'text', text: tracer }], source: { kind: 'user' } })
      const baseline = readRawSidecar(h.root)
      const ledger = createFailureLedger(variant, [message])
      installFlowLedger(h, ledger); const before = calls(h.adapter)
      h.agent.send(message, 'next-turn', true); await h.agent.whenIdle()
      expect(callDelta(calls(h.adapter), before), variant)
        .toEqual({ focus: 0, action: 1, root: 0, provider: 1 })
      expect(ledger.events.filter(event => event.kind === 'agent-error').map(event => event.error), variant)
        .toEqual([stableFailure])
      expectPreservationFlow(ledger, [{ message, mode: 'append' }], stableFailure)
      expect(readRawSidecar(h.root), variant).toEqual(baseline)
      const raw = object(readRawSidecar(h.root))
      expect({ family: raw?.family, transaction: raw?.transaction }, variant)
        .toEqual({ family: undefined, transaction: undefined })
      expect(canonical(h.agent), variant).toHaveLength(0)
      expect(ledger.events.filter(event => event.kind === 'append-committed' && event.operation === 'replace'), variant).toHaveLength(0)
      expect(direct(h.agent, message.id), variant).toHaveLength(1)
      const c20 = spyReports<C20Result>(c20Spy), c21 = spyReports<C21Result>(c21Spy), c22 = spyReports<C22Result>(c22Spy)
      if (variant === 'invalid-neededFor') {
        expect({ c20, c21, c22 }, variant).toEqual({ c20: [], c21: [], c22: [] })
      } else {
        expect({ c20: c20.length, c21: c21.length, c22: c22.length }, variant).toEqual({ c20: 1, c21: 1, c22: 1 })
        const boundaryKind = variant === 'all-actions-blocked' ? 'no_safe_action' : 'actionable'
        const c20Value = object(c20[0])?.value, accepted = object(c20Value), boundary = object(accepted?.value)
        expect(boundary?.kind, variant).toBe(boundaryKind)
        expectBusinessReport(c20[0], 'C20', boundary?.ref, c20Value)
        expectBusinessReport(c21[0], 'C21', boundary?.ref, c20Value)
        expectBusinessReport(c22[0], 'C22', boundary?.ref, c20Value)
        expect(object(c21[0])?.value, variant).toEqual(c20Value)
        expect(object(c22[0])?.value, variant).toEqual(c20Value)
      }
      expect(work(h.agent), variant).toBe(0)
    }
  })

  it('C contains live publication faults and exact, mismatched, or duplicate preappend competition before downstream work', async () => {
    const expected: Record<CVariant, {
      readonly error: string
      readonly sidecarPhase?: 'pending' | 'current'
      readonly tableAttempts: readonly ('pending' | 'current')[]
      readonly tableCommits: readonly ('pending' | 'current')[]
      readonly replaceAttempts: number
      readonly replaceCommits: number
      readonly canonicalEvents: number
      readonly directEvents: 1 | 2
      readonly flushResults: readonly boolean[]
      readonly readKinds: readonly ('read-result' | 'read-error')[]
      readonly preservation?: 'append' | 'reuse'
    }> = {
      'pending-put': { error: stableFailure, tableAttempts: ['pending'], tableCommits: [], replaceAttempts: 0,
        replaceCommits: 0, canonicalEvents: 0, directEvents: 1, flushResults: [true], readKinds: ['read-result'], preservation: 'append' },
      'first-replace': { error: stableFailure, sidecarPhase: 'pending', tableAttempts: ['pending'], tableCommits: ['pending'], replaceAttempts: 1,
        replaceCommits: 0, canonicalEvents: 0, directEvents: 1, flushResults: [true], readKinds: ['read-result'], preservation: 'append' },
      'second-replace': { error: stableFailure, sidecarPhase: 'current', tableAttempts: ['pending', 'current'], tableCommits: ['pending', 'current'], replaceAttempts: 2,
        replaceCommits: 1, canonicalEvents: 1, directEvents: 1, flushResults: [true], readKinds: ['read-result'], preservation: 'append' },
      flush: { error: stableFailure, sidecarPhase: 'current', tableAttempts: ['pending', 'current'], tableCommits: ['pending', 'current'], replaceAttempts: 2,
        replaceCommits: 2, canonicalEvents: 2, directEvents: 1, flushResults: [false, true], readKinds: ['read-result'], preservation: 'append' },
      read: { error: stableFailure, sidecarPhase: 'current', tableAttempts: ['pending', 'current'], tableCommits: ['pending', 'current'], replaceAttempts: 2,
        replaceCommits: 2, canonicalEvents: 2, directEvents: 1, flushResults: [true, true], readKinds: ['read-error', 'read-result'], preservation: 'append' },
      'exact-race': { error: stableFailure, tableAttempts: [], tableCommits: [], replaceAttempts: 0,
        replaceCommits: 0, canonicalEvents: 0, directEvents: 1, flushResults: [true], readKinds: ['read-result'], preservation: 'reuse' },
      'mismatch-race': { error: 'focus-canary', tableAttempts: [], tableCommits: [], replaceAttempts: 0,
        replaceCommits: 0, canonicalEvents: 0, directEvents: 1, flushResults: [], readKinds: [] },
      'duplicate-race': { error: 'focus-canary', tableAttempts: [], tableCommits: [], replaceAttempts: 0,
        replaceCommits: 0, canonicalEvents: 0, directEvents: 2, flushResults: [], readKinds: [] },
    }
    for (const variant of ['pending-put', 'first-replace', 'second-replace', 'flush', 'read', 'exact-race', 'mismatch-race', 'duplicate-race'] as const) {
      const h = await fresh(`f08-c-${variant}-`); await establishFocus(h)
      const baseline = readRawSidecar(h.root)
      const message = createUserMessage({ content: [{ type: 'text', text: tracer }], source: { kind: 'user' } })
      const ledger = createFailureLedger(variant, [message])
      const table = h.domain.table('focus_precanonical'), put = table.put.bind(table); if (variant === 'pending-put') table.put = async (key, value) => { if (storedPhase(value) === 'pending') throw new Error('put'); await put(key, value) }
      if (variant === 'first-replace' || variant === 'second-replace') replaceFault(h.agent, variant === 'first-replace' ? 1 : 2)
      if (variant === 'flush') { const flush = h.ctx.sessions.flush.bind(h.ctx.sessions); let failed = false; h.ctx.sessions.flush = async s => !failed && (failed = true) ? false : await flush(s) }
      if (variant === 'read') { const readFrom = h.ctx.sessionPersistence.readFrom.bind(h.ctx.sessionPersistence); let failed = false; h.ctx.sessionPersistence.readFrom = async (id, seq) => { if (!failed) { failed = true; throw new Error('read') } return await readFrom(id, seq) } }
      installFlowLedger(h, ledger)
      if (variant.endsWith('race')) h.adapter.beforeActionOutput = () => {
        ledger.actor = 'race'
        try {
          h.agent.session.append('user/message', variant === 'mismatch-race'
            ? { ...message, content: [{ type: 'text', text: `${tracer}错` }] } : message, { surfaceOp: 'append' })
          if (variant === 'duplicate-race') h.agent.session.append('user/message', message, { surfaceOp: 'append' })
        } finally { ledger.actor = 'runtime' }
      }
      const before = calls(h.adapter); h.agent.send(message, 'next-turn', true); await h.agent.whenIdle()
      const oracle = expected[variant]
      expect(callDelta(calls(h.adapter), before), variant)
        .toEqual({ focus: 0, action: 1, root: 0, provider: 1 })
      expect(ledger.events.filter(event => event.kind === 'agent-error').map(event => event.error), variant)
        .toEqual([oracle.error])
      const attempts = ledger.events.filter(event => event.kind === 'table-put-attempt').map(event => 'phase' in event ? event.phase : undefined)
      const commits = ledger.events.filter(event => event.kind === 'table-put-committed').map(event => 'phase' in event ? event.phase : undefined)
      expect(attempts, variant).toEqual(oracle.tableAttempts); expect(commits, variant).toEqual(oracle.tableCommits)
      const replaceAttempts = ledger.events.filter(event => event.kind === 'append-attempt' && event.operation === 'replace')
      const replaceCommits = ledger.events.filter(event => event.kind === 'append-committed' && event.operation === 'replace')
      expect(replaceAttempts, variant).toHaveLength(oracle.replaceAttempts); expect(replaceCommits, variant).toHaveLength(oracle.replaceCommits)
      const canonicalEvents = canonical(h.agent)
      expect(canonicalEvents, variant).toHaveLength(oracle.canonicalEvents)
      expect(canonicalEvents.map(event => ({ id: String(event.data.id), seq: event.seq,
        phase: event.data.source.kind === 'context-manager-local-restriction' ? event.data.source.phase : undefined })), variant)
        .toEqual(replaceCommits.map(event => ({ id: 'id' in event ? event.id : undefined,
          seq: 'seq' in event ? event.seq : undefined, phase: 'phase' in event ? event.phase : undefined })))
      expect(direct(h.agent, message.id), variant).toHaveLength(oracle.directEvents)
      expect(ledger.events.filter(event => event.kind === 'flush-result').map(event => event.result), variant)
        .toEqual(oracle.flushResults)
      expect(ledger.events.filter(event => event.kind === 'read-result' || event.kind === 'read-error').map(event => event.kind), variant)
        .toEqual(oracle.readKinds)
      const raw = object(readRawSidecar(h.root)), rawTransaction = object(raw?.transaction)
      const committedPuts = ledger.events.filter(event => event.kind === 'table-put-committed')
      const lastCommitted = committedPuts.at(-1)
      expect(readRawSidecar(h.root), variant).toEqual(lastCommitted?.value ?? baseline)
      expect(rawTransaction?.phase, variant).toBe(oracle.sidecarPhase)
      expect(rawTransaction === undefined ? undefined : raw?.family, variant)
        .toBe(oracle.sidecarPhase === undefined ? undefined : 'local_restriction')
      if (oracle.sidecarPhase === 'pending') {
        expect(Object.keys(rawTransaction ?? {}).sort(), variant).toEqual([
          'body', 'bodyHash', 'c02', 'c06', 'c20', 'c21', 'c22', 'c29', 'canonicalRef', 'family',
          'generation', 'machine', 'material', 'pendingRef', 'phase',
        ].sort())
        expect({ c29: object(rawTransaction?.c29)?.kind, c30: rawTransaction?.c30,
          firstReplaceSeq: rawTransaction?.firstReplaceSeq, finalizedReplaceSeq: rawTransaction?.finalizedReplaceSeq }, variant)
          .toEqual({ c29: 'business_result', c30: undefined, firstReplaceSeq: undefined, finalizedReplaceSeq: undefined })
      }
      if (oracle.sidecarPhase === 'current') {
        expect(Object.keys(rawTransaction ?? {}).sort(), variant).toEqual([
          'body', 'bodyHash', 'c02', 'c06', 'c20', 'c21', 'c22', 'c29', 'c30', 'c33', 'canonicalRef',
          'family', 'firstC31', 'firstC32', 'firstReplaceSeq', 'generation', 'machine', 'material', 'pendingRef', 'phase',
        ].sort())
        expect({ c30: object(rawTransaction?.c30)?.kind, firstC31: object(rawTransaction?.firstC31)?.kind,
          firstReplaceSeq: rawTransaction?.firstReplaceSeq, finalizedC31: rawTransaction?.finalizedC31,
          finalizedReplaceSeq: rawTransaction?.finalizedReplaceSeq }, variant).toEqual({
          c30: 'business_result', firstC31: 'business_result', firstReplaceSeq: canonicalEvents[0]?.seq,
          finalizedC31: undefined, finalizedReplaceSeq: undefined,
        })
      }
      if (oracle.sidecarPhase !== undefined) {
        const parsed = parseCanonicalLocalRestrictionStateRecord(readRawSidecar(h.root))
        if (parsed?.transaction === undefined) throw new Error(`${variant} lacks exact committed local transaction`)
        const persisted = parsed.transaction, boundary = { ...persisted.material.canonicalState.boundary, chat: sessionId }
        expect(persisted.machine.originMessageId).toBe(String(message.id))
        expect(persisted.machine.originHash).toBe(expressionHash(String(message.id), tracer))
        expect(persisted.bodyHash).toBe(createHash('sha256').update(persisted.body).digest('hex'))
        expect(persisted.c20.identity.subject).toBe(boundary.ref)
        expect(object(persisted.c20)?.value).toEqual({ kind: 'accepted_for_contract', value: boundary })
        expect(object(persisted.c21)?.value).toEqual(object(persisted.c20)?.value)
        expect(object(persisted.c22)?.value).toEqual(object(persisted.c20)?.value)
        expect(object(persisted.c29)?.value).toEqual({ kind: 'eligible', state: persisted.pendingRef })
        if (persisted.phase === 'current') {
          expect(object(persisted.c33)?.value).toEqual({ kind: 'saved', material: persisted.material.ref })
          expect(object(persisted.c30)?.value).toEqual({ kind: 'established', state: persisted.pendingRef })
          expect(object(persisted.firstC31)?.value).toEqual({ kind: 'uniquely_replaced', state: persisted.pendingRef })
          expect(object(persisted.firstC32)?.value).toEqual({ kind: 'current_context_accepted', state: {
            kind: 'canonical', state: { ...persisted.material.canonicalState, target: sessionId },
          } })
        }
        for (const event of canonicalEvents) {
          if (event.data.source.kind !== 'context-manager-local-restriction') throw new Error(`${variant} has foreign canonical source`)
          expect(event.data, variant).toEqual({
            id: event.data.id, role: 'user', content: [{ type: 'text', text: persisted.body }],
            source: {
              kind: 'context-manager-local-restriction', phase: event.data.source.phase,
              pendingStateRef: persisted.pendingRef, canonicalStateRef: persisted.canonicalRef,
              generation: persisted.generation, chat: sessionId, bodyHash: persisted.bodyHash,
              machine: persisted.machine,
            },
          })
        }
      }
      expect(canonicalEvents.map(event => ({ id: String(event.data.id), seq: event.seq, message: event.data })), variant)
        .toEqual(replaceCommits.map(event => ({ id: 'id' in event ? event.id : undefined,
          seq: 'seq' in event ? event.seq : undefined, message: 'message' in event ? event.message : undefined })))
      if (oracle.preservation !== undefined) {
        expectPreservationFlow(ledger, [{ message, mode: oracle.preservation }], oracle.error)
      } else expect(ledger.events.filter(event => event.kind === 'preserve'), variant).toHaveLength(0)
      const raceAppends = ledger.events.filter(event => event.kind === 'append-committed'
        && event.actor === 'race' && event.id === String(message.id))
      if (variant === 'exact-race') {
        expect(raceAppends, variant).toHaveLength(1)
        expect(raceAppends[0]).toMatchObject({ source: 'user', text: tracer,
          hash: expressionHash(String(message.id), tracer) })
      }
      if (variant === 'mismatch-race') {
        expect(raceAppends, variant).toHaveLength(1)
        expect(raceAppends[0]).toMatchObject({ source: 'user', text: `${tracer}错`,
          hash: expressionHash(String(message.id), `${tracer}错`) })
      }
      if (variant === 'duplicate-race') {
        expect(raceAppends, variant).toHaveLength(2)
        expect(raceAppends.every(event => 'text' in event && event.text === tracer
          && 'hash' in event && event.hash === expressionHash(String(message.id), tracer))).toBe(true)
      }
      expect(work(h.agent), variant).toBe(0)
    }
  })

  it('D keeps one generation and target across repair pending, replace, flush, readback, and final-marker faults', async () => {
    for (const variant of ['replace', 'flush', 'read', 'final-marker'] as const) {
      const root = await mkdtemp(join(tmpdir(), `f08-d-${variant}-`)); roots.push(root)
      await establishTail(root)
      const original = snapshot(readLocalSidecar(root))
      const ledger: RepairLedger = { variant, events: [], hits: 0 }
      const h = await mount(root, true, (ctx, domain, adapter) => installRepairFault(ctx, domain, adapter, ledger))
      await h.agent.whenIdle()

      const pendingRow = readLocalSidecar(root), pending = snapshot(pendingRow), repair = pending.repair
      expect(ledger.hits, variant).toBe(1)
      expect(ledger.events.filter(event => event.kind === 'fault-hit'), variant).toEqual([{ kind: 'fault-hit', seam: variant }])
      expect({ generation: pending.generation, boundary: pending.boundary, canonicalRef: pending.canonicalRef, bodyHash: pending.bodyHash })
        .toEqual({ generation: original.generation, boundary: original.boundary, canonicalRef: original.canonicalRef, bodyHash: original.bodyHash })
      expect(repair?.phase, variant).toBe('repair_pending')
      const target = repair?.targetMessageId
      expect(target, variant).toMatch(/^[0-9a-f-]{36}$/)
      const replaceCommitted = ledger.events.find(event => event.kind === 'replace-committed') as
        | (RepairEvent & { readonly kind: 'replace-committed'; readonly id?: string; readonly seq?: number; readonly body?: string; readonly bodyHash?: string })
        | undefined
      const physicalTarget = canonical(h.agent).filter(event => String(event.data.id) === target)
      if (variant === 'replace') {
        expect(replaceCommitted, variant).toBeUndefined()
        expect(physicalTarget, variant).toHaveLength(0)
      } else {
        expect(replaceCommitted, variant).toMatchObject({ id: target, body: transaction(pendingRow).body,
          bodyHash: pending.bodyHash })
        expect(physicalTarget, variant).toHaveLength(1)
        expect({ id: String(physicalTarget[0]?.data.id), seq: physicalTarget[0]?.seq,
          body: messageText(physicalTarget[0]!.data), source: physicalTarget[0]?.data.source.kind })
          .toEqual({ id: target, seq: replaceCommitted?.seq, body: transaction(pendingRow).body,
            source: 'context-manager-local-restriction' })
      }
      const maintenanceKinds = ledger.events.map(event => event.kind)
      const expectedMaintenance: Record<DVariant, readonly string[]> = {
        replace: ['put-attempt', 'put-committed', 'replace-attempt', 'fault-hit', 'replace-error'],
        flush: ['put-attempt', 'put-committed', 'replace-attempt', 'replace-committed', 'flush-attempt', 'fault-hit', 'flush-fault'],
        read: ['put-attempt', 'put-committed', 'replace-attempt', 'replace-committed', 'flush-attempt', 'flush-committed', 'read-attempt', 'fault-hit', 'read-fault'],
        'final-marker': ['put-attempt', 'put-committed', 'replace-attempt', 'replace-committed', 'flush-attempt', 'flush-committed', 'read-attempt', 'read-committed', 'put-attempt', 'fault-hit'],
      }
      expect(maintenanceKinds, variant).toEqual(expectedMaintenance[variant])
      const pendingPut = ledger.events.find(event => event.kind === 'put-committed' && event.phase === 'repair_pending')
      expect(pendingPut, variant).toMatchObject({ target })
      const finalizedPut = ledger.events.find(event => event.kind === 'put-attempt' && event.phase === 'repair_finalized')
      if (variant === 'final-marker') expect(finalizedPut, `${variant}: planned final marker`)
        .toMatchObject({ target, seq: replaceCommitted?.seq })
      else expect(finalizedPut, variant).toBeUndefined()

      const callsBefore = calls(h.adapter), assistantsBefore = assistants(h.agent).length
      const boundary = ledger.events.length
      const rejected = await send(h.agent, `未经授权的后续-${variant}`)
      const post = ledger.events.slice(boundary)
      expect(callDelta(calls(h.adapter), callsBefore), variant).toEqual({ focus: 0, action: 0, root: 0, provider: 0 })
      expect(assistants(h.agent), variant).toHaveLength(assistantsBefore)
      expect(direct(h.agent, rejected.id), variant).toHaveLength(1)
      const directEvent = direct(h.agent, rejected.id)[0]!
      const appendIndex = post.findIndex(event => event.kind === 'direct-append-committed' && event.id === String(rejected.id))
      const flushIndex = post.findIndex((event, index) => index > appendIndex && event.kind === 'flush-committed')
      const readIndex = post.findIndex((event, index) => index > flushIndex && event.kind === 'read-committed')
      const errorIndex = post.findIndex((event, index) => index > readIndex && event.kind === 'agent-error' && event.error === stableFailure)
      expect(post[0], variant).toEqual({ kind: 'pre-step', requestCount: callsBefore.provider })
      expect(appendIndex, variant).toBeGreaterThanOrEqual(0)
      expect(flushIndex, variant).toBeGreaterThan(appendIndex)
      expect(readIndex, variant).toBeGreaterThan(flushIndex)
      expect(errorIndex, variant).toBeGreaterThan(readIndex)
      const productionRead = post[readIndex]
      if (productionRead?.kind !== 'read-committed') throw new Error(`${variant} lacks production detached read`)
      expect({ sessionId: productionRead.sessionId, fromSeq: productionRead.fromSeq }, variant)
        .toEqual({ sessionId, fromSeq: directEvent.seq })
      expect(productionRead.events.filter(event => event.seq === directEvent.seq || event.id === String(rejected.id)), variant)
        .toEqual([{ seq: directEvent.seq, type: 'user/message', id: String(rejected.id), source: { kind: 'user' },
          text: `未经授权的后续-${variant}`, hash: expressionHash(String(rejected.id), `未经授权的后续-${variant}`) }])
      expect(canonical(h.agent).length, variant).toBe(variant === 'replace' ? 2 : 3)
      expect(snapshot(readLocalSidecar(root)), variant).toEqual(pending)
      expect(work(h.agent), variant).toBe(0)
    }
  })

  it('E mounts then closes on explicitly schema-invalid local records, valid foreign no-focus, or real polluted tails', async () => {
    for (const variant of ['schema-invalid-body', 'schema-invalid-body-hash', 'schema-invalid-c20-subject',
      'valid-foreign-no-focus', 'extra-direct', 'tool-tail'] as const satisfies readonly EVariant[]) {
      const root = await mkdtemp(join(tmpdir(), `f08-e-${variant}-`)); roots.push(root)
      if (variant === 'tool-tail') await establishToolTail(root)
      else await establishTail(root)
      const original = readLocalSidecar(root), originalSnapshot = snapshot(original)
      const foreign = variant === 'valid-foreign-no-focus' ? await naturalForeignNoFocus(root) : undefined
      const t = transaction(original)
      const poisoned: unknown = variant === 'schema-invalid-body'
        ? { ...original, transaction: { ...t, body: 'wrong but schema-shaped body' } }
        : variant === 'schema-invalid-body-hash'
          ? { ...original, transaction: { ...t, bodyHash: '0'.repeat(64) } }
          : variant === 'schema-invalid-c20-subject'
            ? { ...original, transaction: { ...t, c20: { ...t.c20,
                identity: { ...t.c20.identity, subject: 'foreign-action-boundary' } } } }
            : variant === 'valid-foreign-no-focus' ? foreign?.record : original
      if (poisoned === undefined) throw new Error(`${variant} lacks physical pollution`)
      if (variant.startsWith('schema-invalid-')) {
        expect(parseCanonicalLocalRestrictionStateRecord(poisoned), variant).toBeUndefined()
        expect(object(poisoned)?.family, variant).toBe('local_restriction')
      }
      if (variant === 'valid-foreign-no-focus') {
        const closure = object(object(poisoned)?.closure), decision = object(closure?.decision)
        expect({ kind: decision?.kind, chat: decision?.chat }).toEqual({ kind: 'no_focus', chat: foreign!.session })
        expect(JSON.stringify(poisoned)).toContain(foreign!.session)
        expect(JSON.stringify(poisoned)).not.toContain(`\"chat\":\"${sessionId}\"`)
      }

      const injected = variant === 'extra-direct'
        ? createUserMessage({ content: [{ type: 'text', text: '真实用户尾部污染' }], source: { kind: 'user' } })
        : undefined
      const h = await mount(root, true, async (ctx, domain) => {
        await domain.table('focus_precanonical').put(sessionId, poisoned)
        if (injected !== undefined) ctx.on('agent/created', ({ agent }) => {
          agent.session.append('user/message', injected, { surfaceOp: 'append' })
        }, { prepend: true })
      })
      await h.agent.whenIdle()
      expect(h.adapter.requests, `${variant}: mount must not dispatch`).toHaveLength(0)
      if (injected !== undefined) expect(direct(h.agent, injected.id), variant).toHaveLength(1)
      if (variant === 'tool-tail') {
        expect(h.agent.session.events.filter(event => event.type === 'tool/call'), variant).toHaveLength(1)
        expect(h.agent.session.events.filter(event => event.type === 'tool/result'), variant).toHaveLength(1)
      }
      const canonicalBefore = canonical(h.agent).map(event => ({ id: String(event.data.id), seq: event.seq,
        body: messageText(event.data), source: event.data.source }))
      const sidecarBefore = readRawSidecar(root)
      expect(sidecarBefore, variant).toEqual(poisoned)

      const follow = createUserMessage({ content: [{ type: 'text', text: `后续直接输入-${variant}` }], source: { kind: 'user' } })
      const ledger = createFailureLedger(variant, [follow])
      installFlowLedger(h, ledger)
      let preSteps = 0
      h.ctx.on('agent/pre-step', async (_event, next) => { preSteps += 1; return await next() }, { prepend: true })
      const beforeCalls = calls(h.adapter), beforeEvents = h.agent.session.events.length, beforeAssistants = assistants(h.agent).length
      h.agent.send(follow, 'next-turn', true)
      await h.agent.whenIdle()
      expect(preSteps, variant).toBe(1)
      expectPreservationFlow(ledger, [{ message: follow, mode: 'append' }], stableFailure)
      expect(callDelta(calls(h.adapter), beforeCalls), variant).toEqual({ focus: 0, action: 0, root: 0, provider: 0 })
      expect(assistants(h.agent), variant).toHaveLength(beforeAssistants)
      expect(direct(h.agent, follow.id), variant).toHaveLength(1)
      expect(postWork(h.agent.session.events.slice(beforeEvents)), variant).toBe(0)
      expect(canonical(h.agent).map(event => ({ id: String(event.data.id), seq: event.seq,
        body: messageText(event.data), source: event.data.source })), variant).toEqual(canonicalBefore)
      expect(readRawSidecar(root), variant).toEqual(sidecarBefore)
      if (object(poisoned)?.family === 'local_restriction') {
        const raw = rawSnapshot(readRawSidecar(root))
        expect({ generation: raw.generation, boundary: raw.boundary, canonicalRef: raw.canonicalRef }, variant)
          .toEqual({ generation: originalSnapshot.generation, boundary: originalSnapshot.boundary,
            canonicalRef: originalSnapshot.canonicalRef })
        if (variant !== 'schema-invalid-body-hash') expect(raw.bodyHash, variant).toBe(originalSnapshot.bodyHash)
      }
    }
  })
})
