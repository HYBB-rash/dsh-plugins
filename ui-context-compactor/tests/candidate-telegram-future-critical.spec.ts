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
import {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import WebRuntime, { type WebSearchRequest } from '@deepseek-ai/dsh-web'
import type {
  ActionFactBoundary,
  ActionFactBoundaryRef,
  ActionRef,
  ActionableFactMeaning,
  EvidenceSourceRef,
  FactNeedSetRef,
  FactRef,
} from '../src/action-boundary.ts'
import {
  BackgroundCandidateFormation,
  CandidateBasisFreshnessReviewer,
  CandidateContentReviewer,
  renderCandidateBackground,
  type CandidateAssemblySnapshot,
  type CandidatePreparationSnapshot,
  type C23Result,
  type C24Result,
  type ExplicitBackgroundUpdateRuntimeEvidence,
  type FixedH1CandidateBudgetProof,
} from '../src/candidate.ts'
import {
  CandidateQualificationAuthority,
  type CandidateEnvelope,
  type CandidateBasisFreshnessDecision,
  type CandidateContentReviewDecision,
  type CandidateFormationResult,
  type CandidateQualificationDecision,
  type CandidateQualificationIssue,
  type CandidateRef,
  type C25Result,
  type C26Result,
  type C27Result,
  type C28Result,
  type C42Result,
  type FutureCriticalConclusion,
  type FutureCriticalCondition,
  type FutureCriticalUse,
} from '../src/candidate-qualification.ts'
import type { EvidenceConclusionSet, EvidenceConclusionSetRef } from '../src/fact-resolution.ts'
import { F03_EXACT_FOCUS_DIRECT, F03_EXACT_MULTI_SOURCE_DIRECT } from '../src/fact-resolution.ts'
import {
  projectFutureCriticalPoints,
  type AuthenticatedStructuredFutureCriticalMaterial,
  type AuthorizedUnstructuredFutureCriticalMaterial,
  type FutureCriticalPointProjection,
} from '../src/future-critical-candidate.ts'
import {
  UserInteractionAdvice,
  type ChatRef,
  type ContractCallRef,
  type CorrectionMeaning,
  type CurrentMatterMeaning,
  type FocusDecision,
  type FocusDecisionRef,
} from '../src/focus.ts'
import { ManagedAwareBasicCompactionEngine } from '../src/managed-compaction.ts'
import { BoundedAuxiliarySemanticCall } from '../src/managed-runtime.ts'
import * as ContextManager from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
const chat = ContextManager.FOCUS_CANARY_IDS[0] as ChatRef
const focusDirect = F03_EXACT_FOCUS_DIRECT
const evidenceDirect = F03_EXACT_MULTI_SOURCE_DIRECT
const updateDirect = '请更新当前背景'
const fact = 'DeepSeek Harness 最新版本'
const action = '升级 DeepSeek Harness'
const inspect = '列出已确认的只读升级前检查'
const point = Object.freeze({
  conclusion: 'DeepSeek Harness 当前稳定版本为 1.4.2',
  appliesWhen: 'stable channel',
  futureUse: '发布新稳定版时重新核验升级判断',
})

type FutureMode = 'valid' | 'malformed' | 'timeout'

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
  return options.messages.some(message => message.source.kind === 'plugin'
    && message.source.plugin === plugin)
}

