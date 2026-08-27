import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import type { ActionFactBoundary, ActionFactBoundaryRef, ActionRef, ActionableFactMeaning, EvidenceSourceRef, FactNeedSetRef, FactRef } from '../src/action-boundary.ts'
import { BackgroundCandidateFormation, CandidateBasisFreshnessReviewer, CandidateContentReviewer, renderCandidateBackground, type CandidateAssemblySnapshot, type CandidateContentReviewSink, type CandidateFormationResultSink, type CandidateFreshnessReviewSink, type CandidatePreparationSnapshot, type C23Result, type C24Result, type ExplicitBackgroundUpdateRuntimeEvidence, type FixedH1CandidateBudgetProof } from '../src/candidate.ts'
import { CandidateQualificationAuthority, type CandidateBasisFreshnessDecision, type CandidateContentReviewDecision, type CandidateEnvelope, type CandidateFormationResult, type CandidateQualificationDecision, type CandidateQualificationIssue, type CandidateRef, type C25Result, type C26Result, type C27Result, type C28Result, type C42Result, type ContentFailureReason, type FutureCriticalConclusion, type FutureCriticalCondition, type FutureCriticalUse, type ReadOnlyCandidateQualificationObserver } from '../src/candidate-qualification.ts'
import type { EvidenceConclusionSet, EvidenceConclusionSetRef } from '../src/fact-resolution.ts'
import { UserInteractionAdvice, type ChatRef, type ContractCallRef, type CorrectionMeaning, type CurrentMatterMeaning, type FocusDecision, type FocusDecisionRef } from '../src/focus.ts'
import { ManagedAwareBasicCompactionEngine } from '../src/managed-compaction.ts'
import * as ContextManager from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
const chat = ContextManager.FOCUS_CANARY_IDS[0]!
const otherChat = ContextManager.FOCUS_CANARY_IDS[1]!
const candidateChat = chat as ChatRef
const focusDirect = '准备升级 DeepSeek Harness'
const evidenceDirect = '查一下 DeepSeek Harness 当前最新版本；确认后再决定是否升级。'
const updateDirect = '请更新当前背景'
const fact = 'DeepSeek Harness 最新版本'
const action = '升级 DeepSeek Harness'
const qualifiedPresentation = '背景候选已通过资格检查，但尚未应用为当前背景。'

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function textChunks(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

function messagesText(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function hasSchema(options: GenerateOptions, plugin: string): boolean {
  return options.messages.some(message => message.source.kind === 'plugin' && message.source.plugin === plugin)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

class CandidateAdapter extends LlmAdapter {
  readonly rootRequests: GenerateOptions[] = []
  focusCalls = 0
  actionCalls = 0
  evidenceCalls = 0
  rootCalls = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 16_384 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (hasSchema(options, 'ui-context-compactor:focus-canary-schema')) {
      this.focusCalls += 1
      yield* textChunks(JSON.stringify({ kind: 'focus', subject: focusDirect, relation: 'new' }))
      return
    }
    if (hasSchema(options, 'ui-context-compactor:action-fact-need-schema')) {
      this.actionCalls += 1
      yield* textChunks(JSON.stringify({ actions: [action], proposedRequirements: [{ fact, neededFor: [action] }], usableInputs: [], unresolvedInputs: [{ fact, meaning: '当前版本尚未核清', source: 'direct-user', degree: 'unknown', affected: action }] }))
      return
    }
    if (hasSchema(options, 'ui-context-compactor:evidence-schema')) {
      this.evidenceCalls += 1
      const projection = object(JSON.parse(messagesText(options.messages.slice(1))))
      const material = object(projection?.material)
      yield* textChunks(JSON.stringify({ kind: 'direct_fact', fact: projection?.fact, conclusion: 'DeepSeek Harness 当前最新稳定版本为 1.4.2', appliesWhen: 'stable channel', observedAt: material?.observedAt, publishedAt: material?.publishedAt ?? null, futureUse: '只用于本次升级前版本判断', source: material?.source, degree: 'established', request: projection?.request, material: material?.ref, factNeeds: projection?.factNeeds }))
      return
    }
    this.rootCalls += 1
    this.rootRequests.push(options)
    yield* textChunks('natural root response')
  }
}

interface Harness { readonly ctx: Context; readonly agent: Agent; readonly adapter: CandidateAdapter }
interface FrozenHarnessLedger {
  readonly events: readonly SessionEvent[]
  readonly detachedEvents: readonly SessionEvent[]
  readonly provider: Readonly<{ focus: number; action: number; evidence: number; root: number }>
}

async function fresh(prefix: string, target = chat): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mkdir(join(root, 'storages'), { recursive: true })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: join(root, 'storages', 'candidate.sqlite') })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(CommandRuntime)
  const managedRuntime = { mode: 'enforce' as const, safeUpdateMarginTokens: 64, allowlist: [...ContextManager.FOCUS_CANARY_IDS] }
  await ctx.plugin(ManagedAwareBasicCompactionEngine, { auto: true, thresholdRatio: .99, retainRatio: .1, managedRuntime })
  await ctx.plugin(commandCompact)
  await ctx.plugin(WebRuntime, { searchProvider: 'candidate-search' })
  ctx.web.registerSearchProvider({ id: 'candidate-search', available: () => true, search: async (_request: WebSearchRequest) => ({ content: 'raw provider envelope', sources: [{ url: 'https://example.test/deepseek-harness/releases/latest', snippet: 'DeepSeek Harness 当前最新稳定版本为 1.4.2。', publishedAt: '2026-08-25T09:30:00.000Z' }], truncated: false }) })
  const adapter = new CandidateAdapter()
  ctx.llm.registerAdapter(['candidate-test'], adapter)
  await ctx.plugin(ContextManager, { focusCanary: { ...managedRuntime, auxiliary: { provider: 'candidate-test', model: 'candidate-test', maxOutputTokens: 256, timeoutMs: 500, maxExpressionChars: 240, maxProjectionTokens: 2_048, safetyMarginTokens: 128 } }, nativeWriterArbitration: { mode: 'enforce' }, evidenceCanary: { mode: 'enforce' } })
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = ctx.agentLoop.create(SessionId(target), { provider: 'candidate-test', model: 'candidate-test', maxTokens: 256 })
  return { ctx, agent, adapter }
}

