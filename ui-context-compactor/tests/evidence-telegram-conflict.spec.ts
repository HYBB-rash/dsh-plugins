import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
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
import WebRuntime, {
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
} from '@deepseek-ai/dsh-web'
import * as ContextManager from '../src/index.ts'
import {
  ActionFactBoundaryAuthority,
  type ActionBoundaryProposal,
  type ActionFactBoundary,
  type ActionRef,
  type ActionableFactMeaning,
  type C20Result,
  type C21Result,
  type C22Result,
  type EvidenceSourceRef,
  type FactAffectedScope,
  type FactRef,
  type UncertaintyMeaning,
} from '../src/action-boundary.ts'
import {
  EvidenceResolution,
  F03_EXACT_FOCUS_DIRECT,
  F03_EXACT_MULTI_SOURCE_DIRECT,
  type BoundedEvidenceProposalRequest,
  type EvidenceProposalOutcome,
  type EvidenceResolutionResult,
} from '../src/fact-resolution.ts'
import {
  FocusAuthority,
  createExplicitUserExpression,
  type ChatRef,
  type FocusDecision,
  type FocusDecisionRef,
  type FocusProposalOutcome,
} from '../src/focus.ts'
import { LocalRestrictionAdapter, UserInteractionAdvice } from '../src/local-restriction.ts'
import { ManagedAwareBasicCompactionEngine } from '../src/managed-compaction.ts'
import {
  type BoundedActionFactNeedProposal,
  type DirectMessageRef,
  type ExactDirectExpressionHash,
} from '../src/managed-runtime.ts'
import {
  CanonicalContextAuthority,
  CanonicalStateTransaction,
  EffectiveStatePreservation,
} from '../src/state-transaction.ts'

const contexts: Context[] = []
const roots: string[] = []
const sessionId = ContextManager.FOCUS_CANARY_IDS[0]
const focusDirect = F03_EXACT_FOCUS_DIRECT
const multiDirect = F03_EXACT_MULTI_SOURCE_DIRECT
const fact = 'DeepSeek Harness 最新版本'
const upgrade = '升级 DeepSeek Harness'
const inspect = '列出已确认的只读升级前检查'
const privateQuery = 'DeepSeek Harness latest version'
const observedAt = '2026-08-26T04:00:00.000Z'
const firstPublishedAt = '2026-08-25T09:30:00.000Z'
const secondPublishedAt = '2026-08-25T10:30:00.000Z'
const firstUrl = 'https://a.example.test/deepseek-harness/releases/latest'
const secondUrl = 'https://b.example.test/deepseek-harness/releases/latest'
const rawEnvelope = 'PRIVATE-RAW-SEARCH-ENVELOPE'
const stableFailure = '唯一背景未能安全换入，本轮未继续行动'

type ResolutionMode = 'agree' | 'conditional' | 'conflict' | 'source_incomplete'
type EvidenceFault = 'none' | 'url-only' | 'malformed' | 'empty' | 'overlong'

