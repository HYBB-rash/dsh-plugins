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
import {
  CallId,
  createAssistantMessage,
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  type SessionEvent,
  type SessionEventMap,
  type SessionEventType,
  type SurfaceEventType,
  type SurfaceIntent,
} from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as ContextManager from '../src/index.ts'
import {
  ActionFactBoundaryAuthority,
  type C20Result,
  type C21Result,
  type C22Result,
  type C36Result,
} from '../src/action-boundary.ts'
import { FocusAuthority, type C35Result } from '../src/focus.ts'
import { UserInteractionAdvice } from '../src/local-restriction.ts'
import { ManagedAwareBasicCompactionEngine } from '../src/managed-compaction.ts'
import { NoSafeActionAdapter } from '../src/no-safe-action.ts'
import {
  CanonicalContextAuthority,
  EffectiveStatePreservation,
  StatePersistence,
  UniqueVisibleContextReplacement,
  parseCanonicalNoSafeActionStateRecord,
  type C30Result,
  type C31Result,
  type C34Result,
  type C37Result,
  type NoSafeActionStateRecord,
} from '../src/state-transaction.ts'

const roots: string[] = []
const contexts: Context[] = []
const sessionId = ContextManager.FOCUS_CANARY_IDS[0]
const foreignSessionId = ContextManager.FOCUS_CANARY_IDS[1]
const focusExpression = '处理生产记录'
const tracer = '把生产里的那条记录删掉'
const stableFailure = '唯一背景未能安全换入，本轮未继续行动'
const noSafeOutput = JSON.stringify({
  actions: ['删除生产记录'],
  proposedRequirements: [{ fact: 'RecordRef', neededFor: ['删除生产记录'] }],
  usableInputs: [],
  unresolvedInputs: [{
    fact: 'RecordRef', meaning: '目标记录身份尚未确定', source: 'direct-user', degree: 'unknown', affected: '删除生产记录',
  }],
})
const userExplanation = '当前没有可安全执行的删除操作；我不会执行。请提供目标记录标识，或允许我先做只读核验。'

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

function guardedToolChunks(id: string): StreamChunk[] {
  const callId = CallId(id)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: userExplanation } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: callId, name: 'delete_record', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: 'delete_record', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function hasSchema(options: GenerateOptions, plugin: string): boolean {
  return options.messages.some(message => message.source.kind === 'plugin' && message.source.plugin === plugin)
}

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  focusCalls = 0
  actionCalls = 0
  rootCalls = 0
  focusOutput = '{"kind":"focus","subject":"处理生产记录","relation":"new"}'
  actionOutput = noSafeOutput
  rootToolAttempt = false
  beforeActionOutput: (() => void) | undefined
  observeRootDispatch: ((request: GenerateOptions) => void) | undefined

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 8_192 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (hasSchema(options, 'ui-context-compactor:focus-canary-schema')) {
      this.focusCalls += 1
      yield* textChunks(this.focusOutput)
      return
    }
    if (hasSchema(options, 'ui-context-compactor:action-fact-need-schema')) {
      this.actionCalls += 1
      this.beforeActionOutput?.()
      yield* textChunks(this.actionOutput)
      return
    }
    this.rootCalls += 1
    this.observeRootDispatch?.(options)
    if (this.rootToolAttempt) {
      this.rootToolAttempt = false
      yield* guardedToolChunks(`f09-tool-${this.rootCalls}`)
      return
    }
    yield* textChunks(options.messages[0]?.source.kind === 'context-manager-no-safe-action'
      ? userExplanation : '已建立处理生产记录焦点')
  }
}

interface Table {
  get(key: string): unknown
  put(key: string, value: unknown): Promise<void>
}
interface Domain { table(name: string): Table }
interface Harness { readonly ctx: Context; readonly agent: Agent; readonly adapter: Adapter; readonly domain: Domain; readonly root: string }

async function mount(
  root: string,
  resume = false,
  beforeAgent?: (ctx: Context, domain: Domain, adapter: Adapter) => void | Promise<void>,
  targetSessionId: string = sessionId,
): Promise<Harness> {
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
  const managedRuntime = {
    mode: 'enforce' as const,
    safeUpdateMarginTokens: 64,
    allowlist: [...ContextManager.FOCUS_CANARY_IDS],
  }
  await ctx.plugin(ManagedAwareBasicCompactionEngine, {
    auto: true, thresholdRatio: .99, retainRatio: .1, managedRuntime,
  })
  await ctx.plugin(commandCompact)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['local-test'], adapter)
  let domain: Domain | undefined
  const facility: { open(spec: unknown): Promise<Domain> } = ctx.storageDomain
  const open = facility.open.bind(facility)
  facility.open = async spec => domain = await open(spec)
  await ctx.plugin(ContextManager, {
    focusCanary: {
      ...managedRuntime,
      auxiliary: {
        provider: 'local-test', model: 'local-test', maxOutputTokens: 64, timeoutMs: 500,
        maxExpressionChars: 240, maxProjectionTokens: 1_024, safetyMarginTokens: 128,
      },
    },
    nativeWriterArbitration: { mode: 'enforce' },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (domain === undefined) throw new Error('missing context-manager domain')
  await beforeAgent?.(ctx, domain, adapter)
  const agent = resume
    ? (await ctx.agents.resume({
        resumeSessionId: SessionId(targetSessionId),
        agentOptions: { provider: 'local-test', model: 'local-test' },
      })).agent
    : ctx.agentLoop.create(SessionId(targetSessionId), { provider: 'local-test', model: 'local-test' })
  return { ctx, agent, adapter, domain, root }
}

async function fresh(prefix: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return await mount(root)
}

async function dispose(harness: Harness): Promise<void> {
  await harness.ctx.sessions.flush(harness.agent.session)
  await harness.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(harness.ctx), 1)
}

async function send(agent: Agent, text: string): Promise<UserMessage> {
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  agent.send(message, 'next-turn', true)
  await agent.whenIdle()
  return message
}

async function establishFocus(harness: Harness): Promise<void> {
  await send(harness.agent, focusExpression)
  expect(harness.adapter.focusCalls).toBe(1)
  expect(harness.adapter.rootCalls).toBe(1)
}

function messageText(message: UserMessage): string | undefined {
  return message.content.length === 1 && message.content[0]?.type === 'text'
    ? message.content[0].text : undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function storedPhase(value: unknown): string | undefined {
  const raw = object(value)
  const state = object(raw?.transaction)
  return typeof state?.phase === 'string' ? state.phase : undefined
}

function expressionHash(id: string, text: string): string {
  return createHash('sha256').update(id).update('\0').update(text).digest('hex')
}

function direct(agent: Agent, id?: UserMessage['id']): SessionEvent<'user/message'>[] {
  return agent.session.events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && event.data.source.kind === 'user'
      && (id === undefined || String(event.data.id) === String(id)))
}

function noSafeCanonical(agent: Agent): SessionEvent<'user/message'>[] {
  return agent.session.events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && event.data.source.kind === 'context-manager-no-safe-action')
}

function assistants(agent: Agent): SessionEvent<'assistant/message'>[] {
  return agent.session.events.filter((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')
}

function readRawSidecar(root: string, targetSessionId: string = sessionId): unknown {
  const db = new DatabaseSync(join(root, 'storages', 'context-manager-focus-canary.sqlite'), { readOnly: true })
  try {
    const row = object(db.prepare('SELECT value FROM "u_context_manager_focus_precanonical" WHERE key=?').get(targetSessionId))
    return typeof row?.value === 'string' ? JSON.parse(row.value) as unknown : undefined
  } finally {
    db.close()
  }
}

function readNoSafeSidecar(root: string): NoSafeActionStateRecord {
  const parsed = parseCanonicalNoSafeActionStateRecord(readRawSidecar(root))
  if (parsed === undefined) throw new Error('missing exact no-safe sidecar')
  return parsed
}

function transaction(record: NoSafeActionStateRecord) {
  if (record.transaction === undefined) throw new Error('missing no-safe transaction')
  return record.transaction
}

function expectBusinessReport(report: unknown, contract: string, subject: unknown, value: unknown): void {
  const raw = object(report)
  const identity = object(raw?.identity)
  expect(Object.keys(raw ?? {}).sort()).toEqual(['identity', 'kind', 'value'])
  expect(raw?.kind).toBe('business_result')
  expect(Object.keys(identity ?? {}).sort()).toEqual(['call', 'contract', 'subject'])
  expect(identity?.contract).toBe(contract)
  expect(identity?.call).toMatch(new RegExp(`^${contract}:`))
  expect(identity?.subject).toEqual(subject)
  expect(raw?.value).toEqual(value)
}

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
  readonly contract: Contract
  readonly invocation: number
  readonly report: ReceiverReportMap[Contract]
} }[ReceiverContract]
interface RecordedSpy {
  readonly mock: {
    readonly invocationCallOrder: readonly number[]
    readonly results: readonly { readonly type: string; readonly value?: unknown }[]
  }
}
interface ObservationLedger {
  readonly receivers: ReceiverObservation[]
  readonly dispatches: GenerateOptions[]
}