async function send(agent: Agent, text: string, message?: UserMessage): Promise<UserMessage> {
  const direct = message ?? createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  agent.followup(direct)
  await agent.whenIdle()
  return direct
}

async function establishNaturalBasis(harness: Harness): Promise<void> {
  await send(harness.agent, focusDirect)
  await send(harness.agent, evidenceDirect)
}

async function freezeHarness(harness: Harness, agent = harness.agent): Promise<FrozenHarnessLedger> {
  if (agent.session.events.length === 0) {
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'candidate production-port ledger checkpoint' }],
      source: { kind: 'plugin', plugin: 'ui-context-compactor:candidate-port-ledger' },
    }), { surfaceOp: 'append' })
  }
  const events = Object.freeze([...agent.session.events])
  await harness.ctx.sessions.flush(agent.session)
  const detached = await harness.ctx.sessionPersistence.readFrom(SessionId(String(agent.session.id)), 0)
  return Object.freeze({ events, detachedEvents: Object.freeze([...detached.events]), provider: Object.freeze({ focus: harness.adapter.focusCalls, action: harness.adapter.actionCalls, evidence: harness.adapter.evidenceCalls, root: harness.adapter.rootCalls }) })
}

function visibleText(ledger: FrozenHarnessLedger): string {
  return ledger.detachedEvents.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message').flatMap(event => event.data.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function stateHash(agent: Agent): string {
  const canonical = agent.session.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'context-manager-canonical')
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

interface CandidateBasisFixture {
  readonly focus: Extract<FocusDecision, { readonly kind: 'focus_established' }>
  readonly action: ActionFactBoundary
  readonly evidence: EvidenceConclusionSet
}

function basisFixture(tag: string, target: ChatRef = candidateChat): CandidateBasisFixture {
  const factRef = `fact:${tag}` as FactRef
  const actionNeed = `action:${tag}` as ActionRef
  const directFact = Object.freeze({ kind: 'direct_fact' as const, fact: factRef, meaning: `DeepSeek Harness ${tag} 当前稳定版本为 1.4.2` as ActionableFactMeaning, source: `source:${tag}` as EvidenceSourceRef, degree: 'established' as const })
  return deepFreeze({
    focus: { kind: 'focus_established', ref: `focus:${tag}` as FocusDecisionRef, chat: target, currentMatter: `升级 DeepSeek Harness ${tag}` as CurrentMatterMeaning, latestCorrections: `仅采用 ${tag} 稳定版事实` as CorrectionMeaning },
    action: { kind: 'actionable', ref: `action-boundary:${tag}` as ActionFactBoundaryRef, chat: target, requiredFacts: { ref: `fact-needs:${tag}` as FactNeedSetRef, requirements: [{ fact: factRef, neededFor: [actionNeed] }] }, usableFacts: [directFact], unresolvedFacts: [], preciselyBlockedActions: [], safelyContinuableActions: [actionNeed] },
    evidence: { ref: `evidence:${tag}` as EvidenceConclusionSetRef, chat: target, conclusions: [directFact] },
  })
}

