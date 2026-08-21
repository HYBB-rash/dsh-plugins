import {
  CurrentRunItemRegistry,
  itemIdFor,
  type CurrentRunCandidateInput,
} from './current-run-item-registry.ts'
import type {
  XFeedComposerFact,
  XFeedComposerMaterial,
} from './composer-agent.ts'
import { renderDigest } from './digest-renderer.ts'
import {
  validateComposerDto,
  validatePlannerDto,
  type PlannerDto,
} from './two-call-contract.ts'
import {
  prepareDigest,
  type PrepareDigestPorts,
} from './prepare-digest.ts'
export type XCronPlannerMechanicalSignals = Readonly<Record<string, boolean | number | string>>

export interface XCronPlannerRequest {
  readonly candidates: readonly Readonly<{ id: string; title: string; summary: string }>[]
  readonly allowedThemes: readonly string[]
  readonly allowedTopics: readonly string[]
  readonly allowlistedExploreIds: readonly string[]
  readonly mechanicalSignals?: XCronPlannerMechanicalSignals
}

const ALLOWED_SECTION_KINDS = Object.freeze(['highlight', 'timeline', 'wander', 'focus', 'source'] as const)
const MAX_SEARCH_ITEMS = 20
const MAX_SUMMARY_BYTES = 1_200
const MAX_CONTENT_BYTES = 12_000
const MAX_FACTS = 20
const MAX_AUDIT_MATCHES = 100_000

export interface XFeedDigestCandidateInput extends CurrentRunCandidateInput {
  readonly title: string
  readonly summary: string
}

export interface XFeedSearchResult {
  readonly items: readonly CurrentRunCandidateInput[]
  readonly summary: string
}

export interface XFeedExploreResult {
  readonly content: string
  readonly topics: readonly string[]
  readonly summary: string
}

export interface XFeedFactAudit {
  readonly itemId: string
  readonly audit: {
    readonly policyId: 'x-cron-exact-target'
    readonly policyVersion: '1'
    readonly matchedLocatorCount: number
  }
}

export interface GenerateXDigestPorts {
  plan(request: XCronPlannerRequest): PlannerDto | Promise<PlannerDto>
  search(topicId: string): XFeedSearchResult | Promise<XFeedSearchResult>
  explore(candidateId: string): XFeedExploreResult | Promise<XFeedExploreResult>
  projectFacts(item: CurrentRunCandidateInput): ProjectFactsResult | Promise<ProjectFactsResult>
  prepareDelivery: PrepareDigestPorts['prepareDelivery']
}

export interface ProjectFactsResult {
  readonly facts: readonly XFeedComposerFact[]
  readonly audit: XFeedFactAudit['audit']
}

export interface GenerateXDigestInput {
  readonly candidates: readonly XFeedDigestCandidateInput[]
  readonly allowedThemes: readonly string[]
  readonly allowedTopics: readonly string[]
  readonly allowlistedExploreIds: readonly string[]
  readonly mechanicalSignals?: XCronPlannerMechanicalSignals
  readonly ports: GenerateXDigestPorts
}

export interface XFeedDigestSuccessOutcome {
  readonly text: string
  readonly error: undefined
}

export interface GenerateXDigestSkip {
  readonly kind: 'skip'
  readonly outcome: Readonly<{ text: undefined; error: undefined }>
}

export interface GenerateXDigestReady {
  readonly kind: 'ready'
  readonly composerMaterial: XFeedComposerMaterial
  readonly themeId: string
  readonly factAudits: readonly XFeedFactAudit[]
  readonly finalize: (dto: unknown) => Promise<XFeedDigestSuccessOutcome>
}

export type GenerateXDigestResult = GenerateXDigestSkip | GenerateXDigestReady

export class GenerateXDigestError extends Error {
  readonly code: 'invalid-plan' | 'projection-failed' | 'invalid-input'

  constructor(code: GenerateXDigestError['code'], message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GenerateXDigestError'
    this.code = code
  }
}

