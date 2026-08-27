import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
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
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import WebRuntime, {
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
} from '@deepseek-ai/dsh-web'
import * as ContextManager from '../src/index.ts'
import {
  ActionFactBoundaryAuthority,
  type ActionFactBoundary,
  type ActionableFactMeaning,
  type ActionRef,
  type C20Result,
  type C21Result,
  type C22Result,
  type CompletedEvidenceActionFactBoundary,
  type CompletedSingleEvidenceActionableBoundary,
  type EvidenceSourceRef,
  type FactAffectedScope,
  type FactNeedSet,
  type FactNeedSetRef,
  type FactRef,
  type UncertaintyMeaning,
} from '../src/action-boundary.ts'
import {
  EvidenceResolution,
  bindExpectedFactNeedOwner,
  issueOwnerBoundFactNeedSet,
  type BoundedEvidenceProposalRequest,
  type EvidenceResolutionOutcome,
  type EvidenceResolutionResult,
} from '../src/fact-resolution.ts'
import {
  FocusAuthority,
  UserInteractionAdvice as FocusUserInteractionAdvice,
  createExplicitUserExpression,
  type ChatRef,
  type FocusDecision,
  type FocusProposalOutcome,
} from '../src/focus.ts'
import {
  LocalRestrictionAdapter,
  UserInteractionAdvice,
} from '../src/local-restriction.ts'
import { ManagedAwareBasicCompactionEngine } from '../src/managed-compaction.ts'
import { ManagedFailurePresenter } from '../src/managed-failure.ts'
import {
  createBoundedActionFactNeedProposalRequest,
  type BoundedActionFactNeedProposal,
  type BoundedActionFactNeedProposalOutcome,
} from '../src/managed-runtime.ts'
import {
  CanonicalContextAuthority,
  CanonicalStateTransaction,
  EffectiveStatePreservation,
  UniqueVisibleContextReplacement,
  parseCanonicalLocalRestrictionStateRecord,
  parseCanonicalNoSafeActionStateRecord,
} from '../src/state-transaction.ts'

const contexts: Context[] = []
const roots: string[] = []
const sessionId = ContextManager.FOCUS_CANARY_IDS[0]
const foreignSessionId = ContextManager.FOCUS_CANARY_IDS[1]
const focusTracer = '准备升级 DeepSeek Harness'
const factTracer = '查一下 DeepSeek Harness 当前最新版本；确认后再决定是否升级。'
const privateQuery = 'DeepSeek Harness latest version'
const releaseUrl = 'https://example.test/deepseek-harness/releases/latest'
const publishedAt = '2026-08-25T09:30:00.000Z'
const releaseContent = 'DeepSeek Harness 当前最新稳定版本为 1.4.2。'
const stableFailure = '唯一背景未能安全换入，本轮未继续行动'
const noSafeToolDenial = '当前请求没有可安全执行的行动，工具未执行。'

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

function toolChunks(id: string, name: string): StreamChunk[] {
  const callId = CallId(id)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function hasSchema(options: GenerateOptions, plugin: string): boolean {
  return options.messages.some(message => message.source.kind === 'plugin'
    && message.source.plugin === plugin)
}

function messageText(message: UserMessage): string | undefined {
  return message.content.length === 1 && message.content[0]?.type === 'text'
    ? message.content[0].text : undefined
}

function requestText(options: GenerateOptions): string {
  return options.messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isSingleEvidenceResolutionOutcome(
  outcome: EvidenceResolutionResult,
): outcome is EvidenceResolutionOutcome {
  const raw = object(outcome)
  return raw !== undefined
    && !('kind' in raw)
    && Object.keys(raw).length === 6
    && ['c11', 'request', 'c12', 'conclusions', 'material', 'provenance']
      .every(key => key in raw)
}

function isSingleEvidenceActionableCompletion(
  completion: CompletedEvidenceActionFactBoundary,
): completion is CompletedSingleEvidenceActionableBoundary {
  return completion.family === 'actionable'
    && !('kind' in completion)
    && 'provenance' in completion
}

function directHash(id: string, text: string): string {
  return createHash('sha256').update(id).update('\0').update(text).digest('hex')
}

function sourceRef(url: string): string {
  return `web-source:${createHash('sha256').update(url).digest('hex')}`
}

const singleActionProposal = JSON.stringify({
  actions: ['升级 DeepSeek Harness'],
  proposedRequirements: [{ fact: 'DeepSeek Harness 最新版本', neededFor: ['升级 DeepSeek Harness'] }],
  usableInputs: [],
  unresolvedInputs: [{
    fact: 'DeepSeek Harness 最新版本',
    meaning: '当前最新版本尚未核清',
    source: 'direct-user',
    degree: 'unknown',
    affected: '升级 DeepSeek Harness',
  }],
})

const twoActionProposal = JSON.stringify({
  actions: ['升级 DeepSeek Harness', '列出已确认的只读升级前检查'],
  proposedRequirements: [{ fact: 'DeepSeek Harness 最新版本', neededFor: ['升级 DeepSeek Harness'] }],
  usableInputs: [],
  unresolvedInputs: [{
    fact: 'DeepSeek Harness 最新版本',
    meaning: '当前最新版本尚未核清',
    source: 'direct-user',
    degree: 'unknown',
    affected: '升级 DeepSeek Harness',
  }],
})

type AdapterMode = 'single' | 'two'
type EvidenceConclusionMode = 'direct-fact' | 'unresolved'
type EvidenceProviderFailure = 'none' | 'focus' | 'action' | 'evidence' | 'root'
type EvidenceFinish = 'stop' | 'length' | 'tool-call'
type EvidenceIdentityFault = 'none' | 'source' | 'request' | 'material' | 'factNeeds'

class EvidenceAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly rootRequests: GenerateOptions[] = []
  focusCalls = 0
  actionCalls = 0
  evidenceCalls = 0
  rootCalls = 0
  mode: AdapterMode = 'single'
  failure: EvidenceProviderFailure = 'none'
  focusOutput = JSON.stringify({ kind: 'focus', subject: focusTracer, relation: 'new' })
  actionOutput: string | undefined
  evidenceOutput: string | undefined
  evidenceConclusionMode: EvidenceConclusionMode = 'direct-fact'
  evidenceIdentityFault: EvidenceIdentityFault = 'none'
  rootToolAttempt = false
  evidenceFinish: EvidenceFinish = 'stop'
  evidenceDelayMs = 0
  contextWindow = 16_384
  onDispatch: ((kind: 'focus' | 'action' | 'evidence' | 'root', options: GenerateOptions) => void) | undefined

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.contextWindow } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (hasSchema(options, 'ui-context-compactor:focus-canary-schema')) {
      this.focusCalls += 1
      this.onDispatch?.('focus', options)
      if (this.failure === 'focus') throw new Error('focus provider failure')
      yield* textChunks(this.focusOutput)
      return
    }
    if (hasSchema(options, 'ui-context-compactor:action-fact-need-schema')) {
      this.actionCalls += 1
      this.onDispatch?.('action', options)
      if (this.failure === 'action') throw new Error('action provider failure')
      yield* textChunks(this.actionOutput ?? (this.mode === 'single' ? singleActionProposal : twoActionProposal))
      return
    }
    if (hasSchema(options, 'ui-context-compactor:evidence-schema')) {
      this.evidenceCalls += 1
      this.onDispatch?.('evidence', options)
      if (this.failure === 'evidence') throw new Error('evidence provider failure')
      const projection = object(JSON.parse(requestText(options.messages[1] === undefined
        ? options
        : { ...options, messages: [options.messages[1]] })))
      const material = object(projection?.material)
      const source = this.evidenceIdentityFault === 'source' ? 'foreign-source' : material?.source
      const request = this.evidenceIdentityFault === 'request' ? 'foreign-request' : projection?.request
      const materialRef = this.evidenceIdentityFault === 'material' ? 'foreign-material' : material?.ref
      const factNeeds = this.evidenceIdentityFault === 'factNeeds' ? 'foreign-needs' : projection?.factNeeds
      const output = this.evidenceOutput ?? JSON.stringify(this.evidenceConclusionMode === 'direct-fact'
        ? {
            kind: 'direct_fact',
            fact: projection?.fact,
            meaning: 'DeepSeek Harness 当前最新稳定版本为 1.4.2',
            source,
            degree: 'established',
            request,
            material: materialRef,
            factNeeds,
          }
        : {
            kind: 'unresolved',
            fact: projection?.fact,
            meaning: '版本证据仍不足，不能安全升级',
            source,
            degree: 'insufficient',
            affected: projection?.affected,
            request,
            material: materialRef,
            factNeeds,
          })
      if (this.evidenceDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.evidenceDelayMs))
      if (this.evidenceFinish === 'length') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      }
      if (this.evidenceFinish === 'tool-call') {
        yield* toolChunks('f03-evidence-tool', 'upgrade_probe')
        return
      }
      yield* textChunks(output)
      return
    }
    this.rootCalls += 1
    this.rootRequests.push(options)
    this.onDispatch?.('root', options)
    if (this.failure === 'root') throw new Error('root provider failure')
    if (this.rootToolAttempt) {
      this.rootToolAttempt = false
      yield* toolChunks(`f03-root-tool-${this.rootCalls}`, 'upgrade_probe')
      return
    }
    yield* textChunks('已核清最新版本；等待你决定是否升级。')
  }
}

interface Table {
  get(key: string): unknown
  put(key: string, value: unknown): Promise<void>
}

interface Domain {
  table(name: string): Table
}

type ProductionEvent =
  | { readonly kind: 'abort-injected'; readonly stage: 'postcommit' }
  | { readonly kind: 'provider'; readonly role: 'focus' | 'action' | 'evidence' | 'root'; readonly request: GenerateOptions }
  | { readonly kind: 'search'; readonly request: WebSearchRequest; readonly result?: WebSearchResult; readonly error?: string }
  | { readonly kind: 'append'; readonly type: string; readonly source?: string; readonly id?: string; readonly text?: string; readonly seq?: number }
  | { readonly kind: 'flush'; readonly result: boolean }
  | { readonly kind: 'read'; readonly session: string; readonly fromSeq: number;
      readonly eventTypes: readonly string[]; readonly events: readonly ReadObservation[] }
  | { readonly kind: 'sidecar'; readonly value: unknown; readonly family?: string; readonly phase?: string }
  | { readonly kind: 'state'; readonly receiver: 'C20'; readonly report: C20Result }
  | { readonly kind: 'state'; readonly receiver: 'C21'; readonly report: C21Result }
  | { readonly kind: 'presenter'; readonly receiver: 'C22'; readonly report: C22Result }
  | { readonly kind: 'evidence'; readonly receiver: 'C11-C12'; readonly outcome: EvidenceResolutionOutcome | undefined }
  | { readonly kind: 'agent-error'; readonly message: string }

interface FrozenProductionLedger {
  readonly events: readonly ProductionEvent[]
  readonly fullSessionEvents: readonly SessionEvent[]
  readonly surfaceMessages: readonly UserMessage[]
}

interface ReadObservation {
  readonly seq: number
  readonly type: string
  readonly id?: string
  readonly source?: string
  readonly text?: string
  readonly hash?: string
}