function withoutChat<Value extends { readonly chat: ChatRef }>(value: Value): Omit<Value, 'chat'> {
  const { chat: _chat, ...rest } = value
  return deepFreeze(structuredClone(rest))
}

function directHash(messageId: string): string {
  return createHash('sha256').update(messageId).update('\0').update(updateDirect).digest('hex')
}

type ProofChange = (proof: FixedH1CandidateBudgetProof) => FixedH1CandidateBudgetProof

function runtimeEvidence(basis: CandidateBasisFixture, tag: string, change?: ProofChange): ExplicitBackgroundUpdateRuntimeEvidence {
  const body = renderCandidateBackground({ target: basis.focus.chat, focus: withoutChat(basis.focus), action: withoutChat(basis.action), evidence: withoutChat(basis.evidence), knownFutureCriticalPoints: Object.freeze([]) })
  const messageId = `candidate-direct:${tag}`
  const originHash = directHash(messageId)
  const assembly: CandidateAssemblySnapshot = Object.freeze({ fingerprint: `assembly:${tag}`, provider: 'candidate-test', model: 'candidate-test', headerFingerprint: `header:${tag}`, contextFingerprint: `context:${tag}`, revision: 7, directMessageId: messageId, directHash: originHash, directText: updateDirect, directChat: basis.focus.chat, baseInputTokens: 100 })
  const preparation: CandidatePreparationSnapshot = Object.freeze({ fingerprint: `prepare:${tag}`, provider: 'candidate-test', model: 'candidate-test', contextWindow: 16_384, outputTokens: 256 })
  const proof: FixedH1CandidateBudgetProof = Object.freeze({ kind: 'fixed_h1_known_envelope', firstAssembly: assembly, secondAssembly: Object.freeze({ ...assembly }), firstPreparation: preparation, secondPreparation: Object.freeze({ ...preparation }), bodyHash: createHash('sha256').update(body).digest('hex'), bodyTokens: 100, safeUpdateMarginTokens: 64 })
  return deepFreeze({ chat: basis.focus.chat, text: updateDirect, origin: { messageId, hash: originHash }, budget: change === undefined ? proof : change(proof) })
}

interface ProductionPortLedger {
  readonly formations: CandidateFormationResult[]
  readonly c25: C25Result[]
  readonly c23: C23Result[]
  readonly c24: C24Result[]
  readonly content: CandidateContentReviewDecision[]
  readonly c26: C26Result[]
  readonly freshness: CandidateBasisFreshnessDecision[]
  readonly c27: C27Result[]
  readonly qualified: Extract<CandidateQualificationDecision, { readonly kind: 'qualified' }>[]
  readonly c28: C28Result[]
  readonly issues: CandidateQualificationIssue[]
  readonly c42: C42Result[]
  readonly presentations: string[]
}

function mutableLedger(): ProductionPortLedger {
  return { formations: [], c25: [], c23: [], c24: [], content: [], c26: [], freshness: [], c27: [], qualified: [], c28: [], issues: [], c42: [], presentations: [] }
}

function acceptedC28<Ref extends CandidateRef>(decision: Extract<CandidateQualificationDecision<Ref>, { readonly kind: 'qualified' }>): C28Result<Ref> {
  const subject = Object.freeze({ kind: 'candidate' as const, candidate: decision.candidate })
  return { kind: 'business_result', identity: { contract: 'C28', call: `C28:test:${decision.candidate.ref}` as ContractCallRef, subject }, value: { kind: 'accepted_for_contract', value: decision } }
}

interface QualificationPorts { readonly authority: CandidateQualificationAuthority; readonly advice: UserInteractionAdvice; readonly formation: CandidateFormationResultSink; readonly content: CandidateContentReviewSink; readonly freshness: CandidateFreshnessReviewSink }