/**
 * Coordinate one bounded X cron run. The service owns only current-run DTOs;
 * framework sessions, providers, Python artifacts, and delivery lifecycles
 * stay behind its narrow ports.
 */
export async function generateXDigest(input: GenerateXDigestInput): Promise<GenerateXDigestResult> {
  if (input.candidates.length === 0) {
    return { kind: 'skip', outcome: { text: undefined, error: undefined } }
  }

  const currentCandidates = validateCandidates(input.candidates)
  const registry = new CurrentRunItemRegistry(currentCandidates)
  const plannerRequest = createPlannerRequest(input, currentCandidates)
  const plannerDto = await planOnce(input.ports, plannerRequest)
  const selectedIds = validatePlan(plannerDto, plannerRequest, registry)
  const candidateById = new Map(currentCandidates.map(candidate => [candidate.id, candidate]))

  const exploration = await runExploration(input.ports, plannerDto, registry, candidateById)
  const selectedItems = selectedIds.map(candidateId => {
    const candidate = candidateById.get(candidateId)
    if (candidate === undefined) throw new GenerateXDigestError('invalid-plan', 'planner selected an unknown candidate')
    return { itemId: itemIdFor(candidate.id), title: candidate.title, summary: candidate.summary }
  })
  const { facts, factAudits } = await projectSelectedFacts(input.ports, selectedIds, candidateById)
  const material: XFeedComposerMaterial = Object.freeze({
    selectedItems: Object.freeze(selectedItems),
    exploration,
    facts: Object.freeze(facts),
    allowedSectionKinds: ALLOWED_SECTION_KINDS,
  })

  const themeId = plannerDto.themeId
  const selectedItemIds = Object.freeze(selectedItems.map(item => item.itemId))
  const prepareDelivery = input.ports.prepareDelivery
  let finalized = false
  return {
    kind: 'ready',
    composerMaterial: material,
    themeId,
    factAudits: Object.freeze(factAudits),
    finalize: async (dto: unknown): Promise<XFeedDigestSuccessOutcome> => {
      if (finalized) throw new GenerateXDigestError('invalid-plan', 'finalize already consumed')
      finalized = true
      const validated = validateComposerDto(dto, { itemIds: selectedItemIds })
      if (!validated.ok) throw new GenerateXDigestError('invalid-plan', `composer DTO is invalid: ${validated.code}`)
      const rendered = renderDigest(validated.value, registry)
      if (!rendered.ok) throw new GenerateXDigestError('invalid-plan', `digest render failed: ${rendered.code}`)
      const prepared = await prepareDigest({
        text: rendered.text,
        themeId,
        usedItemIds: rendered.usedItemIds,
        registry,
        ports: { prepareDelivery },
      })
      if (!prepared.ok) throw new GenerateXDigestError('invalid-plan', `digest preparation failed: ${prepared.code}`)
      return { text: prepared.text, error: undefined }
    },
  }
}

function validateCandidates(candidates: readonly XFeedDigestCandidateInput[]): readonly XFeedDigestCandidateInput[] {
  const ids = new Set<string>()
  for (const candidate of candidates) {
    if (!hasExactKeys(candidate, ['id', 'source', 'content', 'topics', 'title', 'summary'])) {
      throw new GenerateXDigestError('invalid-input', 'current-run candidate has an invalid shape')
    }
    if (ids.has(candidate.id)) throw new GenerateXDigestError('invalid-input', 'current-run candidate IDs must be unique')
    if (!isBoundedText(candidate.content, MAX_CONTENT_BYTES) || candidate.topics.some(topic => !isBoundedText(topic, 320))
      || !isBoundedText(candidate.title, MAX_SUMMARY_BYTES) || !isBoundedText(candidate.summary, MAX_SUMMARY_BYTES)) {
      throw new GenerateXDigestError('invalid-input', 'current-run planner material is invalid')
    }
    ids.add(candidate.id)
  }
  return Object.freeze([...candidates])
}

