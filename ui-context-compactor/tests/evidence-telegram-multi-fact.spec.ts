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
  type ActionFactBoundary,
  type ActionableFactMeaning,
  type ActionRef,
  type C20Result,
  type C21Result,
  type C22Result,
  type CompletedEvidenceActionFactBoundary,
  type EvidenceSourceRef,
  type FactAffectedScope,
  type FactRef,
  type UncertaintyMeaning,
} from '../src/action-boundary.ts'
import {
  EvidenceResolution,
  type BoundedEvidenceProposalRequest,
  type EvidenceProposalOutcome,
  type EvidencePromiseDescription,
  type EvidenceResolutionResult,
  type MultiFactEvidenceResolutionOutcome,
} from '../src/fact-resolution.ts'
import {
  FocusAuthority,
  UserInteractionAdvice as FocusUserInteractionAdvice,
  createExplicitUserExpression,
  type ChatRef,
  type FocusDecision,
  type FocusProposalOutcome,
} from '../src/focus.ts'
import { LocalRestrictionAdapter, UserInteractionAdvice } from '../src/local-restriction.ts'
import { ManagedAwareBasicCompactionEngine } from '../src/managed-compaction.ts'
import {
  createBoundedActionFactNeedProposalRequest,
  type BoundedActionFactNeedProposal,
  type BoundedActionFactNeedProposalOutcome,
} from '../src/managed-runtime.ts'
import {
  CanonicalContextAuthority,
  CanonicalStateTransaction,
  EffectiveStatePreservation,
} from '../src/state-transaction.ts'

const contexts: Context[] = []
const roots: string[] = []
const sessionId = ContextManager.FOCUS_CANARY_IDS[0]
const focusDirect = '准备升级 DeepSeek Harness'
const multiDirect = '查一下 DeepSeek Harness 当前最新版本和该版本要求的 Node.js 版本；分别确认后再决定是否升级。'
const factA = 'DeepSeek Harness 最新版本'
const factB = 'DeepSeek Harness 最新版本的 Node.js 版本要求'
const actionU = '升级 DeepSeek Harness'
const actionN = '核对当前 Node.js 是否兼容'
const actionR = '列出已确认的只读升级前检查'
const queryA = 'DeepSeek Harness latest version'
const queryB = 'DeepSeek Harness latest version Node.js requirements'
const urlA = 'https://example.test/deepseek-harness/releases/latest'
const urlB = 'https://example.test/deepseek-harness/releases/latest/node-requirements'
const publishedA = '2026-08-25T09:30:00.000Z'
const publishedB = '2026-08-25T09:35:00.000Z'
const contentA = 'DeepSeek Harness 当前最新稳定版本为 1.4.2。'
const contentB = 'DeepSeek Harness 1.4.2 要求 Node.js 22 或更新版本。'

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

function directHash(id: string, text: string): string {
  return createHash('sha256').update(id).update('\0').update(text).digest('hex')
}

function sourceRef(url: string): EvidenceSourceRef {
  return `web-source:${createHash('sha256').update(url).digest('hex')}` as EvidenceSourceRef
}

function webResultFor(query: string): WebSearchResult {
  if (query === queryA) {
    return { content: 'raw provider A', sources: [{ url: urlA, snippet: contentA, publishedAt: publishedA }], truncated: false }
  }
  if (query === queryB) {
    return { content: 'raw provider B', sources: [{ url: urlB, snippet: contentB, publishedAt: publishedB }], truncated: false }
  }
  return { content: 'foreign raw provider result', sources: [], truncated: false }
}

const forwardProposal = JSON.stringify({
  actions: [actionU, actionN, actionR],
  proposedRequirements: [
    { fact: factA, neededFor: [actionU] },
    { fact: factB, neededFor: [actionU, actionN] },
  ],
  usableInputs: [],
  unresolvedInputs: [
    { fact: factA, meaning: 'A 尚未核清', source: 'direct-user', degree: 'unknown', affected: actionU },
    { fact: factB, meaning: 'B 尚未核清', source: 'direct-user', degree: 'unknown', affected: `${actionU}|${actionN}` },
  ],
})

class MultiFactAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly rootRequests: GenerateOptions[] = []
  focusCalls = 0
  actionCalls = 0
  evidenceCalls = 0
  rootCalls = 0
  actionOutput = forwardProposal

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
      const projection = object(JSON.parse(requestText(options.messages[1] === undefined
        ? options
        : { ...options, messages: [options.messages[1]] })))
      const material = object(projection?.material)
      const fact = projection?.fact
      yield* textChunks(JSON.stringify({
        kind: 'direct_fact',
        fact,
        meaning: fact === factA ? 'DeepSeek Harness 当前最新稳定版本为 1.4.2' : 'DeepSeek Harness 1.4.2 要求 Node.js 22 或更新版本',
        source: material?.source,
        degree: 'established',
        request: projection?.request,
        material: material?.ref,
        factNeeds: projection?.factNeeds,
      }))
      return
    }
    this.rootCalls += 1
    this.rootRequests.push(options)
    yield* textChunks('两个事实已分别核清；等待你决定是否升级。')
  }
}

interface Table {
  get(key: string): unknown
  put(key: string, value: unknown): Promise<void>
}

interface Domain { table(name: string): Table }

type ProductionEvent =
  | { readonly kind: 'search'; readonly request: WebSearchRequest; readonly result: WebSearchResult }
  | { readonly kind: 'resolution'; readonly outcome: EvidenceResolutionResult | undefined }
  | { readonly kind: 'semantic'; readonly request: BoundedEvidenceProposalRequest }
  | { readonly kind: 'receiver'; readonly receiver: 'C22'; readonly report: C22Result }
  | { readonly kind: 'receiver'; readonly receiver: 'C20'; readonly report: C20Result }
  | { readonly kind: 'receiver'; readonly receiver: 'C21'; readonly report: C21Result }
  | { readonly kind: 'append'; readonly event: SessionEvent }
  | { readonly kind: 'sidecar'; readonly value: unknown }