interface SearchController {
  available: boolean
  result: WebSearchResult
  error: Error | undefined
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: EvidenceAdapter
  readonly domain: Domain
  readonly root: string
  readonly productionEvents: ProductionEvent[]
  readonly search: SearchController
  readonly sidecarHooks: { afterCommit: ((value: unknown) => void) | undefined }
}

interface MountOptions {
  readonly resume?: boolean
  readonly targetSession?: string
  readonly timeoutMs?: number
}

function installReceiverLedger(events: ProductionEvent[], afterPresenter?: () => void): void {
  const originalC20 = EffectiveStatePreservation.prototype.acceptActionBoundaryToPreserve
  vi.spyOn(EffectiveStatePreservation.prototype, 'acceptActionBoundaryToPreserve')
    .mockImplementation(function (this: EffectiveStatePreservation, boundary) {
      const report = originalC20.call(this, boundary)
      events.push({ kind: 'state', receiver: 'C20', report })
      return report
    })
  const originalC21 = CanonicalContextAuthority.prototype.acceptActionSafetyBoundary
  vi.spyOn(CanonicalContextAuthority.prototype, 'acceptActionSafetyBoundary')
    .mockImplementation(function (this: CanonicalContextAuthority, boundary) {
      const report = originalC21.call(this, boundary)
      events.push({ kind: 'state', receiver: 'C21', report })
      return report
    })
  const originalC22 = UserInteractionAdvice.prototype.acceptFactDecisionNeeds
  vi.spyOn(UserInteractionAdvice.prototype, 'acceptFactDecisionNeeds')
    .mockImplementation(function (this: UserInteractionAdvice, boundary) {
      const report = originalC22.call(this, boundary)
      events.push({ kind: 'presenter', receiver: 'C22', report })
      afterPresenter?.()
      return report
    })
  const originalEvidence = EvidenceResolution.prototype.acceptFactNeeds
  vi.spyOn(EvidenceResolution.prototype, 'acceptFactNeeds')
    .mockImplementation(async function (this: EvidenceResolution, needs, signal) {
      const outcome = await originalEvidence.call(this, needs, signal)
      if (outcome !== undefined && !isSingleEvidenceResolutionOutcome(outcome)) {
        throw new Error('multi-fact outcome entered the frozen T1 receiver ledger')
      }
      events.push({ kind: 'evidence', receiver: 'C11-C12', outcome })
      return outcome
    })
}

function installRecoverySpies() {
  return {
    c34: vi.spyOn(EffectiveStatePreservation.prototype, 'acceptStoredStateReadout'),
    c35: vi.spyOn(FocusAuthority.prototype, 'acceptRestoredFocusFact'),
    c36: vi.spyOn(ActionFactBoundaryAuthority.prototype, 'acceptRestoredActionBoundary'),
    c30: vi.spyOn(EffectiveStatePreservation.prototype, 'establishRetainedRecoverablePreservation'),
    c31: vi.spyOn(UniqueVisibleContextReplacement.prototype, 'replaceVisibleContext'),
    c37: vi.spyOn(CanonicalContextAuthority.prototype, 'acceptCanonicalRestoration'),
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function observeReadEvent(event: SessionEvent): ReadObservation {
  if (event.type !== 'user/message') return { seq: event.seq, type: event.type }
  const text = messageText(event.data)
  return {
    seq: event.seq,
    type: event.type,
    id: String(event.data.id),
    source: event.data.source.kind,
    ...text === undefined ? {} : { text, hash: directHash(String(event.data.id), text) },
  }
}

function exactWebResult(): WebSearchResult {
  return {
    content: 'provider answer must not outrank the source snippet',
    sources: [{ url: releaseUrl, snippet: releaseContent, publishedAt }],
    truncated: false,
  }
}

async function mount(root: string, options: MountOptions = {}): Promise<Harness> {
  const resume = options.resume ?? false
  const targetSession = options.targetSession ?? sessionId
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
    auto: true,
    thresholdRatio: .99,
    retainRatio: .1,
    managedRuntime,
  })
  await ctx.plugin(commandCompact)
  await ctx.plugin(WebRuntime, { searchProvider: 'f03-test-search' })
  const productionEvents: ProductionEvent[] = []
  const search: SearchController = { available: true, result: exactWebResult(), error: undefined }
  const provider: WebSearchProvider = {
    id: 'f03-test-search',
    available: () => search.available,
    search: async request => {
      if (search.error !== undefined) {
        productionEvents.push({ kind: 'search', request, error: search.error.message })
        throw search.error
      }
      productionEvents.push({ kind: 'search', request, result: search.result })
      return search.result
    },
  }
  ctx.web.registerSearchProvider(provider)
  const adapter = new EvidenceAdapter()
  adapter.onDispatch = (role, request) => productionEvents.push({ kind: 'provider', role, request })
  ctx.llm.registerAdapter(['f03-test'], adapter)
  let domain: Domain | undefined
  const facility: { open(spec: unknown): Promise<Domain> } = ctx.storageDomain
  const open = facility.open.bind(facility)
  facility.open = async spec => domain = await open(spec)

  await ctx.plugin(ContextManager, {
    focusCanary: {
      ...managedRuntime,
      auxiliary: {
        provider: 'f03-test',
        model: 'f03-test',
        maxOutputTokens: 256,
        timeoutMs: options.timeoutMs ?? 500,
        maxExpressionChars: 240,
        maxProjectionTokens: 2_048,
        safetyMarginTokens: 128,
      },
    },
    nativeWriterArbitration: { mode: 'enforce' },
    evidenceCanary: { mode: 'enforce' },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (domain === undefined) throw new Error('missing context-manager domain')
  const sidecarHooks: Harness['sidecarHooks'] = { afterCommit: undefined }
  const table = domain.table('focus_precanonical')
  const put = table.put.bind(table)
  table.put = async (key, value) => {
    const raw = object(value)
    const transaction = object(raw?.transaction)
    productionEvents.push({
      kind: 'sidecar',
      value,
      ...(typeof raw?.family === 'string' ? { family: raw.family } : {}),
      ...(typeof transaction?.phase === 'string' ? { phase: transaction.phase } : {}),
    })
    await put(key, value)
    sidecarHooks.afterCommit?.(value)
  }
  ctx.on('session/event', (subject, event) => {
    if (String(subject.id) !== targetSession) return
    const candidate = event.type === 'user/message' ? event.data : undefined
    const text = candidate === undefined ? undefined : messageText(candidate)
    productionEvents.push({
      kind: 'append',
      type: event.type,
      seq: event.seq,
      ...(candidate === undefined ? {} : { source: candidate.source.kind, id: String(candidate.id) }),
      ...(text === undefined ? {} : { text }),
    })
  })
  const agent = resume
    ? (await ctx.agents.resume({
        resumeSessionId: SessionId(targetSession),
        agentOptions: { provider: 'f03-test', model: 'f03-test' },
      })).agent
    : ctx.agentLoop.create(SessionId(targetSession), { provider: 'f03-test', model: 'f03-test' })

  const flush = ctx.sessions.flush.bind(ctx.sessions)
  ctx.sessions.flush = async session => {
    const result = await flush(session)
    productionEvents.push({ kind: 'flush', result })
    return result
  }
  const readFrom = ctx.sessionPersistence.readFrom.bind(ctx.sessionPersistence)
  ctx.sessionPersistence.readFrom = async (id, fromSeq) => {
    const result = await readFrom(id, fromSeq)
    productionEvents.push({
      kind: 'read',
      session: id,
      fromSeq,
      eventTypes: Object.freeze(result.events.map(event => event.type)),
      events: Object.freeze(result.events.map(observeReadEvent)),
    })
    return result
  }
  ctx.on('agent/error', ({ agent: subject, error }) => {
    if (subject === agent) productionEvents.push({ kind: 'agent-error', message: errorText(error) })
  })
  return { ctx, agent, adapter, domain, root, productionEvents, search, sidecarHooks }
}

async function fresh(prefix: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return await mount(root)
}

async function freshWith(prefix: string, options: MountOptions): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return await mount(root, options)
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

async function establishFocus(harness: Harness): Promise<UserMessage> {
  const message = await send(harness.agent, focusTracer)
  expect(harness.adapter.focusCalls).toBe(1)
  expect(harness.adapter.rootCalls).toBe(1)
  return message
}

function freezeProductionLedger(harness: Harness): FrozenProductionLedger {
  return Object.freeze({
    events: Object.freeze([...harness.productionEvents]),
    fullSessionEvents: Object.freeze([...harness.agent.session.events]),
    surfaceMessages: Object.freeze(harness.agent.session.deriveMessages()
      .filter((message): message is UserMessage => message.role === 'user')),
  })
}

function directEvents(events: readonly SessionEvent[], id?: string): SessionEvent<'user/message'>[] {
  return events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message'
    && event.data.source.kind === 'user'
    && (id === undefined || String(event.data.id) === id))
}

function userMessages(events: readonly SessionEvent[], sourceKind: string): SessionEvent<'user/message'>[] {
  return events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message'
    && event.data.source.kind === sourceKind)
}