function qualificationPorts(ledger: ProductionPortLedger, observer?: ReadOnlyCandidateQualificationObserver): QualificationPorts {
  const advice = new UserInteractionAdvice()
  const actualObserver: ReadOnlyCandidateQualificationObserver = observer ?? {
    acceptCandidateQualification<Ref extends CandidateRef>(decision: Extract<CandidateQualificationDecision<Ref>, { readonly kind: 'qualified' }>): C28Result<Ref> {
      ledger.qualified.push(decision)
      const report = acceptedC28(decision)
      ledger.c28.push(report)
      return report
    },
  }
  const authority = new CandidateQualificationAuthority({ observer: actualObserver, userAdvice: {
    acceptCandidateQualificationIssue<Ref extends CandidateRef>(issue: CandidateQualificationIssue<Ref>): C42Result<Ref> {
      ledger.issues.push(issue)
      const report = advice.acceptCandidateQualificationIssue(issue)
      ledger.c42.push(report)
      const presentation = advice.presentCandidateQualificationIssue(report)
      if (presentation !== undefined) ledger.presentations.push(presentation)
      return report
    },
  } })
  return {
    authority,
    advice,
    formation: { acceptFormationResult<Ref extends CandidateRef>(result: CandidateFormationResult<Ref>): C25Result<Ref> { ledger.formations.push(result); const report = authority.acceptFormationResult(result); ledger.c25.push(report); return report } },
    content: { acceptContentReview<Ref extends CandidateRef>(review: CandidateContentReviewDecision<Ref>): C26Result<Ref> { ledger.content.push(review); const report = authority.acceptContentReview(review); ledger.c26.push(report); return report } },
    freshness: { acceptBasisFreshness<Ref extends CandidateRef>(freshness: CandidateBasisFreshnessDecision<Ref>): C27Result<Ref> { ledger.freshness.push(freshness); const report = authority.acceptBasisFreshness(freshness); ledger.c27.push(report); return report } },
  }
}

interface ProductionComposition { readonly formation: BackgroundCandidateFormation; readonly ports: QualificationPorts; readonly ledger: ProductionPortLedger }
interface CompositionOptions { readonly formationBasis?: CandidateBasisFixture; readonly contentBasis?: CandidateBasisFixture; readonly freshnessBasis?: CandidateBasisFixture; readonly proofChange?: ProofChange; readonly observer?: ReadOnlyCandidateQualificationObserver }

function productionComposition(tag: string, options: CompositionOptions = {}): ProductionComposition {
  const formationBasis = options.formationBasis ?? basisFixture(`${tag}:formation`)
  const contentBasis = options.contentBasis ?? formationBasis
  const freshnessBasis = options.freshnessBasis ?? formationBasis
  const ledger = mutableLedger()
  const ports = qualificationPorts(ledger, options.observer)
  const contentReviewer = new CandidateContentReviewer({ qualification: ports.content })
  const freshnessReviewer = new CandidateBasisFreshnessReviewer({ qualification: ports.freshness })
  const evidence = runtimeEvidence(formationBasis, tag, options.proofChange)
  let available = true
  const formation = new BackgroundCandidateFormation({
    qualification: ports.formation,
    contentReview: { acceptCandidateForContentReview<Ref extends CandidateRef>(candidate: CandidateEnvelope<Ref>): C23Result<Ref> { const report = contentReviewer.acceptCandidateForContentReview(candidate); ledger.c23.push(report); return report } },
    freshnessReview: { acceptCandidateForFreshnessReview<Ref extends CandidateRef>(candidate: CandidateEnvelope<Ref>): C24Result<Ref> { const report = freshnessReviewer.acceptCandidateForFreshnessReview(candidate); ledger.c24.push(report); return report } },
    runtimeEvidence: { takeExplicitUpdateEvidence(target: ChatRef): ExplicitBackgroundUpdateRuntimeEvidence | undefined { if (!available || target !== evidence.chat) return undefined; available = false; return evidence } },
  })
  formation.acceptFocusBasis(formationBasis.focus)
  formation.acceptActionFactBoundary(formationBasis.action)
  formation.acceptEvidenceConclusions(formationBasis.evidence)
  contentReviewer.acceptRequiredFocus(contentBasis.focus)
  contentReviewer.acceptRequiredActionFacts(contentBasis.action)
  contentReviewer.acceptEvidenceConclusions(contentBasis.evidence)
  freshnessReviewer.acceptCurrentFocus(freshnessBasis.focus)
  freshnessReviewer.acceptCurrentActionFacts(freshnessBasis.action)
  freshnessReviewer.acceptCurrentEvidence(freshnessBasis.evidence)
  return { formation, ports, ledger }
}

function freezeProductionLedger(ledger: ProductionPortLedger): ProductionPortLedger {
  for (const values of Object.values(ledger)) Object.freeze(values)
  return Object.freeze(ledger)
}

function formedCandidate(ledger: ProductionPortLedger): CandidateEnvelope {
  const formation = ledger.formations.find(result => result.kind === 'formed')
  if (formation?.kind !== 'formed') throw new Error('production Formation did not form a candidate')
  return formation.candidate
}

