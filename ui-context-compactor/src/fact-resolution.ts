/**
 * F03's sole evidence authority for one exact Telegram web fact.
 *
 * Raw web results and bounded semantic proposals remain unsigned inputs. Only
 * this authority may form C11/C12 evidence conclusions, and it never decides
 * which actions need the fact or forms an action boundary.
 */

import { createHash } from 'node:crypto'
import type { WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import type {
  ActionRef,
  ActionableFactMeaning,
  DirectFact,
  EvidenceSourceRef,
  FactAffectedScope,
  FactNeedSet,
  FactNeedSetRef,
  FactRef,
  FactRequirement,
  UncertaintyMeaning,
  UnresolvedFact,
} from './action-boundary.ts'
import type {
  Accepted,
  Branded,
  ChatRef,
  ContractCallRef,
  ContractCode,
  ContractReport,
  ContractScope,
  FocusDecision,
  FocusDecisionRef,
} from './focus.ts'
import {
  exactTwo,
  exactTwoDistinctBy,
  projectExactTwoFactResults,
  sameExactStringSet,
  type ExactTwo,
} from './multi-fact-resolution.ts'
import {
  resolveMultiSourceConflict,
  type CompleteMultiSourceResolution,
  type MultiSourceFindingShape,
  type MultiSourceMaterialShape,
} from './multi-source-conflict.ts'

export const F03_EXACT_FOCUS_DIRECT = '准备升级 DeepSeek Harness'
export const F03_EXACT_FACT_DIRECT = '查一下 DeepSeek Harness 当前最新版本；确认后再决定是否升级。'
export const F03_EXACT_MULTI_SOURCE_DIRECT = '查一下 DeepSeek Harness 当前最新版本的两个来源；如果结论冲突，说明冲突并只限制依赖版本结论的行动。'
export const F03_EXACT_MULTI_FACT_DIRECT = '查一下 DeepSeek Harness 当前最新版本和该版本要求的 Node.js 版本；分别确认后再决定是否升级。'
export const F03_PRIVATE_SEARCH_QUERY = 'DeepSeek Harness latest version'
const F03_NODE_REQUIREMENT_SEARCH_QUERY = 'DeepSeek Harness latest version Node.js requirements'
const F03_RELEASE_FACT = 'DeepSeek Harness 最新版本'
const F03_NODE_REQUIREMENT_FACT = 'DeepSeek Harness 最新版本的 Node.js 版本要求'
const F03_UPGRADE_ACTION = '升级 DeepSeek Harness'
const F03_NODE_COMPATIBILITY_ACTION = '核对当前 Node.js 是否兼容'
export const F03_SEARCH_MAX_RESULTS = 1
const F03_MULTI_SOURCE_MAX_RESULTS = 2
export const F03_MAX_MATERIAL_CHARS = 4_096

export type EvidenceRequestRef = Branded<'EvidenceRequestRef'>
export type EvidenceConclusionSetRef = Branded<'EvidenceConclusionSetRef'>
export type EvidenceMaterialRef = Branded<'EvidenceMaterial'>
export type PartialEvidenceMaterialRef = Branded<'PartialEvidenceMaterial'>
export type EvidencePromiseDescription = Branded<'EvidencePromiseDescription'>

export interface EvidenceRetrievalRequest {
  readonly ref: EvidenceRequestRef
  readonly need: FactRequirement
}

export interface EvidenceMaterial {
  readonly ref: EvidenceMaterialRef
  readonly request: EvidenceRequestRef
  readonly fact: FactRef
  readonly source: EvidenceSourceRef
  readonly url: string
  readonly content: string
  readonly observedAt: string
  readonly publishedAt: string | undefined
  readonly truncated: false
}

export interface RetrievedEvidence {
  readonly request: EvidenceRequestRef
  readonly actualMaterials: readonly EvidenceMaterialRef[]
  readonly sources: readonly EvidenceSourceRef[]
  readonly observedGaps: readonly UncertaintyMeaning[]
  readonly observedConflicts: readonly UncertaintyMeaning[]
}

export interface PartialRetrievedEvidence {
  readonly request: EvidenceRequestRef
  readonly actualPartialMaterials: readonly PartialEvidenceMaterialRef[]
  readonly sources: readonly EvidenceSourceRef[]
  readonly observedGaps: readonly UncertaintyMeaning[]
  readonly observedConflicts: readonly UncertaintyMeaning[]
  readonly missing: FactAffectedScope
}

export type EvidenceConclusion = DirectFact | UnresolvedFact
export interface EvidenceConclusionSet {
  readonly ref: EvidenceConclusionSetRef
  readonly chat: ChatRef
  readonly conclusions: readonly EvidenceConclusion[]
}
export interface PartialFactNeedSet {
  readonly ref: FactNeedSetRef
  readonly establishedRequirements: readonly FactRequirement[]
  readonly complete: false
}
export interface PartialEvidenceConclusionSet {
  readonly ref: EvidenceConclusionSetRef
  readonly establishedConclusions: readonly EvidenceConclusion[]
  readonly complete: false
}

export type C11Result = ContractReport<'C11', FactNeedSetRef, Accepted<FactNeedSet>, PartialFactNeedSet>
export type C12Result = ContractReport<'C12', EvidenceRequestRef, RetrievedEvidence, PartialRetrievedEvidence>
export type C13Result = ContractReport<
  'C13',
  EvidenceConclusionSetRef,
  Accepted<EvidenceConclusionSet>,
  PartialEvidenceConclusionSet
>

export interface WebSearchPort {
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

export interface BoundedEvidenceProposalRequest {
  readonly factNeeds: FactNeedSet
  readonly retrieval: EvidenceRetrievalRequest
  readonly material: EvidenceMaterial
  readonly origin: {
    readonly messageId: string
    readonly hash: string
    readonly chat: ChatRef
  }
  readonly focus: FocusDecisionRef
  readonly affected: FactAffectedScope
}

export type EvidenceProposalOutcome =
  | {
      readonly kind: 'proposal'
      readonly request: BoundedEvidenceProposalRequest
      readonly value: EvidenceConclusion
    }
  | {
      readonly kind: 'known_failure' | 'unknown'
      readonly request: BoundedEvidenceProposalRequest
      readonly detail: EvidencePromiseDescription
    }

export interface EvidenceSemanticPort {
  proposeEvidence(
    request: BoundedEvidenceProposalRequest,
    signal: AbortSignal,
  ): Promise<EvidenceProposalOutcome>
}

/** Dependencies from which the action composition creates its private receiver. */
export interface EvidenceResolutionDependencies {
  readonly web: WebSearchPort
  readonly semantic: EvidenceSemanticPort
  readonly now?: () => string
}

export interface EvidenceConclusionCandidateReceivers {
  readonly formation: {
    acceptEvidenceConclusions(conclusions: EvidenceConclusionSet): unknown
  }
  readonly contentReview: {
    acceptEvidenceConclusions(conclusions: EvidenceConclusionSet): unknown
  }
  readonly freshnessReview: {
    acceptCurrentEvidence(conclusions: EvidenceConclusionSet): unknown
  }
}

/** Read-only presentation provenance for one exact concluded fact. */
export interface EvidenceConclusionProvenance {
  readonly conclusion: EvidenceConclusion
  readonly source: EvidenceSourceRef
  readonly url: string | undefined
  readonly observedAt: string | undefined
  readonly publishedAt: string | undefined
}

export interface EvidenceResolutionOutcome {
  readonly c11: C11Result
  readonly request: EvidenceRetrievalRequest
  readonly c12: C12Result
  readonly conclusions: EvidenceConclusionSet
  readonly material: EvidenceMaterial | undefined
  readonly provenance: EvidenceConclusionProvenance
}

export interface MultiFactEvidenceResolutionItem {
  readonly requirement: FactRequirement
  readonly request: EvidenceRetrievalRequest
  readonly c12: C12Result
  readonly material: EvidenceMaterial | undefined
  readonly conclusion: EvidenceConclusion
  readonly provenance: EvidenceConclusionProvenance
}

export interface MultiFactEvidenceResolutionOutcome {
  readonly kind: 'multi'
  readonly c11: C11Result
  readonly items: ExactTwo<MultiFactEvidenceResolutionItem>
  readonly conclusions: EvidenceConclusionSet
}

export interface MultiSourceEvidenceResolutionOutcome {
  readonly kind: 'multi_source'
  readonly resolution: 'agree' | 'conditional' | 'conflict' | 'source_incomplete'
  readonly c11: C11Result
  readonly request: EvidenceRetrievalRequest
  readonly c12: C12Result
  readonly materials: readonly EvidenceMaterial[]
  readonly findings: readonly MultiSourceFindingShape[]
  readonly conclusions: EvidenceConclusionSet
  readonly provenances: readonly EvidenceConclusionProvenance[]
}

export type EvidenceResolutionResult =
  | EvidenceResolutionOutcome
  | MultiFactEvidenceResolutionOutcome
  | MultiSourceEvidenceResolutionOutcome

export function isMultiFactEvidenceResolutionOutcome(
  outcome: EvidenceResolutionResult,
): outcome is MultiFactEvidenceResolutionOutcome {
  return 'kind' in outcome && outcome.kind === 'multi'
}

interface OwnerIssuedFactNeedBinding {
  readonly owner: object
  readonly focus: Extract<FocusDecision, { readonly kind: 'focus_established' }>
  readonly origin: {
    readonly messageId: string
    readonly hash: string
    readonly chat: ChatRef
  }
}

interface MultiFactResolutionRun {
  readonly binding: OwnerIssuedFactNeedBinding
  readonly c11: C11Result
  readonly items: MultiFactEvidenceResolutionItem[]
  nextIndex: number
  active: boolean
}

interface MultiSourceResolutionRun {
  readonly binding: OwnerIssuedFactNeedBinding
  readonly c11: C11Result
  readonly request: EvidenceRetrievalRequest
  retrieval: {
    readonly c12: C12Result
    readonly materials: readonly EvidenceMaterial[]
  } | undefined
  readonly findings: MultiSourceFindingShape[]
  nextIndex: number
  active: boolean
}

const expectedOwners = new WeakMap<EvidenceResolution, object>()
const pendingFactNeeds = new WeakMap<EvidenceResolution, WeakMap<FactNeedSet, OwnerIssuedFactNeedBinding>>()
const completedFactNeedOutcomes = new WeakMap<
  EvidenceResolution,
  WeakMap<FactNeedSet, {
    readonly owner: object
    readonly outcome: EvidenceResolutionResult
  }>
>()
const authenticEvidenceRequests = new WeakMap<BoundedEvidenceProposalRequest, EvidenceSemanticPort>()
const multiFactResolutionRuns = new WeakMap<
  EvidenceResolution,
  WeakMap<FactNeedSet, MultiFactResolutionRun>
>()
const multiSourceResolutionRuns = new WeakMap<
  EvidenceResolution,
  WeakMap<FactNeedSet, MultiSourceResolutionRun>
>()
const evidenceConclusionCandidateReceivers = new WeakMap<
  EvidenceResolution,
  EvidenceConclusionCandidateReceivers
>()
const evidenceConclusionFanoutRuns = new WeakMap<
  EvidenceResolution,
  WeakMap<EvidenceConclusionSet, {
    readonly owner: object
    nextStage: 0 | 1 | 2 | 3
    active: boolean
  }>
>()

function identity<Code extends ContractCode, Subject>(contract: Code, subject: Subject) {
  return { contract, call: `${contract}:${crypto.randomUUID()}` as ContractCallRef, subject }
}

function scope<Code extends ContractCode, Kind extends string>(
  contract: Code,
  kind: Kind,
): ContractScope<Code, Kind> {
  return `${contract}:${kind}` as ContractScope<Code, Kind>
}

function failed<Code extends ContractCode, Subject>(
  contract: Code,
  subject: Subject,
): Extract<ContractReport<Code, Subject, unknown>, { readonly kind: 'known_failure' }> {
  return {
    kind: 'known_failure',
    identity: identity(contract, subject),
    problem: {
      detail: scope(contract, 'failure'),
      affected: scope(contract, 'failure_scope'),
    },
  }
}

function unknown<Code extends ContractCode, Subject>(
  contract: Code,
  subject: Subject,
): Extract<ContractReport<Code, Subject, unknown>, { readonly kind: 'unknown' }> {
  return {
    kind: 'unknown',
    identity: identity(contract, subject),
    problem: {
      detail: scope(contract, 'unknown'),
      affected: scope(contract, 'unknown_scope'),
    },
  }
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function onlyKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exactDirectHash(messageId: string, text: string): string {
  return createHash('sha256').update(messageId).update('\0').update(text).digest('hex')
}

function exactRequirementIdentity(requirement: FactRequirement): 'a' | 'b' | undefined {
  if (!onlyKeys(requirement, ['fact', 'neededFor'])
    || !nonblank(requirement.fact)
    || requirement.neededFor.length === 0
    || requirement.neededFor.some(action => !nonblank(action))) return undefined
  if (requirement.fact === F03_RELEASE_FACT
    && sameExactStringSet(requirement.neededFor, [F03_UPGRADE_ACTION])) return 'a'
  if (requirement.fact === F03_NODE_REQUIREMENT_FACT
    && sameExactStringSet(requirement.neededFor, [F03_UPGRADE_ACTION, F03_NODE_COMPATIBILITY_ACTION])) return 'b'
  return undefined
}

function searchQueryForRequirement(requirement: FactRequirement): string | undefined {
  const identity = exactRequirementIdentity(requirement)
  return identity === 'a'
    ? F03_PRIVATE_SEARCH_QUERY
    : identity === 'b' ? F03_NODE_REQUIREMENT_SEARCH_QUERY : undefined
}

function exactOwnerBinding(needs: FactNeedSet, binding: OwnerIssuedFactNeedBinding): boolean {
  const { focus, origin } = binding
  if (!onlyKeys(needs, ['ref', 'chat', 'requirements'])
    || focus.kind !== 'focus_established'
    || focus.currentMatter !== F03_EXACT_FOCUS_DIRECT
    || focus.chat !== needs.chat
    || focus.chat !== origin.chat
    || !nonblank(needs.ref)
    || !nonblank(origin.messageId)
    || !nonblank(origin.hash)) return false
  if (needs.requirements.length === 1) {
    const requirement = needs.requirements[0]
    return (exactDirectHash(origin.messageId, F03_EXACT_FACT_DIRECT) === origin.hash
        || exactDirectHash(origin.messageId, F03_EXACT_MULTI_SOURCE_DIRECT) === origin.hash)
      && requirement !== undefined
      && exactRequirementIdentity(requirement) === 'a'
  }
  return exactDirectHash(origin.messageId, F03_EXACT_MULTI_FACT_DIRECT) === origin.hash
    && exactTwoDistinctBy(needs.requirements, exactRequirementIdentity) !== undefined
}

function isMultiSourceOwnerBinding(binding: OwnerIssuedFactNeedBinding): boolean {
  return exactDirectHash(binding.origin.messageId, F03_EXACT_MULTI_SOURCE_DIRECT)
    === binding.origin.hash
}

/** Bind one EvidenceResolution to the sole ActionFactBoundaryAuthority owner. */
export function bindExpectedFactNeedOwner(
  resolution: EvidenceResolution,
  owner: object,
): boolean {
  const existing = expectedOwners.get(resolution)
  if (existing !== undefined) return existing === owner
  expectedOwners.set(resolution, owner)
  return true
}

/** @internal One package-local binding; it neither creates nor edits conclusions. */
export function bindEvidenceConclusionCandidateReceivers(
  resolution: EvidenceResolution,
  receivers: EvidenceConclusionCandidateReceivers,
): boolean {
  const existing = evidenceConclusionCandidateReceivers.get(resolution)
  if (existing !== undefined) return existing === receivers
  if (typeof receivers.formation?.acceptEvidenceConclusions !== 'function'
    || typeof receivers.contentReview?.acceptEvidenceConclusions !== 'function'
    || typeof receivers.freshnessReview?.acceptCurrentEvidence !== 'function') return false
  evidenceConclusionCandidateReceivers.set(resolution, receivers)
  return true
}

/**
 * Implementation-only owner bridge. A structural FactNeedSet is insufficient:
 * the exact object and its direct/focus association must come from the bound
 * action authority.
 */
export function issueOwnerBoundFactNeedSet(
  resolution: EvidenceResolution,
  owner: object,
  needs: FactNeedSet,
  focus: FocusDecision,
  origin: { readonly messageId: string; readonly hash: string; readonly chat: ChatRef },
): boolean {
  if (expectedOwners.get(resolution) !== owner || focus.kind !== 'focus_established') return false
  const registry = pendingFactNeeds.get(resolution)
  if (registry === undefined || registry.has(needs)) return false
  const binding: OwnerIssuedFactNeedBinding = Object.freeze({
    owner,
    focus,
    origin: Object.freeze({ ...origin }),
  })
  if (!exactOwnerBinding(needs, binding)) return false
  registry.set(needs, binding)
  return true
}

/** Runtime authentication used only by the existing bounded caller. */
export function isAuthenticBoundedEvidenceProposalRequest(
  request: BoundedEvidenceProposalRequest,
  semantic: EvidenceSemanticPort,
): boolean {
  return authenticEvidenceRequests.get(request) === semantic
}

function affectedScope(actions: readonly [ActionRef, ...ActionRef[]]): FactAffectedScope {
  return `actions:${actions.join('|')}` as FactAffectedScope
}

function sourceRef(url: string): EvidenceSourceRef {
  return `web-source:${createHash('sha256').update(url).digest('hex')}` as EvidenceSourceRef
}

function requestRef(needs: FactNeedSet, requirement: FactRequirement): EvidenceRequestRef {
  const hash = createHash('sha256').update('evidence-request')
    .update('\0').update(needs.ref)
    .update('\0').update(needs.chat)
    .update('\0').update(requirement.fact)
    .update('\0').update(String(requirement.neededFor.length))
  for (const action of requirement.neededFor) hash.update('\0').update(action)
  return `evidence-request:${hash.digest('hex')}` as EvidenceRequestRef
}

function isDirectFact(conclusion: EvidenceConclusion): conclusion is DirectFact {
  return 'kind' in conclusion && conclusion.kind === 'direct_fact'
}

function validEvidenceProposal(
  request: BoundedEvidenceProposalRequest,
  conclusion: EvidenceConclusion,
): boolean {
  if (conclusion.fact !== request.retrieval.need.fact
    || !nonblank(conclusion.meaning)
    || conclusion.source !== request.material.source) return false
  return isDirectFact(conclusion)
    ? onlyKeys(conclusion, ['kind', 'fact', 'meaning', 'source', 'degree'])
      && conclusion.degree === 'established'
    : onlyKeys(conclusion, ['fact', 'meaning', 'source', 'degree', 'affected'])
      && conclusion.affected === request.affected
      && (conclusion.degree === 'insufficient'
        || conclusion.degree === 'conflicting'
        || conclusion.degree === 'unknown')
}

function freezeConclusion(conclusion: EvidenceConclusion): EvidenceConclusion {
  if (isDirectFact(conclusion)) return Object.freeze({ ...conclusion })
  return Object.freeze({ ...conclusion })
}

function conclusionSetRef(
  needs: FactNeedSet,
  request: EvidenceRetrievalRequest,
  conclusion: EvidenceConclusion,
): EvidenceConclusionSetRef {
  const hash = createHash('sha256').update('evidence-conclusions')
    .update('\0').update(needs.ref)
    .update('\0').update(request.ref)
    .update('\0').update(isDirectFact(conclusion) ? conclusion.kind : 'unresolved')
    .update('\0').update(conclusion.fact)
    .update('\0').update(conclusion.meaning)
    .update('\0').update(conclusion.source)
    .update('\0').update(conclusion.degree)
  if (!isDirectFact(conclusion)) hash.update('\0').update(conclusion.affected)
  return `evidence-conclusions:${hash.digest('hex')}` as EvidenceConclusionSetRef
}

function multiConclusionSetRef(
  needs: FactNeedSet,
  items: ExactTwo<MultiFactEvidenceResolutionItem>,
): EvidenceConclusionSetRef {
  const hash = createHash('sha256').update('multi-fact-evidence-conclusions')
    .update('\0').update(needs.ref)
    .update('\0').update(needs.chat)
  for (const item of items) {
    const conclusion = item.conclusion
    hash.update('\0').update(item.request.ref)
      .update('\0').update(isDirectFact(conclusion) ? conclusion.kind : 'unresolved')
      .update('\0').update(conclusion.fact)
      .update('\0').update(conclusion.meaning)
      .update('\0').update(conclusion.source)
      .update('\0').update(conclusion.degree)
    if (!isDirectFact(conclusion)) hash.update('\0').update(conclusion.affected)
  }
  return `evidence-conclusions:${hash.digest('hex')}` as EvidenceConclusionSetRef
}

function webSearchResult(value: unknown): value is WebSearchResult {
  const raw = object(value)
  if (raw === undefined
    || !onlyKeys(raw, raw.content === undefined
    ? ['sources', 'truncated']
    : ['content', 'sources', 'truncated'])
    || !Array.isArray(raw.sources)
    || raw.sources.length !== F03_SEARCH_MAX_RESULTS
    || raw.truncated !== false
    || (raw.content !== undefined && typeof raw.content !== 'string')) return false
  const source = object(raw.sources[0])
  if (source === undefined
    || !onlyKeys(source, Object.keys(source).filter(key =>
      key === 'url' || key === 'title' || key === 'snippet' || key === 'publishedAt'))
    || typeof source.url !== 'string'
    || (source.title !== undefined && typeof source.title !== 'string')
    || (source.snippet !== undefined && typeof source.snippet !== 'string')
    || (source.publishedAt !== undefined && typeof source.publishedAt !== 'string')) return false
  try {
    const parsed = new URL(source.url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  } catch {
    return false
  }
  return source.publishedAt === undefined
    || (nonblank(source.publishedAt) && Number.isFinite(Date.parse(source.publishedAt)))
}

function normalizeMaterial(
  result: WebSearchResult,
  request: EvidenceRetrievalRequest,
  observedAt: string,
): EvidenceMaterial | undefined {
  if (!webSearchResult(result)
    || !nonblank(observedAt)
    || !Number.isFinite(Date.parse(observedAt))) return undefined
  const source = result.sources[0]
  if (source === undefined) return undefined
  const snippet = source.snippet?.trim() ?? ''
  const answer = result.content?.trim() ?? ''
  const content = snippet.length > 0 ? snippet : answer
  if (content.length === 0 || content.length > F03_MAX_MATERIAL_CHARS || source.url.length > 2_048) return undefined
  const evidenceSource = sourceRef(source.url)
  const materialHash = createHash('sha256').update('evidence-material')
    .update('\0').update(request.ref)
    .update('\0').update(request.need.fact)
    .update('\0').update(evidenceSource)
    .update('\0').update(source.url)
    .update('\0').update(content)
    .update('\0').update(observedAt)
  const ref = `evidence-material:${materialHash.digest('hex')}` as EvidenceMaterialRef
  return Object.freeze({
    ref,
    request: request.ref,
    fact: request.need.fact,
    source: evidenceSource,
    url: source.url,
    content,
    observedAt,
    publishedAt: source.publishedAt,
    truncated: false,
  })
}

function multiSourceWebSearchEnvelope(value: unknown): value is WebSearchResult {
  const raw = object(value)
  if (raw === undefined
    || !onlyKeys(raw, raw.content === undefined
      ? ['sources', 'truncated']
      : ['content', 'sources', 'truncated'])
    || !Array.isArray(raw.sources)
    || raw.sources.length !== F03_MULTI_SOURCE_MAX_RESULTS
    || raw.truncated !== false
    || (raw.content !== undefined && typeof raw.content !== 'string')) return false
  return true
}

function normalizeMultiSourceMaterial(
  candidate: unknown,
  request: EvidenceRetrievalRequest,
  observedAt: string,
): EvidenceMaterial | undefined {
  const source = object(candidate)
  if (source === undefined
    || !onlyKeys(source, Object.keys(source).filter(key =>
      key === 'url' || key === 'title' || key === 'snippet' || key === 'publishedAt'))
    || typeof source.url !== 'string'
    || source.url.length > 2_048
    || typeof source.snippet !== 'string'
    || !nonblank(source.snippet)
    || source.snippet.trim().length > F03_MAX_MATERIAL_CHARS
    || (source.title !== undefined && typeof source.title !== 'string')
    || (source.publishedAt !== undefined && (typeof source.publishedAt !== 'string'
      || !nonblank(source.publishedAt)
      || !Number.isFinite(Date.parse(source.publishedAt))))) return undefined
  try {
    const parsed = new URL(source.url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  } catch {
    return undefined
  }
  const content = source.snippet.trim()
  const evidenceSource = sourceRef(source.url)
  const materialHash = createHash('sha256').update('evidence-material')
    .update('\0').update(request.ref)
    .update('\0').update(request.need.fact)
    .update('\0').update(evidenceSource)
    .update('\0').update(source.url)
    .update('\0').update(content)
    .update('\0').update(observedAt)
  return Object.freeze({
    ref: `evidence-material:${materialHash.digest('hex')}` as EvidenceMaterialRef,
    request: request.ref,
    fact: request.need.fact,
    source: evidenceSource,
    url: source.url,
    content,
    observedAt,
    publishedAt: source.publishedAt,
    truncated: false,
  })
}

function normalizeMultiSourceMaterials(
  result: WebSearchResult,
  request: EvidenceRetrievalRequest,
  observedAt: string,
): readonly EvidenceMaterial[] | undefined {
  if (!multiSourceWebSearchEnvelope(result)
    || !nonblank(observedAt)
    || !Number.isFinite(Date.parse(observedAt))) return undefined
  const candidates = result.sources.map(source =>
    normalizeMultiSourceMaterial(source, request, observedAt))
  const occurrences = new Map<EvidenceSourceRef, number>()
  for (const material of candidates) {
    if (material !== undefined) occurrences.set(
      material.source,
      (occurrences.get(material.source) ?? 0) + 1,
    )
  }
  return Object.freeze(candidates.flatMap(material => material !== undefined
    && occurrences.get(material.source) === 1 ? [material] : []))
}

function materialShape(material: EvidenceMaterial): MultiSourceMaterialShape {
  return Object.freeze({
    ref: material.ref,
    request: material.request,
    fact: material.fact,
    source: material.source,
    url: material.url,
    observedAt: material.observedAt,
    publishedAt: material.publishedAt,
  })
}

function structuredFinding(
  proposal: EvidenceProposalOutcome | undefined,
  request: BoundedEvidenceProposalRequest,
): MultiSourceFindingShape | undefined {
  const rawProposal = object(proposal)
  if (rawProposal === undefined
    || !onlyKeys(rawProposal, ['kind', 'request', 'value', 'finding'])
    || proposal?.kind !== 'proposal'
    || proposal.request !== request
    || !validEvidenceProposal(request, proposal.value)
    || !isDirectFact(proposal.value)) return undefined
  const raw = object(rawProposal.finding)
  if (raw === undefined || !onlyKeys(raw, [
    'factNeeds', 'request', 'material', 'fact', 'source', 'conclusion',
    'appliesWhen', 'observedAt', 'publishedAt', 'futureUse',
  ])) return undefined
  const {
    factNeeds, request: requestIdentity, material, fact, source, conclusion,
    appliesWhen, observedAt, publishedAt, futureUse,
  } = raw
  if (!nonblank(factNeeds)
    || !nonblank(requestIdentity)
    || !nonblank(material)
    || !nonblank(fact)
    || !nonblank(source)
    || factNeeds !== request.factNeeds.ref
    || requestIdentity !== request.retrieval.ref
    || material !== request.material.ref
    || fact !== request.retrieval.need.fact
    || source !== request.material.source
    || !nonblank(conclusion)
    || conclusion !== proposal.value.meaning
    || !nonblank(appliesWhen)
    || !nonblank(observedAt)
    || observedAt !== request.material.observedAt
    || !Number.isFinite(Date.parse(observedAt))
    || publishedAt !== request.material.publishedAt
    || (publishedAt !== undefined
      && (!nonblank(publishedAt) || !Number.isFinite(Date.parse(publishedAt))))
    || !nonblank(futureUse)) return undefined
  return Object.freeze({
    factNeeds,
    request: requestIdentity,
    material,
    fact,
    source,
    conclusion,
    appliesWhen,
    observedAt,
    publishedAt,
    futureUse,
  })
}

function combinedSourceRef(sources: readonly [string, string]): EvidenceSourceRef {
  const hash = createHash('sha256').update('multi-source-evidence')
  for (const source of sources) hash.update('\0').update(source)
  return `multi-source:${hash.digest('hex')}` as EvidenceSourceRef
}

function multiSourceProvenance(
  conclusion: EvidenceConclusion,
  resolution: CompleteMultiSourceResolution,
): readonly [EvidenceConclusionProvenance, EvidenceConclusionProvenance] {
  return Object.freeze(resolution.items.map(item => Object.freeze({
    conclusion,
    source: item.material.source as EvidenceSourceRef,
    url: item.material.url,
    observedAt: item.material.observedAt,
    publishedAt: item.material.publishedAt,
  })) as [EvidenceConclusionProvenance, EvidenceConclusionProvenance])
}

function unresolvedConclusion(
  request: EvidenceRetrievalRequest,
  degree: 'insufficient' | 'unknown',
  source: EvidenceSourceRef = sourceRef(F03_PRIVATE_SEARCH_QUERY),
): UnresolvedFact {
  return Object.freeze({
    fact: request.need.fact,
    meaning: (degree === 'unknown'
      ? 'web evidence state is unknown'
      : 'web evidence was not established') as UncertaintyMeaning,
    source,
    degree,
    affected: affectedScope(request.need.neededFor),
  })
}

function conclusionProvenance(
  conclusion: EvidenceConclusion,
  material: EvidenceMaterial | undefined,
): EvidenceConclusionProvenance | undefined {
  if (material !== undefined && conclusion.source === material.source) {
    return Object.freeze({
      conclusion,
      source: conclusion.source,
      url: material.url,
      observedAt: material.observedAt,
      publishedAt: material.publishedAt,
    })
  }
  if (isDirectFact(conclusion)) return undefined
  return Object.freeze({
    conclusion,
    source: conclusion.source,
    url: undefined,
    observedAt: undefined,
    publishedAt: undefined,
  })
}

export class EvidenceResolution {
  private constructor(
    private readonly web: WebSearchPort,
    private readonly semantic: EvidenceSemanticPort,
    private readonly now: () => string,
  ) {
    pendingFactNeeds.set(this, new WeakMap())
    completedFactNeedOutcomes.set(this, new WeakMap())
    multiFactResolutionRuns.set(this, new WeakMap())
    multiSourceResolutionRuns.set(this, new WeakMap())
    evidenceConclusionFanoutRuns.set(this, new WeakMap())
  }

  static create(
    web: WebSearchPort,
    semantic: EvidenceSemanticPort,
    now: () => string = () => new Date().toISOString(),
  ): EvidenceResolution {
    return new EvidenceResolution(web, semantic, now)
  }

  /**
   * The receiver completes C11, C12, and bounded interpretation in one call.
   * There is deliberately no public accepted-C11 continuation for a caller to
   * wrap, retain, or invoke ahead of the action owner.
   */
  async acceptFactNeeds(
    needs: FactNeedSet,
    signal: AbortSignal,
  ): Promise<EvidenceResolutionResult | undefined> {
    if (signal.aborted) return undefined
    const completed = completedFactNeedOutcomes.get(this)?.get(needs)
    if (completed !== undefined) {
      if (expectedOwners.get(this) !== completed.owner) return undefined
      this.#fanoutConclusions(completed.owner, completed.outcome.conclusions)
      return completed.outcome
    }
    const registry = pendingFactNeeds.get(this)
    const existingMultiFactRun = multiFactResolutionRuns.get(this)?.get(needs)
    const existingMultiSourceRun = multiSourceResolutionRuns.get(this)?.get(needs)
    const binding = existingMultiFactRun?.binding
      ?? existingMultiSourceRun?.binding
      ?? registry?.get(needs)
    if (binding === undefined || expectedOwners.get(this) !== binding.owner
      || !exactOwnerBinding(needs, binding)) return undefined
    if (needs.requirements.length === 2) {
      return await this.#acceptMultiFactNeeds(needs, binding, signal)
    }
    if (isMultiSourceOwnerBinding(binding)) {
      return await this.#acceptMultiSourceFactNeeds(needs, binding, signal)
    }
    registry?.delete(needs)
    return await this.#acceptSingleFactNeeds(needs, binding, signal)
  }

  #acceptedConclusionDelivery(
    report: unknown,
    contract: 'C15' | 'C17' | 'C19',
    conclusions: EvidenceConclusionSet,
  ): boolean {
    if (report === null || typeof report !== 'object') return false
    const value = report as {
      readonly kind?: unknown
      readonly identity?: { readonly contract?: unknown; readonly subject?: unknown }
      readonly value?: { readonly kind?: unknown; readonly value?: unknown }
    }
    return value.kind === 'business_result'
      && value.identity?.contract === contract
      && value.identity.subject === conclusions.ref
      && value.value?.kind === 'accepted_for_contract'
      && value.value.value === conclusions
  }

  #fanoutConclusions(owner: object, conclusions: EvidenceConclusionSet): void {
    const receivers = evidenceConclusionCandidateReceivers.get(this)
    if (receivers === undefined
      || expectedOwners.get(this) !== owner
      || !Object.isFrozen(conclusions)
      || !Object.isFrozen(conclusions.conclusions)
      || !nonblank(conclusions.ref)
      || !nonblank(conclusions.chat)
      || conclusions.conclusions.length === 0
      || conclusions.conclusions.some(conclusion => !Object.isFrozen(conclusion))) return
    const runs = evidenceConclusionFanoutRuns.get(this)
    if (runs === undefined) return
    let run = runs.get(conclusions)
    if (run === undefined) {
      run = { owner, nextStage: 0, active: false }
      runs.set(conclusions, run)
    }
    if (run.owner !== owner || run.active || run.nextStage === 3) return
    run.active = true
    try {
      while (run.nextStage < 3) {
        let report: unknown
        let contract: 'C15' | 'C17' | 'C19'
        try {
          if (run.nextStage === 0) {
            contract = 'C15'
            report = receivers.formation.acceptEvidenceConclusions(conclusions)
          } else if (run.nextStage === 1) {
            contract = 'C17'
            report = receivers.contentReview.acceptEvidenceConclusions(conclusions)
          } else {
            contract = 'C19'
            report = receivers.freshnessReview.acceptCurrentEvidence(conclusions)
          }
        } catch {
          return
        }
        if (!this.#acceptedConclusionDelivery(report, contract, conclusions)) return
        run.nextStage = (run.nextStage + 1) as 1 | 2 | 3
      }
    } finally {
      run.active = false
    }
  }

  async #acceptSingleFactNeeds(
    needs: FactNeedSet,
    binding: OwnerIssuedFactNeedBinding,
    signal: AbortSignal,
  ): Promise<EvidenceResolutionOutcome | undefined> {
    const report: C11Result = {
      kind: 'business_result',
      identity: identity('C11', needs.ref),
      value: { kind: 'accepted_for_contract', value: needs },
    }
    const requirement = needs.requirements[0]
    if (requirement === undefined) return undefined
    const request: EvidenceRetrievalRequest = Object.freeze({
      ref: requestRef(needs, requirement),
      need: requirement,
    })
    const retrieval = await this.#retrieveEvidence(request, F03_PRIVATE_SEARCH_QUERY, signal)
    let conclusion: EvidenceConclusion
    if (retrieval.material === undefined) {
      conclusion = unresolvedConclusion(request, retrieval.c12.kind === 'unknown' ? 'unknown' : 'insufficient')
    } else {
      const boundedRequest: BoundedEvidenceProposalRequest = Object.freeze({
        factNeeds: needs,
        retrieval: request,
        material: retrieval.material,
        origin: binding.origin,
        focus: binding.focus.ref,
        affected: affectedScope(requirement.neededFor),
      })
      authenticEvidenceRequests.set(boundedRequest, this.semantic)
      let proposal: EvidenceProposalOutcome | undefined
      try {
        proposal = await this.semantic.proposeEvidence(boundedRequest, signal)
      } catch {
        proposal = undefined
      }
      authenticEvidenceRequests.delete(boundedRequest)
      conclusion = proposal?.kind === 'proposal'
        && proposal.request === boundedRequest
        && validEvidenceProposal(boundedRequest, proposal.value)
        ? freezeConclusion(proposal.value)
        : unresolvedConclusion(
            request,
            proposal?.kind === 'unknown' ? 'unknown' : 'insufficient',
            retrieval.material.source,
          )
    }
    const conclusions: EvidenceConclusionSet = Object.freeze({
      ref: conclusionSetRef(needs, request, conclusion),
      chat: needs.chat,
      conclusions: Object.freeze([conclusion]),
    })
    const provenance = conclusionProvenance(conclusion, retrieval.material)
    if (provenance === undefined) return undefined
    const outcome: EvidenceResolutionOutcome = Object.freeze({
      c11: report,
      request,
      c12: retrieval.c12,
      conclusions,
      material: retrieval.material,
      provenance,
    })
    completedFactNeedOutcomes.get(this)?.set(needs, Object.freeze({
      owner: binding.owner,
      outcome,
    }))
    this.#fanoutConclusions(binding.owner, conclusions)
    return outcome
  }

  async #acceptMultiSourceFactNeeds(
    needs: FactNeedSet,
    binding: OwnerIssuedFactNeedBinding,
    signal: AbortSignal,
  ): Promise<MultiSourceEvidenceResolutionOutcome | undefined> {
    const runs = multiSourceResolutionRuns.get(this)
    const registry = pendingFactNeeds.get(this)
    if (runs === undefined) return undefined
    let run = runs.get(needs)
    if (run === undefined) {
      const requirement = needs.requirements[0]
      if (requirement === undefined || exactRequirementIdentity(requirement) !== 'a') return undefined
      const c11: C11Result = {
        kind: 'business_result',
        identity: identity('C11', needs.ref),
        value: { kind: 'accepted_for_contract', value: needs },
      }
      run = {
        binding,
        c11,
        request: Object.freeze({
          ref: requestRef(needs, requirement),
          need: requirement,
        }),
        retrieval: undefined,
        findings: [],
        nextIndex: 0,
        active: false,
      }
      registry?.delete(needs)
      runs.set(needs, run)
    }
    if (run.binding !== binding || run.active) return undefined
    run.active = true
    try {
      if (run.retrieval === undefined) {
        const retrieval = await this.#retrieveMultiSourceEvidence(run.request, signal)
        if (signal.aborted) return undefined
        if (retrieval.materials === undefined) {
          return this.#sourceIncompleteOutcome(
            needs,
            run,
            retrieval.c12,
            Object.freeze([]),
            retrieval.c12.kind === 'unknown' ? 'unknown' : 'insufficient',
          )
        }
        run.retrieval = Object.freeze({ c12: retrieval.c12, materials: retrieval.materials })
      }
      const activeRetrieval = run.retrieval
      if (activeRetrieval === undefined) return undefined
      while (run.nextIndex < activeRetrieval.materials.length) {
        if (signal.aborted) return undefined
        const material = activeRetrieval.materials[run.nextIndex]
        if (material === undefined) return undefined
        const boundedRequest: BoundedEvidenceProposalRequest = Object.freeze({
          factNeeds: needs,
          retrieval: run.request,
          material,
          origin: run.binding.origin,
          focus: run.binding.focus.ref,
          affected: affectedScope(run.request.need.neededFor),
        })
        authenticEvidenceRequests.set(boundedRequest, this.semantic)
        let proposal: EvidenceProposalOutcome | undefined
        try {
          proposal = await this.semantic.proposeEvidence(boundedRequest, signal)
        } catch {
          proposal = undefined
        }
        authenticEvidenceRequests.delete(boundedRequest)
        if (signal.aborted) return undefined
        const finding = structuredFinding(proposal, boundedRequest)
        if (finding === undefined) {
          return this.#sourceIncompleteOutcome(
            needs,
            run,
            activeRetrieval.c12,
            activeRetrieval.materials,
            proposal?.kind === 'unknown' ? 'unknown' : 'insufficient',
          )
        }
        run.findings.push(finding)
        run.nextIndex += 1
      }
      const resolution = resolveMultiSourceConflict(
        Object.freeze({ ref: needs.ref, requirements: needs.requirements }),
        activeRetrieval.materials.map(materialShape),
        run.findings,
      )
      if (resolution.kind === 'source_incomplete') {
        return this.#sourceIncompleteOutcome(
          needs,
          run,
          activeRetrieval.c12,
          activeRetrieval.materials,
          'insufficient',
        )
      }
      const source = combinedSourceRef(resolution.sortedSources)
      const conclusion: EvidenceConclusion = resolution.kind === 'conflict'
        ? Object.freeze({
            fact: run.request.need.fact,
            meaning: resolution.meaning as UncertaintyMeaning,
            source,
            degree: 'conflicting',
            affected: affectedScope(run.request.need.neededFor),
          })
        : Object.freeze({
            kind: 'direct_fact',
            fact: run.request.need.fact,
            meaning: resolution.meaning as ActionableFactMeaning,
            source,
            degree: 'established',
          })
      const conclusions: EvidenceConclusionSet = Object.freeze({
        ref: conclusionSetRef(needs, run.request, conclusion),
        chat: needs.chat,
        conclusions: Object.freeze([conclusion]),
      })
      const canonicalMaterials = resolution.items.map(item =>
        activeRetrieval.materials.find(material => material.ref === item.material.ref))
      const materials = exactTwo(canonicalMaterials)
      if (materials === undefined || materials[0] === undefined || materials[1] === undefined) return undefined
      const outcome: MultiSourceEvidenceResolutionOutcome = Object.freeze({
        kind: 'multi_source',
        resolution: resolution.kind,
        c11: run.c11,
        request: run.request,
        c12: activeRetrieval.c12,
        materials: Object.freeze([materials[0], materials[1]]),
        findings: Object.freeze(resolution.items.map(item => item.finding)),
        conclusions,
        provenances: multiSourceProvenance(conclusion, resolution),
      })
      completedFactNeedOutcomes.get(this)?.set(needs, Object.freeze({
        owner: binding.owner,
        outcome,
      }))
      this.#fanoutConclusions(binding.owner, conclusions)
      runs.delete(needs)
      return outcome
    } finally {
      run.active = false
    }
  }

  #sourceIncompleteOutcome(
    needs: FactNeedSet,
    run: MultiSourceResolutionRun,
    c12: C12Result,
    materials: readonly EvidenceMaterial[],
    degree: 'insufficient' | 'unknown',
  ): MultiSourceEvidenceResolutionOutcome {
    const actualMaterials = Object.freeze([...materials])
    const pair = exactTwo(actualMaterials)
    const sources: readonly [string, string] | undefined = pair === undefined
      ? undefined
      : pair[0].source.localeCompare(pair[1].source) <= 0
        ? Object.freeze([pair[0].source, pair[1].source])
        : Object.freeze([pair[1].source, pair[0].source])
    const source = sources === undefined
      ? sourceRef(F03_PRIVATE_SEARCH_QUERY)
      : combinedSourceRef(sources)
    const conclusion = unresolvedConclusion(run.request, degree, source)
    const conclusions: EvidenceConclusionSet = Object.freeze({
      ref: conclusionSetRef(needs, run.request, conclusion),
      chat: needs.chat,
      conclusions: Object.freeze([conclusion]),
    })
    const provenances: readonly EvidenceConclusionProvenance[] = Object.freeze(
      actualMaterials.map(material => Object.freeze({
          conclusion,
          source: material.source,
          url: material.url,
          observedAt: material.observedAt,
          publishedAt: material.publishedAt,
        })),
    )
    return Object.freeze({
      kind: 'multi_source',
      resolution: 'source_incomplete',
      c11: run.c11,
      request: run.request,
      c12,
      materials: actualMaterials,
      findings: Object.freeze(run.findings.map(finding => Object.freeze({ ...finding }))),
      conclusions,
      provenances,
    })
  }

  async #acceptMultiFactNeeds(
    needs: FactNeedSet,
    binding: OwnerIssuedFactNeedBinding,
    signal: AbortSignal,
  ): Promise<MultiFactEvidenceResolutionOutcome | undefined> {
    const runs = multiFactResolutionRuns.get(this)
    const registry = pendingFactNeeds.get(this)
    if (runs === undefined) return undefined
    let run = runs.get(needs)
    if (run === undefined) {
      const requirements = exactTwoDistinctBy(needs.requirements, exactRequirementIdentity)
      if (requirements === undefined) return undefined
      const queries = requirements.map(searchQueryForRequirement)
      if (queries.some(query => query === undefined)) return undefined
      const c11: C11Result = {
        kind: 'business_result',
        identity: identity('C11', needs.ref),
        value: { kind: 'accepted_for_contract', value: needs },
      }
      run = {
        binding,
        c11,
        items: [],
        nextIndex: 0,
        active: false,
      }
      registry?.delete(needs)
      runs.set(needs, run)
    }
    if (run.binding !== binding || run.active) return undefined
    const requirements = exactTwoDistinctBy(needs.requirements, exactRequirementIdentity)
    if (requirements === undefined) return undefined
    run.active = true
    try {
      while (run.nextIndex < requirements.length) {
        if (signal.aborted) return undefined
        const requirement = requirements[run.nextIndex]
        if (requirement === undefined) return undefined
        const query = searchQueryForRequirement(requirement)
        if (query === undefined) return undefined
        const item = await this.#resolveMultiFactRequirement(
          needs,
          run.binding,
          requirement,
          query,
          signal,
        )
        if (item === undefined) return undefined
        run.items.push(item)
        run.nextIndex += 1
      }
      const projection = projectExactTwoFactResults(
        requirements,
        run.items,
        isDirectFact,
      )
      if (projection === undefined) return undefined
      const items = exactTwo(run.items)
      if (items === undefined) return undefined
      const conclusions: EvidenceConclusionSet = Object.freeze({
        ref: multiConclusionSetRef(needs, items),
        chat: needs.chat,
        conclusions: projection.conclusions,
      })
      const outcome: MultiFactEvidenceResolutionOutcome = Object.freeze({
        kind: 'multi',
        c11: run.c11,
        items,
        conclusions,
      })
      completedFactNeedOutcomes.get(this)?.set(needs, Object.freeze({
        owner: binding.owner,
        outcome,
      }))
      this.#fanoutConclusions(binding.owner, conclusions)
      runs.delete(needs)
      return outcome
    } finally {
      run.active = false
    }
  }

  async #resolveMultiFactRequirement(
    needs: FactNeedSet,
    binding: OwnerIssuedFactNeedBinding,
    requirement: FactRequirement,
    query: string,
    signal: AbortSignal,
  ): Promise<MultiFactEvidenceResolutionItem | undefined> {
    if (!needs.requirements.some(member => member === requirement)
      || searchQueryForRequirement(requirement) !== query
      || signal.aborted) return undefined
    const request: EvidenceRetrievalRequest = Object.freeze({
      ref: requestRef(needs, requirement),
      need: requirement,
    })
    const retrieval = await this.#retrieveEvidence(request, query, signal)
    if (signal.aborted) return undefined
    let conclusion: EvidenceConclusion
    if (retrieval.material === undefined) {
      conclusion = unresolvedConclusion(request, retrieval.c12.kind === 'unknown' ? 'unknown' : 'insufficient')
    } else {
      const boundedRequest: BoundedEvidenceProposalRequest = Object.freeze({
        factNeeds: needs,
        retrieval: request,
        material: retrieval.material,
        origin: binding.origin,
        focus: binding.focus.ref,
        affected: affectedScope(requirement.neededFor),
      })
      authenticEvidenceRequests.set(boundedRequest, this.semantic)
      let proposal: EvidenceProposalOutcome | undefined
      try {
        proposal = await this.semantic.proposeEvidence(boundedRequest, signal)
      } catch {
        proposal = undefined
      }
      authenticEvidenceRequests.delete(boundedRequest)
      if (signal.aborted) return undefined
      conclusion = proposal?.kind === 'proposal'
        && proposal.request === boundedRequest
        && validEvidenceProposal(boundedRequest, proposal.value)
        ? freezeConclusion(proposal.value)
        : unresolvedConclusion(
            request,
            proposal?.kind === 'unknown' ? 'unknown' : 'insufficient',
            retrieval.material.source,
          )
    }
    const provenance = conclusionProvenance(conclusion, retrieval.material)
    return provenance === undefined ? undefined : Object.freeze({
      requirement,
      request,
      c12: retrieval.c12,
      material: retrieval.material,
      conclusion,
      provenance,
    })
  }

  async #retrieveMultiSourceEvidence(
    request: EvidenceRetrievalRequest,
    signal: AbortSignal,
  ): Promise<{
    readonly c12: C12Result
    readonly materials: readonly EvidenceMaterial[] | undefined
  }> {
    if (signal.aborted) return { c12: unknown('C12', request.ref), materials: undefined }
    let result: WebSearchResult
    try {
      result = await this.web.search({
        query: F03_PRIVATE_SEARCH_QUERY,
        maxResults: F03_MULTI_SOURCE_MAX_RESULTS,
      }, signal)
    } catch {
      return {
        c12: signal.aborted ? unknown('C12', request.ref) : failed('C12', request.ref),
        materials: undefined,
      }
    }
    if (signal.aborted) return { c12: unknown('C12', request.ref), materials: undefined }
    let observedAt: string
    try {
      observedAt = this.now()
    } catch {
      return { c12: failed('C12', request.ref), materials: undefined }
    }
    const materials = normalizeMultiSourceMaterials(result, request, observedAt)
    if (materials === undefined || materials.length === 0) {
      return { c12: failed('C12', request.ref), materials: undefined }
    }
    const retrieved: RetrievedEvidence = Object.freeze({
      request: request.ref,
      actualMaterials: Object.freeze(materials.map(material => material.ref)),
      sources: Object.freeze(materials.map(material => material.source)),
      observedGaps: Object.freeze([]),
      observedConflicts: Object.freeze([]),
    })
    const c12: C12Result = {
      kind: 'business_result',
      identity: identity('C12', request.ref),
      value: retrieved,
    }
    return { c12, materials }
  }

  async #retrieveEvidence(
    request: EvidenceRetrievalRequest,
    query: string,
    signal: AbortSignal,
  ): Promise<{ readonly c12: C12Result; readonly material: EvidenceMaterial | undefined }> {
    if (signal.aborted) return { c12: unknown('C12', request.ref), material: undefined }
    let result: WebSearchResult
    try {
      result = await this.web.search({
        query,
        maxResults: F03_SEARCH_MAX_RESULTS,
      }, signal)
    } catch {
      return {
        c12: signal.aborted ? unknown('C12', request.ref) : failed('C12', request.ref),
        material: undefined,
      }
    }
    if (signal.aborted) return { c12: unknown('C12', request.ref), material: undefined }
    let observedAt: string
    try {
      observedAt = this.now()
    } catch {
      return { c12: failed('C12', request.ref), material: undefined }
    }
    const material = normalizeMaterial(result, request, observedAt)
    if (material === undefined) return { c12: failed('C12', request.ref), material: undefined }
    const retrieved: RetrievedEvidence = Object.freeze({
      request: request.ref,
      actualMaterials: Object.freeze([material.ref]),
      sources: Object.freeze([material.source]),
      observedGaps: Object.freeze([]),
      observedConflicts: Object.freeze([]),
    })
    const c12: C12Result = {
      kind: 'business_result',
      identity: identity('C12', request.ref),
      value: retrieved,
    }
    return { c12, material }
  }
}