function assistantEvents(events: readonly SessionEvent[]): SessionEvent<'assistant/message'>[] {
  return events.filter((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')
}

function latestSidecar(ledger: FrozenProductionLedger): unknown {
  return ledger.events.filter((event): event is Extract<ProductionEvent, { readonly kind: 'sidecar' }> =>
    event.kind === 'sidecar').at(-1)?.value
}

function providerCounts(harness: Harness): { readonly focus: number; readonly action: number; readonly evidence: number; readonly root: number } {
  return {
    focus: harness.adapter.focusCalls,
    action: harness.adapter.actionCalls,
    evidence: harness.adapter.evidenceCalls,
    root: harness.adapter.rootCalls,
  }
}

async function expectColdNoSafe(root: string): Promise<void> {
  vi.restoreAllMocks()
  const cold = await mount(root, { resume: true })
  await cold.agent.whenIdle()
  let executions = 0
  cold.ctx.tools.register(defineContentToolFixture({
    name: 'upgrade_probe', description: 'Attempt the version-dependent upgrade.', parameters: {},
    async execute() { executions += 1; return [{ type: 'text', text: 'executed' }] },
  }))
  const result = await cold.ctx.tools.execute({
    name: 'upgrade_probe', arguments: {}, callId: CallId('f03-cold-no-safe'),
    signal: new AbortController().signal, agent: cold.agent,
  })
  expect(executions).toBe(0)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain(noSafeToolDenial.slice(0, 12))
  expect(cold.adapter.requests).toHaveLength(0)
  await dispose(cold)
}

function rootProjection(request: GenerateOptions): string {
  return requestText(request)
}

type EstablishedFocus = Extract<FocusDecision, { readonly kind: 'focus_established' }>

function createPublicEstablishedFocus(chat: ChatRef, seed: string): {
  readonly authority: FocusAuthority
  readonly focus: EstablishedFocus
} {
  const authority = FocusAuthority.createOwner()
  const origin = Object.freeze({
    messageId: `f03-public-focus-${seed}`,
    hash: directHash(`f03-public-focus-${seed}`, focusTracer),
  })
  const expression = createExplicitUserExpression(focusTracer, chat, origin)
  const proposal: FocusProposalOutcome = Object.freeze({
    kind: 'proposal',
    origin,
    value: Object.freeze({ kind: 'focus', subject: focusTracer, relation: 'new', origin }),
  })
  const c01 = authority.fromBoundProposal(proposal).decideFocus(expression)
  if (c01.kind !== 'business_result' || c01.value.kind !== 'focus_established') {
    throw new Error('public C01 did not establish the exact F03 focus')
  }
  const c08 = new FocusUserInteractionAdvice().acceptMatterRelation(c01.value)
  if (c08.kind !== 'business_result' || c08.value.kind !== 'accepted_for_contract'
    || c08.value.value !== c01.value) throw new Error('public C08 did not accept the exact F03 focus')
  return Object.freeze({ authority, focus: c08.value.value })
}

function publicFactNeeds(chat: ChatRef, suffix: string): FactNeedSet {
  const action = '升级 DeepSeek Harness' as ActionRef
  const requirement = Object.freeze({
    fact: 'DeepSeek Harness 最新版本' as FactRef,
    neededFor: Object.freeze([action] as const),
  })
  return Object.freeze({
    ref: `fact-needs:public-${suffix}` as FactNeedSetRef,
    chat,
    requirements: Object.freeze([requirement]),
  })
}

function formPublicActionProposal(
  harness: Harness,
  composition: ReturnType<typeof ActionFactBoundaryAuthority.createComposition>,
  focusAuthority: FocusAuthority,
  focus: EstablishedFocus,
  suffix: string,
) {
  const direct = createUserMessage({
    content: [{ type: 'text', text: factTracer }],
    source: { kind: 'user' },
  })
  const claimed = composition.claimedStructuredDirectIssuer.issue(harness.agent.session, focus.chat, direct)
  if (claimed === undefined) throw new Error(`public direct claim failed for ${suffix}`)
  const origin = Object.freeze({ messageId: String(direct.id), hash: directHash(String(direct.id), factTracer) })
  const expression = createExplicitUserExpression(factTracer, focus.chat, origin)
  const request = createBoundedActionFactNeedProposalRequest(expression, origin, focus)
  if (request === undefined) throw new Error(`public action request failed for ${suffix}`)
  const action = '升级 DeepSeek Harness' as ActionRef
  const fact = 'DeepSeek Harness 最新版本' as FactRef
  const actions = Object.freeze([action] as const)
  const value: BoundedActionFactNeedProposal = Object.freeze({
    origin: request.origin,
    focus: request.focus.ref,
    actions,
    proposedRequirements: Object.freeze([
      Object.freeze({ fact, neededFor: actions }),
    ]),
    usableInputs: Object.freeze([]),
    unresolvedInputs: Object.freeze([
      Object.freeze({
        fact,
        meaning: '当前最新版本尚未核清' as UncertaintyMeaning,
        source: 'direct-user' as EvidenceSourceRef,
        degree: 'unknown' as const,
        affected: 'actions:升级 DeepSeek Harness' as FactAffectedScope,
      }),
    ]),
  })
  const outcome: BoundedActionFactNeedProposalOutcome = Object.freeze({
    kind: 'proposal', origin: request.origin, focus: request.focus.ref, value,
  })
  const adapter = new LocalRestrictionAdapter({
    focus: focusAuthority,
    actionBoundaryOwner: composition.authority,
    completeActionBoundary: composition.completeLocalRestrictionBoundary,
    stateTransaction: new CanonicalStateTransaction(),
  })
  const proposal = adapter.formActionBoundaryProposal(focus, outcome, claimed)
  if (proposal === undefined) throw new Error(`real adapter proposal failed for ${suffix}`)
  return Object.freeze({ direct, proposal })
}

function publicReceiverProjection(ledger: FrozenProductionLedger): readonly object[] {
  const projection: object[] = []
  for (const event of ledger.events) {
    if (event.kind === 'state' || event.kind === 'presenter') projection.push(event.report)
    if (event.kind === 'evidence' && event.outcome !== undefined) projection.push({
      c11: event.outcome.c11,
      c12: event.outcome.c12,
      conclusions: event.outcome.conclusions,
      provenance: event.outcome.provenance,
    })
  }
  return Object.freeze(projection)
}

function canonicalFamilyHistory(events: readonly SessionEvent[]): readonly SessionEvent<'user/message'>[] {
  return events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message'
    && (event.data.source.kind === 'context-manager-local-restriction'
      || event.data.source.kind === 'context-manager-no-safe-action'))
}

function canonicalStatePhaseEvents(events: readonly SessionEvent[]): readonly SessionEvent<'user/message'>[] {
  return canonicalFamilyHistory(events).filter(event => {
    const phase = object(event.data.source)?.phase
    return phase === 'pending' || phase === 'current' || phase === 'finalized'
      || phase === 'repair_pending' || phase === 'repair_finalized'
  })
}

describe('F03-T1 one external fact through the public Telegram Agent lifecycle', () => {
  it('P1 resolves one DirectFact through one bounded search and projects only signed provenance plus the exact safe scope', async () => {
    const harness = await fresh('f03-p1-')
    await establishFocus(harness)
    installReceiverLedger(harness.productionEvents)
    const factMessage = await send(harness.agent, factTracer)
    const ledger = freezeProductionLedger(harness)

    expect(harness.adapter.actionCalls).toBe(1)
    expect(harness.adapter.evidenceCalls).toBe(1)
    expect(harness.adapter.rootCalls).toBe(2)
    const evidenceRequest = harness.adapter.requests.find(request =>
      hasSchema(request, 'ui-context-compactor:evidence-schema'))
    expect(evidenceRequest?.reasoningEffort).toBeUndefined()
    expect(ledger.events.filter(event => event.kind === 'search')).toEqual([expect.objectContaining({
      kind: 'search', request: { query: privateQuery, maxResults: 1 }, result: exactWebResult(),
    })])
    const evidenceEvents = ledger.events.filter((event): event is Extract<ProductionEvent, { readonly kind: 'evidence' }> =>
      event.kind === 'evidence')
    expect(evidenceEvents).toHaveLength(1)
    const evidence = evidenceEvents[0]?.outcome
    if (evidence === undefined || evidence.c11.kind !== 'business_result'
      || evidence.c12.kind !== 'business_result' || evidence.material === undefined) {
      throw new Error('missing direct evidence outcome')
    }
    expect(evidence.c11).toStrictEqual({
      kind: 'business_result',
      identity: {
        contract: 'C11', call: evidence.c11.identity.call, subject: evidence.c11.identity.subject,
      },
      value: { kind: 'accepted_for_contract', value: evidence.c11.value.value },
    })
    expect(evidence.c12).toStrictEqual({
      kind: 'business_result',
      identity: { contract: 'C12', call: evidence.c12.identity.call, subject: evidence.request.ref },
      value: {
        request: evidence.request.ref,
        actualMaterials: [evidence.material.ref],
        sources: [sourceRef(releaseUrl)],
        observedGaps: [],
        observedConflicts: [],
      },
    })
    const exactConclusion = Object.freeze({
      kind: 'direct_fact' as const,
      fact: 'DeepSeek Harness 最新版本',
      meaning: 'DeepSeek Harness 当前最新稳定版本为 1.4.2',
      source: sourceRef(releaseUrl),
      degree: 'established' as const,
    })
    expect(Number.isFinite(Date.parse(evidence.provenance.observedAt ?? ''))).toBe(true)
    expect(evidence.provenance).toStrictEqual({
      conclusion: exactConclusion,
      source: sourceRef(releaseUrl),
      url: releaseUrl,
      observedAt: evidence.provenance.observedAt,
      publishedAt,
    })
    expect(evidence.conclusions).toStrictEqual({
      ref: evidence.conclusions.ref,
      chat: sessionId,
      conclusions: [exactConclusion],
    })
    const c20Events = ledger.events.filter(
      (event): event is Extract<ProductionEvent, { readonly kind: 'state'; readonly receiver: 'C20' }> =>
        event.kind === 'state' && event.receiver === 'C20',
    )
    const c21Events = ledger.events.filter(
      (event): event is Extract<ProductionEvent, { readonly kind: 'state'; readonly receiver: 'C21' }> =>
        event.kind === 'state' && event.receiver === 'C21',
    )
    expect(c20Events).toHaveLength(1)
    expect(c21Events).toHaveLength(1)
    const presenterEvents = ledger.events.filter((event): event is Extract<ProductionEvent, { readonly kind: 'presenter' }> =>
      event.kind === 'presenter')
    expect(presenterEvents).toHaveLength(1)
    const c22Report = presenterEvents[0]?.report
    if (c22Report?.kind !== 'business_result'
      || c20Events[0]?.report.kind !== 'business_result'
      || c21Events[0]?.report.kind !== 'business_result') throw new Error('missing exact accepted boundary reports')
    const boundary = c22Report.value.value
    expect(c22Report).toStrictEqual({
      kind: 'business_result',
      identity: { contract: 'C22', call: c22Report.identity.call, subject: boundary.ref },
      value: { kind: 'accepted_for_contract', value: boundary },
    })
    expect(c20Events[0].report).toStrictEqual({
      kind: 'business_result',
      identity: { contract: 'C20', call: c20Events[0].report.identity.call, subject: boundary.ref },
      value: { kind: 'accepted_for_contract', value: boundary },
    })
    expect(c21Events[0].report).toStrictEqual({
      kind: 'business_result',
      identity: { contract: 'C21', call: c21Events[0].report.identity.call, subject: boundary.ref },
      value: { kind: 'accepted_for_contract', value: boundary },
    })
    expect(boundary).toStrictEqual({
      ref: boundary.ref,
      chat: sessionId,
      requiredFacts: boundary.requiredFacts,
      usableFacts: [exactConclusion],
      unresolvedFacts: [],
      kind: 'actionable',
      preciselyBlockedActions: [],
      safelyContinuableActions: ['升级 DeepSeek Harness'],
    })
    const projection = rootProjection(harness.adapter.rootRequests.at(-1)!)
    expect(projection).toContain(`url: ${releaseUrl}`)
    expect(projection).toContain(`observedAt: ${evidence.provenance.observedAt}`)
    expect(projection).toContain(`publishedAt: ${publishedAt}`)
    expect(projection).toContain('safeActions: 升级 DeepSeek Harness')
    const safeLedger = JSON.stringify(publicReceiverProjection(ledger))
    const surface = JSON.stringify(ledger.surfaceMessages)
    for (const visible of [safeLedger, projection, surface]) {
      expect(visible).not.toContain(privateQuery)
      expect(visible).not.toContain(releaseContent)
      expect(visible).not.toContain(exactWebResult().content)
      expect(visible).not.toContain('"raw":')
      expect(visible).not.toContain('"query":')
      expect(visible).not.toContain('"material":{')
      expect(visible).not.toContain('"request":{')
    }
    expect(projection).not.toContain('evidence-material:')
    expect(projection).not.toContain('evidence-request:')
    expect(surface).not.toContain('evidence-material:')
    expect(surface).not.toContain('evidence-request:')
    expect(directEvents(ledger.fullSessionEvents, String(factMessage.id))).toHaveLength(1)
    expect(userMessages(ledger.fullSessionEvents, 'ui-context-compactor:evidence-actionable')).toHaveLength(0)
    expect(userMessages(ledger.fullSessionEvents, 'context-manager-local-restriction')).toHaveLength(0)
    expect(userMessages(ledger.fullSessionEvents, 'context-manager-no-safe-action')).toHaveLength(0)
    expect(ledger.fullSessionEvents.filter(event => event.type === 'assistant/message')).toHaveLength(2)
  })

  it('P2 table-drives mechanically unavailable evidence into one finalized F09 state before one root dispatch and cold-recovers its denial', async () => {
    const variants: readonly {
      readonly name: string
      readonly configure: (harness: Harness) => void
    }[] = [
      { name: 'unavailable', configure: harness => { harness.search.available = false } },
      { name: 'throw', configure: harness => { harness.search.error = new Error('search failed') } },
      { name: 'empty', configure: harness => { harness.search.result = { sources: [], truncated: false } } },
      { name: 'url-only', configure: harness => {
        harness.search.result = { sources: [{ url: releaseUrl }], truncated: false }
      } },
    ]
    for (const variant of variants) {
      const harness = await fresh(`f03-p2-${variant.name}-`)
      await establishFocus(harness)
      installReceiverLedger(harness.productionEvents)
      variant.configure(harness)
      let executions = 0
      harness.ctx.tools.register(defineContentToolFixture({
        name: 'upgrade_probe', description: 'Attempt the version-dependent upgrade.', parameters: {},
        async execute() { executions += 1; return [{ type: 'text', text: 'executed' }] },
      }))
      const before = providerCounts(harness)
      const direct = await send(harness.agent, factTracer)
      const result = await harness.ctx.tools.execute({
        name: 'upgrade_probe', arguments: {}, callId: CallId(`f03-p2-${variant.name}`),
        signal: new AbortController().signal, agent: harness.agent,
      })
      const ledger = freezeProductionLedger(harness)
      expect(providerCounts(harness)).toEqual({
        focus: before.focus,
        action: before.action + 1,
        evidence: before.evidence,
        root: before.root + 1,
      })
      expect(executions).toBe(0)
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain(noSafeToolDenial.slice(0, 12))
      const noSafe = parseCanonicalNoSafeActionStateRecord(latestSidecar(ledger))
      expect(noSafe?.transaction?.phase).toBe('finalized')
      expect(noSafe?.transaction?.material.canonicalState.boundary).toMatchObject({
        kind: 'no_safe_action',
        usableFacts: [],
        unresolvedFacts: [{ fact: 'DeepSeek Harness 最新版本' }],
        preciselyBlockedActions: ['升级 DeepSeek Harness'],
        safelyContinuableActions: [],
      })
      const rootIndex = ledger.events.findIndex(event => event.kind === 'provider' && event.role === 'root'
        && event.request === harness.adapter.rootRequests.at(-1))
      const finalSidecarIndex = ledger.events.findLastIndex(event => event.kind === 'sidecar' && event.phase === 'finalized')
      expect(finalSidecarIndex).toBeGreaterThan(-1)
      expect(rootIndex).toBeGreaterThan(finalSidecarIndex)
      const root = rootProjection(harness.adapter.rootRequests.at(-1)!)
      expect(root).not.toContain(privateQuery)
      expect(root).not.toContain(releaseContent)
      expect(root).not.toContain(releaseUrl)
      expect(directEvents(ledger.fullSessionEvents, String(direct.id)), variant.name).toHaveLength(1)
      expect(userMessages(ledger.fullSessionEvents, 'context-manager-no-safe-action')).toHaveLength(2)
      expect(ledger.surfaceMessages.filter(message => message.source.kind === 'context-manager-no-safe-action')).toHaveLength(1)
      await dispose(harness)
      await expectColdNoSafe(harness.root)
    }
  })

  it('P3 table-drives the same unresolved fact into F08 while preserving the exact independent read-only action across cold recovery', async () => {
    const variants: readonly {
      readonly name: string
      readonly configure: (harness: Harness) => void
    }[] = [
      { name: 'unavailable', configure: harness => { harness.search.available = false } },
      { name: 'throw', configure: harness => { harness.search.error = new Error('search failed') } },
      { name: 'empty', configure: harness => { harness.search.result = { sources: [], truncated: false } } },
      { name: 'url-only', configure: harness => {
        harness.search.result = { sources: [{ url: releaseUrl }], truncated: false }
      } },
    ]
    for (const variant of variants) {
      const harness = await fresh(`f03-p3-${variant.name}-`)
      harness.adapter.mode = 'two'
      await establishFocus(harness)
      installReceiverLedger(harness.productionEvents)
      variant.configure(harness)
      const before = providerCounts(harness)
      const direct = await send(harness.agent, factTracer)
      const ledger = freezeProductionLedger(harness)
      expect(providerCounts(harness)).toEqual({
        focus: before.focus,
        action: before.action + 1,
        evidence: before.evidence,
        root: before.root + 1,
      })
      const local = parseCanonicalLocalRestrictionStateRecord(latestSidecar(ledger))
      expect(local?.transaction?.phase).toBe('finalized')
      expect(local?.transaction?.material.canonicalState.boundary).toMatchObject({
        kind: 'local_restriction',
        usableFacts: [],
        unresolvedFacts: [{ fact: 'DeepSeek Harness 最新版本' }],
        preciselyBlockedActions: ['升级 DeepSeek Harness'],
        safelyContinuableActions: ['列出已确认的只读升级前检查'],
      })
      const rootIndex = ledger.events.findIndex(event => event.kind === 'provider' && event.role === 'root'
        && event.request === harness.adapter.rootRequests.at(-1))
      const finalSidecarIndex = ledger.events.findLastIndex(event => event.kind === 'sidecar' && event.phase === 'finalized')
      expect(rootIndex).toBeGreaterThan(finalSidecarIndex)
      expect(rootProjection(harness.adapter.rootRequests.at(-1)!)).toContain('列出已确认的只读升级前检查')
      expect(directEvents(ledger.fullSessionEvents, String(direct.id)), variant.name).toHaveLength(1)
      expect(userMessages(ledger.fullSessionEvents, 'context-manager-local-restriction')).toHaveLength(2)
      expect(ledger.surfaceMessages.filter(message => message.source.kind === 'context-manager-local-restriction')).toHaveLength(1)
      await dispose(harness)
      vi.restoreAllMocks()
      const cold = await mount(harness.root, { resume: true })
      await cold.agent.whenIdle()
      expect(cold.adapter.requests).toHaveLength(0)
      await send(cold.agent, '继续')
      expect(cold.adapter.focusCalls).toBe(0)
      expect(cold.adapter.actionCalls).toBe(0)
      expect(cold.adapter.evidenceCalls).toBe(0)
      expect(cold.adapter.rootCalls).toBe(1)
      expect(rootProjection(cold.adapter.rootRequests[0]!)).toContain('列出已确认的只读升级前检查')
      await dispose(cold)
    }
  })

  it('A rejects absent or cross-wired admission and source histories at the real managed boundary with a variant-specific physical oracle', async () => {
    const variants = ['no-focus', 'wrong-chat', 'wrong-hash', 'old-assistant', 'wrong-route', 'cron-same-text'] as const
    for (const variant of variants) {
      const target = variant === 'cron-same-text' ? 'session-cron-f03-same-text' : sessionId
      const harness = await freshWith(`f03-a-${variant}-`, { targetSession: target })
      if (variant === 'wrong-chat' || variant === 'wrong-hash') {
        await establishFocus(harness)
        const table = harness.domain.table('focus_precanonical')
        const stored = object(table.get(sessionId))
        const decision = object(stored?.decision)
        const original = object(stored?.original)
        if (stored === undefined || decision === undefined || original === undefined) throw new Error('missing focus setup')
        await table.put(sessionId, variant === 'wrong-chat'
          ? { ...stored, decision: { ...decision, chat: foreignSessionId } }
          : { ...stored, original: { ...original, hash: 'wrong-hash' } })
      }
      if (variant === 'old-assistant') {
        harness.agent.session.append('assistant/message', {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: focusTracer }],
            source: { provider: 'old-provider', model: 'old-model' },
          }),
        }, { surfaceOp: 'append' })
      }
      if (variant === 'wrong-route') {
        harness.agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: focusTracer }],
          source: { kind: 'plugin', plugin: 'context-route' },
        }), { surfaceOp: 'append' })
      }
      const before = providerCounts(harness)
      const direct = await send(harness.agent, factTracer)
      const ledger = freezeProductionLedger(harness)
      expect(harness.adapter.actionCalls).toBe(before.action)
      expect(harness.adapter.evidenceCalls).toBe(before.evidence)
      expect(ledger.events.filter(event => event.kind === 'search')).toHaveLength(0)
      if (variant === 'cron-same-text') {
        expect(harness.adapter.rootCalls).toBeGreaterThan(before.root)
        expect(ledger.events.filter(event => event.kind === 'agent-error'
          && event.message === stableFailure)).toHaveLength(0)
        expect(directEvents(ledger.fullSessionEvents, String(direct.id))).toHaveLength(1)
      } else {
        expect(harness.adapter.rootCalls, variant).toBe(before.root)
        expect(ledger.events.filter(event => event.kind === 'agent-error'
          && event.message === stableFailure)).toHaveLength(1)
        expect(directEvents(ledger.fullSessionEvents, String(direct.id))).toHaveLength(1)
      }
      if (variant === 'old-assistant') expect(assistantEvents(ledger.fullSessionEvents)).toHaveLength(1)
      if (variant === 'wrong-route') {
        expect(userMessages(ledger.fullSessionEvents, 'plugin').some(event =>
          event.data.source.kind === 'plugin' && event.data.source.plugin === 'context-route')).toBe(true)
      }
      expect(parseCanonicalLocalRestrictionStateRecord(latestSidecar(ledger))).toBeUndefined()
      expect(parseCanonicalNoSafeActionStateRecord(latestSidecar(ledger))).toBeUndefined()
      await dispose(harness)
      vi.restoreAllMocks()
    }

  })

  it('B rejects malformed fact-need proposals before C11 or search without manufacturing a classification', async () => {
    const variants: readonly { readonly name: string; readonly output: string }[] = [
      { name: 'multi-fact', output: JSON.stringify({
        actions: ['升级 DeepSeek Harness'],
        proposedRequirements: [
          { fact: '最新版本', neededFor: ['升级 DeepSeek Harness'] },
          { fact: '兼容性', neededFor: ['升级 DeepSeek Harness'] },
        ],
        usableInputs: [],
        unresolvedInputs: [
          { fact: '最新版本', meaning: '未知', source: 'direct', degree: 'unknown', affected: '升级 DeepSeek Harness' },
          { fact: '兼容性', meaning: '未知', source: 'direct', degree: 'unknown', affected: '升级 DeepSeek Harness' },
        ],
      }) },
      { name: 'zero-requirement', output: JSON.stringify({
        actions: ['升级 DeepSeek Harness'], proposedRequirements: [], usableInputs: [], unresolvedInputs: [],
      }) },
      { name: 'duplicate-requirement', output: JSON.stringify({
        actions: ['升级 DeepSeek Harness'],
        proposedRequirements: [
          { fact: '最新版本', neededFor: ['升级 DeepSeek Harness'] },
          { fact: '最新版本', neededFor: ['升级 DeepSeek Harness'] },
        ],
        usableInputs: [],
        unresolvedInputs: [{ fact: '最新版本', meaning: '未知', source: 'direct', degree: 'unknown', affected: '升级' }],
      }) },
      { name: 'invalid-neededFor', output: JSON.stringify({
        actions: ['升级 DeepSeek Harness'],
        proposedRequirements: [{ fact: '最新版本', neededFor: ['删除数据库'] }],
        usableInputs: [],
        unresolvedInputs: [{ fact: '最新版本', meaning: '未知', source: 'direct', degree: 'unknown', affected: '升级' }],
      }) },
      { name: 'usable-unresolved-mismatch', output: JSON.stringify({
        actions: ['升级 DeepSeek Harness'],
        proposedRequirements: [{ fact: '最新版本', neededFor: ['升级 DeepSeek Harness'] }],
        usableInputs: [{ kind: 'direct_fact', fact: '别的事实', meaning: '已知', source: 'foreign', degree: 'established' }],
        unresolvedInputs: [{ fact: '最新版本', meaning: '未知', source: 'direct', degree: 'unknown', affected: '升级' }],
      }) },
      { name: 'foreign-direct', output: JSON.stringify({
        actions: ['升级 DeepSeek Harness'],
        proposedRequirements: [{ fact: 'DeepSeek Harness 最新版本', neededFor: ['升级 DeepSeek Harness'] }],
        usableInputs: [{
          kind: 'direct_fact', fact: 'DeepSeek Harness 最新版本', meaning: '外部声称已知', source: 'foreign-chat', degree: 'established',
        }],
        unresolvedInputs: [],
      }) },
    ]
    for (const variant of variants) {
      const harness = await fresh(`f03-b-${variant.name}-`)
      await establishFocus(harness)
      installReceiverLedger(harness.productionEvents)
      harness.adapter.actionOutput = variant.output
      const before = providerCounts(harness)
      const direct = await send(harness.agent, factTracer)
      const ledger = freezeProductionLedger(harness)
      expect(providerCounts(harness)).toEqual({
        focus: before.focus,
        action: before.action + 1,
        evidence: before.evidence,
        root: before.root,
      })
      expect(ledger.events.filter(event => event.kind === 'search')).toHaveLength(0)
      expect(ledger.events.filter(event => event.kind === 'evidence')).toHaveLength(0)
      expect(ledger.events.filter(event => event.kind === 'presenter')).toHaveLength(0)
      expect(ledger.events.filter(event => event.kind === 'agent-error' && event.message === stableFailure)).toHaveLength(1)
      expect(directEvents(ledger.fullSessionEvents, String(direct.id))).toHaveLength(1)
      await dispose(harness)
      vi.restoreAllMocks()
    }

  })

  it('C normalizes hostile retrieval shapes without ever promoting them to DirectFact and commits the real semantic fallback state', async () => {
    const variants: readonly {
      readonly name: string
      readonly configure: (harness: Harness) => void
      readonly semanticCalls: number
      readonly mode?: AdapterMode
      readonly semanticIdentityFault?: EvidenceIdentityFault
    }[] = [
      { name: 'empty-url', semanticCalls: 0, configure: harness => {
        harness.search.result = { sources: [{ url: '' }], truncated: false }
      } },
      { name: 'bad-url', semanticCalls: 0, configure: harness => {
        harness.search.result = { sources: [{ url: 'ftp://example.test/release', snippet: releaseContent }], truncated: false }
      } },
      { name: 'empty-content', semanticCalls: 0, configure: harness => {
        harness.search.result = { sources: [{ url: releaseUrl, snippet: '   ' }], truncated: false }
      } },
      { name: 'overlong', semanticCalls: 0, configure: harness => {
        harness.search.result = { sources: [{ url: releaseUrl, snippet: 'x'.repeat(4_097) }], truncated: false }
      } },
      { name: 'wrong-semantic-source', semanticCalls: 1, semanticIdentityFault: 'source', configure: harness => {
        harness.adapter.evidenceIdentityFault = 'source'
      } },
      { name: 'wrong-semantic-request', semanticCalls: 1, mode: 'two', semanticIdentityFault: 'request', configure: harness => {
        harness.adapter.evidenceIdentityFault = 'request'
      } },
      { name: 'wrong-semantic-material', semanticCalls: 1, semanticIdentityFault: 'material', configure: harness => {
        harness.adapter.evidenceIdentityFault = 'material'
      } },
      { name: 'wrong-semantic-fact-needs', semanticCalls: 1, mode: 'two', semanticIdentityFault: 'factNeeds', configure: harness => {
        harness.adapter.evidenceIdentityFault = 'factNeeds'
      } },
      { name: 'truncated', semanticCalls: 0, configure: harness => {
        harness.search.result = { sources: [{ url: releaseUrl, snippet: releaseContent }], truncated: true }
      } },
      { name: 'multi-source', semanticCalls: 0, configure: harness => {
        harness.search.result = {
          sources: [
            { url: releaseUrl, snippet: releaseContent },
            { url: 'https://example.test/second', snippet: 'second' },
          ],
          truncated: false,
        }
      } },
    ]
    for (const variant of variants) {
      const harness = await fresh(`f03-c-${variant.name}-`)
      harness.adapter.mode = variant.mode ?? 'single'
      await establishFocus(harness)
      installReceiverLedger(harness.productionEvents)
      variant.configure(harness)
      const before = providerCounts(harness)
      await send(harness.agent, factTracer)
      const ledger = freezeProductionLedger(harness)
      expect(harness.adapter.actionCalls).toBe(before.action + 1)
      expect(harness.adapter.evidenceCalls).toBe(before.evidence + variant.semanticCalls)
      expect(harness.adapter.rootCalls).toBe(before.root + 1)
      expect(ledger.events.filter(event => event.kind === 'search')).toHaveLength(1)
      const evidence = ledger.events.filter((event): event is Extract<ProductionEvent, { readonly kind: 'evidence' }> =>
        event.kind === 'evidence')
      expect(evidence).toHaveLength(1)
      const resolved = evidence[0]?.outcome
      if (resolved === undefined) throw new Error(`missing normalized evidence for ${variant.name}`)
      expect(resolved.provenance.conclusion).not.toMatchObject({ kind: 'direct_fact' })
      if (variant.semanticIdentityFault !== undefined) {
        expect(resolved.provenance).toStrictEqual({
          conclusion: {
            fact: 'DeepSeek Harness 最新版本',
            meaning: 'web evidence was not established',
            source: sourceRef(releaseUrl),
            degree: 'insufficient',
            affected: 'actions:升级 DeepSeek Harness',
          },
          source: sourceRef(releaseUrl),
          url: releaseUrl,
          observedAt: resolved.provenance.observedAt,
          publishedAt,
        })
      }
      const presenter = ledger.events.filter(
        (event): event is Extract<ProductionEvent, { readonly kind: 'presenter' }> => event.kind === 'presenter',
      )
      expect(presenter).toHaveLength(1)
      const c22 = presenter[0]?.report
      if (c22?.kind !== 'business_result') throw new Error(`missing fallback C22 for ${variant.name}`)
      expect(c22.value.value.usableFacts).toStrictEqual([])
      expect(c22.value.value.unresolvedFacts).toStrictEqual([resolved.provenance.conclusion])
      if (variant.mode === 'two') {
        const local = parseCanonicalLocalRestrictionStateRecord(latestSidecar(ledger))
        expect(local?.transaction?.phase).toBe('finalized')
        const { chat: _chat, ...preservedBoundary } = c22.value.value
        expect(_chat).toBe(sessionId)
        expect(local?.transaction?.material.canonicalState.boundary).toStrictEqual(preservedBoundary)
        expect(c22.value.value).toMatchObject({
          kind: 'local_restriction',
          preciselyBlockedActions: ['升级 DeepSeek Harness'],
          safelyContinuableActions: ['列出已确认的只读升级前检查'],
        })
      } else {
        const noSafe = parseCanonicalNoSafeActionStateRecord(latestSidecar(ledger))
        expect(noSafe?.transaction?.phase).toBe('finalized')
        expect(c22.value.value).toMatchObject({
          kind: 'no_safe_action',
          preciselyBlockedActions: ['升级 DeepSeek Harness'],
          safelyContinuableActions: [],
        })
      }
      const root = rootProjection(harness.adapter.rootRequests.at(-1)!)
      expect(root).not.toContain(privateQuery)
      expect(root).not.toContain(releaseContent)
      await dispose(harness)
      vi.restoreAllMocks()
    }
  })

  it('D contains evidence-call budget, window, cancellation, stream, and identity faults without leaking raw material or confusing provider and publication failure', async () => {
    const variants = [
      'budget', 'window', 'timeout', 'abort-evidence', 'abort-before-commit', 'abort-postcommit',
      'provider-throw', 'non-stop', 'empty', 'malformed', 'tool-call', 'fact-source-mismatch',
    ] as const
    for (const variant of variants) {
      const harness = variant === 'timeout'
        ? await freshWith(`f03-d-${variant}-`, { timeoutMs: 5 })
        : await fresh(`f03-d-${variant}-`)
      await establishFocus(harness)
      const abortVariant = variant === 'abort-evidence'
        || variant === 'abort-before-commit'
        || variant === 'abort-postcommit'
      installReceiverLedger(harness.productionEvents, variant === 'abort-before-commit'
        ? () => harness.agent.cancel({ kind: 'user' }, { keepInbox: true })
        : undefined)
      const fixedPresenter = abortVariant
        ? vi.spyOn(ManagedFailurePresenter.prototype, 'afterPhysicallyProvedInput')
        : undefined
      let toolBodies = 0
      if (variant === 'abort-postcommit') {
        harness.adapter.evidenceConclusionMode = 'unresolved'
        harness.ctx.tools.register(defineContentToolFixture({
          name: 'upgrade_probe', description: 'Attempt the version-dependent upgrade.', parameters: {},
          async execute() { toolBodies += 1; return [{ type: 'text', text: 'executed' }] },
        }))
        harness.sidecarHooks.afterCommit = value => {
          const transaction = object(object(value)?.transaction)
          if (transaction?.phase === 'finalized') {
            harness.productionEvents.push({ kind: 'abort-injected', stage: 'postcommit' })
            harness.agent.cancel({ kind: 'user' })
          }
        }
      }
      if (variant === 'budget') {
        const estimate = TokenMeter.prototype.estimateMessage
        vi.spyOn(TokenMeter.prototype, 'estimateMessage').mockImplementation(function (this: TokenMeter, message) {
          return message.source.kind === 'plugin' && message.source.plugin === 'ui-context-compactor:evidence-schema'
            ? 1_000_000
            : estimate.call(this, message)
        })
      }
      if (variant === 'window') {
        const prior = harness.adapter.onDispatch
        harness.adapter.onDispatch = (role, request) => {
          prior?.(role, request)
          if (role === 'action') harness.adapter.contextWindow = 300
        }
      }
      if (variant === 'timeout') harness.adapter.evidenceDelayMs = 20
      if (variant === 'abort-evidence') {
        const prior = harness.adapter.onDispatch
        harness.adapter.onDispatch = (role, request) => {
          prior?.(role, request)
          if (role === 'evidence') harness.agent.cancel({ kind: 'user' }, { keepInbox: true })
        }
      }
      if (variant === 'provider-throw') harness.adapter.failure = 'evidence'
      if (variant === 'non-stop') harness.adapter.evidenceFinish = 'length'
      if (variant === 'empty') harness.adapter.evidenceOutput = ''
      if (variant === 'malformed') harness.adapter.evidenceOutput = '{not-json'
      if (variant === 'tool-call') harness.adapter.evidenceFinish = 'tool-call'
      if (variant === 'fact-source-mismatch') {
        harness.adapter.evidenceOutput = JSON.stringify({
          kind: 'direct_fact', fact: 'wrong-fact', meaning: 'wrong', source: 'wrong-source', degree: 'established',
          request: 'wrong-request', material: 'wrong-material', factNeeds: 'wrong-needs',
        })
      }
      const before = providerCounts(harness)
      const direct = await send(harness.agent, factTracer)
      const ledger = freezeProductionLedger(harness)
      expect(harness.adapter.actionCalls).toBe(before.action + 1)
      expect(ledger.events.filter(event => event.kind === 'search')).toHaveLength(1)
      if (abortVariant) {
        if (variant === 'abort-postcommit') {
          expect(ledger.events.filter(event => event.kind === 'abort-injected'), variant).toHaveLength(1)
        }
        const physicalDirect = directEvents(ledger.fullSessionEvents, String(direct.id))
        expect(physicalDirect, variant).toHaveLength(1)
        expect(physicalDirect[0]?.data, variant).toStrictEqual(direct)
        expect(messageText(physicalDirect[0]!.data), variant).toBe(factTracer)
        expect(physicalDirect[0]?.data.source, variant).toEqual({ kind: 'user' })
        if (variant === 'abort-evidence' || variant === 'abort-before-commit') {
          expect(userMessages(ledger.fullSessionEvents, 'context-manager-local-restriction'), variant).toHaveLength(0)
          expect(userMessages(ledger.fullSessionEvents, 'context-manager-no-safe-action'), variant).toHaveLength(0)
          expect(ledger.surfaceMessages.filter(message =>
            message.source.kind === 'context-manager-local-restriction'), variant).toHaveLength(0)
          expect(ledger.surfaceMessages.filter(message =>
            message.source.kind === 'context-manager-no-safe-action'), variant).toHaveLength(0)
          expect(canonicalStatePhaseEvents(ledger.fullSessionEvents), variant).toHaveLength(0)
          expect(ledger.events.filter(event => event.kind === 'sidecar'
            && (event.family === 'local_restriction' || event.family === 'no_safe_action')
            && (event.phase === 'pending' || event.phase === 'current' || event.phase === 'finalized'
              || event.phase === 'repair_pending' || event.phase === 'repair_finalized')), variant).toHaveLength(0)
        }
        expect(harness.adapter.rootCalls, variant).toBe(before.root)
        expect(ledger.events.filter(event => event.kind === 'presenter')).toHaveLength(1)
        expect(fixedPresenter).toHaveBeenCalledTimes(1)
        expect(fixedPresenter?.mock.results[0]?.type).toBe('throw')
        expect(ledger.events.filter(event => event.kind === 'agent-error')).toHaveLength(0)
        const userAbortEnds = ledger.fullSessionEvents.filter((event): event is SessionEvent<'turn/end'> => event.type === 'turn/end'
          && event.data.reason.kind === 'aborted' && event.data.reason.reason.kind === 'user')
        expect(userAbortEnds, variant).toHaveLength(1)
        expect(userAbortEnds[0]?.data.reason, variant).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
        const detached = ledger.events.filter((event): event is Extract<ProductionEvent, { readonly kind: 'read' }> =>
          event.kind === 'read').flatMap(event => event.events).filter(event => event.id === String(direct.id))
        expect(detached).toEqual([{
          seq: directEvents(ledger.fullSessionEvents, String(direct.id))[0]!.seq,
          type: 'user/message', id: String(direct.id), source: 'user', text: factTracer,
          hash: directHash(String(direct.id), factTracer),
        }])
        if (variant === 'abort-postcommit') {
          const guarded = await harness.ctx.tools.execute({
            name: 'upgrade_probe', arguments: {}, callId: CallId('f03-abort-postcommit-live'),
            signal: new AbortController().signal, agent: harness.agent,
          })
          expect(toolBodies).toBe(0)
          expect(guarded.isError).toBe(true)
          const noSafe = parseCanonicalNoSafeActionStateRecord(latestSidecar(ledger))
          expect(noSafe?.transaction?.phase).toBe('finalized')
          expect(noSafe?.transaction?.repair).toBeUndefined()
          if (noSafe?.transaction === undefined) throw new Error('missing finalized postcommit state')
          const generation = noSafe?.transaction?.generation
          if (generation === undefined) throw new Error('missing postcommit abort generation')
          await dispose(harness)
          vi.restoreAllMocks()
          const recovery = installRecoverySpies()
          const cold = await mount(harness.root, { resume: true })
          await cold.agent.whenIdle()
          const coldLedger = freezeProductionLedger(cold)
          const repaired = parseCanonicalNoSafeActionStateRecord(latestSidecar(coldLedger))
          expect(cold.adapter.requests).toHaveLength(0)
          expect(repaired?.transaction?.generation).toBe(generation)
          expect(repaired?.transaction?.repair?.phase).toBe('repair_finalized')
          expect(repaired?.transaction?.material.canonicalState.boundary)
            .toEqual(noSafe.transaction.material.canonicalState.boundary)
          expect(repaired?.transaction?.bodyHash).toBe(noSafe.transaction.bodyHash)
          expect(coldLedger.surfaceMessages).toHaveLength(1)
          expect(coldLedger.surfaceMessages[0]?.source.kind).toBe('context-manager-no-safe-action')
          expect(directEvents(coldLedger.fullSessionEvents, String(direct.id))).toHaveLength(1)
          expect(recovery.c34).toHaveBeenCalledTimes(1)
          expect(recovery.c35).toHaveBeenCalledTimes(1)
          expect(recovery.c36).toHaveBeenCalledTimes(1)
          expect(recovery.c30).toHaveBeenCalledTimes(1)
          expect(recovery.c31).toHaveBeenCalledTimes(1)
          expect(recovery.c37).toHaveBeenCalledTimes(1)
          expect(recovery.c34.mock.results[0]?.value).toMatchObject({ kind: 'business_result', identity: { contract: 'C34' } })
          expect(recovery.c35.mock.results[0]?.value).toMatchObject({ kind: 'business_result', identity: { contract: 'C35' } })
          expect(recovery.c36.mock.results[0]?.value).toMatchObject({ kind: 'business_result', identity: { contract: 'C36' } })
          expect(recovery.c30.mock.results[0]?.value).toMatchObject({ kind: 'business_result', identity: { contract: 'C30' } })
          expect(recovery.c31.mock.results[0]?.value).toMatchObject({ kind: 'business_result', identity: { contract: 'C31' } })
          expect(recovery.c37.mock.results[0]?.value).toMatchObject({ kind: 'business_result', identity: { contract: 'C37' } })
          const coldProofReads = coldLedger.events.filter((event): event is Extract<ProductionEvent, { readonly kind: 'read' }> =>
            event.kind === 'read' && event.events.some(read => read.id === String(direct.id)))
          expect(coldProofReads).toHaveLength(1)
          expect(coldProofReads[0]?.eventTypes).toEqual([
            'turn/start', 'agent/inbox/spliced', 'user/message', 'user/message',
            'user/message', 'turn/end', 'session/end-seed', 'user/message',
          ])
          expect(coldProofReads[0]?.events.filter(event => event.id === String(direct.id))).toEqual([{
            seq: directEvents(coldLedger.fullSessionEvents, String(direct.id))[0]!.seq,
            type: 'user/message', id: String(direct.id), source: 'user', text: factTracer,
            hash: directHash(String(direct.id), factTracer),
          }])
          const repair = repaired?.transaction?.repair
          if (repair?.phase !== 'repair_finalized') throw new Error('missing finalized repair target')
          expect(coldLedger.fullSessionEvents.filter(event => event.seq === repair.targetReplaceSeq)).toHaveLength(1)
          expect(coldLedger.fullSessionEvents.filter(event => event.type === 'user/message'
            && String(event.data.id) === repair.targetMessageId)).toHaveLength(1)
          await dispose(cold)
          vi.restoreAllMocks()
          const afterTargetRecovery = installRecoverySpies()
          const afterTarget = await mount(harness.root, { resume: true })
          await afterTarget.agent.whenIdle()
          afterTarget.agent.session.append('session/end-seed', {})
          const afterTargetLedger = freezeProductionLedger(afterTarget)
          expect(afterTarget.adapter.requests).toHaveLength(0)
          expect(afterTargetRecovery.c37).toHaveBeenCalledTimes(1)
          const afterTargetProofReads = afterTargetLedger.events.filter(
            (event): event is Extract<ProductionEvent, { readonly kind: 'read' }> =>
              event.kind === 'read' && event.events.some(read => read.id === String(direct.id)),
          )
          expect(afterTargetProofReads).toHaveLength(1)
          expect(afterTargetProofReads[0]?.eventTypes).toEqual([
            'turn/start', 'agent/inbox/spliced', 'user/message', 'user/message',
            'user/message', 'turn/end', 'session/end-seed', 'user/message', 'session/end-seed',
          ])
          await dispose(afterTarget)
          vi.restoreAllMocks()
          const excessiveTailRecovery = installRecoverySpies()
          const excessiveTail = await mount(harness.root, { resume: true })
          await excessiveTail.agent.whenIdle()
          let excessiveTailBodies = 0
          excessiveTail.ctx.tools.register(defineContentToolFixture({
            name: 'upgrade_probe', description: 'Attempt the version-dependent upgrade.', parameters: {},
            async execute() { excessiveTailBodies += 1; return [{ type: 'text', text: 'executed' }] },
          }))
          const excessiveTailGuard = await excessiveTail.ctx.tools.execute({
            name: 'upgrade_probe', arguments: {}, callId: CallId('f03-abort-postcommit-excessive-tail'),
            signal: new AbortController().signal, agent: excessiveTail.agent,
          })
          const excessiveTailLedger = freezeProductionLedger(excessiveTail)
          expect(excessiveTail.adapter.requests).toHaveLength(0)
          expect(excessiveTailRecovery.c37).toHaveBeenCalledTimes(0)
          expect(excessiveTailLedger.events.filter(event => event.kind === 'sidecar')).toHaveLength(0)
          expect(excessiveTailBodies).toBe(0)
          expect(excessiveTailGuard.isError).toBe(true)
          await dispose(excessiveTail)
          vi.restoreAllMocks()
          continue
        }
        expect(parseCanonicalNoSafeActionStateRecord(latestSidecar(ledger))).toBeUndefined()
        expect(parseCanonicalLocalRestrictionStateRecord(latestSidecar(ledger))).toBeUndefined()
        const focus = object(latestSidecar(ledger))
        expect(object(focus?.decision)?.currentMatter).toBe(focusTracer)
      } else {
        expect(directEvents(ledger.fullSessionEvents, String(direct.id)), variant).toHaveLength(1)
        expect(harness.adapter.rootCalls).toBe(before.root + 1)
        const noSafe = parseCanonicalNoSafeActionStateRecord(latestSidecar(ledger))
        expect(noSafe?.transaction?.phase).toBe('finalized')
        expect(noSafe?.transaction?.material.canonicalState.boundary).toMatchObject({
          kind: 'no_safe_action', usableFacts: [], unresolvedFacts: [{ fact: 'DeepSeek Harness 最新版本' }],
        })
        const root = rootProjection(harness.adapter.rootRequests.at(-1)!)
        expect(root).not.toContain(privateQuery)
        expect(root).not.toContain(releaseContent)
        expect(root).not.toContain(releaseUrl)
      }
      if (variant === 'provider-throw') {
        expect(ledger.events.some(event => event.kind === 'provider' && event.role === 'evidence')).toBe(true)
        expect(ledger.events.some(event => event.kind === 'sidecar' && event.phase === 'finalized')).toBe(true)
      }
      await dispose(harness)
      vi.restoreAllMocks()
    }

    const closedPostcommitVariants = [
      { name: 'parent-reason', cause: { kind: 'parent' as const }, pollution: 'none' as const },
      { name: 'disposed-reason', cause: { kind: 'disposed' as const }, pollution: 'none' as const },
      { name: 'extra-user-reason-field', cause: { kind: 'user' as const, extra: 'foreign' }, pollution: 'none' as const },
      { name: 'extra-direct', cause: { kind: 'user' as const }, pollution: 'direct' as const },
      { name: 'extra-history', cause: { kind: 'user' as const }, pollution: 'history' as const },
      { name: 'two-seeds-before-target', cause: { kind: 'user' as const }, pollution: 'two-seeds' as const },
    ]
    for (const variant of closedPostcommitVariants) {
      const harness = await fresh(`f03-d-closed-${variant.name}-`)
      await establishFocus(harness)
      installReceiverLedger(harness.productionEvents)
      const fixedPresenter = vi.spyOn(ManagedFailurePresenter.prototype, 'afterPhysicallyProvedInput')
      harness.adapter.evidenceConclusionMode = 'unresolved'
      let cancelled = false
      harness.sidecarHooks.afterCommit = value => {
        const transaction = object(object(value)?.transaction)
        if (!cancelled && transaction?.phase === 'finalized') {
          cancelled = true
          harness.agent.cancel(variant.cause)
        }
      }
      const before = providerCounts(harness)
      const direct = await send(harness.agent, factTracer)
      if (variant.pollution === 'direct') {
        harness.agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'foreign direct tail' }], source: { kind: 'user' },
        }), { surfaceOp: 'append' })
      }
      if (variant.pollution === 'history') {
        harness.agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'foreign history tail' }],
          source: { kind: 'plugin', plugin: 'foreign-history' },
        }), { surfaceOp: 'append' })
      }
      if (variant.pollution === 'two-seeds') {
        harness.agent.session.append('session/end-seed', {})
        harness.agent.session.append('session/end-seed', {})
      }
      const liveLedger = freezeProductionLedger(harness)
      expect(harness.adapter.rootCalls, variant.name).toBe(before.root)
      expect(liveLedger.events.filter(event => event.kind === 'presenter'), variant.name).toHaveLength(1)
      expect(fixedPresenter, variant.name).toHaveBeenCalledTimes(1)
      expect(fixedPresenter.mock.results[0]?.type, variant.name).toBe('throw')
      const physical = directEvents(liveLedger.fullSessionEvents, String(direct.id))
      expect(physical, variant.name).toHaveLength(1)
      expect(physical[0]?.data, variant.name).toStrictEqual(direct)
      const aborted = liveLedger.fullSessionEvents.filter((event): event is SessionEvent<'turn/end'> => event.type === 'turn/end'
        && event.data.reason.kind === 'aborted')
      expect(aborted, variant.name).toHaveLength(1)
      expect(aborted[0]?.data.reason, variant.name).toEqual({ kind: 'aborted', reason: variant.cause })
      const persisted = parseCanonicalNoSafeActionStateRecord(latestSidecar(liveLedger))
      expect(persisted?.transaction?.phase, variant.name).toBe('finalized')
      expect(persisted?.transaction?.repair, variant.name).toBeUndefined()
      await dispose(harness)
      vi.restoreAllMocks()

      const recovery = installRecoverySpies()
      const cold = await mount(harness.root, { resume: true })
      await cold.agent.whenIdle()
      let toolBodies = 0
      cold.ctx.tools.register(defineContentToolFixture({
        name: 'upgrade_probe', description: 'Attempt the version-dependent upgrade.', parameters: {},
        async execute() { toolBodies += 1; return [{ type: 'text', text: 'executed' }] },
      }))
      const guarded = await cold.ctx.tools.execute({
        name: 'upgrade_probe', arguments: {}, callId: CallId(`f03-d-closed-${variant.name}`),
        signal: new AbortController().signal, agent: cold.agent,
      })
      const coldLedger = freezeProductionLedger(cold)
      expect(cold.adapter.requests, variant.name).toHaveLength(0)
      expect(recovery.c37, variant.name).toHaveBeenCalledTimes(0)
      expect(coldLedger.events.filter(event => event.kind === 'sidecar'), variant.name).toHaveLength(0)
      expect(userMessages(coldLedger.fullSessionEvents, 'context-manager-no-safe-action'), variant.name).toHaveLength(2)
      expect(directEvents(coldLedger.fullSessionEvents, String(direct.id)), variant.name).toHaveLength(1)
      expect(toolBodies, variant.name).toBe(0)
      expect(guarded.isError, variant.name).toBe(true)
      expect(cold.adapter.rootCalls, variant.name).toBe(0)
      await dispose(cold)
      vi.restoreAllMocks()
    }
  })

  it('E proves public C11-C13 equivalence and staged C22/C20/C21 retry without replay, while wrong, foreign, and reused direct inputs stay inert', async () => {
    const publicHarness = await fresh('f03-e-public-needs-')
    const publicChat = String(publicHarness.agent.session.id) as ChatRef
    const publicFocus = createPublicEstablishedFocus(publicChat, 'needs')
    const publicCounts = { search: 0, semantic: 0 }
    const resolution = EvidenceResolution.create({
      search: async () => {
        publicCounts.search += 1
        return exactWebResult()
      },
    }, {
      proposeEvidence: async request => {
        publicCounts.semantic += 1
        return Object.freeze({
          kind: 'proposal' as const,
          request,
          value: Object.freeze({
            kind: 'direct_fact' as const,
            fact: request.retrieval.need.fact,
            meaning: 'DeepSeek Harness 当前最新稳定版本为 1.4.2' as ActionableFactMeaning,
            source: request.material.source,
            degree: 'established' as const,
          }),
        })
      },
    }, () => '2026-08-26T00:00:00.000Z')
    const owner = Object.freeze({ role: 'exact-owner' })
    const wrongOwner = Object.freeze({ role: 'wrong-owner' })
    const unboundNeeds = publicFactNeeds(publicChat, 'unbound')
    const wrongOwnerNeeds = publicFactNeeds(publicChat, 'wrong-owner')
    const exactNeeds = publicFactNeeds(publicChat, 'exact')
    const exactOrigin = Object.freeze({
      messageId: 'f03-public-exact-direct',
      hash: directHash('f03-public-exact-direct', factTracer),
      chat: publicChat,
    })
    const signal = new AbortController().signal
    expect(issueOwnerBoundFactNeedSet(
      resolution, owner, unboundNeeds, publicFocus.focus, exactOrigin,
    )).toBe(false)
    expect(await resolution.acceptFactNeeds(unboundNeeds, signal)).toBeUndefined()
    expect(bindExpectedFactNeedOwner(resolution, owner)).toBe(true)
    expect(issueOwnerBoundFactNeedSet(
      resolution, wrongOwner, wrongOwnerNeeds, publicFocus.focus, exactOrigin,
    )).toBe(false)
    expect(await resolution.acceptFactNeeds(wrongOwnerNeeds, signal)).toBeUndefined()
    expect(issueOwnerBoundFactNeedSet(
      resolution, owner, exactNeeds, publicFocus.focus, exactOrigin,
    )).toBe(true)
    const exactOutcome = await resolution.acceptFactNeeds(exactNeeds, signal)
    if (exactOutcome === undefined || !isSingleEvidenceResolutionOutcome(exactOutcome)
      || exactOutcome.c11.kind !== 'business_result'
      || exactOutcome.c12.kind !== 'business_result' || exactOutcome.material === undefined) {
      throw new Error('public exact owner-bound needs did not complete C11/C12')
    }
    expect(exactOutcome.c11).toStrictEqual({
      kind: 'business_result',
      identity: { contract: 'C11', call: exactOutcome.c11.identity.call, subject: exactNeeds.ref },
      value: { kind: 'accepted_for_contract', value: exactNeeds },
    })
    expect(exactOutcome.c12).toStrictEqual({
      kind: 'business_result',
      identity: { contract: 'C12', call: exactOutcome.c12.identity.call, subject: exactOutcome.request.ref },
      value: {
        request: exactOutcome.request.ref,
        actualMaterials: [exactOutcome.material.ref],
        sources: [sourceRef(releaseUrl)],
        observedGaps: [],
        observedConflicts: [],
      },
    })
    expect(await resolution.acceptFactNeeds(exactNeeds, signal)).toBe(exactOutcome)
    expect(publicCounts).toStrictEqual({ search: 1, semantic: 1 })
    await dispose(publicHarness)

    const retryVariants = [
      { name: 'C22', expected: { C22: 2, C20: 1, C21: 1, search: 1, semantic: 1 } },
      { name: 'C20', expected: { C22: 1, C20: 2, C21: 1, search: 1, semantic: 1 } },
      { name: 'C21', expected: { C22: 1, C20: 1, C21: 2, search: 1, semantic: 1 } },
    ] as const
    for (const variant of retryVariants) {
      const stagedHarness = await fresh(`f03-e-staged-${variant.name}-`)
      const chat = String(stagedHarness.agent.session.id) as ChatRef
      const focus = createPublicEstablishedFocus(chat, variant.name)
      const preservation = new EffectiveStatePreservation()
      const canonical = new CanonicalContextAuthority()
      const presenter = new UserInteractionAdvice()
      const counts = { C22: 0, C20: 0, C21: 0, search: 0, semantic: 0 }
      let firstFaultPending = true
      const composition = ActionFactBoundaryAuthority.createComposition({
        preservation: Object.freeze({
          acceptActionBoundaryToPreserve: (boundary: ActionFactBoundary) => {
            counts.C20 += 1
            if (variant.name === 'C20' && firstFaultPending) {
              firstFaultPending = false
              throw new Error('first C20 fault')
            }
            return preservation.acceptActionBoundaryToPreserve(boundary)
          },
        }),
        canonicalContext: Object.freeze({
          acceptActionSafetyBoundary: (boundary: ActionFactBoundary) => {
            counts.C21 += 1
            if (variant.name === 'C21' && firstFaultPending) {
              firstFaultPending = false
              throw new Error('first C21 fault')
            }
            return canonical.acceptActionSafetyBoundary(boundary)
          },
        }),
        userInteraction: Object.freeze({
          acceptFactDecisionNeeds: (boundary: ActionFactBoundary) => {
            counts.C22 += 1
            if (variant.name === 'C22' && firstFaultPending) {
              firstFaultPending = false
              throw new Error('first C22 fault')
            }
            return presenter.acceptFactDecisionNeeds(boundary)
          },
        }),
      }, {
        web: Object.freeze({
          search: async () => {
            counts.search += 1
            return exactWebResult()
          },
        }),
        semantic: Object.freeze({
          proposeEvidence: async (request: BoundedEvidenceProposalRequest) => {
            counts.semantic += 1
            return Object.freeze({
              kind: 'proposal' as const,
              request,
              value: Object.freeze({
                kind: 'direct_fact' as const,
                fact: request.retrieval.need.fact,
                meaning: 'DeepSeek Harness 当前最新稳定版本为 1.4.2' as ActionableFactMeaning,
                source: request.material.source,
                degree: 'established' as const,
              }),
            })
          },
        }),
        now: () => '2026-08-26T00:00:00.000Z',
      })
      const formed = formPublicActionProposal(
        stagedHarness, composition, focus.authority, focus.focus, variant.name,
      )
      const stagedSignal = new AbortController().signal
      expect(await composition.completeEvidenceActionFactBoundary.accept(
        focus.focus, formed.proposal, stagedSignal,
      ), variant.name).toBeUndefined()
      const completion = await composition.completeEvidenceActionFactBoundary.accept(
        focus.focus, formed.proposal, stagedSignal,
      )
      if (completion === undefined || !isSingleEvidenceActionableCompletion(completion)
        || completion.c22.kind !== 'business_result'
        || completion.c20.kind !== 'business_result'
        || completion.c21.kind !== 'business_result') {
        throw new Error(`staged public retry did not complete for ${variant.name}`)
      }
      expect(counts, variant.name).toStrictEqual(variant.expected)
      const boundary = completion.boundary
      expect(completion.provenance).toStrictEqual({
        conclusion: {
          kind: 'direct_fact',
          fact: 'DeepSeek Harness 最新版本',
          meaning: 'DeepSeek Harness 当前最新稳定版本为 1.4.2',
          source: sourceRef(releaseUrl),
          degree: 'established',
        },
        source: sourceRef(releaseUrl),
        url: releaseUrl,
        observedAt: '2026-08-26T00:00:00.000Z',
        publishedAt,
      })
      expect(boundary).toStrictEqual({
        ref: boundary.ref,
        chat,
        requiredFacts: boundary.requiredFacts,
        usableFacts: [completion.provenance.conclusion],
        unresolvedFacts: [],
        kind: 'actionable',
        preciselyBlockedActions: [],
        safelyContinuableActions: ['升级 DeepSeek Harness'],
      })
      expect(completion.c22).toStrictEqual({
        kind: 'business_result',
        identity: { contract: 'C22', call: completion.c22.identity.call, subject: boundary.ref },
        value: { kind: 'accepted_for_contract', value: boundary },
      })
      expect(completion.c20).toStrictEqual({
        kind: 'business_result',
        identity: { contract: 'C20', call: completion.c20.identity.call, subject: boundary.ref },
        value: { kind: 'accepted_for_contract', value: boundary },
      })
      expect(completion.c21).toStrictEqual({
        kind: 'business_result',
        identity: { contract: 'C21', call: completion.c21.identity.call, subject: boundary.ref },
        value: { kind: 'accepted_for_contract', value: boundary },
      })
      expect(completion.c22.value.value).toBe(boundary)
      expect(completion.c20.value.value).toBe(boundary)
      expect(completion.c21.value.value).toBe(boundary)
      const completedCounts = Object.freeze({ ...counts })
      expect(await composition.completeEvidenceActionFactBoundary.accept(
        focus.focus, formed.proposal, stagedSignal,
      ), variant.name).toBeUndefined()
      expect(counts, variant.name).toStrictEqual(completedCounts)
      await dispose(stagedHarness)
    }

    const harness = await fresh('f03-e-one-shot-')
    await establishFocus(harness)
    installReceiverLedger(harness.productionEvents)
    const foreign = createUserMessage({
      content: [{ type: 'text', text: factTracer }],
      source: { kind: 'plugin', plugin: 'foreign-direct-source' },
    })
    harness.agent.send(foreign, 'next-turn', true)
    await harness.agent.whenIdle()
    const wrong = await send(harness.agent, `${factTracer}（错误串线）`)
    const beforeCorrectLedger = freezeProductionLedger(harness)
    expect(beforeCorrectLedger.events.filter(event => event.kind === 'search')).toHaveLength(0)
    expect(beforeCorrectLedger.events.filter(event => event.kind === 'evidence')).toHaveLength(0)
    expect(beforeCorrectLedger.events.filter(event => event.kind === 'presenter')).toHaveLength(0)
    expect(beforeCorrectLedger.events.filter(event => event.kind === 'state')).toHaveLength(0)
    const beforeCorrect = providerCounts(harness)
    const correct = await send(harness.agent, factTracer)
    const beforeReuseLedger = freezeProductionLedger(harness)
    expect(providerCounts(harness)).toEqual({
      focus: beforeCorrect.focus,
      action: beforeCorrect.action + 1,
      evidence: beforeCorrect.evidence + 1,
      root: beforeCorrect.root + 1,
    })
    expect(beforeReuseLedger.events.filter(event => event.kind === 'search')).toHaveLength(1)
    expect(beforeReuseLedger.events.filter(event => event.kind === 'evidence')).toHaveLength(1)
    expect(beforeReuseLedger.events.filter(event => event.kind === 'presenter')).toHaveLength(1)
    expect(beforeReuseLedger.events.filter(event => event.kind === 'state' && event.receiver === 'C20')).toHaveLength(1)
    expect(beforeReuseLedger.events.filter(event => event.kind === 'state' && event.receiver === 'C21')).toHaveLength(1)
    expect(directEvents(beforeReuseLedger.fullSessionEvents, String(wrong.id))).toHaveLength(1)
    expect(directEvents(beforeReuseLedger.fullSessionEvents, String(correct.id))).toHaveLength(1)
    expect(beforeReuseLedger.fullSessionEvents.some(event => event.type === 'user/message'
      && String(event.data.id) === String(foreign.id))).toBe(false)
    const beforeReuse = providerCounts(harness)
    harness.agent.send(correct, 'next-turn', true)
    await harness.agent.whenIdle()
    const reused = freezeProductionLedger(harness)
    expect(providerCounts(harness)).toEqual(beforeReuse)
    expect(reused.events.filter(event => event.kind === 'search')).toHaveLength(1)
    expect(reused.events.filter(event => event.kind === 'evidence')).toHaveLength(1)
    expect(reused.events.filter(event => event.kind === 'presenter')).toHaveLength(1)
    expect(reused.events.filter(event => event.kind === 'state' && event.receiver === 'C20')).toHaveLength(1)
    expect(reused.events.filter(event => event.kind === 'state' && event.receiver === 'C21')).toHaveLength(1)
    expect(directEvents(reused.fullSessionEvents, String(correct.id))).toHaveLength(1)
    const correctAppend = reused.events.findIndex(event => event.kind === 'append' && event.id === String(correct.id))
    const reuseFlush = reused.events.findIndex((event, index) => index > correctAppend && event.kind === 'flush')
    const reuseRead = reused.events.findIndex((event, index) => index > reuseFlush && event.kind === 'read')
    const reusePresenter = reused.events.findIndex((event, index) => index > reuseRead
      && event.kind === 'agent-error' && event.message === stableFailure)
    expect(correctAppend).toBeGreaterThan(-1)
    expect(reuseFlush).toBeGreaterThan(correctAppend)
    expect(reuseRead).toBeGreaterThan(reuseFlush)
    expect(reusePresenter).toBeGreaterThan(reuseRead)
  })

  it('F separates C22, root, state, and publication faults while preserving one exact direct proof and the pre-existing focus state', async () => {
    const variants = ['C22', 'C20', 'C21', 'root', 'publish'] as const
    for (const variant of variants) {
      const harness = await fresh(`f03-f-${variant}-`)
      await establishFocus(harness)
      installReceiverLedger(harness.productionEvents)
      if (variant === 'C22') {
        vi.spyOn(UserInteractionAdvice.prototype, 'acceptFactDecisionNeeds').mockImplementation(() => {
          throw new Error('C22 fault')
        })
      }
      if (variant === 'C20') {
        vi.spyOn(EffectiveStatePreservation.prototype, 'acceptActionBoundaryToPreserve').mockImplementation(() => {
          throw new Error('C20 fault')
        })
      }
      if (variant === 'C21') {
        vi.spyOn(CanonicalContextAuthority.prototype, 'acceptActionSafetyBoundary').mockImplementation(() => {
          throw new Error('C21 fault')
        })
      }
      if (variant === 'root') harness.adapter.failure = 'root'
      if (variant === 'publish') {
        harness.search.available = false
        const table = harness.domain.table('focus_precanonical')
        const put = table.put.bind(table)
        let failed = false
        table.put = async (key, value) => {
          const phase = object(object(value)?.transaction)?.phase
          if (!failed && phase === 'pending') {
            failed = true
            throw new Error('publication fault')
          }
          await put(key, value)
        }
      }
      const before = providerCounts(harness)
      const direct = await send(harness.agent, factTracer)
      const ledger = freezeProductionLedger(harness)
      expect(directEvents(ledger.fullSessionEvents, String(direct.id))).toHaveLength(1)
      expect(parseCanonicalLocalRestrictionStateRecord(latestSidecar(ledger))).toBeUndefined()
      expect(parseCanonicalNoSafeActionStateRecord(latestSidecar(ledger))).toBeUndefined()
      if (variant === 'root') {
        expect(harness.adapter.rootCalls).toBe(before.root + 1)
        expect(ledger.events.some(event => event.kind === 'agent-error' && event.message === 'root provider failure')).toBe(true)
      } else {
        expect(harness.adapter.rootCalls).toBe(before.root)
        expect(ledger.events.some(event => event.kind === 'agent-error' && event.message === stableFailure)).toBe(true)
        const appendIndex = ledger.events.findIndex(event => event.kind === 'append' && event.id === String(direct.id))
        const flushIndex = ledger.events.findIndex((event, index) => index > appendIndex && event.kind === 'flush' && event.result)
        const readIndex = ledger.events.findIndex((event, index) => index > flushIndex && event.kind === 'read')
        const presenterIndex = ledger.events.findIndex((event, index) => index > readIndex
          && event.kind === 'agent-error' && event.message === stableFailure)
        expect(appendIndex).toBeGreaterThan(-1)
        expect(flushIndex).toBeGreaterThan(appendIndex)
        expect(readIndex).toBeGreaterThan(flushIndex)
        expect(presenterIndex).toBeGreaterThan(readIndex)
      }
      expect(ledger.surfaceMessages.some(message => message.source.kind === 'plugin'
        && message.source.plugin === 'ui-context-compactor:focus-canary-advice')).toBe(true)
      await dispose(harness)
      vi.restoreAllMocks()
    }
  })
})