function text(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

class FutureCriticalAdapter extends LlmAdapter {
  focusCalls = 0
  actionCalls = 0
  evidenceCalls = 0
  futureCalls = 0
  rootCalls = 0
  futureMode: FutureMode = 'valid'

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
        actions: [action, inspect],
        proposedRequirements: [{ fact, neededFor: [action] }],
        usableInputs: [],
        unresolvedInputs: [{
          fact, meaning: '当前最新版本尚未核清', source: 'direct-user', degree: 'unknown', affected: action,
        }],
      }))
      return
    }
    if (hasSchema(options, 'ui-context-compactor:evidence-schema')) {
      this.evidenceCalls += 1
      const input = options.messages.at(-1)
      const projection = record(JSON.parse(input === undefined ? '{}' : text([input])))
      const material = record(projection?.material)
      yield* chunks(JSON.stringify({
        kind: 'direct_fact',
        fact: projection?.fact,
        conclusion: point.conclusion,
        appliesWhen: point.appliesWhen,
        observedAt: material?.observedAt,
        publishedAt: material?.publishedAt ?? null,
        futureUse: point.futureUse,
        source: material?.source,
        degree: 'established',
        request: projection?.request,
        material: material?.ref,
        factNeeds: projection?.factNeeds,
      }))
      return
    }
    if (hasSchema(options, 'ui-context-compactor:future-critical-schema')) {
      this.futureCalls += 1
      if (this.futureMode === 'timeout') {
        await new Promise(resolve => setTimeout(resolve, 30))
      }
      const input = options.messages.at(-1)
      const projection = record(JSON.parse(input === undefined ? '{}' : text([input])))
      yield* chunks(this.futureMode === 'malformed'
        ? '{"material":"wrong"}'
        : JSON.stringify({
            material: projection?.material,
            source: projection?.source,
            conclusion: point.conclusion,
            appliesWhen: point.appliesWhen,
            futureUse: point.futureUse,
          }))
      return
    }
    this.rootCalls += 1
    yield* chunks('natural root response')
  }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: FutureCriticalAdapter
  readonly sqlitePath: string
}

async function fresh(prefix: string, timeoutMs = 100): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  const sqlitePath = join(root, 'future-critical.sqlite')
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mkdir(join(root, 'sessions'), { recursive: true })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: sqlitePath })
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
  await ctx.plugin(WebRuntime, { searchProvider: 'future-critical-search' })
  ctx.web.registerSearchProvider({
    id: 'future-critical-search',
    available: () => true,
    search: async (_request: WebSearchRequest) => ({
      content: 'bounded two-source envelope',
      sources: [
        {
          url: 'https://a.example.test/releases/latest',
          snippet: 'DeepSeek Harness 当前稳定版本为 1.4.2。',
          publishedAt: '2026-08-25T09:30:00.000Z',
        },
        {
          url: 'https://b.example.test/releases/latest',
          snippet: 'DeepSeek Harness 当前稳定版本为 1.4.2。',
          publishedAt: '2026-08-25T10:30:00.000Z',
        },
      ],
      truncated: false,
    }),
  })
  const adapter = new FutureCriticalAdapter()
  ctx.llm.registerAdapter(['future-critical-test'], adapter)
  await ctx.plugin(ContextManager, {
    focusCanary: {
      ...managedRuntime,
      auxiliary: {
        provider: 'future-critical-test', model: 'future-critical-test', maxOutputTokens: 256,
        timeoutMs, maxExpressionChars: 240, maxProjectionTokens: 2_048, safetyMarginTokens: 128,
      },
    },
    nativeWriterArbitration: { mode: 'enforce' },
    evidenceCanary: { mode: 'enforce' },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = ctx.agentLoop.create(SessionId(chat), {
    provider: 'future-critical-test', model: 'future-critical-test', maxTokens: 256,
  })
  return { ctx, agent, adapter, sqlitePath }
}

async function send(agent: Agent, direct: string): Promise<void> {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: direct }], source: { kind: 'user' },
  }))
  await agent.whenIdle()
}

async function physicalLedger(harness: Harness, label: string): Promise<readonly SessionEvent[]> {
  harness.agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: label }],
    source: { kind: 'plugin', plugin: 'ui-context-compactor:future-critical-test-ledger' },
  }), { surfaceOp: 'append' })
  await harness.ctx.sessions.flush(harness.agent.session)
  const detached = await harness.ctx.sessionPersistence.readFrom(harness.agent.session.id, 0)
  return Object.freeze([...detached.events])
}