function installRecoverySpies() {
  return {
    c34: vi.spyOn(EffectiveStatePreservation.prototype, 'acceptStoredStateReadout'),
    c35: vi.spyOn(FocusAuthority.prototype, 'acceptRestoredFocusFact'),
    c36: vi.spyOn(ActionFactBoundaryAuthority.prototype, 'acceptRestoredActionBoundary'),
    c30Live: vi.spyOn(EffectiveStatePreservation.prototype, 'establishRecoverablePreservation'),
    c30Retained: vi.spyOn(EffectiveStatePreservation.prototype, 'establishRetainedRecoverablePreservation'),
    c31: vi.spyOn(UniqueVisibleContextReplacement.prototype, 'replaceVisibleContext'),
    c37: vi.spyOn(CanonicalContextAuthority.prototype, 'acceptCanonicalRestoration'),
  }
}

async function observationsFrom<Contract extends ReceiverContract>(
  contract: Contract,
  rawSpy: unknown,
): Promise<ReceiverObservation[]> {
  const spy = rawSpy as RecordedSpy
  const observations: ReceiverObservation[] = []
  for (const [index, invocation] of spy.mock.invocationCallOrder.entries()) {
    const result = spy.mock.results[index]
    if (result?.type !== 'return') throw new Error(`${contract} receiver did not return normally`)
    const report = await Promise.resolve(result.value) as ReceiverReportMap[Contract]
    observations.push({ contract, invocation, report } as ReceiverObservation)
  }
  return observations
}

async function recoveryObservations(spies: ReturnType<typeof installRecoverySpies>): Promise<ReceiverObservation[]> {
  return (await Promise.all([
    observationsFrom('C34', spies.c34), observationsFrom('C35', spies.c35),
    observationsFrom('C36', spies.c36), observationsFrom('C30', spies.c30Live),
    observationsFrom('C30', spies.c30Retained), observationsFrom('C31', spies.c31),
    observationsFrom('C37', spies.c37),
  ])).flat().sort((left, right) => left.invocation - right.invocation)
}

function reportsFor<Contract extends ReceiverContract>(
  observations: readonly ReceiverObservation[],
  contract: Contract,
): readonly ReceiverReportMap[Contract][] {
  return observations.filter(observation => observation.contract === contract)
    .map(observation => observation.report as ReceiverReportMap[Contract])
}

function expectCanonical(agent: Agent, record: NoSafeActionStateRecord): SessionEvent<'user/message'> {
  const state = transaction(record)
  const visible = agent.session.deriveMessages()
  const canonical = visible[0]
  if (canonical === undefined || canonical.source.kind !== 'context-manager-no-safe-action') {
    throw new Error('missing visible no-safe canonical')
  }
  const physical = noSafeCanonical(agent).filter(event => String(event.data.id) === String(canonical.id))
  expect(physical).toHaveLength(1)
  expect(canonical).toEqual({
    id: canonical.id,
    role: 'user',
    content: [{ type: 'text', text: state.body }],
    source: {
      kind: 'context-manager-no-safe-action',
      phase: 'finalized',
      pendingStateRef: state.pendingRef,
      canonicalStateRef: state.canonicalRef,
      generation: state.generation,
      chat: sessionId,
      bodyHash: state.bodyHash,
      machine: state.machine,
    },
  })
  expect(createHash('sha256').update(state.body).digest('hex')).toBe(state.bodyHash)
  expect(physical[0]?.data).toEqual(canonical)
  return physical[0]!
}

function eventCounts(events: readonly SessionEvent[]) {
  return {
    noSafeWriter: events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'context-manager-no-safe-action').length,
    nativeWriter: events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'context-manager-canonical').length,
    checkpoint: events.filter(event => event.type === 'user/message'
      && isCompactCheckpointSource(event.data.source)).length,
    route: events.filter(event => event.type === 'user/message'
      && (event.data.source.kind === 'context-route'
        || event.data.source.kind === 'plugin' && event.data.source.plugin === 'context-route')).length,
    compaction: events.filter(event => event.type.startsWith('compaction/')).length,
    toolCall: events.filter(event => event.type === 'tool/call').length,
    toolResult: events.filter(event => event.type === 'tool/result').length,
  }
}

type ProductionFlowEvent =
  | { readonly kind: 'append-attempt'; readonly actor: string; readonly id: string; readonly source: string;
      readonly text?: string; readonly hash?: string; readonly operation: 'append' | 'replace' }
  | { readonly kind: 'append-committed'; readonly actor: string; readonly id: string; readonly source: string;
      readonly text?: string; readonly hash?: string; readonly operation: 'append' | 'replace';
      readonly event: SessionEvent<'user/message'> }
  | { readonly kind: 'flush-attempt' }
  | { readonly kind: 'flush-result'; readonly result: boolean }
  | { readonly kind: 'read-attempt'; readonly session: string; readonly fromSeq: number }
  | { readonly kind: 'read-result'; readonly session: string; readonly fromSeq: number;
      readonly events: readonly SessionEvent[] }
  | { readonly kind: 'read-error'; readonly session: string; readonly fromSeq: number; readonly error: string }
  | { readonly kind: 'presenter'; readonly error: string }