interface FrozenProductionLedger {
  readonly events: readonly ProductionEvent[]
  readonly sessionEvents: readonly SessionEvent[]
  readonly surfaceMessages: readonly UserMessage[]
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: MultiFactAdapter
  readonly domain: Domain
  readonly root: string
  readonly events: ProductionEvent[]
  readonly search: {
    handle(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
  }
}

async function mount(root: string): Promise<Harness> {
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
  await ctx.plugin(WebRuntime, { searchProvider: 'f03-multi-test-search' })
  const events: ProductionEvent[] = []
  const search = {
    async handle(request: WebSearchRequest): Promise<WebSearchResult> {
      return webResultFor(request.query)
    },
  }
  const provider: WebSearchProvider = {
    id: 'f03-multi-test-search',
    available: () => true,
    search: async request => {
      const result = await search.handle(request)
      events.push({ kind: 'search', request, result })
      return result
    },
  }
  ctx.web.registerSearchProvider(provider)
  const adapter = new MultiFactAdapter()
  ctx.llm.registerAdapter(['f03-multi-test'], adapter)
  let domain: Domain | undefined
  const facility: { open(spec: unknown): Promise<Domain> } = ctx.storageDomain
  const open = facility.open.bind(facility)
  facility.open = async spec => domain = await open(spec)
  await ctx.plugin(ContextManager, {
    focusCanary: {
      ...managedRuntime,
      auxiliary: {
        provider: 'f03-multi-test', model: 'f03-multi-test', maxOutputTokens: 256,
        timeoutMs: 500, maxExpressionChars: 240, maxProjectionTokens: 2_048,
        safetyMarginTokens: 128,
      },
    },
    nativeWriterArbitration: { mode: 'enforce' },
    evidenceCanary: { mode: 'enforce' },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (domain === undefined) throw new Error('missing real SQLite storage domain')
  const table = domain.table('focus_precanonical')
  const put = table.put.bind(table)
  table.put = async (key, value) => {
    events.push({ kind: 'sidecar', value })
    await put(key, value)
  }
  const agent = ctx.agentLoop.create(SessionId(sessionId), {
    provider: 'f03-multi-test', model: 'f03-multi-test',
  })
  ctx.on('session/event', (subject, event) => {
    if (subject === agent.session) events.push({ kind: 'append', event })
  })
  return { ctx, agent, adapter, domain, root, events, search }
}

async function fresh(prefix: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return await mount(root)
}

async function send(agent: Agent, text: string): Promise<UserMessage> {
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  agent.send(message, 'next-turn', true)
  await agent.whenIdle()
  return message
}

async function establishFocus(harness: Harness): Promise<void> {
  await send(harness.agent, focusDirect)
  if (harness.adapter.focusCalls !== 1 || harness.adapter.rootCalls !== 1) {
    throw new Error('real public focus lifecycle did not establish once')
  }
}

function freezeLedger(harness: Harness, extra: readonly ProductionEvent[] = []): FrozenProductionLedger {
  return Object.freeze({
    events: Object.freeze([...harness.events, ...extra]),
    sessionEvents: Object.freeze([...harness.agent.session.events]),
    surfaceMessages: Object.freeze(harness.agent.session.deriveMessages()
      .filter((message): message is UserMessage => message.role === 'user')),
  })
}

type EstablishedFocus = Extract<FocusDecision, { readonly kind: 'focus_established' }>
type ExactActions = readonly [ActionRef, ...ActionRef[]]
type RequirementInput = {
  readonly fact: FactRef
  readonly neededFor: ExactActions
}
type SemanticMode = 'direct' | 'known-failure' | 'throw' | 'wrong-request' | 'wrong-source'

const refA = factA as FactRef
const refB = factB as FactRef
const refU = actionU as ActionRef
const refN = actionN as ActionRef
const refR = actionR as ActionRef
const actionsWithRead: ExactActions = Object.freeze([refU, refN, refR])
const actionsNoRead: ExactActions = Object.freeze([refU, refN])
const requirementA: RequirementInput = Object.freeze({ fact: refA, neededFor: Object.freeze([refU] as const) })
const requirementB: RequirementInput = Object.freeze({ fact: refB, neededFor: Object.freeze([refU, refN] as const) })

function createPublicFocus(chat: ChatRef, seed: string): {
  readonly authority: FocusAuthority
  readonly focus: EstablishedFocus
} {
  const authority = FocusAuthority.createOwner()
  const messageId = `f03-multi-focus-${seed}`
  const origin = Object.freeze({ messageId, hash: directHash(messageId, focusDirect) })
  const expression = createExplicitUserExpression(focusDirect, chat, origin)
  const proposal: FocusProposalOutcome = Object.freeze({
    kind: 'proposal', origin,
    value: Object.freeze({ kind: 'focus', relation: 'new', subject: focusDirect, origin }),
  })
  const c01 = authority.fromBoundProposal(proposal).decideFocus(expression)
  if (c01.kind !== 'business_result' || c01.value.kind !== 'focus_established') {
    throw new Error('public C01 did not establish multi-fact focus')
  }
  const c08 = new FocusUserInteractionAdvice().acceptMatterRelation(c01.value)
  if (c08.kind !== 'business_result' || c08.value.kind !== 'accepted_for_contract'
    || c08.value.value !== c01.value) throw new Error('public C08 did not accept multi-fact focus')
  return Object.freeze({ authority, focus: c08.value.value })
}

function formProposal(
  harness: Harness,
  composition: ReturnType<typeof ActionFactBoundaryAuthority.createComposition>,
  focusAuthority: FocusAuthority,
  focus: EstablishedFocus,
  seed: string,
  requirements: readonly RequirementInput[] = Object.freeze([requirementA, requirementB]),
  actions: ExactActions = actionsWithRead,
  directText = multiDirect,
): { readonly direct: UserMessage; readonly proposal: Parameters<typeof composition.completeEvidenceActionFactBoundary.accept>[1] } | undefined {
  if (seed.length === 0) return undefined
  const direct = createUserMessage({ content: [{ type: 'text', text: directText }], source: { kind: 'user' } })
  const claimed = composition.claimedStructuredDirectIssuer.issue(harness.agent.session, focus.chat, direct)
  if (claimed === undefined) return undefined
  const origin = Object.freeze({ messageId: String(direct.id), hash: directHash(String(direct.id), directText) })
  const expression = createExplicitUserExpression(directText, focus.chat, origin)
  const request = createBoundedActionFactNeedProposalRequest(expression, origin, focus)
  if (request === undefined) return undefined
  const unresolvedInputs = requirements.map(requirement => Object.freeze({
    fact: requirement.fact,
    meaning: `${requirement.fact} 尚未核清` as UncertaintyMeaning,
    source: 'direct-user' as EvidenceSourceRef,
    degree: 'unknown' as const,
    affected: `actions:${requirement.neededFor.join('|')}` as FactAffectedScope,
  }))
  const value: BoundedActionFactNeedProposal = Object.freeze({
    origin: request.origin,
    focus: request.focus.ref,
    actions,
    proposedRequirements: Object.freeze(requirements),
    usableInputs: Object.freeze([]),
    unresolvedInputs: Object.freeze(unresolvedInputs),
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
  return proposal === undefined ? undefined : Object.freeze({ direct, proposal })
}

interface CompositionControls {
  modeA: SemanticMode
  modeB: SemanticMode
  stageFault: 'none' | 'C22' | 'C20' | 'C21'
  stageFaultPending: boolean
  attempts?: { C22: number; C20: number; C21: number }
}

function installResolutionLedger(events: ProductionEvent[]): void {
  const original = EvidenceResolution.prototype.acceptFactNeeds
  vi.spyOn(EvidenceResolution.prototype, 'acceptFactNeeds')
    .mockImplementation(async function (this: EvidenceResolution, needs, signal) {
      const outcome = await original.call(this, needs, signal)
      events.push({ kind: 'resolution', outcome })
      return outcome
    })
}

function installPluginReceiverLedger(events: ProductionEvent[]): void {
  installResolutionLedger(events)
  const originalC20 = EffectiveStatePreservation.prototype.acceptActionBoundaryToPreserve
  vi.spyOn(EffectiveStatePreservation.prototype, 'acceptActionBoundaryToPreserve')
    .mockImplementation(function (this: EffectiveStatePreservation, boundary) {
      const report = originalC20.call(this, boundary)
      events.push({ kind: 'receiver', receiver: 'C20', report })
      return report
    })
  const originalC21 = CanonicalContextAuthority.prototype.acceptActionSafetyBoundary
  vi.spyOn(CanonicalContextAuthority.prototype, 'acceptActionSafetyBoundary')
    .mockImplementation(function (this: CanonicalContextAuthority, boundary) {
      const report = originalC21.call(this, boundary)
      events.push({ kind: 'receiver', receiver: 'C21', report })
      return report
    })
  const originalC22 = UserInteractionAdvice.prototype.acceptFactDecisionNeeds
  vi.spyOn(UserInteractionAdvice.prototype, 'acceptFactDecisionNeeds')
    .mockImplementation(function (this: UserInteractionAdvice, boundary) {
      const report = originalC22.call(this, boundary)
      events.push({ kind: 'receiver', receiver: 'C22', report })
      return report
    })
}

function createComposition(
  harness: Harness,
  events: ProductionEvent[],
  controls: CompositionControls = {
    modeA: 'direct', modeB: 'direct', stageFault: 'none', stageFaultPending: false,
  },
): ReturnType<typeof ActionFactBoundaryAuthority.createComposition> {
  const preservation = new EffectiveStatePreservation()
  const canonical = new CanonicalContextAuthority()
  const presenter = new UserInteractionAdvice()
  return ActionFactBoundaryAuthority.createComposition({
    preservation: Object.freeze({
      acceptActionBoundaryToPreserve: (boundary: ActionFactBoundary) => {
        if (controls.attempts !== undefined) controls.attempts.C20 += 1
        if (controls.stageFault === 'C20' && controls.stageFaultPending) {
          controls.stageFaultPending = false
          throw new Error('injected C20 fault')
        }
        const report = preservation.acceptActionBoundaryToPreserve(boundary)
        events.push({ kind: 'receiver', receiver: 'C20', report })
        return report
      },
    }),
    canonicalContext: Object.freeze({
      acceptActionSafetyBoundary: (boundary: ActionFactBoundary) => {
        if (controls.attempts !== undefined) controls.attempts.C21 += 1
        if (controls.stageFault === 'C21' && controls.stageFaultPending) {
          controls.stageFaultPending = false
          throw new Error('injected C21 fault')
        }
        const report = canonical.acceptActionSafetyBoundary(boundary)
        events.push({ kind: 'receiver', receiver: 'C21', report })
        return report
      },
    }),
    userInteraction: Object.freeze({
      acceptFactDecisionNeeds: (boundary: ActionFactBoundary) => {
        if (controls.attempts !== undefined) controls.attempts.C22 += 1
        if (controls.stageFault === 'C22' && controls.stageFaultPending) {
          controls.stageFaultPending = false
          throw new Error('injected C22 fault')
        }
        const report = presenter.acceptFactDecisionNeeds(boundary)
        events.push({ kind: 'receiver', receiver: 'C22', report })
        return report
      },
    }),
  }, {
    web: Object.freeze({
      search: async (request: WebSearchRequest, signal?: AbortSignal) =>
        signal?.aborted === true ? Promise.reject(new Error('search aborted before WebRuntime')) : await harness.ctx.web.search(request),
    }),
    semantic: Object.freeze({
      proposeEvidence: async (
        request: BoundedEvidenceProposalRequest,
      ): Promise<EvidenceProposalOutcome> => {
        events.push({ kind: 'semantic', request })
        const mode = request.retrieval.need.fact === refA ? controls.modeA : controls.modeB
        if (mode === 'throw') throw new Error(`semantic fault for ${request.retrieval.need.fact}`)
        if (mode === 'known-failure') {
          return Object.freeze({
            kind: 'known_failure', request,
            detail: `semantic-failure:${request.retrieval.need.fact}` as EvidencePromiseDescription,
          })
        }
        const source = mode === 'wrong-source'
          ? 'foreign-source' as EvidenceSourceRef
          : request.material.source
        const value = Object.freeze({
          kind: 'direct_fact' as const,
          fact: request.retrieval.need.fact,
          meaning: (request.retrieval.need.fact === refA
            ? 'DeepSeek Harness 当前最新稳定版本为 1.4.2'
            : 'DeepSeek Harness 1.4.2 要求 Node.js 22 或更新版本') as ActionableFactMeaning,
          source,
          degree: 'established' as const,
        })
        if (mode === 'wrong-request') {
          const foreignRequest = Object.freeze({
            ...request,
            origin: Object.freeze({ ...request.origin, messageId: `${request.origin.messageId}-foreign` }),
          })
          return Object.freeze({ kind: 'proposal', request: foreignRequest, value })
        }
        return Object.freeze({ kind: 'proposal', request, value })
      },
    }),
    now: () => '2026-08-26T00:00:00.000Z',
  })
}

function multiOutcome(event: ProductionEvent | undefined): MultiFactEvidenceResolutionOutcome | undefined {
  if (event?.kind !== 'resolution' || event.outcome === undefined
    || !('kind' in event.outcome) || event.outcome.kind !== 'multi') return undefined
  return event.outcome
}

function completionKeys(completion: CompletedEvidenceActionFactBoundary): readonly string[] {
  return Object.freeze(Object.keys(completion).sort())
}

function publicText(ledger: FrozenProductionLedger): string {
  return ledger.surfaceMessages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

describe('F03-T2 two external facts through the public Telegram production composition', () => {
  it('P1 resolves A and B as DirectFact once and publishes one exact actionable boundary in requirement order', async () => {
    const harness = await fresh('f03-t2-p1-')
    await establishFocus(harness)
    const receiverEvents: ProductionEvent[] = []
    installPluginReceiverLedger(receiverEvents)
    await send(harness.agent, multiDirect)
    const ledger = freezeLedger(harness, receiverEvents)

    const searches = ledger.events.filter((event): event is Extract<ProductionEvent, { readonly kind: 'search' }> =>
      event.kind === 'search')
    const resolutions = ledger.events.filter((event): event is Extract<ProductionEvent, { readonly kind: 'resolution' }> =>
      event.kind === 'resolution')
    const resolved = multiOutcome(resolutions[0])
    const receivers = ledger.events.filter((event): event is Extract<ProductionEvent, { readonly kind: 'receiver' }> =>
      event.kind === 'receiver')
    if (resolved === undefined) throw new Error('missing one public multi-fact resolution')
    expect(searches.map(event => event.request)).toStrictEqual([
      { query: queryA, maxResults: 1 },
      { query: queryB, maxResults: 1 },
    ])
    expect(harness.adapter.evidenceCalls).toBe(2)
    expect(resolutions).toHaveLength(1)
    expect(resolved.c11.kind).toBe('business_result')
    expect(Object.keys(resolved).sort()).toStrictEqual(['c11', 'conclusions', 'items', 'kind'])
    expect(resolved.items).toHaveLength(2)
    expect(resolved.items.map(item => item.requirement.fact)).toStrictEqual([factA, factB])
    expect(resolved.items.map(item => item.request.need)).toStrictEqual(resolved.items.map(item => item.requirement))
    expect(resolved.items.map(item => item.c12.identity.contract)).toStrictEqual(['C12', 'C12'])
    expect(resolved.items.map(item => item.provenance.conclusion)).toStrictEqual(resolved.items.map(item => item.conclusion))
    expect(resolved.conclusions.conclusions).toStrictEqual(resolved.items.map(item => item.conclusion))
    expect(resolved.items.map(item => item.provenance.url)).toStrictEqual([urlA, urlB])
    expect(resolved.items.map(item => item.provenance.publishedAt)).toStrictEqual([publishedA, publishedB])
    expect(receivers.map(event => event.receiver)).toStrictEqual(['C22', 'C20', 'C21'])
    const c22 = receivers[0]?.report
    if (c22?.kind !== 'business_result') throw new Error('missing public actionable C22')
    const boundary = c22.value.value
    expect(boundary.kind).toBe('actionable')
    expect(boundary.usableFacts).toStrictEqual(resolved.conclusions.conclusions)
    expect(boundary.unresolvedFacts).toStrictEqual([])
    expect(boundary.preciselyBlockedActions).toStrictEqual([])
    expect(boundary.safelyContinuableActions).toStrictEqual([actionU, actionN, actionR])
    for (const event of receivers) {
      if (event.report.kind !== 'business_result') throw new Error(`missing ${event.receiver} result`)
      expect(event.report.value.value).toBe(boundary)
    }
    const presentation = requestText(harness.adapter.rootRequests.at(-1)!)
    expect(presentation.indexOf(`fact[1]: ${factA}`)).toBeLessThan(presentation.indexOf(`fact[2]: ${factB}`))
    expect(presentation).toContain(`url[1]: ${urlA}`)
    expect(presentation).toContain(`url[2]: ${urlB}`)
    expect(presentation).not.toContain(queryA)
    expect(presentation).not.toContain(queryB)
    expect(presentation).not.toContain('raw provider')
    expect(presentation).not.toContain('material:')
    expect(publicText(ledger)).not.toContain(queryA)
    expect(publicText(ledger)).not.toContain(queryB)
    expect(ledger.sessionEvents.some(event => JSON.stringify(event).includes(queryA))).toBe(false)
    expect(ledger.sessionEvents.some(event => JSON.stringify(event).includes(queryB))).toBe(false)
  })

  it('P2 preserves A when B is unresolved and keeps only R safe for forward and reversed requirements', async () => {
    const receiverEvents: ProductionEvent[] = []
    installResolutionLedger(receiverEvents)
    const variants = [
      { name: 'forward', requirements: Object.freeze([requirementA, requirementB]), queries: [queryA, queryB], facts: [factA, factB] },
      { name: 'reverse', requirements: Object.freeze([requirementB, requirementA]), queries: [queryB, queryA], facts: [factB, factA] },
    ] as const
    for (const variant of variants) {
      const harness = await fresh(`f03-t2-p2-${variant.name}-`)
      const chat = String(harness.agent.session.id) as ChatRef
      const focus = createPublicFocus(chat, variant.name)
      const start = receiverEvents.length
      const controls: CompositionControls = {
        modeA: 'direct', modeB: 'known-failure', stageFault: 'none', stageFaultPending: false,
      }
      const composition = createComposition(harness, receiverEvents, controls)
      const formed = formProposal(harness, composition, focus.authority, focus.focus, variant.name, variant.requirements)
      if (formed === undefined) throw new Error(`public P2 proposal failed for ${variant.name}`)
      const completion = await composition.completeEvidenceActionFactBoundary.accept(
        focus.focus, formed.proposal, new AbortController().signal,
      )
      const ledger = freezeLedger(harness, receiverEvents.slice(start))

      if (completion === undefined || completion.family !== 'local_restriction'
        || !('kind' in completion) || completion.kind !== 'multi') {
        throw new Error(`missing multi local restriction for ${variant.name}`)
      }
      expect(ledger.events.filter(event => event.kind === 'search').map(event => event.request.query), variant.name)
        .toStrictEqual(variant.queries)
      expect(completion.provenances.map(provenance => provenance.conclusion.fact), variant.name)
        .toStrictEqual(variant.facts)
      expect(completion.provenances.find(provenance => provenance.conclusion.fact === factA)?.url, variant.name).toBe(urlA)
      expect(completion.provenances.find(provenance => provenance.conclusion.fact === factB)?.url, variant.name).toBe(urlB)
      expect(completion.boundary.kind, variant.name).toBe('local_restriction')
      expect(completion.boundary.usableFacts.map(fact => fact.fact), variant.name).toStrictEqual([factA])
      expect(completion.boundary.unresolvedFacts.map(fact => fact.fact), variant.name).toStrictEqual([factB])
      expect(completion.boundary.preciselyBlockedActions, variant.name).toStrictEqual([actionU, actionN])
      expect(completion.boundary.safelyContinuableActions, variant.name).toStrictEqual([actionR])
      expect(completion.boundary.requiredFacts.requirements.map(requirement => requirement.fact), variant.name)
        .toStrictEqual(variant.facts)
      expect(ledger.events.filter(event => event.kind === 'semantic'), variant.name).toHaveLength(2)
      expect(ledger.events.filter(event => event.kind === 'resolution'), variant.name).toHaveLength(1)
    }
  })

  it('P3 isolates two unresolved facts into one no-safe boundary without admitting R anywhere', async () => {
    const harness = await fresh('f03-t2-p3-')
    const chat = String(harness.agent.session.id) as ChatRef
    const focus = createPublicFocus(chat, 'p3')
    const events: ProductionEvent[] = []
    installResolutionLedger(events)
    const controls: CompositionControls = {
      modeA: 'known-failure', modeB: 'known-failure', stageFault: 'none', stageFaultPending: false,
    }
    const composition = createComposition(harness, events, controls)
    const formed = formProposal(
      harness, composition, focus.authority, focus.focus, 'p3',
      Object.freeze([requirementA, requirementB]), actionsNoRead,
    )
    if (formed === undefined) throw new Error('public P3 proposal failed')
    const completion = await composition.completeEvidenceActionFactBoundary.accept(
      focus.focus, formed.proposal, new AbortController().signal,
    )
    const ledger = freezeLedger(harness, events)

    if (completion === undefined || completion.family !== 'no_safe_action'
      || !('kind' in completion) || completion.kind !== 'multi') throw new Error('missing multi no-safe completion')
    expect(ledger.events.filter(event => event.kind === 'search').map(event => event.request.query))
      .toStrictEqual([queryA, queryB])
    expect(ledger.events.filter(event => event.kind === 'semantic')).toHaveLength(2)
    expect(ledger.events.filter(event => event.kind === 'resolution')).toHaveLength(1)
    expect(completion.boundary.usableFacts).toStrictEqual([])
    expect(completion.boundary.unresolvedFacts.map(fact => fact.fact)).toStrictEqual([factA, factB])
    expect(completion.boundary.preciselyBlockedActions).toStrictEqual([actionU, actionN])
    expect(completion.boundary.safelyContinuableActions).toStrictEqual([])
    expect(completion.boundary.requiredFacts.requirements.flatMap(requirement => requirement.neededFor)).not.toContain(actionR)
    expect(JSON.stringify(completion.boundary)).not.toContain(actionR)
  })

  it('N1 closes wrong admission, owner, generation, requirement identity and neededFor before search', async () => {
    const harness = await fresh('f03-t2-n1-')
    const chat = String(harness.agent.session.id) as ChatRef
    const focus = createPublicFocus(chat, 'n1')
    const events: ProductionEvent[] = []
    installResolutionLedger(events)
    const ownerComposition = createComposition(harness, events)
    const foreignComposition = createComposition(harness, events)

    const wrongDirect = formProposal(
      harness, ownerComposition, focus.authority, focus.focus, 'wrong-direct',
      Object.freeze([requirementA, requirementB]), actionsWithRead, `${multiDirect}错误`,
    )
    const wrongDirectResult = wrongDirect === undefined ? undefined
      : await ownerComposition.completeEvidenceActionFactBoundary.accept(
          focus.focus, wrongDirect.proposal, new AbortController().signal,
        )
    const wrongOwner = formProposal(harness, ownerComposition, focus.authority, focus.focus, 'wrong-owner')
    const wrongOwnerResult = wrongOwner === undefined ? undefined
      : await foreignComposition.completeEvidenceActionFactBoundary.accept(
          focus.focus, wrongOwner.proposal, new AbortController().signal,
        )
    const stale = formProposal(harness, ownerComposition, focus.authority, focus.focus, 'stale')
    if (stale !== undefined) {
      harness.agent.session.append('user/message', stale.direct, { surfaceOp: 'append' })
    }
    const staleResult = stale === undefined ? undefined
      : await ownerComposition.completeEvidenceActionFactBoundary.accept(
          focus.focus, stale.proposal, new AbortController().signal,
        )
    const foreignRequirement: RequirementInput = Object.freeze({
      fact: 'DeepSeek Harness 下载地址' as FactRef,
      neededFor: Object.freeze([refU] as const),
    })
    const wrongNeededFor: RequirementInput = Object.freeze({ fact: refB, neededFor: Object.freeze([refN] as const) })
    const negativeRequirements = [
      Object.freeze([requirementA, foreignRequirement]),
      Object.freeze([requirementA, wrongNeededFor]),
      Object.freeze([requirementA, requirementA]),
      Object.freeze([foreignRequirement, requirementB]),
    ]
    const negativeResults: Array<CompletedEvidenceActionFactBoundary | undefined> = []
    for (const [index, requirements] of negativeRequirements.entries()) {
      const composition = createComposition(harness, events)
      const formed = formProposal(
        harness, composition, focus.authority, focus.focus, `negative-${index}`, requirements,
      )
      negativeResults.push(formed === undefined ? undefined
        : await composition.completeEvidenceActionFactBoundary.accept(
            focus.focus, formed.proposal, new AbortController().signal,
          ))
    }
    const foreignSource = createUserMessage({
      content: [{ type: 'text', text: multiDirect }],
      source: { kind: 'plugin', plugin: 'foreign-direct' },
    })
    const foreignClaim = ownerComposition.claimedStructuredDirectIssuer.issue(
      harness.agent.session, focus.focus.chat, foreignSource,
    )
    const ledger = freezeLedger(harness, events)

    expect(wrongDirectResult).toBeUndefined()
    expect(wrongOwnerResult).toBeUndefined()
    expect(staleResult).toBeUndefined()
    expect(negativeResults).toStrictEqual([undefined, undefined, undefined, undefined])
    expect(foreignClaim).toBeUndefined()
    expect(ledger.events.filter(event => event.kind === 'search')).toHaveLength(0)
    expect(ledger.events.filter(event => event.kind === 'semantic')).toHaveLength(0)
    expect(ledger.events.filter(event => event.kind === 'receiver')).toHaveLength(0)
    expect(publicText(ledger)).not.toContain(queryA)
    expect(publicText(ledger)).not.toContain(queryB)
  })

  it('N2 proves partial is neither all-success nor all-stop and rejects a first-item facade', async () => {
    const harness = await fresh('f03-t2-n2-')
    const chat = String(harness.agent.session.id) as ChatRef
    const focus = createPublicFocus(chat, 'n2')
    const events: ProductionEvent[] = []
    installResolutionLedger(events)
    const partialComposition = createComposition(harness, events, {
      modeA: 'direct', modeB: 'known-failure', stageFault: 'none', stageFaultPending: false,
    })
    const partialProposal = formProposal(
      harness, partialComposition, focus.authority, focus.focus, 'partial',
    )
    if (partialProposal === undefined) throw new Error('missing public partial proposal')
    const partial = await partialComposition.completeEvidenceActionFactBoundary.accept(
      focus.focus, partialProposal.proposal, new AbortController().signal,
    )
    const stoppedComposition = createComposition(harness, events, {
      modeA: 'known-failure', modeB: 'known-failure', stageFault: 'none', stageFaultPending: false,
    })
    const stoppedProposal = formProposal(
      harness, stoppedComposition, focus.authority, focus.focus, 'stopped',
      Object.freeze([requirementA, requirementB]), actionsNoRead,
    )
    if (stoppedProposal === undefined) throw new Error('missing public stopped proposal')
    const stopped = await stoppedComposition.completeEvidenceActionFactBoundary.accept(
      focus.focus, stoppedProposal.proposal, new AbortController().signal,
    )
    const ledger = freezeLedger(harness, events)

    if (partial === undefined || partial.family !== 'local_restriction'
      || !('kind' in partial) || partial.kind !== 'multi') throw new Error('partial result was not local restriction')
    if (stopped === undefined || stopped.family !== 'no_safe_action'
      || !('kind' in stopped) || stopped.kind !== 'multi') throw new Error('stopped result was not no-safe')
    expect(partial.boundary.usableFacts.map(fact => fact.fact)).toStrictEqual([factA])
    expect(partial.boundary.unresolvedFacts.map(fact => fact.fact)).toStrictEqual([factB])
    expect(partial.boundary.safelyContinuableActions).toStrictEqual([actionR])
    expect(stopped.boundary.usableFacts).toStrictEqual([])
    expect(stopped.boundary.unresolvedFacts.map(fact => fact.fact)).toStrictEqual([factA, factB])
    expect(stopped.boundary.safelyContinuableActions).toStrictEqual([])
    expect(JSON.stringify(stopped.boundary)).not.toContain(actionR)
    expect(completionKeys(partial)).toStrictEqual([
      'acceptance', 'boundary', 'c02', 'c20', 'c21', 'c22', 'family', 'kind', 'origin', 'provenances',
    ])
    expect(completionKeys(partial)).not.toContain('provenance')
    expect(partial.provenances).toHaveLength(2)
    expect(ledger.events.filter(event => event.kind === 'semantic')).toHaveLength(4)
  })

  it('N3 isolates source, request, material, semantic, provenance and publication faults to B', async () => {
    const events: ProductionEvent[] = []
    installResolutionLedger(events)
    const variants = [
      { name: 'source', semantic: 'direct' as const, web: 'empty' as const },
      { name: 'request', semantic: 'wrong-request' as const, web: 'normal' as const },
      { name: 'material', semantic: 'direct' as const, web: 'truncated' as const },
      { name: 'semantic', semantic: 'throw' as const, web: 'normal' as const },
      { name: 'provenance', semantic: 'wrong-source' as const, web: 'normal' as const },
      { name: 'publication', semantic: 'direct' as const, web: 'bad-publication' as const },
    ]
    for (const variant of variants) {
      const harness = await fresh(`f03-t2-n3-${variant.name}-`)
      const chat = String(harness.agent.session.id) as ChatRef
      const focus = createPublicFocus(chat, variant.name)
      const start = events.length
      harness.search.handle = async request => {
        if (request.query !== queryB || variant.web === 'normal') return webResultFor(request.query)
        if (variant.web === 'empty') return { content: 'B source missing', sources: [], truncated: false }
        if (variant.web === 'truncated') {
          return { ...webResultFor(queryB), truncated: true }
        }
        return {
          content: 'B publication malformed',
          sources: [{ url: urlB, snippet: contentB, publishedAt: 'not-a-date' }],
          truncated: false,
        }
      }
      const composition = createComposition(harness, events, {
        modeA: 'direct', modeB: variant.semantic, stageFault: 'none', stageFaultPending: false,
      })
      const formed = formProposal(harness, composition, focus.authority, focus.focus, variant.name)
      if (formed === undefined) throw new Error(`missing N3 proposal for ${variant.name}`)
      const completion = await composition.completeEvidenceActionFactBoundary.accept(
        focus.focus, formed.proposal, new AbortController().signal,
      )
      const ledger = freezeLedger(harness, events.slice(start))

      if (completion === undefined || completion.family !== 'local_restriction'
        || !('kind' in completion) || completion.kind !== 'multi') {
        throw new Error(`N3 ${variant.name} crossed its fact line`)
      }
      expect(completion.boundary.usableFacts.map(fact => fact.fact), variant.name).toStrictEqual([factA])
      expect(completion.boundary.unresolvedFacts.map(fact => fact.fact), variant.name).toStrictEqual([factB])
      expect(completion.provenances[0].url, variant.name).toBe(urlA)
      expect(completion.provenances[0].source, variant.name).toBe(sourceRef(urlA))
      expect(completion.provenances[1].url, variant.name)
        .toBe(variant.web === 'normal' ? urlB : undefined)
      expect(ledger.events.filter(event => event.kind === 'search').map(event => event.request.query), variant.name)
        .toStrictEqual([queryA, queryB])
      expect(ledger.events.filter(event => event.kind === 'resolution'), variant.name).toHaveLength(1)
    }
  })

  it('N4 resumes only B after abort, preserves identity under reversal, and retries C22 C20 C21 without replay', async () => {
    const events: ProductionEvent[] = []
    installResolutionLedger(events)
    const harness = await fresh('f03-t2-n4-abort-')
    const chat = String(harness.agent.session.id) as ChatRef
    const focus = createPublicFocus(chat, 'abort')
    const controller = new AbortController()
    let firstB = true
    harness.search.handle = async request => {
      if (request.query === queryB && firstB) {
        firstB = false
        controller.abort()
      }
      return webResultFor(request.query)
    }
    const composition = createComposition(harness, events)
    const formed = formProposal(harness, composition, focus.authority, focus.focus, 'abort')
    if (formed === undefined) throw new Error('missing abort proposal')
    const beforeSession = Object.freeze([...harness.agent.session.events])
    const beforeState = harness.domain.table('focus_precanonical').get(sessionId)
    const first = await composition.completeEvidenceActionFactBoundary.accept(
      focus.focus, formed.proposal, controller.signal,
    )
    const retry = await composition.completeEvidenceActionFactBoundary.accept(
      focus.focus, formed.proposal, new AbortController().signal,
    )
    const completedEventCount = events.length
    const reused = await composition.completeEvidenceActionFactBoundary.accept(
      focus.focus, formed.proposal, new AbortController().signal,
    )
    const afterState = harness.domain.table('focus_precanonical').get(sessionId)
    const abortLedger = freezeLedger(harness, events)

    expect(first).toBeUndefined()
    if (retry === undefined || retry.family !== 'actionable'
      || !('kind' in retry) || retry.kind !== 'multi') throw new Error('abort retry did not complete multi boundary')
    expect(reused).toBeUndefined()
    expect(events).toHaveLength(completedEventCount)
    expect(abortLedger.events.filter(event => event.kind === 'search').map(event => event.request.query))
      .toStrictEqual([queryA, queryB, queryB])
    expect(abortLedger.events.filter(event => event.kind === 'semantic')
      .map(event => event.request.retrieval.need.fact)).toStrictEqual([factA, factB])
    expect(retry.provenances.map(provenance => provenance.conclusion.fact)).toStrictEqual([factA, factB])
    expect(abortLedger.events.filter(event => event.kind === 'resolution')).toHaveLength(2)
    expect(multiOutcome(abortLedger.events.filter(event => event.kind === 'resolution')[1])?.c11.identity.contract).toBe('C11')
    expect(harness.agent.session.events).toStrictEqual(beforeSession)
    expect(afterState).toBe(beforeState)

    const reverseHarness = await fresh('f03-t2-n4-reverse-')
    const reverseChat = String(reverseHarness.agent.session.id) as ChatRef
    const reverseFocus = createPublicFocus(reverseChat, 'reverse')
    const reverseStart = events.length
    const reverseComposition = createComposition(reverseHarness, events)
    const reverseFormed = formProposal(
      reverseHarness, reverseComposition, reverseFocus.authority, reverseFocus.focus, 'reverse',
      Object.freeze([requirementB, requirementA]),
    )
    if (reverseFormed === undefined) throw new Error('missing reverse proposal')
    const reverse = await reverseComposition.completeEvidenceActionFactBoundary.accept(
      reverseFocus.focus, reverseFormed.proposal, new AbortController().signal,
    )
    const reverseLedger = freezeLedger(reverseHarness, events.slice(reverseStart))
    if (reverse === undefined || !('provenances' in reverse)) throw new Error('missing reverse completion')
    expect(reverseLedger.events.filter(event => event.kind === 'search').map(event => event.request.query))
      .toStrictEqual([queryB, queryA])
    expect(reverse.provenances.map(provenance => provenance.conclusion.fact)).toStrictEqual([factB, factA])

    const stages = ['C22', 'C20', 'C21'] as const
    for (const stage of stages) {
      const stagedHarness = await fresh(`f03-t2-n4-${stage}-`)
      const stagedChat = String(stagedHarness.agent.session.id) as ChatRef
      const stagedFocus = createPublicFocus(stagedChat, stage)
      const attempts = { C22: 0, C20: 0, C21: 0 }
      const start = events.length
      const stagedComposition = createComposition(stagedHarness, events, {
        modeA: 'direct', modeB: 'direct', stageFault: stage, stageFaultPending: true, attempts,
      })
      const stagedFormed = formProposal(
        stagedHarness, stagedComposition, stagedFocus.authority, stagedFocus.focus, stage,
      )
      if (stagedFormed === undefined) throw new Error(`missing staged ${stage} proposal`)
      const initial = await stagedComposition.completeEvidenceActionFactBoundary.accept(
        stagedFocus.focus, stagedFormed.proposal, new AbortController().signal,
      )
      const completed = await stagedComposition.completeEvidenceActionFactBoundary.accept(
        stagedFocus.focus, stagedFormed.proposal, new AbortController().signal,
      )
      const stagedLedger = freezeLedger(stagedHarness, events.slice(start))
      const expected = stage === 'C22'
        ? { C22: 2, C20: 1, C21: 1 }
        : stage === 'C20' ? { C22: 1, C20: 2, C21: 1 } : { C22: 1, C20: 1, C21: 2 }
      expect(initial, stage).toBeUndefined()
      expect(completed, stage).toBeDefined()
      expect(attempts, stage).toStrictEqual(expected)
      expect(stagedLedger.events.filter(event => event.kind === 'search').map(event => event.request.query), stage)
        .toStrictEqual([queryA, queryB])
      expect(stagedLedger.events.filter(event => event.kind === 'semantic'), stage).toHaveLength(2)
      expect(stagedLedger.events.filter(event => event.kind === 'resolution'), stage).toHaveLength(1)
    }
  })

  it('N5 keeps presentation, publication, provenance and outer XOR closed against raw, extras and order pollution', async () => {
    const harness = await fresh('f03-t2-n5-')
    await establishFocus(harness)
    harness.adapter.actionOutput = JSON.stringify({
      actions: [actionU, actionN, actionR],
      proposedRequirements: [
        { fact: factB, neededFor: [actionU, actionN] },
        { fact: factA, neededFor: [actionU] },
      ],
      usableInputs: [],
      unresolvedInputs: [
        { fact: factB, meaning: 'B 尚未核清', source: 'direct-user', degree: 'unknown', affected: `${actionU}|${actionN}` },
        { fact: factA, meaning: 'A 尚未核清', source: 'direct-user', degree: 'unknown', affected: actionU },
      ],
    })
    const receiverEvents: ProductionEvent[] = []
    installPluginReceiverLedger(receiverEvents)
    await send(harness.agent, multiDirect)
    const ledger = freezeLedger(harness, receiverEvents)

    const resolutions = ledger.events.filter((event): event is Extract<ProductionEvent, { readonly kind: 'resolution' }> =>
      event.kind === 'resolution')
    const resolved = multiOutcome(resolutions[0])
    if (resolved === undefined) throw new Error('missing reversed public resolution')
    expect(Object.keys(resolved).sort()).toStrictEqual(['c11', 'conclusions', 'items', 'kind'])
    expect(resolved.items.map(item => item.requirement.fact)).toStrictEqual([factB, factA])
    expect(resolved.items.map(item => Object.keys(item).sort())).toStrictEqual([
      ['c12', 'conclusion', 'material', 'provenance', 'request', 'requirement'],
      ['c12', 'conclusion', 'material', 'provenance', 'request', 'requirement'],
    ])
    expect(resolved.items.map(item => Object.keys(item.provenance).sort())).toStrictEqual([
      ['conclusion', 'observedAt', 'publishedAt', 'source', 'url'],
      ['conclusion', 'observedAt', 'publishedAt', 'source', 'url'],
    ])
    expect(Object.keys(resolved)).not.toContain('request')
    expect(Object.keys(resolved)).not.toContain('c12')
    expect(Object.keys(resolved)).not.toContain('material')
    expect(Object.keys(resolved)).not.toContain('provenance')
    const presentation = requestText(harness.adapter.rootRequests.at(-1)!)
    expect(presentation.indexOf(`fact[1]: ${factB}`)).toBeLessThan(presentation.indexOf(`fact[2]: ${factA}`))
    for (const forbidden of [queryA, queryB, 'raw provider A', 'raw provider B', 'material:', 'foreign-source']) {
      expect(presentation, forbidden).not.toContain(forbidden)
      expect(publicText(ledger), forbidden).not.toContain(forbidden)
      expect(JSON.stringify(ledger.sessionEvents), forbidden).not.toContain(forbidden)
    }

    vi.restoreAllMocks()
    const closedHarness = await fresh('f03-t2-n5-closed-')
    const chat = String(closedHarness.agent.session.id) as ChatRef
    const focus = createPublicFocus(chat, 'closed')
    const closedEvents: ProductionEvent[] = []
    installResolutionLedger(closedEvents)
    const composition = createComposition(closedHarness, closedEvents)
    const extraRequirement: RequirementInput = Object.freeze({
      fact: 'DeepSeek Harness 包校验和' as FactRef,
      neededFor: Object.freeze([refU] as const),
    })
    const extra = formProposal(
      closedHarness, composition, focus.authority, focus.focus, 'extra',
      Object.freeze([requirementA, requirementB, extraRequirement]),
    )
    const result = extra === undefined ? undefined
      : await composition.completeEvidenceActionFactBoundary.accept(
          focus.focus, extra.proposal, new AbortController().signal,
        )
    const closedLedger = freezeLedger(closedHarness, closedEvents)
    expect(result).toBeUndefined()
    expect(closedLedger.events.filter(event => event.kind === 'search')).toHaveLength(0)
    expect(closedLedger.events.filter(event => event.kind === 'receiver')).toHaveLength(0)
    expect(closedLedger.events.filter(event => event.kind === 'sidecar')).toHaveLength(0)
    expect(closedHarness.domain.table('focus_precanonical').get(sessionId)).toBeUndefined()
  })
})