afterEach(async () => {
  vi.useRealTimers()
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

function hasSchema(options: GenerateOptions, plugin: string): boolean {
  return options.messages.some(message => message.source.kind === 'plugin'
    && message.source.plugin === plugin)
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

function messageText(message: UserMessage): string | undefined {
  return message.content.length === 1 && message.content[0]?.type === 'text'
    ? message.content[0].text
    : undefined
}

function directHash(messageId: string, text: string): string {
  return createHash('sha256').update(messageId).update('\0').update(text).digest('hex')
}

const exactActionProposal = JSON.stringify({
  actions: [upgrade, inspect],
  proposedRequirements: [{ fact, neededFor: [upgrade] }],
  usableInputs: [],
  unresolvedInputs: [{
    fact,
    meaning: '当前最新版本尚未核清',
    source: 'direct-user',
    degree: 'unknown',
    affected: upgrade,
  }],
})

const forgedNeedsProposal = JSON.stringify({
  actions: [upgrade, inspect],
  proposedRequirements: [{ fact: '外来事实', neededFor: [upgrade] }],
  usableInputs: [],
  unresolvedInputs: [{
    fact: '外来事实', meaning: '外来', source: 'foreign-source', degree: 'unknown', affected: upgrade,
  }],
})

const overbroadActionProposal = JSON.stringify({
  actions: [upgrade, inspect, '执行未授权升级动作'],
  proposedRequirements: [{ fact, neededFor: [upgrade] }],
  usableInputs: [],
  unresolvedInputs: [{
    fact, meaning: '当前最新版本尚未核清', source: 'direct-user', degree: 'unknown', affected: upgrade,
  }],
})

interface SourceVariant {
  readonly reverse: boolean
  readonly firstLabel: string
  readonly secondLabel: string
  readonly firstPublishedAt: string
  readonly secondPublishedAt: string
}

const ordinarySources: SourceVariant = Object.freeze({
  reverse: false,
  firstLabel: 'community-old-far',
  secondLabel: 'official-new-near',
  firstPublishedAt,
  secondPublishedAt,
})

function webResult(variant: SourceVariant, truncated = false, duplicate = false): WebSearchResult {
  const first = {
    url: firstUrl,
    snippet: `RAW-FIRST ${variant.firstLabel}`,
    publishedAt: variant.firstPublishedAt,
  }
  const second = {
    url: duplicate ? firstUrl : secondUrl,
    snippet: `RAW-SECOND ${variant.secondLabel}`,
    publishedAt: variant.secondPublishedAt,
  }
  return {
    content: rawEnvelope,
    sources: variant.reverse ? [second, first] : [first, second],
    truncated,
  }
}

class ConflictAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly rootRequests: GenerateOptions[] = []
  focusCalls = 0
  actionCalls = 0
  evidenceCalls = 0
  rootCalls = 0
  mode: ResolutionMode = 'agree'
  fault: EvidenceFault = 'none'
  wrongBinding = false
  actionOutput = exactActionProposal

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 16_384 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (hasSchema(options, 'ui-context-compactor:focus-canary-schema')) {
      this.focusCalls += 1
      yield* textChunks(JSON.stringify({ kind: 'focus', subject: focusDirect, relation: 'new' }))
      return
    }
    if (hasSchema(options, 'ui-context-compactor:action-fact-need-schema')) {
      this.actionCalls += 1
      yield* textChunks(this.actionOutput)
      return
    }
    if (hasSchema(options, 'ui-context-compactor:evidence-schema')) {
      this.evidenceCalls += 1
      const input = options.messages.at(-1)
      const projection = object(JSON.parse(input === undefined
        ? '{}'
        : requestText({ ...options, messages: [input] })))
      const material = object(projection?.material)
      const second = material?.url === secondUrl
      if (second && this.fault === 'malformed') { yield* textChunks('{"malformed":true}'); return }
      if (second && this.fault === 'empty') { yield* textChunks(''); return }
      if (second && this.fault === 'overlong') { yield* textChunks('x'.repeat(9_000)); return }
      const conditional = this.mode === 'conditional'
      const conflict = this.mode === 'conflict'
      yield* textChunks(JSON.stringify({
        kind: 'direct_fact',
        fact: projection?.fact,
        conclusion: second && (conditional || conflict) ? '1.4.3' : '1.4.2',
        appliesWhen: second && conditional ? 'preview channel' : 'stable channel',
        observedAt: material?.observedAt,
        publishedAt: material?.publishedAt ?? null,
        futureUse: second ? '仅用于第二来源的未来版本行动' : '仅用于第一来源的未来版本行动',
        source: this.wrongBinding && second ? 'foreign-source' : material?.source,
        degree: 'established',
        request: projection?.request,
        material: material?.ref,
        factNeeds: projection?.factNeeds,
      }))
      return
    }
    this.rootCalls += 1
    this.rootRequests.push(options)
    yield* textChunks('多来源事实已按行动边界处理。')
  }
}

interface Table {
  get(key: string): unknown
  put(key: string, value: unknown): Promise<void>
}

interface Domain { table(name: string): Table }

type ProductionEvent =
  | { readonly kind: 'search'; readonly request: WebSearchRequest; readonly result: WebSearchResult }
  | { readonly kind: 'resolution'; readonly result: EvidenceResolutionResult | undefined }
  | { readonly kind: 'receiver'; readonly contract: 'C22'; readonly report: C22Result }
  | { readonly kind: 'receiver'; readonly contract: 'C20'; readonly report: C20Result }
  | { readonly kind: 'receiver'; readonly contract: 'C21'; readonly report: C21Result }
  | { readonly kind: 'append'; readonly event: SessionEvent }
  | { readonly kind: 'sidecar'; readonly value: unknown }
  | { readonly kind: 'error'; readonly message: string }

interface FrozenLedger {
  readonly events: readonly ProductionEvent[]
  readonly sessionEvents: readonly SessionEvent[]
  readonly surfaceMessages: readonly UserMessage[]
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: ConflictAdapter
  readonly domain: Domain
  readonly events: ProductionEvent[]
  readonly search: {
    result: WebSearchResult
  }
}

const acceptResolution = EvidenceResolution.prototype.acceptFactNeeds
const acceptC22 = UserInteractionAdvice.prototype.acceptFactDecisionNeeds
const acceptC20 = EffectiveStatePreservation.prototype.acceptActionBoundaryToPreserve
const acceptC21 = CanonicalContextAuthority.prototype.acceptActionSafetyBoundary

async function mount(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'f03-t3-conflict-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mkdir(join(root, 'storages'), { recursive: true })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: join(root, 'storages', 'context-manager.sqlite') })
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
  await ctx.plugin(WebRuntime, { searchProvider: 'f03-conflict-search' })
  const events: ProductionEvent[] = []
  const search = { result: webResult(ordinarySources) }
  const provider: WebSearchProvider = {
    id: 'f03-conflict-search',
    available: () => true,
    search: async request => {
      events.push({ kind: 'search', request, result: search.result })
      return search.result
    },
  }
  ctx.web.registerSearchProvider(provider)
  const adapter = new ConflictAdapter()
  ctx.llm.registerAdapter(['f03-conflict'], adapter)
  let domain: Domain | undefined
  const facility: { open(spec: unknown): Promise<Domain> } = ctx.storageDomain
  const open = facility.open.bind(facility)
  facility.open = async spec => domain = await open(spec)
  await ctx.plugin(ContextManager, {
    focusCanary: {
      ...managedRuntime,
      auxiliary: {
        provider: 'f03-conflict', model: 'f03-conflict', maxOutputTokens: 256,
        timeoutMs: 500, maxExpressionChars: 240, maxProjectionTokens: 2_048,
        safetyMarginTokens: 128,
      },
    },
    nativeWriterArbitration: { mode: 'enforce' },
    evidenceCanary: { mode: 'enforce' },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (domain === undefined) throw new Error('missing real storage domain')
  const table = domain.table('focus_precanonical')
  const put = table.put.bind(table)
  table.put = async (key, value) => {
    events.push({ kind: 'sidecar', value })
    await put(key, value)
  }
  const agent = ctx.agentLoop.create(SessionId(sessionId), {
    provider: 'f03-conflict', model: 'f03-conflict',
  })
  ctx.on('session/event', (subject, event) => {
    if (subject === agent.session) events.push({ kind: 'append', event })
  })
  ctx.on('agent/error', ({ agent: subject, error }) => {
    if (subject === agent) events.push({
      kind: 'error', message: error instanceof Error ? error.message : String(error),
    })
  })
  return { ctx, agent, adapter, domain, events, search }
}

function installReceiverLedger(events: ProductionEvent[]): void {
  vi.spyOn(EvidenceResolution.prototype, 'acceptFactNeeds')
    .mockImplementation(async function (this: EvidenceResolution, needs, signal) {
      const result = await acceptResolution.call(this, needs, signal)
      events.push({ kind: 'resolution', result })
      return result
    })
  vi.spyOn(UserInteractionAdvice.prototype, 'acceptFactDecisionNeeds')
    .mockImplementation(function (this: UserInteractionAdvice, boundary) {
      const report = acceptC22.call(this, boundary)
      events.push({ kind: 'receiver', contract: 'C22', report })
      return report
    })
  vi.spyOn(EffectiveStatePreservation.prototype, 'acceptActionBoundaryToPreserve')
    .mockImplementation(function (this: EffectiveStatePreservation, boundary) {
      const report = acceptC20.call(this, boundary)
      events.push({ kind: 'receiver', contract: 'C20', report })
      return report
    })
  vi.spyOn(CanonicalContextAuthority.prototype, 'acceptActionSafetyBoundary')
    .mockImplementation(function (this: CanonicalContextAuthority, boundary) {
      const report = acceptC21.call(this, boundary)
      events.push({ kind: 'receiver', contract: 'C21', report })
      return report
    })
}

async function send(agent: Agent, text: string): Promise<UserMessage> {
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  agent.send(message, 'next-turn', true)
  await agent.whenIdle()
  return message
}

async function establishFocus(harness: Harness): Promise<void> {
  await send(harness.agent, focusDirect)
  expect(harness.adapter.focusCalls).toBe(1)
  expect(harness.adapter.rootCalls).toBe(1)
}

function freezeLedger(harness: Harness): FrozenLedger {
  return Object.freeze({
    events: Object.freeze([...harness.events]),
    sessionEvents: Object.freeze([...harness.agent.session.events]),
    surfaceMessages: Object.freeze(harness.agent.session.deriveMessages()
      .filter((message): message is UserMessage => message.role === 'user')),
  })
}

function rootPresentation(harness: Harness): string {
  const request = harness.adapter.rootRequests.at(-1)
  return request === undefined ? '' : requestText(request)
}

function latestResolution(ledger: FrozenLedger) {
  return ledger.events.filter((event): event is Extract<ProductionEvent, { readonly kind: 'resolution' }> =>
    event.kind === 'resolution').at(-1)?.result
}

function latestBoundary(ledger: FrozenLedger): ActionFactBoundary | undefined {
  const c22 = ledger.events.filter((event): event is Extract<ProductionEvent, { readonly kind: 'receiver' }> =>
    event.kind === 'receiver' && event.contract === 'C22').at(-1)?.report
  return c22?.kind === 'business_result' ? c22.value.value : undefined
}

function receiverCounts(ledger: FrozenLedger): Record<'C22' | 'C20' | 'C21', number> {
  return {
    C22: ledger.events.filter(event => event.kind === 'receiver' && event.contract === 'C22').length,
    C20: ledger.events.filter(event => event.kind === 'receiver' && event.contract === 'C20').length,
    C21: ledger.events.filter(event => event.kind === 'receiver' && event.contract === 'C21').length,
  }
}

function directEvents(events: readonly SessionEvent[], id: string): readonly SessionEvent<'user/message'>[] {
  return events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message'
    && event.data.source.kind === 'user' && String(event.data.id) === id)
}

interface FocusSnapshot {
  readonly record: unknown
  readonly event: string
  readonly focusCalls: number
}

function focusSnapshot(harness: Harness): FocusSnapshot {
  const record = harness.domain.table('focus_precanonical').get(sessionId)
  const event = harness.agent.session.events.find(candidate => candidate.type === 'user/message'
    && candidate.data.source.kind === 'user' && messageText(candidate.data) === focusDirect)
  if (event === undefined) throw new Error('missing physical focus event')
  return Object.freeze({ record, event: JSON.stringify(event), focusCalls: harness.adapter.focusCalls })
}

function expectFocusPreserved(harness: Harness, before: FocusSnapshot): void {
  const afterRecord = harness.domain.table('focus_precanonical').get(sessionId)
  const afterEvent = harness.agent.session.events.find(candidate => candidate.type === 'user/message'
    && candidate.data.source.kind === 'user' && messageText(candidate.data) === focusDirect)
  expect(JSON.stringify(afterEvent)).toBe(before.event)
  expect(harness.adapter.focusCalls).toBe(before.focusCalls)
  const beforeRecord = object(before.record)
  const beforeDecision = object(beforeRecord?.decision)
  expect(JSON.stringify(afterRecord)).toContain(String(beforeDecision?.ref))
  expect(JSON.stringify(afterRecord)).toContain(String(beforeDecision?.chat))
  expect(JSON.stringify(afterRecord)).toContain(String(beforeDecision?.currentMatter))
  expect(JSON.stringify(afterRecord)).toContain(String(beforeDecision?.latestCorrections))
}

function expectPrivateMaterialAbsent(text: string): void {
  expect(text).not.toContain(rawEnvelope)
  expect(text).not.toContain('RAW-FIRST')
  expect(text).not.toContain('RAW-SECOND')
  expect(text).not.toContain('factNeeds')
  expect(text).not.toContain('material:')
  expect(text).not.toContain(privateQuery)
}

async function naturalRun(
  mode: ResolutionMode,
  variant: SourceVariant = ordinarySources,
): Promise<{ readonly harness: Harness; readonly direct: UserMessage; readonly ledger: FrozenLedger }> {
  const harness = await mount()
  await establishFocus(harness)
  harness.adapter.mode = mode
  harness.search.result = mode === 'source_incomplete'
    ? { content: rawEnvelope, sources: [], truncated: false }
    : webResult(variant)
  vi.restoreAllMocks()
  installReceiverLedger(harness.events)
  const direct = await send(harness.agent, multiDirect)
  return Object.freeze({ harness, direct, ledger: freezeLedger(harness) })
}

type EstablishedFocus = Extract<FocusDecision, { readonly kind: 'focus_established' }>

function publicFocus(chat: ChatRef, seed: string): {
  readonly authority: FocusAuthority
  readonly focus: EstablishedFocus
} {
  const authority = FocusAuthority.createOwner()
  const messageId = `focus-${seed}`
  const origin = Object.freeze({ messageId, hash: directHash(messageId, focusDirect) })
  const proposal: FocusProposalOutcome = Object.freeze({
    kind: 'proposal', origin,
    value: Object.freeze({ kind: 'focus', subject: focusDirect, relation: 'new', origin }),
  })
  const result = authority.fromBoundProposal(proposal)
    .decideFocus(createExplicitUserExpression(focusDirect, chat, origin))
  if (result.kind !== 'business_result' || result.value.kind !== 'focus_established') {
    throw new Error('public focus was not established')
  }
  return Object.freeze({ authority, focus: result.value })
}

interface ManualCounts { search: number; semanticA: number; semanticB: number; C22: number; C20: number; C21: number }

function manualScenario(
  harness: Harness,
  options: {
    readonly mode?: ResolutionMode
    readonly abortB?: AbortController
    readonly failStage?: 'C22' | 'C20' | 'C21'
  } = {},
): {
  readonly composition: ReturnType<typeof ActionFactBoundaryAuthority.createComposition>
  readonly focus: EstablishedFocus
  readonly proposal: ActionBoundaryProposal
  readonly counts: ManualCounts
} {
  const counts: ManualCounts = { search: 0, semanticA: 0, semanticB: 0, C22: 0, C20: 0, C21: 0 }
  let failed = false
  const preservation = new EffectiveStatePreservation()
  const canonical = new CanonicalContextAuthority()
  const presenter = new UserInteractionAdvice()
  const composition = ActionFactBoundaryAuthority.createComposition({
    userInteraction: { acceptFactDecisionNeeds(boundary) {
      counts.C22 += 1
      if (options.failStage === 'C22' && !failed) { failed = true; throw new Error('C22 once') }
      return presenter.acceptFactDecisionNeeds(boundary)
    } },
    preservation: { acceptActionBoundaryToPreserve(boundary) {
      counts.C20 += 1
      if (options.failStage === 'C20' && !failed) { failed = true; throw new Error('C20 once') }
      return preservation.acceptActionBoundaryToPreserve(boundary)
    } },
    canonicalContext: { acceptActionSafetyBoundary(boundary) {
      counts.C21 += 1
      if (options.failStage === 'C21' && !failed) { failed = true; throw new Error('C21 once') }
      return canonical.acceptActionSafetyBoundary(boundary)
    } },
  }, {
    web: { search: async () => { counts.search += 1; return webResult(ordinarySources) } },
    semantic: { proposeEvidence: async (request, _signal): Promise<EvidenceProposalOutcome> => {
      const second = request.material.url === secondUrl
      if (second) counts.semanticB += 1
      else counts.semanticA += 1
      if (second && options.abortB !== undefined && counts.semanticB === 1) {
        options.abortB.abort()
        return Object.freeze({
          kind: 'unknown', request,
          detail: 'aborted B' as import('../src/fact-resolution.ts').EvidencePromiseDescription,
        })
      }
      const mode = options.mode ?? 'conflict'
      return semanticProposal(request,
        second && mode !== 'agree' ? '1.4.3' : '1.4.2',
        second && mode === 'conditional' ? 'preview channel' : 'stable channel')
    } },
    now: () => observedAt,
  })
  const chat = String(harness.agent.session.id) as ChatRef
  const established = publicFocus(chat, crypto.randomUUID())
  const focus = established.focus
  const direct = createUserMessage({ content: [{ type: 'text', text: multiDirect }], source: { kind: 'user' } })
  const claimed = composition.claimedStructuredDirectIssuer.issue(harness.agent.session, chat, direct)
  if (claimed === undefined) throw new Error('manual direct was not claimed')
  const messageId = String(direct.id)
  const origin = Object.freeze({
    message: messageId as DirectMessageRef,
    chat,
    expressionHash: directHash(messageId, multiDirect) as ExactDirectExpressionHash,
  })
  const unsigned: BoundedActionFactNeedProposal = Object.freeze({
    origin,
    focus: focus.ref,
    actions: Object.freeze([upgrade as ActionRef, inspect as ActionRef] as const),
    proposedRequirements: Object.freeze([Object.freeze({
      fact: fact as FactRef, neededFor: Object.freeze([upgrade as ActionRef] as const),
    })]),
    usableInputs: Object.freeze([]),
    unresolvedInputs: Object.freeze([Object.freeze({
      fact: fact as FactRef,
      meaning: '当前最新版本尚未核清' as UncertaintyMeaning,
      source: 'direct-user' as EvidenceSourceRef,
      degree: 'unknown' as const,
      affected: `actions:${upgrade}` as FactAffectedScope,
    })]),
  })
  const adapter = new LocalRestrictionAdapter({
    focus: established.authority,
    actionBoundaryOwner: composition.authority,
    completeActionBoundary: composition.completeLocalRestrictionBoundary,
    stateTransaction: new CanonicalStateTransaction(),
  })
  const proposal = adapter.formActionBoundaryProposal(focus, Object.freeze({
    kind: 'proposal' as const,
    origin: unsigned.origin,
    focus: unsigned.focus,
    value: unsigned,
  }), claimed)
  if (proposal === undefined) throw new Error('manual proposal was not registered')
  return Object.freeze({ composition, focus, proposal, counts })
}

function semanticProposal(
  request: BoundedEvidenceProposalRequest,
  conclusion: string,
  appliesWhen: string,
): EvidenceProposalOutcome & { readonly finding: object } {
  return Object.freeze({
    kind: 'proposal', request,
    value: Object.freeze({
      kind: 'direct_fact', fact: request.retrieval.need.fact,
      meaning: conclusion as ActionableFactMeaning,
      source: request.material.source, degree: 'established',
    }),
    finding: Object.freeze({
      factNeeds: request.factNeeds.ref, request: request.retrieval.ref,
      material: request.material.ref, fact: request.retrieval.need.fact,
      source: request.material.source, conclusion, appliesWhen,
      observedAt: request.material.observedAt, publishedAt: request.material.publishedAt,
      futureUse: '仅用于后续版本相关行动',
    }),
  })
}

describe('F03-T3 public multi-source evidence conflict composition', () => {
  it('P1 publishes one stable agree conclusion with two independent sources and one exact receiver chain', async () => {
    const forward = await naturalRun('agree')
    const resolution = latestResolution(forward.ledger)
    const boundary = latestBoundary(forward.ledger)
    if (resolution === undefined || !('kind' in resolution) || resolution.kind !== 'multi_source') {
      throw new Error('missing multi-source resolution')
    }
    expect(forward.ledger.events.filter(event => event.kind === 'search').map(event => event.request))
      .toStrictEqual([{ query: privateQuery, maxResults: 2 }])
    expect(forward.harness.adapter.evidenceCalls).toBe(2)
    expect(forward.ledger.events.filter(event => event.kind === 'resolution')).toHaveLength(1)
    expect(receiverCounts(forward.ledger)).toStrictEqual({ C22: 1, C20: 1, C21: 1 })
    expect(resolution.resolution).toBe('agree')
    expect(resolution.materials.map(material => material.ref)).toHaveLength(2)
    expect(new Set(resolution.materials.map(material => material.source)).size).toBe(2)
    expect(new Set(resolution.materials.map(material => material.url)).size).toBe(2)
    expect(boundary?.kind).toBe('actionable')
    expect(boundary?.usableFacts).toHaveLength(1)
    expect(boundary?.preciselyBlockedActions).toStrictEqual([])
    expect(boundary?.safelyContinuableActions).toStrictEqual([upgrade, inspect])
    const presentation = rootPresentation(forward.harness)
    expect(presentation).toContain(firstUrl)
    expect(presentation).toContain(secondUrl)
    expect(presentation).toContain('sourceOrder: 仅为稳定展示，不表示强弱或胜负')
    expectPrivateMaterialAbsent(presentation)

    const reverse = await naturalRun('agree', Object.freeze({ ...ordinarySources, reverse: true }))
    const reverseResolution = latestResolution(reverse.ledger)
    const reverseBoundary = latestBoundary(reverse.ledger)
    if (reverseResolution === undefined || !('kind' in reverseResolution)
      || reverseResolution.kind !== 'multi_source') throw new Error('missing reverse resolution')
    expect(reverseResolution.conclusions.conclusions[0]?.source).toBe(resolution.conclusions.conclusions[0]?.source)
    expect(reverseBoundary).toMatchObject({
      kind: boundary?.kind,
      preciselyBlockedActions: boundary?.preciselyBlockedActions,
      safelyContinuableActions: boundary?.safelyContinuableActions,
    })
  })

  it('P2 publishes a self-contained conditional DirectFact and preserves the exact focus record under reversed sources', async () => {
    const forwardHarness = await mount()
    await establishFocus(forwardHarness)
    const before = focusSnapshot(forwardHarness)
    forwardHarness.adapter.mode = 'conditional'
    installReceiverLedger(forwardHarness.events)
    await send(forwardHarness.agent, multiDirect)
    const forward = freezeLedger(forwardHarness)
    const resolution = latestResolution(forward)
    if (resolution === undefined || !('kind' in resolution) || resolution.kind !== 'multi_source') {
      throw new Error('missing conditional resolution')
    }
    expect(resolution.resolution).toBe('conditional')
    expect(resolution.conclusions.conclusions[0]).toMatchObject({
      kind: 'direct_fact', fact, degree: 'established',
    })
    const presentation = rootPresentation(forwardHarness)
    for (const expected of [
      'conclusion: 1.4.2', 'conclusion: 1.4.3',
      'appliesWhen: stable channel', 'appliesWhen: preview channel',
      `publishedAt: ${firstPublishedAt}`, `publishedAt: ${secondPublishedAt}`,
      'futureUse: 仅用于第一来源的未来版本行动',
      'futureUse: 仅用于第二来源的未来版本行动',
    ]) expect(presentation).toContain(expected)
    expect(presentation).toContain('observedAt:')
    expectFocusPreserved(forwardHarness, before)
    const directEvent = forward.sessionEvents.find((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message' && messageText(event.data) === multiDirect)
    expect(directEvent === undefined ? undefined : directHash(String(directEvent.data.id), multiDirect))
      .toBe(directEvent === undefined ? undefined : directHash(String(directEvent.data.id), messageText(directEvent.data) ?? ''))

    const reverse = await naturalRun('conditional', Object.freeze({ ...ordinarySources, reverse: true }))
    const reverseResolution = latestResolution(reverse.ledger)
    const reverseBoundary = latestBoundary(reverse.ledger)
    if (reverseResolution === undefined || !('kind' in reverseResolution)
      || reverseResolution.kind !== 'multi_source') throw new Error('missing reverse conditional')
    expect(reverseResolution.conclusions.conclusions[0]?.source).toBe(resolution.conclusions.conclusions[0]?.source)
    expect(reverseBoundary).toMatchObject({
      kind: latestBoundary(forward)?.kind,
      preciselyBlockedActions: latestBoundary(forward)?.preciselyBlockedActions,
      safelyContinuableActions: latestBoundary(forward)?.safelyContinuableActions,
    })
  })

  it('N1 exposes both conflicting conclusions while blocking only U without choosing a source', async () => {
    const run = await naturalRun('conflict')
    const resolution = latestResolution(run.ledger)
    const boundary = latestBoundary(run.ledger)
    if (resolution === undefined || !('kind' in resolution) || resolution.kind !== 'multi_source') {
      throw new Error('missing conflict resolution')
    }
    expect(resolution.resolution).toBe('conflict')
    expect(resolution.conclusions.conclusions[0]).toMatchObject({ fact, degree: 'conflicting' })
    expect(boundary?.kind).toBe('local_restriction')
    expect(boundary?.usableFacts).toStrictEqual([])
    expect(boundary?.preciselyBlockedActions).toStrictEqual([upgrade])
    expect(boundary?.safelyContinuableActions).toStrictEqual([inspect])
    const presentation = rootPresentation(run.harness)
    for (const value of [firstUrl, secondUrl, 'conclusion: 1.4.2', 'conclusion: 1.4.3', 'conflictPoint:']) {
      expect(presentation).toContain(value)
    }
    expect(presentation).not.toMatch(/preferred|rank|score|winner|trusted/i)
    expectPrivateMaterialAbsent(presentation)
  })

  it('N2 keeps conflict identity and action scope invariant across official/new/near labels, times and source reversal', async () => {
    const variants: readonly SourceVariant[] = [
      ordinarySources,
      Object.freeze({
        reverse: true, firstLabel: 'official-new-near', secondLabel: 'community-old-far',
        firstPublishedAt: secondPublishedAt, secondPublishedAt: firstPublishedAt,
      }),
    ]
    const identities: string[] = []
    const boundaries: string[] = []
    for (const variant of variants) {
      const run = await naturalRun('conflict', variant)
      const resolution = latestResolution(run.ledger)
      const boundary = latestBoundary(run.ledger)
      if (resolution === undefined || !('kind' in resolution) || resolution.kind !== 'multi_source'
        || boundary === undefined) throw new Error('missing invariant conflict')
      identities.push(String(resolution.conclusions.conclusions[0]?.source))
      boundaries.push(JSON.stringify({
        kind: boundary.kind,
        degree: boundary.unresolvedFacts[0]?.degree,
        source: boundary.unresolvedFacts[0]?.source,
        blocked: boundary.preciselyBlockedActions,
        safe: boundary.safelyContinuableActions,
      }))
      expect(boundary.preciselyBlockedActions).toStrictEqual([upgrade])
      expect(boundary.safelyContinuableActions).toStrictEqual([inspect])
      expect(rootPresentation(run.harness)).not.toMatch(/preferred|rank|score|winner|trusted/i)
    }
    expect(new Set(identities).size).toBe(1)
    expect(new Set(boundaries).size).toBe(1)
  })

  it('N3 rejects every incomplete or cross-wired second source without DirectFact, leakage or slot pollution', async () => {
    const variants: readonly {
      readonly fault: EvidenceFault
      readonly truncated?: boolean
      readonly duplicate?: boolean
      readonly wrongBinding?: boolean
      readonly mixedUrlOnly?: boolean
    }[] = [
      { fault: 'url-only' }, { fault: 'url-only', mixedUrlOnly: true },
      { fault: 'malformed' }, { fault: 'empty' }, { fault: 'overlong' },
      { fault: 'none', truncated: true }, { fault: 'none', duplicate: true }, { fault: 'none', wrongBinding: true },
    ]
    for (const variant of variants) {
      const harness = await mount()
      await establishFocus(harness)
      harness.adapter.mode = 'source_incomplete'
      harness.adapter.fault = variant.fault
      harness.adapter.wrongBinding = variant.wrongBinding === true
      harness.search.result = variant.fault === 'url-only'
        ? {
            content: rawEnvelope,
            sources: variant.mixedUrlOnly === true
              ? [{ url: firstUrl, snippet: 'RAW-FIRST complete-A' }, { url: secondUrl }]
              : [{ url: firstUrl }, { url: secondUrl }],
            truncated: false,
          }
        : webResult(ordinarySources, variant.truncated, variant.duplicate)
      vi.restoreAllMocks()
      installReceiverLedger(harness.events)
      await send(harness.agent, multiDirect)
      const ledger = freezeLedger(harness)
      const resolution = latestResolution(ledger)
      if (resolution !== undefined && 'kind' in resolution && resolution.kind === 'multi_source') {
        expect(resolution.resolution).toBe('source_incomplete')
        expect(resolution.conclusions.conclusions[0]).not.toHaveProperty('kind', 'direct_fact')
        if (variant.mixedUrlOnly === true) {
          if (resolution.c12.kind !== 'business_result') throw new Error('missing partial C12 materials')
          expect(resolution.c12.value.actualMaterials).toHaveLength(1)
          expect(resolution.c12.value.sources).toHaveLength(1)
          expect(resolution.materials).toHaveLength(1)
          expect(resolution.materials[0]?.url).toBe(firstUrl)
          expect(resolution.findings).toHaveLength(1)
          expect(resolution.findings[0]).toMatchObject({
            material: resolution.materials[0]?.ref,
            source: resolution.materials[0]?.source,
            fact,
          })
          expect(resolution.provenances).toHaveLength(1)
          expect(resolution.provenances[0]).toMatchObject({
            source: resolution.materials[0]?.source,
            url: firstUrl,
          })
          expect(resolution.conclusions.conclusions.filter(conclusion =>
            'kind' in conclusion && conclusion.kind === 'direct_fact')).toHaveLength(0)
          expect(harness.adapter.evidenceCalls).toBe(1)
          expect(ledger.events.filter(event => event.kind === 'search')).toHaveLength(1)
          expect(latestBoundary(ledger)?.usableFacts).toStrictEqual([])
        }
      }
      const presentation = rootPresentation(harness)
      expect(presentation).not.toContain('sameConclusion:')
      if (variant.mixedUrlOnly === true) {
        expect(presentation).toContain('obtainedSources: 1/2')
        expect(presentation).toContain('verifiedFindings: 1/2')
        expect(presentation).toContain(firstUrl)
        expect(presentation).not.toContain(secondUrl)
      }
      expectPrivateMaterialAbsent(presentation)
    }

    vi.restoreAllMocks()
    const harness = await mount()
    const abort = new AbortController()
    const retry = manualScenario(harness, { mode: 'agree', abortB: abort })
    expect(await retry.composition.completeEvidenceActionFactBoundary.accept(
      retry.focus, retry.proposal, abort.signal,
    )).toBeUndefined()
    expect(retry.counts).toMatchObject({ search: 1, semanticA: 1, semanticB: 1 })
    const completion = await retry.composition.completeEvidenceActionFactBoundary.accept(
      retry.focus, retry.proposal, new AbortController().signal,
    )
    expect(completion !== undefined && 'kind' in completion ? completion.kind : undefined).toBe('multi_source')
    expect(retry.counts).toMatchObject({ search: 1, semanticA: 1, semanticB: 2 })
  })

  it('N4 rejects owner, chat, focus, direct-hash, forged-needs and reuse qualifications without consuming a correct path', async () => {
    const harness = await mount()
    await establishFocus(harness)
    harness.adapter.actionOutput = forgedNeedsProposal
    installReceiverLedger(harness.events)
    await send(harness.agent, multiDirect)
    const forged = freezeLedger(harness)
    expect(forged.events.filter(event => event.kind === 'search')).toHaveLength(0)
    expect(harness.adapter.evidenceCalls).toBe(0)
    expect(receiverCounts(forged)).toStrictEqual({ C22: 0, C20: 0, C21: 0 })

    const correct = manualScenario(harness, { mode: 'agree' })
    const foreign = manualScenario(harness, { mode: 'agree' })
    const wrongFocus = Object.freeze({
      ...correct.focus,
      ref: 'focus:foreign' as FocusDecisionRef,
    })
    const wrongChat = Object.freeze({
      ...correct.focus,
      chat: 'chat:foreign' as ChatRef,
    })
    const wrongHashUnsigned: BoundedActionFactNeedProposal = Object.freeze({
      ...correct.proposal.unsigned,
      origin: Object.freeze({
        ...correct.proposal.unsigned.origin,
        expressionHash: '0'.repeat(64) as ExactDirectExpressionHash,
      }),
    })
    const wrongHash: ActionBoundaryProposal = Object.freeze({
      admission: correct.proposal.admission,
      unsigned: wrongHashUnsigned,
    })
    expect(await correct.composition.completeEvidenceActionFactBoundary.accept(
      wrongFocus, correct.proposal, new AbortController().signal,
    )).toBeUndefined()
    expect(await correct.composition.completeEvidenceActionFactBoundary.accept(
      wrongChat, correct.proposal, new AbortController().signal,
    )).toBeUndefined()
    expect(await correct.composition.completeEvidenceActionFactBoundary.accept(
      correct.focus, wrongHash, new AbortController().signal,
    )).toBeUndefined()
    expect(await foreign.composition.completeEvidenceActionFactBoundary.accept(
      correct.focus, correct.proposal, new AbortController().signal,
    )).toBeUndefined()
    expect(correct.counts).toStrictEqual({ search: 0, semanticA: 0, semanticB: 0, C22: 0, C20: 0, C21: 0 })
    expect(foreign.counts).toStrictEqual({ search: 0, semanticA: 0, semanticB: 0, C22: 0, C20: 0, C21: 0 })
    const completion = await correct.composition.completeEvidenceActionFactBoundary.accept(
      correct.focus, correct.proposal, new AbortController().signal,
    )
    expect(completion !== undefined && 'kind' in completion ? completion.kind : undefined).toBe('multi_source')
    const settled = { ...correct.counts }
    expect(await correct.composition.completeEvidenceActionFactBoundary.accept(
      correct.focus, correct.proposal, new AbortController().signal,
    )).toBeUndefined()
    expect(correct.counts).toStrictEqual(settled)
  })

  it('N5 preserves focus, correction and direct physical evidence across conditional and conflict without a second FocusDecision', async () => {
    for (const mode of ['conditional', 'conflict'] as const) {
      const harness = await mount()
      await establishFocus(harness)
      const before = focusSnapshot(harness)
      harness.adapter.mode = mode
      installReceiverLedger(harness.events)
      const direct = await send(harness.agent, multiDirect)
      const ledger = freezeLedger(harness)
      expectFocusPreserved(harness, before)
      expect(harness.adapter.focusCalls).toBe(1)
      const physical = directEvents(ledger.sessionEvents, String(direct.id))
      expect(physical).toHaveLength(1)
      expect(messageText(physical[0]!.data)).toBe(multiDirect)
      expect(directHash(String(physical[0]!.data.id), messageText(physical[0]!.data) ?? ''))
        .toBe(directHash(String(direct.id), multiDirect))
    }
  })

  it('N6 resumes only B and each failed receiver stage, while presentation/publication failures close to one physical direct', async () => {
    const harness = await mount()
    const abort = new AbortController()
    const resumed = manualScenario(harness, { mode: 'conflict', abortB: abort })
    expect(await resumed.composition.completeEvidenceActionFactBoundary.accept(
      resumed.focus, resumed.proposal, abort.signal,
    )).toBeUndefined()
    expect(await resumed.composition.completeEvidenceActionFactBoundary.accept(
      resumed.focus, resumed.proposal, new AbortController().signal,
    )).toMatchObject({ kind: 'multi_source', family: 'local_restriction' })
    expect(resumed.counts).toMatchObject({ search: 1, semanticA: 1, semanticB: 2 })

    for (const stage of ['C22', 'C20', 'C21'] as const) {
      const staged = manualScenario(harness, { mode: 'conflict', failStage: stage })
      expect(await staged.composition.completeEvidenceActionFactBoundary.accept(
        staged.focus, staged.proposal, new AbortController().signal,
      )).toBeUndefined()
      const upstream = { search: staged.counts.search, A: staged.counts.semanticA, B: staged.counts.semanticB }
      expect(await staged.composition.completeEvidenceActionFactBoundary.accept(
        staged.focus, staged.proposal, new AbortController().signal,
      )).toMatchObject({ kind: 'multi_source', family: 'local_restriction' })
      expect({ search: staged.counts.search, A: staged.counts.semanticA, B: staged.counts.semanticB }).toStrictEqual(upstream)
      expect(staged.counts[stage]).toBe(2)
    }

    const publication = await mount()
    await establishFocus(publication)
    publication.adapter.mode = 'conflict'
    installReceiverLedger(publication.events)
    const table = publication.domain.table('focus_precanonical')
    const before = table.get(sessionId)
    table.put = async () => { throw new Error('publication failure') }
    const direct = await send(publication.agent, multiDirect)
    const ledger = freezeLedger(publication)
    expect(directEvents(ledger.sessionEvents, String(direct.id))).toHaveLength(1)
    expect(table.get(sessionId)).toStrictEqual(before)
    expect(ledger.events.some(event => event.kind === 'error' && event.message === stableFailure)).toBe(true)
    expect(rootPresentation(publication)).not.toContain('ui-context-compactor:multi-source-evidence')
    expectPrivateMaterialAbsent(rootPresentation(publication))

    const presentation = await mount()
    await establishFocus(presentation)
    presentation.adapter.mode = 'agree'
    presentation.adapter.actionOutput = overbroadActionProposal
    installReceiverLedger(presentation.events)
    const rootCalls = presentation.adapter.rootCalls
    const presentationDirect = await send(presentation.agent, multiDirect)
    const presentationLedger = freezeLedger(presentation)
    expect(presentation.adapter.rootCalls).toBe(rootCalls)
    expect(directEvents(presentationLedger.sessionEvents, String(presentationDirect.id))).toHaveLength(1)
    expect(presentationLedger.events.some(event => event.kind === 'error'
      && event.message === stableFailure)).toBe(true)
    expectPrivateMaterialAbsent(rootPresentation(presentation))
  })
})