function createPlannerRequest(input: GenerateXDigestInput, candidates: readonly XFeedDigestCandidateInput[]): XCronPlannerRequest {
  return Object.freeze({
    candidates: Object.freeze(candidates.map(({ id, title, summary }) => ({ id, title, summary }))),
    allowedThemes: Object.freeze([...input.allowedThemes]),
    allowedTopics: Object.freeze([...input.allowedTopics]),
    allowlistedExploreIds: Object.freeze([...input.allowlistedExploreIds]),
    ...(input.mechanicalSignals === undefined ? {} : { mechanicalSignals: input.mechanicalSignals }),
  })
}

async function planOnce(ports: GenerateXDigestPorts, request: XCronPlannerRequest): Promise<PlannerDto> {
  try {
    return await ports.plan(request)
  } catch (error) {
    throw new GenerateXDigestError('invalid-plan', 'planner failed', { cause: error })
  }
}

function validatePlan(dto: PlannerDto, request: XCronPlannerRequest, registry: CurrentRunItemRegistry): readonly string[] {
  const validated = validatePlannerDto(dto, {
    candidateIds: request.candidates.map(candidate => candidate.id),
    allowedTopicIds: [...request.allowedThemes, ...request.allowedTopics],
  })
  if (!validated.ok || !request.allowedThemes.includes(validated.value.themeId)) {
    throw new GenerateXDigestError('invalid-plan', 'planner returned an invalid or unallowlisted DTO')
  }
  if (validated.value.exploration.kind === 'search' && !request.allowedTopics.includes(validated.value.exploration.topicId)) {
    throw new GenerateXDigestError('invalid-plan', 'planner returned an unallowlisted search topic')
  }
  if (validated.value.exploration.kind === 'explore' && !request.allowlistedExploreIds.includes(validated.value.exploration.candidateId)) {
    throw new GenerateXDigestError('invalid-plan', 'planner returned an unallowlisted exploration candidate')
  }
  for (const candidateId of validated.value.selectedCandidateIds) {
    if (registry.getByItemId(itemIdFor(candidateId)) === undefined) {
      throw new GenerateXDigestError('invalid-plan', 'planner selected a candidate outside the current registry')
    }
  }
  return Object.freeze([...validated.value.selectedCandidateIds])
}

async function runExploration(
  ports: GenerateXDigestPorts,
  planner: PlannerDto,
  registry: CurrentRunItemRegistry,
  candidateById: Map<string, XFeedDigestCandidateInput>,
): Promise<XFeedComposerMaterial['exploration']> {
  if (planner.exploration.kind === 'none') return { kind: 'none' }
  if (planner.exploration.kind === 'search') {
    try {
      const result = await ports.search(planner.exploration.topicId)
      validateSearchResult(result)
      const registered = registry.registerExploration({ kind: 'search', items: result.items })
      if (!registered.ok) throw new Error('search result could not be registered')
      return { kind: 'search', topicId: planner.exploration.topicId, status: 'success', summary: result.summary }
    } catch {
      return { kind: 'search', topicId: planner.exploration.topicId, status: 'failed', summary: 'search unavailable' }
    }
  }
  const candidateId = planner.exploration.candidateId
  try {
    const result = await ports.explore(candidateId)
    validateExploreResult(result)
    const registered = registry.registerExploration({ kind: 'explore', itemId: itemIdFor(candidateId), content: result.content, topics: result.topics })
    if (!registered.ok) throw new Error('exploration result could not be registered')
    const original = candidateById.get(candidateId)
    if (original !== undefined) candidateById.set(candidateId, { ...original, content: result.content, topics: result.topics })
    return { kind: 'explore', candidateId, status: 'success', summary: result.summary }
  } catch {
    return { kind: 'explore', candidateId, status: 'failed', summary: 'exploration unavailable' }
  }
}