function semantic(harness: Harness): BoundedAuxiliarySemanticCall {
  return new BoundedAuxiliarySemanticCall(harness.ctx.llm, harness.ctx.tokenMeter, {
    provider: 'future-critical-test', model: 'future-critical-test', maxOutputTokens: 256,
    timeoutMs: 10, maxExpressionChars: 240, maxProjectionTokens: 2_048, safetyMarginTokens: 128,
  })
}

interface Basis {
  readonly focus: Extract<FocusDecision, { readonly kind: 'focus_established' }>
  readonly action: ActionFactBoundary
  readonly evidence: EvidenceConclusionSet
}

function basis(tag: string): Basis {
  const factRef = `fact:${tag}` as FactRef
  const actionRef = `action:${tag}` as ActionRef
  const usable = Object.freeze({
    kind: 'direct_fact' as const,
    fact: factRef,
    meaning: `DeepSeek Harness ${tag} 当前稳定版本为 1.4.2` as ActionableFactMeaning,
    source: `source:${tag}` as EvidenceSourceRef,
    degree: 'established' as const,
  })
  return deepFreeze({
    focus: {
      kind: 'focus_established', ref: `focus:${tag}` as FocusDecisionRef, chat,
      currentMatter: `升级 DeepSeek Harness ${tag}` as CurrentMatterMeaning,
      latestCorrections: `仅采用 ${tag} 稳定版事实` as CorrectionMeaning,
    },
    action: {
      kind: 'actionable', ref: `action-boundary:${tag}` as ActionFactBoundaryRef, chat,
      requiredFacts: {
        ref: `fact-needs:${tag}` as FactNeedSetRef,
        requirements: [{ fact: factRef, neededFor: [actionRef] }],
      },
      usableFacts: [usable], unresolvedFacts: [], preciselyBlockedActions: [],
      safelyContinuableActions: [actionRef],
    },
    evidence: {
      ref: `evidence:${tag}` as EvidenceConclusionSetRef, chat, conclusions: [usable],
    },
  })
}

function withoutChat<Value extends { readonly chat: ChatRef }>(value: Value): Omit<Value, 'chat'> {
  const { chat: _chat, ...rest } = value
  return deepFreeze(structuredClone(rest))
}

function directHash(messageId: string): string {
  return createHash('sha256').update(messageId).update('\0').update(updateDirect).digest('hex')
}

function runtimeEvidence(
  input: Basis,
  projection: FutureCriticalPointProjection,
  tag: string,
  contextWindow = 16_384,
): ExplicitBackgroundUpdateRuntimeEvidence {
  const body = renderCandidateBackground({
    target: chat,
    focus: withoutChat(input.focus),
    action: withoutChat(input.action),
    evidence: withoutChat(input.evidence),
    knownFutureCriticalPoints: projection.kind === 'projected' ? projection.points : Object.freeze([]),
  })
  const messageId = `future-critical-direct:${tag}`
  const originHash = directHash(messageId)
  const assembly: CandidateAssemblySnapshot = Object.freeze({
    fingerprint: `assembly:${tag}`, provider: 'future-critical-test', model: 'future-critical-test',
    headerFingerprint: `header:${tag}`, contextFingerprint: `context:${tag}`, revision: 3,
    directMessageId: messageId, directHash: originHash, directText: updateDirect,
    directChat: chat, baseInputTokens: 100,
  })
  const preparation: CandidatePreparationSnapshot = Object.freeze({
    fingerprint: `preparation:${tag}`, provider: 'future-critical-test', model: 'future-critical-test',
    contextWindow, outputTokens: 256,
  })
  const budget: FixedH1CandidateBudgetProof = Object.freeze({
    kind: 'fixed_h1_known_envelope', firstAssembly: assembly,
    secondAssembly: Object.freeze({ ...assembly }), firstPreparation: preparation,
    secondPreparation: Object.freeze({ ...preparation }),
    bodyHash: createHash('sha256').update(body).digest('hex'), bodyTokens: 100,
    safeUpdateMarginTokens: 64,
  })
  return deepFreeze({
    chat, text: updateDirect, origin: { messageId, hash: originHash }, budget,
    futureCriticalPoints: projection,
  })
}