function reviewCandidateContent(candidate: CandidateEnvelope, basis: CandidateBasisFixture): ProductionPortLedger {
  const ledger = mutableLedger()
  const ports = qualificationPorts(ledger)
  ports.formation.acceptFormationResult(Object.freeze({ kind: 'formed', candidate }))
  const reviewer = new CandidateContentReviewer({ qualification: ports.content })
  reviewer.acceptRequiredFocus(basis.focus)
  reviewer.acceptRequiredActionFacts(basis.action)
  reviewer.acceptEvidenceConclusions(basis.evidence)
  ledger.c23.push(reviewer.acceptCandidateForContentReview(candidate))
  return freezeProductionLedger(ledger)
}

async function publishAdvice(harness: Harness, presentation: string): Promise<FrozenHarnessLedger> {
  harness.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: presentation }], source: { kind: 'plugin', plugin: 'ui-context-compactor:candidate-qualification' } }), { surfaceOp: 'append' })
  return freezeHarness(harness)
}

function candidateVariant(candidate: CandidateEnvelope, changes: Partial<CandidateEnvelope>): CandidateEnvelope {
  return deepFreeze({ ...candidate, ...changes }) as CandidateEnvelope
}

describe('F01-T1 candidate qualification through natural E2E and real production ports', () => {
  it('P1 natural E2E applies the first owner-qualified background from real ContextManager basis under the fixed H1 envelope', async () => {
    const harness = await fresh('f01-candidate-p1-')
    await establishNaturalBasis(harness)
    const before = stateHash(harness.agent)
    const providerBefore = (await freezeHarness(harness)).provider
    await send(harness.agent, updateDirect)
    const ledger = await freezeHarness(harness)
    expect(ledger.detachedEvents.filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === 'ui-context-compactor:candidate-qualification' && messagesText([event.data]) === qualifiedPresentation)).toHaveLength(0)
    expect(ledger.provider).toEqual({ ...providerBefore, root: providerBefore.root + 1 })
    expect(stateHash(harness.agent)).not.toBe(before)
    expect(harness.agent.session.deriveMessages().filter(message => message.source.kind === 'context-manager-canonical'
      && message.source.machine.kind === 'background')).toHaveLength(1)
  })

  it('P2 production composition preserves one Candidate object and ref across C23-C28, independent report identities and one-shot replay', async () => {
    const harness = await fresh('f01-candidate-p2-')
    const composition = productionComposition('p2')
    expect(composition.formation.requestExplicitBackgroundUpdate({ chat: candidateChat }).kind).toBe('business_result')
    expect(composition.formation.requestExplicitBackgroundUpdate({ chat: candidateChat }).kind).toBe('rejected')
    const core = freezeProductionLedger(composition.ledger)
    const candidate = formedCandidate(core)
    expect(core.c23).toHaveLength(1); expect(core.c24).toHaveLength(1); expect(core.c25).toHaveLength(1); expect(core.c26).toHaveLength(1); expect(core.c27).toHaveLength(1); expect(core.c28).toHaveLength(1)
    expect(core.content[0]?.candidate).toBe(candidate)
    expect(core.freshness[0]?.candidate).toBe(candidate)
    expect(core.qualified[0]?.candidate).toBe(candidate)
    expect([core.c23[0]?.identity.subject, core.c24[0]?.identity.subject, core.c26[0]?.identity.subject, core.c27[0]?.identity.subject]).toEqual([candidate.ref, candidate.ref, candidate.ref, candidate.ref])
    expect(core.c26[0]?.identity.call).not.toBe(core.c27[0]?.identity.call)
    expect(core.c28[0]?.identity.subject.kind).toBe('candidate')
    expect(core.c28[0]?.identity.subject.kind === 'candidate'
      ? core.c28[0].identity.subject.candidate
      : undefined).toBe(candidate)
    expect((await freezeHarness(harness)).provider).toEqual({ focus: 0, action: 0, evidence: 0, root: 0 })
  })

  it('P3 production-port basis disagreement yields real C26 failure, explicit C42 and whitelist presentation without claiming a natural renderer defect', async () => {
    const harness = await fresh('f01-candidate-p3-')
    const composition = productionComposition('p3', { formationBasis: basisFixture('p3:A'), contentBasis: basisFixture('p3:B') })
    composition.formation.requestExplicitBackgroundUpdate({ chat: candidateChat })
    const core = freezeProductionLedger(composition.ledger)
    expect(core.content[0]?.kind).toBe('failed')
    expect(core.c28).toHaveLength(0)
    expect(core.issues).toHaveLength(1)
    expect(core.issues[0]).toMatchObject({ kind: 'explicitly_disqualified', affected: 'candidate-background' })
    expect(core.issues[0]?.subject.kind).toBe('candidate')
    expect(core.presentations).toHaveLength(1)
    const ledger = await publishAdvice(harness, core.presentations[0]!)
    expect(visibleText(ledger)).toContain('明确未通过资格检查')
    expect(visibleText(ledger)).toContain('候选背景正文')
  })

  it('N1 real Qualification rejects incomplete, forged, cloned, wrong-chat and wrong-ref inputs without upgrading identity coincidence', async () => {
    const harness = await fresh('f01-candidate-n1-')
    const source = productionComposition('n1-source')
    source.formation.requestExplicitBackgroundUpdate({ chat: candidateChat })
    const actual = formedCandidate(source.ledger)
    for (const variant of ['incomplete', 'forged', 'cloned', 'wrong-chat', 'wrong-ref'] as const) {
      const ledger = mutableLedger()
      const ports = qualificationPorts(ledger)
      expect(ports.formation.acceptFormationResult(Object.freeze({ kind: 'formed', candidate: actual })).kind).toBe('business_result')
      if (variant === 'incomplete') {
        expect(ports.formation.acceptFormationResult(Object.freeze({ kind: 'safely_not_formed', chat: candidateChat, reason: 'basis_incomplete' })).kind).toBe('business_result')
      } else if (variant === 'forged') {
        expect(ports.formation.acceptFormationResult({ kind: 'formed', candidate: { ...actual } }).kind).toBe('rejected')
        ports.formation.acceptFormationResult(Object.freeze({ kind: 'safely_not_formed', chat: candidateChat, reason: 'formation_unknown' }))
      } else if (variant === 'cloned') {
        expect(ports.formation.acceptFormationResult(Object.freeze({ kind: 'formed', candidate: candidateVariant(actual, {}) })).kind).toBe('rejected')
        ports.formation.acceptFormationResult(Object.freeze({ kind: 'safely_not_formed', chat: candidateChat, reason: 'formation_unknown' }))
      } else if (variant === 'wrong-chat') {
        const wrongChat = candidateVariant(actual, { target: otherChat as ChatRef })
        expect(ports.content.acceptContentReview(Object.freeze({ kind: 'passed', candidate: wrongChat })).kind).toBe('rejected')
        ports.formation.acceptFormationResult(Object.freeze({ kind: 'safely_not_formed', chat: candidateChat, reason: 'formation_unknown' }))
      } else {
        const wrongRef = candidateVariant(actual, { ref: `candidate:${'f'.repeat(64)}` as CandidateRef })
        expect(ports.freshness.acceptBasisFreshness(Object.freeze({ kind: 'current', candidate: wrongRef, basis: wrongRef.basis })).kind).toBe('rejected')
        ports.formation.acceptFormationResult(Object.freeze({ kind: 'safely_not_formed', chat: candidateChat, reason: 'formation_unknown' }))
      }
      const frozen = freezeProductionLedger(ledger)
      expect(frozen.c28, variant).toHaveLength(0)
      expect(frozen.issues, variant).toHaveLength(1)
      expect(frozen.issues[0]?.kind, variant).toBe('currently_unprovable')
    }
    expect((await freezeHarness(harness)).provider).toEqual({ focus: 0, action: 0, evidence: 0, root: 0 })
  })

  it('N2 real ContentReviewer ports distinguish omitted, injected, distorted and non-self-contained candidate accidents', async () => {
    const harness = await fresh('f01-candidate-n2-')
    const basis = basisFixture('n2')
    const source = productionComposition('n2-source', { formationBasis: basis })
    source.formation.requestExplicitBackgroundUpdate({ chat: candidateChat })
    const actual = formedCandidate(source.ledger)
    const missingFocusRef = `focus:n2:missing` as FocusDecisionRef
    const variants: ReadonlyArray<readonly [ContentFailureReason, CandidateEnvelope]> = [
      ['required_content_missing', candidateVariant(actual, { basis: deepFreeze({ ...actual.basis, focus: missingFocusRef }), formationFocus: deepFreeze({ ...actual.formationFocus, ref: missingFocusRef }) })],
      ['forbidden_old_content_included', candidateVariant(actual, { knownFutureCriticalPoints: deepFreeze([{ conclusion: '旧路线仍有效' as FutureCriticalConclusion, appliesWhen: '未来切换旧路线时' as FutureCriticalCondition, futureUse: '恢复旧承诺' as FutureCriticalUse }]) })],
      ['meaning_distorted', candidateVariant(actual, { formationFocus: deepFreeze({ ...actual.formationFocus, currentMatter: '被改写的当前事项' as CurrentMatterMeaning }) })],
      ['action_facts_not_self_contained', candidateVariant(actual, { actionableFacts: Object.freeze([]) })],
    ]
    for (const [reason, candidate] of variants) {
      const ledger = reviewCandidateContent(candidate, basis)
      const decision = ledger.content[0]
      expect(decision?.kind, reason).toBe('failed')
      expect(decision?.kind === 'failed' ? decision.reasons : [], reason).toContain(reason)
      expect(ledger.c28, reason).toHaveLength(0)
      expect(ledger.issues[0]?.kind, reason).toBe('explicitly_disqualified')
    }
    expect((await freezeHarness(harness)).provider).toEqual({ focus: 0, action: 0, evidence: 0, root: 0 })
  })

  it('N3 real FreshnessReviewer compares current C05/C18/C19 inputs and reports stale generation/ref changes through Qualification', async () => {
    const harness = await fresh('f01-candidate-n3-')
    const formedBasis = basisFixture('n3:formed')
    const currentBasis = basisFixture('n3:current')
    const source = productionComposition('n3-source', { formationBasis: formedBasis })
    source.formation.requestExplicitBackgroundUpdate({ chat: candidateChat })
    const candidate = formedCandidate(source.ledger)
    const ledger = mutableLedger()
    const ports = qualificationPorts(ledger)
    ports.formation.acceptFormationResult(Object.freeze({ kind: 'formed', candidate }))
    const reviewer = new CandidateBasisFreshnessReviewer({ qualification: ports.freshness })
    reviewer.acceptCurrentFocus(currentBasis.focus); reviewer.acceptCurrentActionFacts(currentBasis.action); reviewer.acceptCurrentEvidence(currentBasis.evidence)
    ledger.c24.push(reviewer.acceptCandidateForFreshnessReview(candidate))
    const frozen = freezeProductionLedger(ledger)
    expect(frozen.freshness[0]?.kind).toBe('stale')
    expect(frozen.freshness[0]?.kind === 'stale' ? frozen.freshness[0].changed.map(change => change.authority) : []).toEqual(['focus', 'action_facts', 'evidence'])
    expect(frozen.c28).toHaveLength(0)
    expect(frozen.issues[0]).toMatchObject({ kind: 'explicitly_disqualified', affected: 'candidate-basis' })
    expect((await freezeHarness(harness)).provider).toEqual({ focus: 0, action: 0, evidence: 0, root: 0 })
  })

  it('N4 real Formation runtime evidence rejects eight fixed-H1 uncertainty/over-budget proofs without truncating a candidate', async () => {
    const harness = await fresh('f01-candidate-n4-')
    const cases: ReadonlyArray<readonly [string, ProofChange, string]> = [
      ['margin-missing', proof => deepFreeze({ ...proof, safeUpdateMarginTokens: Number.NaN }), 'candidate_budget_unknown'],
      ['route-header-unknown', proof => deepFreeze({ ...proof, firstAssembly: { ...proof.firstAssembly, headerFingerprint: '' }, secondAssembly: { ...proof.secondAssembly, headerFingerprint: '' } }), 'candidate_budget_unknown'],
      ['context-window-unknown', proof => deepFreeze({ ...proof, firstPreparation: { ...proof.firstPreparation, contextWindow: 0 }, secondPreparation: { ...proof.secondPreparation, contextWindow: 0 } }), 'candidate_budget_unknown'],
      ['max-tokens-unknown', proof => deepFreeze({ ...proof, firstPreparation: { ...proof.firstPreparation, outputTokens: Number.NaN }, secondPreparation: { ...proof.secondPreparation, outputTokens: Number.NaN } }), 'candidate_budget_unknown'],
      ['assembly-mismatch', proof => deepFreeze({ ...proof, secondAssembly: { ...proof.secondAssembly, fingerprint: 'assembly:changed' } }), 'candidate_budget_unknown'],
      ['prepare-mismatch', proof => deepFreeze({ ...proof, secondPreparation: { ...proof.secondPreparation, outputTokens: proof.secondPreparation.outputTokens + 1 } }), 'candidate_budget_unknown'],
      ['public-dynamic-snapshot', proof => deepFreeze({ ...proof, secondPreparation: { ...proof.secondPreparation, model: 'candidate-test-dynamic' } }), 'candidate_budget_unknown'],
      ['over-budget', proof => deepFreeze({ ...proof, firstPreparation: { ...proof.firstPreparation, contextWindow: 400 }, secondPreparation: { ...proof.secondPreparation, contextWindow: 400 } }), 'candidate_over_budget'],
    ]
    for (const [name, proofChange, expectedReason] of cases) {
      const composition = productionComposition(`n4:${name}`, { proofChange })
      expect(composition.formation.requestExplicitBackgroundUpdate({ chat: candidateChat }).kind, name).toBe('business_result')
      const core = freezeProductionLedger(composition.ledger)
      expect(core.formations, name).toHaveLength(1)
      expect(core.formations[0], name).toMatchObject({ kind: 'safely_not_formed', reason: expectedReason })
      expect(core.c23, name).toHaveLength(0); expect(core.c24, name).toHaveLength(0); expect(core.c28, name).toHaveLength(0)
      expect(core.issues[0]?.kind, name).toBe('currently_unprovable')
    }
    expect((await freezeHarness(harness)).provider).toEqual({ focus: 0, action: 0, evidence: 0, root: 0 })
  })

  it('N5 real ports contain erroneous future input, observer throw and C42 replay while natural repeat cannot overwrite the applied background', async () => {
    const harness = await fresh('f01-candidate-n5-')
    const basis = basisFixture('n5')
    const source = productionComposition('n5-source', { formationBasis: basis })
    source.formation.requestExplicitBackgroundUpdate({ chat: candidateChat })
    const actual = formedCandidate(source.ledger)
    const futureCandidate = candidateVariant(actual, { knownFutureCriticalPoints: deepFreeze([{ conclusion: '未来版本可能改变当前结论' as FutureCriticalConclusion, appliesWhen: '新版本发布时' as FutureCriticalCondition, futureUse: '重新核验升级判断' as FutureCriticalUse }]) })
    const futureLedger = reviewCandidateContent(futureCandidate, basis)
    expect(futureLedger.content[0]?.kind).toBe('failed')
    expect(futureLedger.content[0]?.kind === 'failed' ? futureLedger.content[0].reasons : []).toContain('forbidden_old_content_included')
    expect(futureLedger.c28).toHaveLength(0)

    const observerLedger = mutableLedger()
    const throwingObserver: ReadOnlyCandidateQualificationObserver = { acceptCandidateQualification<Ref extends CandidateRef>(decision: Extract<CandidateQualificationDecision<Ref>, { readonly kind: 'qualified' }>): C28Result<Ref> { observerLedger.qualified.push(decision); throw new Error('read-only C28 observer rejected') } }
    const rejectedObserver = productionComposition('n5-observer', { observer: throwingObserver })
    expect(() => rejectedObserver.formation.requestExplicitBackgroundUpdate({ chat: candidateChat })).toThrow('read-only C28 observer rejected')
    expect(observerLedger.qualified).toHaveLength(1)
    expect(observerLedger.c28).toHaveLength(0)

    const issue = futureLedger.issues[0]!
    const advice = new UserInteractionAdvice()
    const report = advice.acceptCandidateQualificationIssue(issue)
    expect(report.kind).toBe('business_result')
    expect(advice.presentCandidateQualificationIssue(report)).toContain('明确未通过资格检查')
    expect(advice.presentCandidateQualificationIssue(report)).toBeUndefined()
    expect(advice.acceptCandidateQualificationIssue(issue).kind).toBe('rejected')

    await establishNaturalBasis(harness)
    const before = stateHash(harness.agent)
    const repeated = createUserMessage({ content: [{ type: 'text', text: updateDirect }], source: { kind: 'user' } })
    await send(harness.agent, updateDirect, repeated)
    await send(harness.agent, updateDirect, repeated)
    await send(harness.agent, '继续普通讨论。')
    const managed = await freezeHarness(harness)
    expect(managed.detachedEvents.filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === 'ui-context-compactor:candidate-qualification' && messagesText([event.data]) === qualifiedPresentation)).toHaveLength(0)
    expect(stateHash(harness.agent)).not.toBe(before)
    expect(harness.agent.session.deriveMessages().filter(message => message.source.kind === 'context-manager-canonical'
      && message.source.machine.kind === 'background')).toHaveLength(1)

    const nonmanaged = harness.ctx.agentLoop.create(SessionId('session-telegram-not-managed'), { provider: 'candidate-test', model: 'candidate-test', maxTokens: 256 })
    await send(nonmanaged, focusDirect)
    await send(nonmanaged, updateDirect)
    const nonmanagedLedger = await freezeHarness(harness, nonmanaged)
    expect(visibleText(nonmanagedLedger)).not.toContain('背景候选')
    expect(nonmanagedLedger.detachedEvents.some(event => event.type === 'user/message' && event.data.source.kind === 'context-manager-canonical')).toBe(false)
  })
})