interface ProductionFlowLedger {
  actor: string
  readonly events: ProductionFlowEvent[]
  readonly originalFlush: Harness['ctx']['sessions']['flush']
  readonly originalReadFrom: Harness['ctx']['sessionPersistence']['readFrom']
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function installProductionFlow(harness: Harness): ProductionFlowLedger {
  const originalFlush = harness.ctx.sessions.flush.bind(harness.ctx.sessions)
  const originalReadFrom = harness.ctx.sessionPersistence.readFrom.bind(harness.ctx.sessionPersistence)
  const ledger: ProductionFlowLedger = { actor: 'runtime', events: [], originalFlush, originalReadFrom }
  const append = harness.agent.session.append
  harness.agent.session.append = function observedProductionAppend<Type extends SessionEventType>(
    type: Type,
    data: SessionEventMap[Type],
    ...options: Type extends SurfaceEventType ? [SurfaceIntent] : []
  ): SessionEvent<Type> {
    const message = type === 'user/message' ? data as SessionEventMap['user/message'] : undefined
    if (message === undefined) return Reflect.apply(append, this, [type, data, ...options]) as SessionEvent<Type>
    const text = messageText(message)
    const detail = {
      actor: ledger.actor,
      id: String(message.id),
      source: message.source.kind,
      ...(text === undefined ? {} : { text, hash: expressionHash(String(message.id), text) }),
      operation: options[0]?.surfaceOp === 'append' ? 'append' as const : 'replace' as const,
    }
    ledger.events.push({ kind: 'append-attempt', ...detail })
    const event = Reflect.apply(append, this, [type, data, ...options]) as SessionEvent<Type>
    ledger.events.push({ kind: 'append-committed', ...detail, event: event as SessionEvent<'user/message'> })
    return event
  }
  harness.ctx.sessions.flush = async session => {
    ledger.events.push({ kind: 'flush-attempt' })
    const result = await originalFlush(session)
    ledger.events.push({ kind: 'flush-result', result })
    return result
  }
  harness.ctx.sessionPersistence.readFrom = async (id, fromSeq) => {
    const session = String(id)
    ledger.events.push({ kind: 'read-attempt', session, fromSeq })
    try {
      const result = await originalReadFrom(id, fromSeq)
      ledger.events.push({ kind: 'read-result', session, fromSeq, events: result.events })
      return result
    } catch (error: unknown) {
      ledger.events.push({ kind: 'read-error', session, fromSeq, error: errorText(error) })
      throw error
    }
  }
  harness.ctx.on('agent/error', ({ agent, error }) => {
    if (agent === harness.agent) ledger.events.push({ kind: 'presenter', error: errorText(error) })
  })
  return ledger
}

function expectProductionDirectProof(
  ledger: ProductionFlowLedger,
  snapshot: readonly ProductionFlowEvent[],
  message: UserMessage,
  expectedError: string,
  mode: 'append' | 'reuse',
): SessionEvent<'user/message'> {
  const id = String(message.id)
  const expectedText = messageText(message)
  if (expectedText === undefined) throw new Error('production proof requires one text direct')
  expect(ledger.events.slice(0, snapshot.length)).toEqual(snapshot)
  const commits = snapshot.filter((event): event is Extract<ProductionFlowEvent, { readonly kind: 'append-committed' }> =>
    event.kind === 'append-committed' && event.id === id && event.source === 'user')
  const runtime = commits.filter(event => event.actor === 'runtime')
  expect(runtime).toHaveLength(mode === 'append' ? 1 : 0)
  expect(commits).toHaveLength(1)
  const physical = commits[0]!
  expect({ operation: physical.operation, text: physical.text, hash: physical.hash }).toEqual({
    operation: 'append', text: expectedText, hash: expressionHash(id, expectedText),
  })
  const physicalIndex = snapshot.indexOf(physical)
  const flushAttempt = snapshot.findIndex((event, index) => index > physicalIndex && event.kind === 'flush-attempt')
  const flushResult = snapshot.findIndex((event, index) => index > flushAttempt
    && event.kind === 'flush-result' && event.result)
  const readAttempt = snapshot.findIndex((event, index) => index > flushResult && event.kind === 'read-attempt'
    && event.session === sessionId && event.fromSeq === physical.event.seq)
  const readResult = snapshot.findIndex((event, index) => index > readAttempt && event.kind === 'read-result'
    && event.session === sessionId && event.fromSeq === physical.event.seq)
  const presenter = snapshot.findIndex((event, index) => index > readResult
    && event.kind === 'presenter' && event.error === expectedError)
  expect([physicalIndex, flushAttempt, flushResult, readAttempt, readResult, presenter]
    .every(index => index >= 0), JSON.stringify({ physicalIndex, flushAttempt, flushResult,
      readAttempt, readResult, presenter, snapshot })).toBe(true)
  const persisted = snapshot[readResult]
  if (persisted?.kind !== 'read-result') throw new Error('missing production detached read result')
  expect(persisted.events.filter(event => event.seq === physical.event.seq
    || event.type === 'user/message' && String(event.data.id) === id)).toEqual([physical.event])
  return physical.event
}

async function establishNormalNoSafe(root: string): Promise<void> {
  const harness = await mount(root)
  await establishFocus(harness)
  await send(harness.agent, tracer)
  expect(transaction(readNoSafeSidecar(root)).phase).toBe('finalized')
  await dispose(harness)
}

describe('F09-T1 no-safe action through the public Telegram Agent lifecycle', () => {
  it('P1 commits one exact live no-safe state before dispatch and blocks the attempted tool body', async () => {
    const harness = await fresh('f09-p1-')
    await establishFocus(harness)
    let bodyExecutions = 0
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'delete_record',
      description: 'Delete a selected production record.',
      parameters: {},
      async execute() {
        bodyExecutions += 1
        return [{ type: 'text', text: 'deleted' }]
      },
    }))
    const ledger: ObservationLedger = { receivers: [], dispatches: [] }
    const errors: string[] = []
    harness.ctx.on('agent/error', ({ agent, error }) => {
      if (agent === harness.agent) errors.push(error instanceof Error ? error.message : String(error))
    })
    harness.adapter.observeRootDispatch = request => ledger.dispatches.push(request)
    harness.adapter.rootToolAttempt = true
    const rootBefore = harness.adapter.rootCalls
    const directMessage = await send(harness.agent, tracer)
    const record = readNoSafeSidecar(harness.root)
    const state = transaction(record)
    const canonical = expectCanonical(harness.agent, record)

    expect({ family: record.family, phase: state.phase, generation: state.generation }).toEqual({
      family: 'no_safe_action', phase: 'finalized', generation: 1,
    })
    expect(state.material.canonicalState.focus).toMatchObject({
      kind: 'focus_established', currentMatter: '处理生产记录', latestCorrections: '',
    })
    const boundary = state.material.canonicalState.boundary
    expect(boundary).toEqual({
      kind: 'no_safe_action', ref: boundary.ref,
      requiredFacts: { ref: boundary.requiredFacts.ref,
        requirements: [{ fact: 'RecordRef', neededFor: ['删除生产记录'] }] },
      usableFacts: [],
      unresolvedFacts: [{ fact: 'RecordRef', meaning: '目标记录身份尚未确定', source: 'direct-user',
        degree: 'unknown', affected: '删除生产记录' }],
      preciselyBlockedActions: ['删除生产记录'], safelyContinuableActions: [],
    })
    const fullFocus = { ...state.material.canonicalState.focus, chat: sessionId }
    const fullBoundary = { ...boundary, chat: sessionId }
    expectBusinessReport(state.c06, 'C06', fullFocus.ref, { kind: 'accepted_for_contract', value: fullFocus })
    expectBusinessReport(state.c02, 'C02', fullFocus.ref, { kind: 'accepted_for_contract', value: fullFocus })
    expectBusinessReport(state.c20, 'C20', fullBoundary.ref, { kind: 'accepted_for_contract', value: fullBoundary })
    expectBusinessReport(state.c21, 'C21', fullBoundary.ref, { kind: 'accepted_for_contract', value: fullBoundary })
    expectBusinessReport(state.c22, 'C22', fullBoundary.ref, { kind: 'accepted_for_contract', value: fullBoundary })
    expectBusinessReport(state.c29, 'C29', state.pendingRef, { kind: 'eligible', state: state.pendingRef })
    expectBusinessReport(state.c33, 'C33', state.material.ref, { kind: 'saved', material: state.material.ref })
    expectBusinessReport(state.c30, 'C30', state.pendingRef, { kind: 'established', state: state.pendingRef })
    expectBusinessReport(state.firstC31, 'C31', state.pendingRef, { kind: 'uniquely_replaced', state: state.pendingRef })
    expectBusinessReport(state.finalizedC31, 'C31', state.pendingRef, { kind: 'uniquely_replaced', state: state.pendingRef })
    const currentContextValue = { kind: 'current_context_accepted', state: {
      kind: 'canonical', state: { kind: 'no_safe_action', ref: state.canonicalRef,
        target: sessionId, focus: state.material.canonicalState.focus, boundary },
    } }
    expectBusinessReport(state.firstC32, 'C32', { kind: 'canonical_state', state: state.canonicalRef }, currentContextValue)
    expectBusinessReport(state.finalizedC32, 'C32', { kind: 'canonical_state', state: state.canonicalRef }, currentContextValue)

    expect(ledger.dispatches, JSON.stringify({ rootCalls: harness.adapter.rootCalls, assistants: assistants(harness.agent).length, errors,
      tail: harness.agent.session.events.slice(-8).map(event => event.type) })).toHaveLength(1)
    expect(harness.adapter.rootCalls - rootBefore).toBe(1)
    const request = ledger.dispatches[0]!
    const notice = request.messages[2]
    expect(request.messages).toHaveLength(3)
    expect(request.messages[0]).toEqual(canonical.data)
    expect(request.messages[1]).toEqual(directMessage)
    expect(notice).toEqual({
      id: notice?.id, role: 'user',
      content: [{ type: 'text', text: state.body }],
      source: { kind: 'plugin', plugin: 'ui-context-compactor:no-safe-action',
        form: 'notice', summary: 'no safe action notice' },
    })
    expect(direct(harness.agent, directMessage.id).map(event => event.data)).toEqual([directMessage])
    expect(bodyExecutions).toBe(0)
    expect(eventCounts(harness.agent.session.events)).toEqual({
      noSafeWriter: 2, nativeWriter: 0, checkpoint: 0, route: 0, compaction: 0,
      toolCall: 1, toolResult: 1,
    })
    const visibleAssistant = assistants(harness.agent).at(-1)?.data.message
    expect(visibleAssistant?.content.some(block => block.type === 'text' && block.text === userExplanation)).toBe(true)
    expect(JSON.stringify(visibleAssistant)).not.toMatch(/已补全|迁移完成|guard.*释放|已经删除/)
  })

  it('P2 repairs the exact normal tail on cold resume and restores C34-C37 before refusing tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f09-p2-'))
    roots.push(root)
    await establishNormalNoSafe(root)
    const before = readNoSafeSidecar(root)
    const original = transaction(before)
    const spies = installRecoverySpies()
    const harness = await mount(root, true)
    await harness.agent.whenIdle()
    const observations = await recoveryObservations(spies)
    const ledger: ObservationLedger = { receivers: [...observations], dispatches: [] }
    const repaired = readNoSafeSidecar(root)
    const state = transaction(repaired)

    expect(state.repair?.phase, `cold row ${JSON.stringify(state.repair)}`).toBe('repair_finalized')
    expect(ledger.receivers.map(observation => observation.contract)).toEqual(['C34', 'C35', 'C36', 'C30', 'C31', 'C37'])
    expect(ledger.receivers.every(observation => observation.report.kind === 'business_result')).toBe(true)
    const readout = { kind: 'existing_material', material: state.material }
    const c34 = reportsFor(observations, 'C34')[0]
    const c35 = reportsFor(observations, 'C35')[0]
    const c36 = reportsFor(observations, 'C36')[0]
    const c30 = reportsFor(observations, 'C30')[0]
    const c31 = reportsFor(observations, 'C31')[0]
    const c37 = reportsFor(observations, 'C37')[0]
    expectBusinessReport(c34, 'C34', readout, { kind: 'accepted_for_contract', value: readout })
    expectBusinessReport(c35, 'C35', state.material.canonicalState.focus.ref, {
      kind: 'accepted_for_contract', value: { target: sessionId, focus: state.material.canonicalState.focus },
    })
    expectBusinessReport(c36, 'C36', state.material.canonicalState.boundary.ref, {
      kind: 'accepted_for_contract', value: { target: sessionId, boundary: state.material.canonicalState.boundary },
    })
    const c30Value = object(c30)?.value
    const c31Value = object(c31)?.value
    const recoverableProof = object(c30Value)?.proof
    const visibleProof = object(c31Value)?.proof
    expect(recoverableProof).toMatch(/^recoverable:/)
    expect(visibleProof).toMatch(/^visible:/)
    expectBusinessReport(c30, 'C30', state.pendingRef, {
      kind: 'same_complete_state_already_recoverable', state: state.pendingRef, proof: recoverableProof,
    })
    expectBusinessReport(c31, 'C31', state.pendingRef, {
      kind: 'same_state_already_uniquely_visible', state: state.pendingRef, proof: visibleProof,
    })
    const restoration = object(object(c37)?.value)?.value
    const restorationRaw = object(restoration)
    expect(restorationRaw?.restorationProof).toMatch(/^restoration:/)
    expectBusinessReport(c37, 'C37', sessionId, { kind: 'accepted_for_contract', value: restoration })
    expect(restoration).toEqual({
      kind: 'no_safe_action_restored', material: state.material,
      restorationProof: restorationRaw?.restorationProof, recoverableProof, visibleProof,
    })
    expect({ generation: state.generation, canonicalRef: state.canonicalRef, bodyHash: state.bodyHash,
      boundary: state.material.canonicalState.boundary }).toEqual({
      generation: original.generation, canonicalRef: original.canonicalRef, bodyHash: original.bodyHash,
      boundary: original.material.canonicalState.boundary,
    })
    const canonical = expectCanonical(harness.agent, repaired)
    expect(state.repair).toMatchObject({ targetMessageId: String(canonical.data.id), targetReplaceSeq: canonical.seq })
    expect(harness.adapter.requests).toHaveLength(0)

    let bodyExecutions = 0
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'delete_record', description: 'Delete a selected production record.', parameters: {},
      async execute() { bodyExecutions += 1; return [{ type: 'text', text: 'deleted' }] },
    }))
    const result = await harness.ctx.tools.execute({
      name: 'delete_record', arguments: {}, callId: CallId('f09-cold-guard'),
      signal: new AbortController().signal, agent: harness.agent,
    })
    expect(bodyExecutions).toBe(0)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('当前请求没有可安全执行的行动')
    expect(state.body).toBe('当前请求没有可安全执行的行动。已阻止：删除生产记录。待确认：目标记录身份尚未确定。')
  })

  it('A rejects absent or corrupted focus identity and assistant/route-only history without forming no-safe', async () => {
    const expectedError = {
      'missing-focus': stableFailure,
      'wrong-chat': stableFailure,
      'wrong-hash': stableFailure,
      'assistant-only': stableFailure,
      'route-only': stableFailure,
    } as const
    for (const variant of ['missing-focus', 'wrong-chat', 'wrong-hash', 'assistant-only', 'route-only'] as const) {
      const harness = await fresh(`f09-a-${variant}-`)
      if (variant === 'wrong-chat' || variant === 'wrong-hash') {
        await establishFocus(harness)
        const row = object(readRawSidecar(harness.root))
        if (row === undefined) throw new Error(`${variant} missing natural focus row`)
        const poisoned = variant === 'wrong-chat'
          ? { ...row, decision: { ...object(row.decision), chat: foreignSessionId } }
          : { ...row, original: { ...object(row.original), hash: '0'.repeat(64) } }
        await harness.domain.table('focus_precanonical').put(sessionId, poisoned)
      }
      if (variant === 'assistant-only') {
        const assistant = createAssistantMessage({
          content: [{ type: 'text', text: '最近一条是 record-pretend' }],
          source: { provider: 'local-test', model: 'local-test' },
        })
        harness.agent.session.append('assistant/message', { turn: 1, step: 1, message: assistant }, { surfaceOp: 'append' })
      }
      if (variant === 'route-only') {
        const statement = { text: '旧 route 说目标是 record-pretend', sourceSeqs: [] }
        const route = ContextManager.createRouteRevisionMessage(sessionId, {
          version: 1,
          operation: 'create',
          snapshot: {
            revision: 1, asOfSeq: 0, rootGoal: statement, successCriteria: [],
            currentRoute: { ...statement, reason: '历史路线', status: 'tentative' },
            decisions: [], retiredRoutes: [], currentNode: statement, nextDecision: null,
            reviewTriggers: [], detailRefs: [],
          },
        })
        harness.agent.session.append('user/message', route, { surfaceOp: 'append' })
      }
      const baseline = readRawSidecar(harness.root)
      let bodyExecutions = 0
      harness.ctx.tools.register(defineContentToolFixture({
        name: 'delete_record', description: 'Delete a selected production record.', parameters: {},
        async execute() { bodyExecutions += 1; return [{ type: 'text', text: 'deleted' }] },
      }))
      harness.adapter.rootToolAttempt = true
      const flow = installProductionFlow(harness)
      const beforeEvents = eventCounts(harness.agent.session.events)
      const before = { focus: harness.adapter.focusCalls, action: harness.adapter.actionCalls, root: harness.adapter.rootCalls }
      const message = await send(harness.agent, tracer)
      const production = [...flow.events]
      expect({ focus: harness.adapter.focusCalls - before.focus, action: harness.adapter.actionCalls - before.action,
        root: harness.adapter.rootCalls - before.root }, variant).toEqual({ focus: 0, action: 0, root: 0 })
      expectProductionDirectProof(flow, production, message, expectedError[variant], 'append')
      expect(direct(harness.agent, message.id), variant).toHaveLength(1)
      expect(noSafeCanonical(harness.agent), variant).toHaveLength(0)
      expect(readRawSidecar(harness.root), variant).toEqual(baseline)
      expect(assistants(harness.agent).some(event => event.data.message.source.kind === 'model'
        && event.data.message.content.some(block => block.type === 'text' && block.text.includes('record-pretend'))), variant)
        .toBe(variant === 'assistant-only')
      expect(eventCounts(harness.agent.session.events).route, variant).toBe(variant === 'route-only' ? 1 : 0)
      const afterEvents = eventCounts(harness.agent.session.events)
      expect({ bodyExecutions, noSafeWriter: afterEvents.noSafeWriter - beforeEvents.noSafeWriter,
        nativeWriter: afterEvents.nativeWriter - beforeEvents.nativeWriter,
        checkpoint: afterEvents.checkpoint - beforeEvents.checkpoint,
        route: afterEvents.route - beforeEvents.route,
        compaction: afterEvents.compaction - beforeEvents.compaction,
        toolCall: afterEvents.toolCall - beforeEvents.toolCall,
        toolResult: afterEvents.toolResult - beforeEvents.toolResult }, variant).toEqual({
        bodyExecutions: 0, noSafeWriter: 0, nativeWriter: 0, checkpoint: 0,
        route: 0, compaction: 0, toolCall: 0, toolResult: 0,
      })
    }
  })

  it('B rejects actionable, local, invalid-neededFor, and malformed all-blocked proposals as no-safe state', async () => {
    const variants = [
      { variant: 'record-ref-present', output: JSON.stringify({
        actions: ['删除生产记录'],
        proposedRequirements: [{ fact: 'RecordRef', neededFor: ['删除生产记录'] }],
        usableInputs: [{ kind: 'direct_fact', fact: 'RecordRef', meaning: 'record-42', source: 'direct-user', degree: 'established' }],
        unresolvedInputs: [],
      }), boundary: 'actionable' },
      { variant: 'safe-action-remains', output: JSON.stringify({
        actions: ['删除生产记录', '只读核验记录'],
        proposedRequirements: [{ fact: 'RecordRef', neededFor: ['删除生产记录'] }], usableInputs: [],
        unresolvedInputs: [{ fact: 'RecordRef', meaning: '身份未知', source: 'direct-user', degree: 'unknown', affected: '删除生产记录' }],
      }), boundary: 'local_restriction' },
      { variant: 'invalid-neededFor', output: JSON.stringify({
        actions: ['删除生产记录'], proposedRequirements: [{ fact: 'RecordRef', neededFor: ['其他行动'] }], usableInputs: [],
        unresolvedInputs: [{ fact: 'RecordRef', meaning: '身份未知', source: 'direct-user', degree: 'unknown', affected: '删除生产记录' }],
      }) },
      { variant: 'malformed-all-blocked', output: JSON.stringify({
        actions: ['删除生产记录', '删除生产记录'],
        proposedRequirements: [{ fact: 'RecordRef', neededFor: ['删除生产记录'] }], usableInputs: [],
        unresolvedInputs: [{ fact: 'RecordRef', meaning: '身份未知', source: 'direct-user', degree: 'unknown', affected: '全部行动' }],
      }) },
    ] as const
    const c20Spy = vi.spyOn(EffectiveStatePreservation.prototype, 'acceptActionBoundaryToPreserve')
    const c21Spy = vi.spyOn(CanonicalContextAuthority.prototype, 'acceptActionSafetyBoundary')
    const c22Spy = vi.spyOn(UserInteractionAdvice.prototype, 'acceptFactDecisionNeeds')
    for (const candidate of variants) {
      c20Spy.mockClear(); c21Spy.mockClear(); c22Spy.mockClear()
      const harness = await fresh(`f09-b-${candidate.variant}-`)
      await establishFocus(harness)
      harness.adapter.actionOutput = candidate.output
      const baseline = readRawSidecar(harness.root)
      let bodyExecutions = 0
      harness.ctx.tools.register(defineContentToolFixture({
        name: 'delete_record', description: 'Delete a selected production record.', parameters: {},
        async execute() { bodyExecutions += 1; return [{ type: 'text', text: 'deleted' }] },
      }))
      harness.adapter.rootToolAttempt = true
      const flow = installProductionFlow(harness)
      const beforeEvents = eventCounts(harness.agent.session.events)
      const beforeCalls = { focus: harness.adapter.focusCalls, action: harness.adapter.actionCalls,
        root: harness.adapter.rootCalls }
      const message = await send(harness.agent, tracer)
      const production = [...flow.events]
      expect({ focus: harness.adapter.focusCalls - beforeCalls.focus,
        action: harness.adapter.actionCalls - beforeCalls.action,
        root: harness.adapter.rootCalls - beforeCalls.root }, candidate.variant)
        .toEqual({ focus: 0, action: 1, root: 0 })
      expectProductionDirectProof(flow, production, message, stableFailure, 'append')
      expect(direct(harness.agent, message.id), candidate.variant).toHaveLength(1)
      expect(noSafeCanonical(harness.agent), candidate.variant).toHaveLength(0)
      expect(readRawSidecar(harness.root), candidate.variant).toEqual(baseline)
      const c20 = c20Spy.mock.results.map(result => result.value as C20Result)
      const c21 = c21Spy.mock.results.map(result => result.value as C21Result)
      const c22 = c22Spy.mock.results.map(result => result.value as C22Result)
      if ('boundary' in candidate) {
        expect({ c20: c20.length, c21: c21.length, c22: c22.length }, candidate.variant)
          .toEqual({ c20: 1, c21: 1, c22: 1 })
        const accepted = object(object(c21[0])?.value)
        const boundary = object(accepted?.value)
        expect(boundary?.kind, candidate.variant).toBe(candidate.boundary)
        const value = object(c20[0])?.value
        expectBusinessReport(c20[0], 'C20', boundary?.ref, value)
        expectBusinessReport(c21[0], 'C21', boundary?.ref, value)
        expectBusinessReport(c22[0], 'C22', boundary?.ref, value)
        expect(object(c20[0])?.value, candidate.variant).toEqual(object(c21[0])?.value)
        expect(object(c22[0])?.value, candidate.variant).toEqual(object(c21[0])?.value)
      } else {
        expect({ c20, c21, c22 }, candidate.variant).toEqual({ c20: [], c21: [], c22: [] })
      }
      const afterEvents = eventCounts(harness.agent.session.events)
      expect({ bodyExecutions, noSafeWriter: afterEvents.noSafeWriter - beforeEvents.noSafeWriter,
        nativeWriter: afterEvents.nativeWriter - beforeEvents.nativeWriter,
        checkpoint: afterEvents.checkpoint - beforeEvents.checkpoint,
        route: afterEvents.route - beforeEvents.route,
        compaction: afterEvents.compaction - beforeEvents.compaction,
        toolCall: afterEvents.toolCall - beforeEvents.toolCall,
        toolResult: afterEvents.toolResult - beforeEvents.toolResult }, candidate.variant).toEqual({
        bodyExecutions: 0, noSafeWriter: 0, nativeWriter: 0, checkpoint: 0,
        route: 0, compaction: 0, toolCall: 0, toolResult: 0,
      })
    }
  })

  it('C preserves one-use action admission across foreign and cross-wired attempts', async () => {
    type FormArgs = Parameters<NoSafeActionAdapter['formActionBoundaryProposal']>
    type ConsumeArgs = Parameters<NoSafeActionAdapter['consumeBoundedProposal']>
    interface AdmissionObservation {
      readonly kind: 'foreign-captured' | 'private-cross-wired-c22' | 'private-correct-c22'
        | 'private-reuse' | 'wrong-admission' | 'cross-wired-proposal'
        | 'correct-proposal' | 'correct-consume' | 'reuse-rejected'
      readonly accepted: boolean
    }
    const ledger: AdmissionObservation[] = []
    let stage: 'c22-seed' | 'private' | 'correct' = 'c22-seed'
    let foreignClaim: FormArgs[2] | undefined
    let foreignOutcome: FormArgs[1] | undefined
    let foreignC22: C22Result | undefined
    let injectForeignC22 = false
    let privateC02Calls = 0
    const originalC22 = UserInteractionAdvice.prototype.acceptFactDecisionNeeds
    vi.spyOn(UserInteractionAdvice.prototype, 'acceptFactDecisionNeeds').mockImplementation(function (
      this: UserInteractionAdvice, boundary,
    ) {
      if (injectForeignC22) {
        if (foreignC22 === undefined) throw new Error('missing naturally observed foreign C22')
        return foreignC22
      }
      const result = originalC22.call(this, boundary)
      if (stage === 'c22-seed') foreignC22 = result
      return result
    })
    const originalForm = NoSafeActionAdapter.prototype.formActionBoundaryProposal
    vi.spyOn(NoSafeActionAdapter.prototype, 'formActionBoundaryProposal').mockImplementation(function (
      this: NoSafeActionAdapter, focus: FormArgs[0], outcome: FormArgs[1], claimed: FormArgs[2],
    ) {
      if (stage === 'c22-seed') return originalForm.call(this, focus, outcome, claimed)
      if (stage === 'private') {
        foreignClaim = claimed
        foreignOutcome = outcome
        ledger.push({ kind: 'foreign-captured', accepted: true })
        const proposal = originalForm.call(this, focus, outcome, claimed)
        const dependencies = object(this)?.dependencies
        const owner = object(dependencies)?.actionBoundaryOwner
        if (proposal === undefined || owner === null || typeof owner !== 'object') {
          throw new Error('missing private action composition')
        }
        const issue: unknown = Reflect.get(owner, 'issueBoundedProposal')
        const consume: unknown = Reflect.get(owner, 'consumeIssuedBoundary')
        const c02: unknown = Reflect.get(owner, 'acceptFocusForActionBoundary')
        if (typeof issue !== 'function' || typeof consume !== 'function' || typeof c02 !== 'function') {
          throw new Error('private action capability seam is unavailable')
        }
        const observedC02 = (...args: unknown[]): unknown => {
          privateC02Calls += 1
          return Reflect.apply(c02, owner, args)
        }
        if (!Reflect.set(owner, 'acceptFocusForActionBoundary', observedC02)) {
          throw new Error('private C02 observation seam is unavailable')
        }
        const capability: unknown = Reflect.apply(issue, owner, [focus, proposal])
        if (capability === undefined) throw new Error('private action capability was not issued')
        injectForeignC22 = true
        const crossWired: unknown = Reflect.apply(consume, owner, [capability])
        injectForeignC22 = false
        ledger.push({ kind: 'private-cross-wired-c22', accepted: crossWired !== undefined })
        const accepted: unknown = Reflect.apply(consume, owner, [capability])
        ledger.push({ kind: 'private-correct-c22', accepted: accepted !== undefined })
        const reused: unknown = Reflect.apply(consume, owner, [capability])
        ledger.push({ kind: 'private-reuse', accepted: reused !== undefined })
        return undefined
      }
      if (foreignClaim === undefined || foreignOutcome === undefined) throw new Error('missing foreign admission fixture')
      const wrongAdmission = originalForm.call(this, focus, outcome, foreignClaim)
      ledger.push({ kind: 'wrong-admission', accepted: wrongAdmission !== undefined })
      const crossWired = originalForm.call(this, focus, foreignOutcome, claimed)
      ledger.push({ kind: 'cross-wired-proposal', accepted: crossWired !== undefined })
      const correct = originalForm.call(this, focus, outcome, claimed)
      ledger.push({ kind: 'correct-proposal', accepted: correct !== undefined })
      return correct
    })
    const originalConsume = NoSafeActionAdapter.prototype.consumeBoundedProposal
    vi.spyOn(NoSafeActionAdapter.prototype, 'consumeBoundedProposal').mockImplementation(function (
      this: NoSafeActionAdapter, focus: ConsumeArgs[0], proposal: ConsumeArgs[1],
    ) {
      if (stage !== 'correct') return originalConsume.call(this, focus, proposal)
      const accepted = originalConsume.call(this, focus, proposal)
      ledger.push({ kind: 'correct-consume', accepted: accepted !== undefined })
      const reused = originalConsume.call(this, focus, proposal)
      ledger.push({ kind: 'reuse-rejected', accepted: reused !== undefined })
      return accepted
    })

    const seed = await fresh('f09-c-c22-seed-')
    await establishFocus(seed)
    await send(seed.agent, tracer)
    expect(transaction(readNoSafeSidecar(seed.root)).phase).toBe('finalized')
    expect(foreignC22?.kind).toBe('business_result')

    stage = 'private'
    const privateHarness = await fresh('f09-c-private-')
    await establishFocus(privateHarness)
    const privateBaseline = readRawSidecar(privateHarness.root)
    const privateDirect = await send(privateHarness.agent, tracer)
    expect(privateC02Calls).toBe(1)
    expect(direct(privateHarness.agent, privateDirect.id)).toHaveLength(1)
    expect(noSafeCanonical(privateHarness.agent)).toHaveLength(0)
    expect(readRawSidecar(privateHarness.root)).toEqual(privateBaseline)

    stage = 'correct'
    const correct = await fresh('f09-c-correct-')
    await establishFocus(correct)
    const correctDirect = await send(correct.agent, tracer)
    const row = readNoSafeSidecar(correct.root)
    expect(transaction(row).phase).toBe('finalized')
    expectCanonical(correct.agent, row)
    expect(direct(correct.agent, correctDirect.id)).toHaveLength(1)
    expect(ledger).toEqual([
      { kind: 'foreign-captured', accepted: true },
      { kind: 'private-cross-wired-c22', accepted: false },
      { kind: 'private-correct-c22', accepted: true },
      { kind: 'private-reuse', accepted: false },
      { kind: 'wrong-admission', accepted: false },
      { kind: 'cross-wired-proposal', accepted: false },
      { kind: 'correct-proposal', accepted: true },
      { kind: 'correct-consume', accepted: true },
      { kind: 'reuse-rejected', accepted: false },
    ])
    expect(correct.adapter.actionCalls).toBe(1)
    expect(correct.adapter.rootCalls).toBe(2)
  })

  it('D contains every live publication fault window before downstream work', async () => {
    type Fault = 'c33' | 'pending-put' | 'current-put' | 'first-replace'
      | 'final-replace' | 'flush' | 'read' | 'finalized-put'
    interface PutObservation { readonly phase: string | undefined; readonly committed: boolean; readonly value: unknown }
    interface AppendObservation {
      readonly operation: 'append' | 'replace'
      readonly source: string
      readonly id: string
      readonly phase: string | undefined
      readonly committed: boolean
      readonly seq?: number
    }
    interface FaultLedger {
      readonly puts: PutObservation[]
      readonly appends: AppendObservation[]
      readonly flushes: boolean[]
      readonly reads: { readonly session: string; readonly fromSeq: number; readonly ok: boolean }[]
      readonly errors: string[]
    }
    const expectedPhase: Record<Fault, string | undefined> = {
      c33: undefined,
      'pending-put': undefined,
      'current-put': 'pending',
      'first-replace': 'pending',
      'final-replace': 'current',
      flush: 'current',
      read: 'current',
      'finalized-put': 'current',
    }
    const expectedCanonicalCount: Record<Fault, number> = {
      c33: 0, 'pending-put': 0, 'current-put': 1, 'first-replace': 0,
      'final-replace': 1, flush: 2, read: 2, 'finalized-put': 2,
    }
    for (const fault of ['c33', 'pending-put', 'current-put', 'first-replace', 'final-replace',
      'flush', 'read', 'finalized-put'] as const satisfies readonly Fault[]) {
      const harness = await fresh(`f09-d-${fault}-`)
      await establishFocus(harness)
      let bodyExecutions = 0
      harness.ctx.tools.register(defineContentToolFixture({
        name: 'delete_record', description: 'Delete a selected production record.', parameters: {},
        async execute() { bodyExecutions += 1; return [{ type: 'text', text: 'deleted' }] },
      }))
      harness.adapter.rootToolAttempt = true
      const productionFlow = installProductionFlow(harness)
      const ledger: FaultLedger = { puts: [], appends: [], flushes: [], reads: [], errors: [] }
      harness.ctx.on('agent/error', ({ agent, error }) => {
        if (agent === harness.agent) ledger.errors.push(error instanceof Error ? error.message : String(error))
      })
      const baseline = readRawSidecar(harness.root)
      const table = harness.domain.table('focus_precanonical')
      const put = table.put.bind(table)
      table.put = async (key, value) => {
        const phase = storedPhase(value)
        ledger.puts.push({ phase, committed: false, value })
        if (fault === 'pending-put' && phase === 'pending'
          || fault === 'current-put' && phase === 'current'
          || fault === 'finalized-put' && phase === 'finalized') throw new Error(`fault:${fault}`)
        await put(key, value)
        ledger.puts.push({ phase, committed: true, value })
      }
      const append = harness.agent.session.append
      let replaces = 0
      harness.agent.session.append = function observedAppend<Type extends SessionEventType>(
        type: Type,
        data: SessionEventMap[Type],
        ...options: Type extends SurfaceEventType ? [SurfaceIntent] : []
      ): SessionEvent<Type> {
        const intent = options[0]
        const operation: AppendObservation['operation'] = intent?.surfaceOp === 'append' ? 'append' : 'replace'
        const message = type === 'user/message' ? data as SessionEventMap['user/message'] : undefined
        if (message === undefined) return Reflect.apply(append, this, [type, data, ...options]) as SessionEvent<Type>
        const source = message.source.kind
        const phase = source === 'context-manager-no-safe-action' ? message.source.phase : undefined
        const observation = { operation, source, id: String(message.id), phase }
        ledger.appends.push({ ...observation, committed: false })
        if (operation === 'replace' && ++replaces === (fault === 'first-replace' ? 1
          : fault === 'final-replace' ? 2 : -1)) throw new Error(`fault:${fault}`)
        const event = Reflect.apply(append, this, [type, data, ...options]) as SessionEvent<Type>
        ledger.appends.push({ ...observation, committed: true, seq: event.seq })
        return event
      }
      const flush = harness.ctx.sessions.flush.bind(harness.ctx.sessions)
      let flushFaulted = false
      harness.ctx.sessions.flush = async session => {
        if (fault === 'flush' && !flushFaulted) {
          flushFaulted = true
          ledger.flushes.push(false)
          return false
        }
        const result = await flush(session)
        ledger.flushes.push(result)
        return result
      }
      const readFrom = harness.ctx.sessionPersistence.readFrom.bind(harness.ctx.sessionPersistence)
      let readFaulted = false
      harness.ctx.sessionPersistence.readFrom = async (id, fromSeq) => {
        if (fault === 'read' && !readFaulted) {
          readFaulted = true
          ledger.reads.push({ session: String(id), fromSeq, ok: false })
          throw new Error('fault:read')
        }
        const result = await readFrom(id, fromSeq)
        ledger.reads.push({ session: String(id), fromSeq, ok: true })
        return result
      }
      const c33 = fault === 'c33'
        ? vi.spyOn(StatePersistence.prototype, 'saveCompleteState').mockRejectedValueOnce(new Error('fault:c33'))
        : undefined
      const before = { action: harness.adapter.actionCalls, root: harness.adapter.rootCalls }
      const message = await send(harness.agent, tracer)
      const production = [...productionFlow.events]
      c33?.mockRestore()
      expect({ action: harness.adapter.actionCalls - before.action, root: harness.adapter.rootCalls - before.root }, fault)
        .toEqual({ action: 1, root: 0 })
      expect(ledger.errors, fault).toEqual([stableFailure])
      const physicalProof = expectProductionDirectProof(
        productionFlow, production, message, stableFailure, 'append',
      )
      expect(bodyExecutions, fault).toBe(0)
      expect(direct(harness.agent, message.id), fault).toHaveLength(1)
      const physical = direct(harness.agent, message.id)[0]!
      expect(physical).toEqual(physicalProof)
      expect(messageText(physical.data), fault).toBe(tracer)
      expect(physical.data.source, fault).toEqual({ kind: 'user' })
      expect(expressionHash(String(physical.data.id), tracer), fault).toBe(expressionHash(String(message.id), tracer))
      expect(await productionFlow.originalFlush(harness.agent.session), fault).toBe(true)
      const detached = await productionFlow.originalReadFrom(harness.agent.session.id, physical.seq)
      expect(detached.events.filter(event => event.seq === physical.seq
        || event.type === 'user/message' && String(event.data.id) === String(message.id)), fault).toEqual([physical])
      expect(ledger.reads.some(read => read.ok && read.session === sessionId && read.fromSeq === physical.seq), fault).toBe(true)
      const raw = readRawSidecar(harness.root)
      const rawState = object(object(raw)?.transaction)
      const committedPuts = ledger.puts.filter(observation => observation.committed)
      expect(raw, fault).toEqual(committedPuts.at(-1)?.value ?? baseline)
      expect(storedPhase(raw), fault).toBe(expectedPhase[fault])
      if (expectedPhase[fault] === undefined) {
        expect(raw, fault).toEqual(baseline)
      } else {
        expect(object(raw)?.family, fault).toBe('no_safe_action')
        expect({ generation: rawState?.generation, target: object(rawState?.material)?.target,
          pendingRef: rawState?.pendingRef, canonicalRef: rawState?.canonicalRef,
          bodyHash: rawState?.bodyHash }).toEqual({
          generation: 1, target: sessionId, pendingRef: rawState?.pendingRef,
          canonicalRef: rawState?.canonicalRef, bodyHash: rawState?.bodyHash,
        })
        expect(rawState?.pendingRef).toMatch(/^pending:[0-9a-f]{64}$/)
        expect(rawState?.canonicalRef).toMatch(/^canonical:no-safe-action:[0-9a-f]{64}$/)
        expect(rawState?.bodyHash).toMatch(/^[0-9a-f]{64}$/)
        const commonKeys = ['body', 'bodyHash', 'c02', 'c06', 'c20', 'c21', 'c22', 'c29',
          'canonicalRef', 'family', 'generation', 'machine', 'material', 'pendingRef', 'phase']
        expect(Object.keys(rawState ?? {}).sort(), fault).toEqual((expectedPhase[fault] === 'pending'
          ? commonKeys
          : [...commonKeys, 'c30', 'c33', 'firstC31', 'firstC32', 'firstReplaceSeq']).sort())
      }
      const canonicalEvents = noSafeCanonical(harness.agent)
      expect(canonicalEvents, fault).toHaveLength(expectedCanonicalCount[fault])
      for (const event of canonicalEvents) {
        if (event.data.source.kind !== 'context-manager-no-safe-action') {
          throw new Error('D observed foreign canonical writer')
        }
        const text = messageText(event.data)
        expect({ pendingRef: event.data.source.pendingStateRef,
          canonicalRef: event.data.source.canonicalStateRef,
          generation: event.data.source.generation, chat: event.data.source.chat,
          bodyHash: event.data.source.bodyHash, machine: event.data.source.machine,
          textHash: text === undefined ? undefined : createHash('sha256').update(text).digest('hex') }, fault)
          .toEqual({ pendingRef: rawState?.pendingRef, canonicalRef: rawState?.canonicalRef,
            generation: rawState?.generation, chat: sessionId, bodyHash: rawState?.bodyHash,
            machine: rawState?.machine, textHash: rawState?.bodyHash })
      }
      if (expectedPhase[fault] === 'current') {
        expect(rawState?.firstReplaceSeq, fault).toBe(canonicalEvents[0]?.seq)
      } else {
        expect(rawState?.firstReplaceSeq, fault).toBeUndefined()
      }
      const counts = eventCounts(harness.agent.session.events)
      expect({ nativeWriter: counts.nativeWriter, checkpoint: counts.checkpoint, route: counts.route,
        compaction: counts.compaction, toolCall: counts.toolCall, toolResult: counts.toolResult }, fault)
        .toEqual({ nativeWriter: 0, checkpoint: 0, route: 0, compaction: 0, toolCall: 0, toolResult: 0 })
      expect(ledger.appends.filter(event => event.source === 'user' && event.committed), fault).toHaveLength(1)
      expect(ledger.flushes.includes(true), fault).toBe(true)
    }
  })

  it('E fails conservatively for exact-existing, duplicate, mismatched, and ambiguous-tail races', async () => {
    for (const race of ['exact-existing', 'duplicate', 'mismatch'] as const) {
      const harness = await fresh(`f09-e-${race}-`)
      await establishFocus(harness)
      const baseline = readRawSidecar(harness.root)
      const flow = installProductionFlow(harness)
      const message = createUserMessage({ content: [{ type: 'text', text: tracer }], source: { kind: 'user' } })
      const errors: string[] = []
      harness.ctx.on('agent/error', ({ agent, error }) => {
        if (agent === harness.agent) errors.push(error instanceof Error ? error.message : String(error))
      })
      harness.adapter.beforeActionOutput = () => {
        flow.actor = 'race'
        const raced = race === 'mismatch'
          ? { ...message, content: [{ type: 'text' as const, text: `${tracer}（污染）` }] }
          : message
        harness.agent.session.append('user/message', raced, { surfaceOp: 'append' })
        if (race === 'duplicate') harness.agent.session.append('user/message', message, { surfaceOp: 'append' })
        flow.actor = 'runtime'
      }
      const before = { action: harness.adapter.actionCalls, root: harness.adapter.rootCalls }
      harness.agent.send(message, 'next-turn', true)
      await harness.agent.whenIdle()
      const production = [...flow.events]
      expect({ action: harness.adapter.actionCalls - before.action, root: harness.adapter.rootCalls - before.root }, race)
        .toEqual({ action: 1, root: 0 })
      expect(errors, race).toHaveLength(1)
      expect(errors[0], race).toBe(race === 'exact-existing' ? stableFailure : 'focus-canary')
      if (race === 'exact-existing') {
        expectProductionDirectProof(flow, production, message, stableFailure, 'reuse')
      } else {
        expect(production.filter(event => event.kind === 'append-committed'
          && event.actor === 'runtime' && event.id === String(message.id)), race).toEqual([])
        expect(production.filter(event => event.kind === 'flush-attempt' || event.kind === 'flush-result'
          || event.kind === 'read-attempt' || event.kind === 'read-result' || event.kind === 'read-error'), race)
          .toEqual([])
        expect(production.filter(event => event.kind === 'presenter'), race)
          .toEqual([{ kind: 'presenter', error: 'focus-canary' }])
      }
      const physical = direct(harness.agent, message.id)
      expect(physical, race).toHaveLength(race === 'duplicate' ? 2 : 1)
      if (race === 'mismatch') {
        expect(messageText(physical[0]!.data)).toBe(`${tracer}（污染）`)
        expect(physical[0]!.data.source).toEqual({ kind: 'user' })
        expect(expressionHash(String(physical[0]!.data.id), messageText(physical[0]!.data) ?? '')).not
          .toBe(expressionHash(String(message.id), tracer))
      } else {
        expect(physical.every(event => messageText(event.data) === tracer
          && event.data.source.kind === 'user')).toBe(true)
      }
      expect(readRawSidecar(harness.root), race).toEqual(baseline)
      expect(noSafeCanonical(harness.agent), race).toHaveLength(0)
      expect(await flow.originalFlush(harness.agent.session), race).toBe(true)
      const chosen = physical[0]!
      const detached = await flow.originalReadFrom(harness.agent.session.id, chosen.seq)
      const exact = detached.events.filter(event => event.seq === chosen.seq
        || event.type === 'user/message' && String(event.data.id) === String(message.id))
      expect(exact, race).toEqual(physical)
      expect(eventCounts(harness.agent.session.events)).toMatchObject({
        noSafeWriter: 0, nativeWriter: 0, checkpoint: 0, route: 0, compaction: 0, toolCall: 0, toolResult: 0,
      })
    }

    for (const pollution of ['extra-direct', 'extra-assistant'] as const) {
      const root = await mkdtemp(join(tmpdir(), `f09-e-${pollution}-`))
      roots.push(root)
      const live = await mount(root)
      await establishFocus(live)
      await send(live.agent, tracer)
      const row = readNoSafeSidecar(root)
      const original = transaction(row)
      if (pollution === 'extra-direct') {
        live.agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: '歧义尾部' }], source: { kind: 'user' },
        }), { surfaceOp: 'append' })
      } else {
        live.agent.session.append('assistant/message', {
          turn: 99, step: 1, message: createAssistantMessage({
            content: [{ type: 'text', text: '额外 assistant 尾部' }],
            source: { provider: 'local-test', model: 'local-test' },
          }),
        }, { surfaceOp: 'append' })
      }
      await dispose(live)
      const beforeRaw = readRawSidecar(root)
      const beforeCanonical = noSafeCanonical(live.agent).map(event => ({ seq: event.seq, id: String(event.data.id) }))
      const spies = installRecoverySpies()
      const cold = await mount(root, true)
      await cold.agent.whenIdle()
      const observations = await recoveryObservations(spies)
      const after = transaction(readNoSafeSidecar(root))
      expect(observations, pollution).toEqual([])
      expect(readRawSidecar(root), pollution).toEqual(beforeRaw)
      expect(after.repair, pollution).toBeUndefined()
      expect({ generation: after.generation, canonicalRef: after.canonicalRef, bodyHash: after.bodyHash }, pollution)
        .toEqual({ generation: original.generation, canonicalRef: original.canonicalRef, bodyHash: original.bodyHash })
      expect(noSafeCanonical(cold.agent).map(event => ({ seq: event.seq, id: String(event.data.id) })), pollution)
        .toEqual(beforeCanonical)
      expect(cold.adapter.requests, pollution).toHaveLength(0)
      const closedFlow = installProductionFlow(cold)
      const beforeEvents = eventCounts(cold.agent.session.events)
      const beforeCalls = { focus: cold.adapter.focusCalls, action: cold.adapter.actionCalls, root: cold.adapter.rootCalls }
      const closedDirect = await send(cold.agent, '身份仍未确定')
      const production = [...closedFlow.events]
      expectProductionDirectProof(closedFlow, production, closedDirect, stableFailure, 'append')
      expect({ focus: cold.adapter.focusCalls - beforeCalls.focus,
        action: cold.adapter.actionCalls - beforeCalls.action,
        root: cold.adapter.rootCalls - beforeCalls.root }, pollution).toEqual({ focus: 0, action: 0, root: 0 })
      expect(readRawSidecar(root), pollution).toEqual(beforeRaw)
      const afterEvents = eventCounts(cold.agent.session.events)
      expect({ noSafeWriter: afterEvents.noSafeWriter - beforeEvents.noSafeWriter,
        nativeWriter: afterEvents.nativeWriter - beforeEvents.nativeWriter,
        checkpoint: afterEvents.checkpoint - beforeEvents.checkpoint,
        route: afterEvents.route - beforeEvents.route,
        compaction: afterEvents.compaction - beforeEvents.compaction,
        toolCall: afterEvents.toolCall - beforeEvents.toolCall,
        toolResult: afterEvents.toolResult - beforeEvents.toolResult }, pollution).toEqual({
        noSafeWriter: 0, nativeWriter: 0, checkpoint: 0, route: 0,
        compaction: 0, toolCall: 0, toolResult: 0,
      })
      let bodyExecutions = 0
      cold.ctx.tools.register(defineContentToolFixture({
        name: 'delete_record', description: 'Delete a selected production record.', parameters: {},
        async execute() { bodyExecutions += 1; return [{ type: 'text', text: 'deleted' }] },
      }))
      const denied = await cold.ctx.tools.execute({
        name: 'delete_record', arguments: {}, callId: CallId(`f09-e-${pollution}`),
        signal: new AbortController().signal, agent: cold.agent,
      })
      expect({ bodyExecutions, denied: denied.isError }, pollution).toEqual({ bodyExecutions: 0, denied: true })
      vi.restoreAllMocks()
    }
  })

  it('F keeps the guard closed across incomplete tool state, cron text, and identity-supply direct input', async () => {
    {
      const root = await mkdtemp(join(tmpdir(), 'f09-f-incomplete-tool-'))
      roots.push(root)
      const live = await mount(root)
      await establishFocus(live)
      let bodyExecutions = 0
      live.ctx.tools.register(defineContentToolFixture({
        name: 'delete_record', description: 'Delete a selected production record.', parameters: {},
        async execute() { bodyExecutions += 1; return [{ type: 'text', text: 'deleted' }] },
      }))
      const append = live.agent.session.append
      let resultFaulted = false
      live.agent.session.append = function incompleteToolResult<Type extends SessionEventType>(
        type: Type,
        data: SessionEventMap[Type],
        ...options: Type extends SurfaceEventType ? [SurfaceIntent] : []
      ): SessionEvent<Type> {
        if (type === 'tool/result' && !resultFaulted) {
          resultFaulted = true
          throw new Error('fault:incomplete-tool-result')
        }
        return Reflect.apply(append, this, [type, data, ...options]) as SessionEvent<Type>
      }
      live.adapter.rootToolAttempt = true
      await send(live.agent, tracer)
      const before = readNoSafeSidecar(root)
      const state = transaction(before)
      expect({ bodyExecutions, toolCall: eventCounts(live.agent.session.events).toolCall,
        toolResult: eventCounts(live.agent.session.events).toolResult }).toEqual({
        bodyExecutions: 0, toolCall: 1, toolResult: 0,
      })
      await dispose(live)
      const cold = await mount(root, true)
      await cold.agent.whenIdle()
      const after = transaction(readNoSafeSidecar(root))
      expect(after.repair).toBeUndefined()
      expect({ generation: after.generation, canonicalRef: after.canonicalRef, bodyHash: after.bodyHash }).toEqual({
        generation: state.generation, canonicalRef: state.canonicalRef, bodyHash: state.bodyHash,
      })
      expect(cold.adapter.requests).toHaveLength(0)
      let coldBodyExecutions = 0
      cold.ctx.tools.register(defineContentToolFixture({
        name: 'delete_record', description: 'Delete a selected production record.', parameters: {},
        async execute() { coldBodyExecutions += 1; return [{ type: 'text', text: 'deleted' }] },
      }))
      const denied = await cold.ctx.tools.execute({
        name: 'delete_record', arguments: {}, callId: CallId('f09-incomplete-cold'),
        signal: new AbortController().signal, agent: cold.agent,
      })
      expect({ coldBodyExecutions, denied: denied.isError }).toEqual({ coldBodyExecutions: 0, denied: true })
    }

    {
      const cron = await fresh('f09-f-cron-')
      await establishFocus(cron)
      await send(cron.agent, tracer)
      const baseline = readNoSafeSidecar(cron.root)
      const beforeCanonical = noSafeCanonical(cron.agent).map(event => ({ seq: event.seq, id: String(event.data.id) }))
      const cronMessage = createUserMessage({
        content: [{ type: 'text', text: tracer }],
        source: { kind: 'plugin', plugin: 'dsh-cron', form: 'notice', summary: 'scheduled request' },
      })
      const before = { action: cron.adapter.actionCalls, root: cron.adapter.rootCalls }
      cron.agent.send(cronMessage, 'next-turn', true)
      await cron.agent.whenIdle()
      expect({ action: cron.adapter.actionCalls - before.action, root: cron.adapter.rootCalls - before.root })
        .toEqual({ action: 0, root: 0 })
      expect(noSafeCanonical(cron.agent).map(event => ({ seq: event.seq, id: String(event.data.id) })))
        .toEqual(beforeCanonical)
      expect(readRawSidecar(cron.root)).toEqual(baseline)
      expect(cron.adapter.requests.some(request => request.messages.some(message => message.id === cronMessage.id))).toBe(false)
      let cronBodyExecutions = 0
      cron.ctx.tools.register(defineContentToolFixture({
        name: 'delete_record', description: 'Delete a selected production record.', parameters: {},
        async execute() { cronBodyExecutions += 1; return [{ type: 'text', text: 'deleted' }] },
      }))
      const denied = await cron.ctx.tools.execute({
        name: 'delete_record', arguments: {}, callId: CallId('f09-cron-guard'),
        signal: new AbortController().signal, agent: cron.agent,
      })
      expect({ cronBodyExecutions, denied: denied.isError }).toEqual({ cronBodyExecutions: 0, denied: true })
    }

    {
      const identity = await fresh('f09-f-identity-')
      await establishFocus(identity)
      await send(identity.agent, tracer)
      const before = readNoSafeSidecar(identity.root)
      const state = transaction(before)
      const canonical = identity.agent.session.deriveMessages()[0]
      if (canonical?.source.kind !== 'context-manager-no-safe-action') throw new Error('identity case lacks no-safe canonical')
      let bodyExecutions = 0
      identity.ctx.tools.register(defineContentToolFixture({
        name: 'delete_record', description: 'Delete a selected production record.', parameters: {},
        async execute() { bodyExecutions += 1; return [{ type: 'text', text: 'deleted' }] },
      }))
      const flow = installProductionFlow(identity)
      const dispatches: GenerateOptions[] = []
      const errors: string[] = []
      identity.adapter.observeRootDispatch = request => dispatches.push(request)
      identity.adapter.rootToolAttempt = true
      identity.ctx.on('agent/error', ({ agent, error }) => {
        if (agent === identity.agent) errors.push(error instanceof Error ? error.message : String(error))
      })
      const rootBefore = identity.adapter.rootCalls
      const supplied = await send(identity.agent, '目标记录是 record-42')
      const production = [...flow.events]
      expect(identity.adapter.rootCalls - rootBefore).toBe(0)
      expect(dispatches).toHaveLength(0)
      expect(errors).toEqual([stableFailure])
      expectProductionDirectProof(flow, production, supplied, stableFailure, 'append')
      expect(direct(identity.agent, supplied.id).map(event => event.data)).toEqual([supplied])
      const denied = await identity.ctx.tools.execute({
        name: 'delete_record', arguments: {}, callId: CallId('f09-identity-guard'),
        signal: new AbortController().signal, agent: identity.agent,
      })
      expect({ bodyExecutions, denied: denied.isError }).toEqual({ bodyExecutions: 0, denied: true })
      expect(eventCounts(identity.agent.session.events)).toMatchObject({ toolCall: 0, toolResult: 0 })
      const after = readNoSafeSidecar(identity.root)
      expect(after).toEqual(before)
      expect(transaction(after)).toMatchObject({
        phase: 'finalized', generation: state.generation, canonicalRef: state.canonicalRef, bodyHash: state.bodyHash,
      })
      expect(JSON.stringify(assistants(identity.agent).slice(-1))).not
        .toMatch(/已补全|迁移完成|guard.*释放|已经删除/)
    }
  })
})