interface PipelineLedger {
  readonly formations: CandidateFormationResult[]
  readonly candidates: CandidateEnvelope[]
  readonly c25: C25Result[]
  readonly c26: C26Result[]
  readonly c27: C27Result[]
  readonly c28: C28Result[]
  readonly issues: CandidateQualificationIssue[]
  readonly c42: C42Result[]
}

function ledger(): PipelineLedger {
  return { formations: [], candidates: [], c25: [], c26: [], c27: [], c28: [], issues: [], c42: [] }
}

function acceptedC28<Ref extends CandidateRef>(
  decision: Extract<CandidateQualificationDecision<Ref>, { readonly kind: 'qualified' }>,
): C28Result<Ref> {
  const subject = Object.freeze({ kind: 'candidate' as const, candidate: decision.candidate })
  return {
    kind: 'business_result',
    identity: { contract: 'C28', call: `C28:test:${decision.candidate.ref}` as ContractCallRef, subject },
    value: { kind: 'accepted_for_contract', value: decision },
  }
}

function qualification(output: PipelineLedger): CandidateQualificationAuthority {
  const advice = new UserInteractionAdvice()
  return new CandidateQualificationAuthority({
    observer: {
      acceptCandidateQualification<Ref extends CandidateRef>(
        decision: Extract<CandidateQualificationDecision<Ref>, { readonly kind: 'qualified' }>,
      ): C28Result<Ref> {
        const result = acceptedC28(decision)
        output.c28.push(result)
        return result
      },
    },
    userAdvice: {
      acceptCandidateQualificationIssue<Ref extends CandidateRef>(
        issue: CandidateQualificationIssue<Ref>,
      ): C42Result<Ref> {
        output.issues.push(issue)
        const result = advice.acceptCandidateQualificationIssue(issue)
        output.c42.push(result)
        return result
      },
    },
  })
}

function runPipeline(
  input: Basis,
  projection: FutureCriticalPointProjection,
  tag: string,
  contextWindow = 16_384,
): PipelineLedger {
  const output = ledger()
  const authority = qualification(output)
  const content = new CandidateContentReviewer({
    qualification: {
      acceptContentReview<Ref extends CandidateRef>(
        review: CandidateContentReviewDecision<Ref>,
      ): C26Result<Ref> {
        const result = authority.acceptContentReview<Ref>(review)
        output.c26.push(result)
        return result
      },
    },
  })
  const freshness = new CandidateBasisFreshnessReviewer({
    qualification: {
      acceptBasisFreshness<Ref extends CandidateRef>(
        decision: CandidateBasisFreshnessDecision<Ref>,
      ): C27Result<Ref> {
        const result = authority.acceptBasisFreshness<Ref>(decision)
        output.c27.push(result)
        return result
      },
    },
  })
  const evidence = runtimeEvidence(input, projection, tag, contextWindow)
  let available = true
  const formation = new BackgroundCandidateFormation({
    qualification: {
      acceptFormationResult<Ref extends CandidateRef>(
        result: CandidateFormationResult<Ref>,
      ): C25Result<Ref> {
        output.formations.push(result)
        if (result.kind === 'formed') output.candidates.push(result.candidate)
        const report = authority.acceptFormationResult<Ref>(result)
        output.c25.push(report)
        return report
      },
    },
    contentReview: {
      acceptCandidateForContentReview<Ref extends CandidateRef>(
        candidate: CandidateEnvelope<Ref>,
      ): C23Result<Ref> {
        return content.acceptCandidateForContentReview<Ref>(candidate)
      },
    },
    freshnessReview: {
      acceptCandidateForFreshnessReview<Ref extends CandidateRef>(
        candidate: CandidateEnvelope<Ref>,
      ): C24Result<Ref> {
        return freshness.acceptCandidateForFreshnessReview<Ref>(candidate)
      },
    },
    runtimeEvidence: {
      takeExplicitUpdateEvidence(target): ExplicitBackgroundUpdateRuntimeEvidence | undefined {
        if (!available || target !== chat) return undefined
        available = false
        return evidence
      },
    },
  })
  formation.acceptFocusBasis(input.focus)
  formation.acceptActionFactBoundary(input.action)
  formation.acceptEvidenceConclusions(input.evidence)
  content.acceptRequiredFocus(input.focus)
  content.acceptRequiredActionFacts(input.action)
  content.acceptEvidenceConclusions(input.evidence)
  freshness.acceptCurrentFocus(input.focus)
  freshness.acceptCurrentActionFacts(input.action)
  freshness.acceptCurrentEvidence(input.evidence)
  formation.requestExplicitBackgroundUpdate({ chat })
  return deepFreeze(output)
}