async function projectSelectedFacts(
  ports: GenerateXDigestPorts,
  selectedIds: readonly string[],
  candidateById: Map<string, XFeedDigestCandidateInput>,
): Promise<{ readonly facts: readonly XFeedComposerFact[]; readonly factAudits: readonly XFeedFactAudit[] }> {
  const facts: XFeedComposerFact[] = []
  const factAudits: XFeedFactAudit[] = []
  for (const candidateId of selectedIds) {
    const candidate = candidateById.get(candidateId)
    if (candidate === undefined) throw new GenerateXDigestError('projection-failed', 'selected candidate is unavailable')
    let projected: ProjectFactsResult
    const factInput: CurrentRunCandidateInput = {
      id: candidate.id,
      source: candidate.source,
      content: candidate.content,
      topics: candidate.topics,
    }
    try { projected = await ports.projectFacts(factInput) } catch (error) {
      throw new GenerateXDigestError('projection-failed', 'fact projection failed', { cause: error })
    }
    if (!isValidProjection(projected, itemIdFor(candidateId))) throw new GenerateXDigestError('projection-failed', 'fact projection failed closed')
    facts.push(...projected.facts)
    if (facts.length > MAX_FACTS) throw new GenerateXDigestError('projection-failed', 'fact projection exceeded its bound')
    factAudits.push({ itemId: itemIdFor(candidateId), audit: projected.audit })
  }
  return { facts: Object.freeze(facts), factAudits: Object.freeze(factAudits) }
}

function validateSearchResult(result: XFeedSearchResult): void {
  if (!Array.isArray(result.items) || result.items.length > MAX_SEARCH_ITEMS || !isBoundedText(result.summary, MAX_SUMMARY_BYTES)
    || result.items.some(item => !hasExactKeys(item, ['id', 'source', 'content', 'topics']) || !isValidCurrentCandidate(item))) throw new Error('invalid search result')
}

function validateExploreResult(result: XFeedExploreResult): void {
  if (!hasExactKeys(result, ['content', 'topics', 'summary']) || !isBoundedText(result.content, MAX_CONTENT_BYTES) || !isBoundedText(result.summary, MAX_SUMMARY_BYTES)
    || !Array.isArray(result.topics) || result.topics.some(topic => !isBoundedText(topic, 320))) throw new Error('invalid exploration result')
}

function isValidProjection(value: ProjectFactsResult, expectedTargetId: string): boolean {
  if (!value || !hasExactKeys(value, ['facts', 'audit']) || !Array.isArray(value.facts) || value.facts.length > MAX_FACTS || !value.audit || !hasExactKeys(value.audit, ['policyId', 'policyVersion', 'matchedLocatorCount']) || value.audit.policyId !== 'x-cron-exact-target'
    || value.audit.policyVersion !== '1' || !Number.isSafeInteger(value.audit.matchedLocatorCount)
    || value.audit.matchedLocatorCount < 0 || value.audit.matchedLocatorCount > MAX_AUDIT_MATCHES) return false
  return value.facts.every(fact => hasExactKeys(fact, ['targetId', 'summary']) && fact.targetId === expectedTargetId && isBoundedText(fact.summary, MAX_SUMMARY_BYTES))
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value === value.trim()
    && !/(?:https?:\/\/|ftp:\/\/|www\.)/iu.test(value)
    && !/!?(?:\[[^\]]*\]\([^)]*\)|`{1,3}|\*\*|__|^\s{0,3}#{1,6}\s|(?:^|\s)[*+-]\s)/mu.test(value)
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && Buffer.byteLength(value, 'utf8') <= maxBytes
}

function isValidCurrentCandidate(value: CurrentRunCandidateInput): boolean {
  return typeof value.id === 'string' && typeof value.source === 'string' && typeof value.content === 'string'
    && Array.isArray(value.topics) && isBoundedText(value.content, MAX_CONTENT_BYTES)
    && value.topics.every(topic => isBoundedText(topic, 320))
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index])
}