function reviewVariant(input: Basis, candidate: CandidateEnvelope): PipelineLedger {
  const output = ledger()
  const authority = qualification(output)
  output.c25.push(authority.acceptFormationResult(Object.freeze({ kind: 'formed', candidate })))
  const reviewer = new CandidateContentReviewer({
    qualification: {
      acceptContentReview<Ref extends CandidateRef>(
        review: CandidateContentReviewDecision<Ref>,
      ): C26Result<Ref> {
        const result = authority.acceptContentReview<Ref>(review)
        output.c26.push(result)
        return result
      },
    },
  })
  reviewer.acceptRequiredFocus(input.focus)
  reviewer.acceptRequiredActionFacts(input.action)
  reviewer.acceptEvidenceConclusions(input.evidence)
  reviewer.acceptCandidateForContentReview(candidate)
  return deepFreeze(output)
}

function variant(candidate: CandidateEnvelope, changes: Partial<CandidateEnvelope>): CandidateEnvelope {
  return deepFreeze({ ...candidate, ...changes }) as CandidateEnvelope
}

function structuredMaterial(): AuthenticatedStructuredFutureCriticalMaterial {
  return Object.freeze({
    kind: 'authenticated_structured', material: 'material:structured', source: 'source:structured',
    conclusion: point.conclusion, appliesWhen: point.appliesWhen, futureUse: point.futureUse,
  })
}

function authorizedMaterial(): AuthorizedUnstructuredFutureCriticalMaterial {
  return Object.freeze({
    kind: 'authorized_unstructured', material: 'material:authorized', source: 'source:authorized',
    authorizedExcerpt: '稳定版结论只适用于 stable channel；新稳定版发布时需要重新核验升级判断。',
  })
}

describe('F01-T1F future-critical candidate through the real root and production qualification ports', () => {
  it('P1 projects authenticated structured evidence with zero additional provider calls and reaches natural C28', async () => {
    const harness = await fresh('f01-t1f-p1-')
    await send(harness.agent, focusDirect)
    await send(harness.agent, evidenceDirect)
    const before = Object.freeze({
      focus: harness.adapter.focusCalls, action: harness.adapter.actionCalls,
      evidence: harness.adapter.evidenceCalls, future: harness.adapter.futureCalls,
      root: harness.adapter.rootCalls,
    })
    await send(harness.agent, updateDirect)
    const events = await physicalLedger(harness, 'P1 structured projection ledger')
    expect(Object.freeze({
      focus: harness.adapter.focusCalls, action: harness.adapter.actionCalls,
      evidence: harness.adapter.evidenceCalls, future: harness.adapter.futureCalls,
      root: harness.adapter.rootCalls,
    })).toStrictEqual({ ...before, root: before.root + 1 })
    expect(events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'ui-context-compactor:candidate-qualification')).toHaveLength(0)
    expect(events.flatMap(event => event.type === 'user/message'
      && event.data.source.kind === 'context-manager-canonical'
      && event.data.source.machine.kind === 'background'
      ? [event.data.source.phase]
      : [])).toStrictEqual(['current', 'finalized'])
    expect(events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      && text([event.data]) === updateDirect)).toHaveLength(1)
  })

  it('P2 retains conclusion, appliesWhen and futureUse in one frozen candidate through C28', async () => {
    const harness = await fresh('f01-t1f-p2-')
    const projection = await projectFutureCriticalPoints(
      Object.freeze([structuredMaterial()]), semantic(harness), new AbortController().signal,
    )
    const output = runPipeline(basis('p2'), projection, 'p2')
    expect(projection).toMatchObject({ kind: 'projected', auxiliaryCalls: 0 })
    expect(output.c28).toHaveLength(1)
    expect(output.c42).toHaveLength(0)
    expect(output.candidates[0]?.knownFutureCriticalPoints).toStrictEqual([point])
    expect(Object.isFrozen(output.candidates[0]?.knownFutureCriticalPoints)).toBe(true)
    expect(output.candidates[0]?.background).toContain(JSON.stringify(point))
    expect(Object.isFrozen(await physicalLedger(harness, 'P2 full point C28 ledger'))).toBe(true)
  })

  it('P3 uses the existing bounded caller exactly once for authorized unstructured material before both reviewers and C28', async () => {
    const harness = await fresh('f01-t1f-p3-')
    const projection = await projectFutureCriticalPoints(
      Object.freeze([authorizedMaterial()]), semantic(harness), new AbortController().signal,
    )
    const output = runPipeline(basis('p3'), projection, 'p3')
    expect(projection).toMatchObject({ kind: 'projected', auxiliaryCalls: 1 })
    expect(harness.adapter.futureCalls).toBe(1)
    expect(output.c26).toHaveLength(1)
    expect(output.c27).toHaveLength(1)
    expect(output.c28).toHaveLength(1)
    expect(output.c42).toHaveLength(0)
    expect(output.candidates[0]?.knownFutureCriticalPoints).toStrictEqual([point])
    await physicalLedger(harness, 'P3 bounded proposal C28 ledger')
  })

  it('N1 reports C42 for missing, tampered or omitted future-critical fields instead of qualifying a clone', async () => {
    const harness = await fresh('f01-t1f-n1-')
    const projection = await projectFutureCriticalPoints(
      Object.freeze([structuredMaterial()]), semantic(harness), new AbortController().signal,
    )
    const source = runPipeline(basis('n1'), projection, 'n1-source')
    const actual = source.candidates[0]
    if (actual === undefined) throw new Error('N1 source candidate was not formed')
    const cases: ReadonlyArray<readonly [string, CandidateEnvelope]> = [
      ['missing-condition', variant(actual, {
        knownFutureCriticalPoints: deepFreeze([{
          conclusion: point.conclusion as FutureCriticalConclusion,
          appliesWhen: '' as FutureCriticalCondition,
          futureUse: point.futureUse as FutureCriticalUse,
        }]),
      })],
      ['tampered-use', variant(actual, {
        knownFutureCriticalPoints: deepFreeze([{
          conclusion: point.conclusion as FutureCriticalConclusion,
          appliesWhen: point.appliesWhen as FutureCriticalCondition,
          futureUse: '执行旧路线' as FutureCriticalUse,
        }]),
      })],
      ['omitted-point', variant(actual, { knownFutureCriticalPoints: Object.freeze([]) })],
    ]
    for (const [name, candidate] of cases) {
      const output = reviewVariant(basis('n1'), candidate)
      expect(output.c28, name).toHaveLength(0)
      expect(output.c42, name).toHaveLength(1)
      expect(output.issues[0]?.kind, name).toBe('explicitly_disqualified')
    }
    await physicalLedger(harness, 'N1 missing tampered omitted C42 ledger')
  })

  it('N2 reports C42 when old future content is injected beside the one authenticated point', async () => {
    const harness = await fresh('f01-t1f-n2-')
    const projection = await projectFutureCriticalPoints(
      Object.freeze([structuredMaterial()]), semantic(harness), new AbortController().signal,
    )
    const input = basis('n2')
    const source = runPipeline(input, projection, 'n2-source')
    const actual = source.candidates[0]
    if (actual === undefined) throw new Error('N2 source candidate was not formed')
    const injected = variant(actual, {
      knownFutureCriticalPoints: deepFreeze([
        ...actual.knownFutureCriticalPoints,
        {
          conclusion: '旧路线仍有效' as FutureCriticalConclusion,
          appliesWhen: '回到旧版本时' as FutureCriticalCondition,
          futureUse: '恢复旧承诺' as FutureCriticalUse,
        },
      ]),
    })
    const output = reviewVariant(input, injected)
    expect(output.c28).toHaveLength(0)
    expect(output.c42).toHaveLength(1)
    expect(output.issues[0]).toMatchObject({ kind: 'explicitly_disqualified' })
    await physicalLedger(harness, 'N2 injected old point C42 ledger')
  })

  it('N3 keeps an unauthorized unstructured object at zero calls and reports currently-unprovable C42', async () => {
    const harness = await fresh('f01-t1f-n3-')
    const unauthorized: AuthorizedUnstructuredFutureCriticalMaterial = {
      kind: 'authorized_unstructured', material: 'material:untrusted', source: 'source:untrusted',
      authorizedExcerpt: 'not owner-frozen',
    }
    const projection = await projectFutureCriticalPoints(
      Object.freeze([unauthorized]), semantic(harness), new AbortController().signal,
    )
    const output = runPipeline(basis('n3'), projection, 'n3')
    expect(projection).toMatchObject({ kind: 'unavailable', auxiliaryCalls: 0 })
    expect(harness.adapter.futureCalls).toBe(0)
    expect(output.c28).toHaveLength(0)
    expect(output.c42).toHaveLength(1)
    expect(output.issues[0]?.kind).toBe('currently_unprovable')
    await physicalLedger(harness, 'N3 unauthorized zero-call C42 ledger')
  })

  it('N4 table-drives bounded provider timeout and malformed output to one-call unavailable C42', async () => {
    for (const mode of ['timeout', 'malformed'] as const) {
      const harness = await fresh(`f01-t1f-n4-${mode}-`)
      harness.adapter.futureMode = mode
      const projection = await projectFutureCriticalPoints(
        Object.freeze([authorizedMaterial()]), semantic(harness), new AbortController().signal,
      )
      const output = runPipeline(basis(`n4:${mode}`), projection, `n4:${mode}`)
      expect(projection, mode).toMatchObject({ kind: 'unavailable', auxiliaryCalls: 1 })
      expect(harness.adapter.futureCalls, mode).toBe(1)
      expect(output.c28, mode).toHaveLength(0)
      expect(output.c42, mode).toHaveLength(1)
      expect(output.issues[0]?.kind, mode).toBe('currently_unprovable')
      await physicalLedger(harness, `N4 ${mode} C42 ledger`)
    }
  })

  it('N5 preserves the complete point and reports over-budget C42 without truncation, canonical state or apply', async () => {
    const harness = await fresh('f01-t1f-n5-')
    const projection = await projectFutureCriticalPoints(
      Object.freeze([structuredMaterial()]), semantic(harness), new AbortController().signal,
    )
    const output = runPipeline(basis('n5'), projection, 'n5', 400)
    const events = await physicalLedger(harness, 'N5 complete over-budget C42 ledger')
    expect(projection).toMatchObject({ kind: 'projected', auxiliaryCalls: 0, points: [point] })
    expect(output.candidates).toHaveLength(0)
    expect(output.c28).toHaveLength(0)
    expect(output.c42).toHaveLength(1)
    expect(output.issues[0]).toMatchObject({
      kind: 'currently_unprovable', missingOrUncertain: ['candidate_over_budget'],
    })
    expect(events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'context-manager-canonical')).toBe(false)
  })
})
