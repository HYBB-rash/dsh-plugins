import { pinNavigationSnapshot } from '../fact-projection/file-projection-sources.ts'
import type { FactDimension } from '../trusted-facts/model.ts'
import type {
  NavigationItem,
  NavigationSnapshot,
  Sha256Digest,
} from '../trusted-facts/navigation-contract.ts'

/**
 * The only candidate-side values that can become navigation keys.  The
 * candidate body, source prose, user attitude, and any model output are
 * intentionally absent from this contract.
 */
export interface CandidateNavigationRecallKeys {
  readonly targetIds: readonly string[]
  readonly canonicalSources: readonly string[]
  readonly topics: readonly string[]
  readonly relationKeys: readonly string[]
  readonly dimensions: readonly FactDimension[]
}

/** A pinned request also carries the host-owned snapshot revision. */
export interface CandidateNavigationRecallRequest extends CandidateNavigationRecallKeys {
  readonly sourceRevision: Sha256Digest
}

export type CandidateNavigationRecallFailureCode =
  | 'needs-explicit-recall-key'
  | 'invalid-candidate-recall-key'
  | 'navigation-recall-index-invalid'
  | 'navigation-recall-revision-mismatch'

export interface CandidateNavigationRecallFailure {
  readonly kind: 'recall-failure'
  readonly code: CandidateNavigationRecallFailureCode
  readonly message: string
}

export interface CandidateNavigationRecallDiagnostic {
  /** Number of exact candidate keys supplied, never the size of the index. */
  readonly explicitKeyCount: number
  /** Number of supplied exact keys that had at least one index hit. */
  readonly matchingKeyCount: number
  readonly matchedLocatorCount: number
  readonly dimensionFilterApplied: boolean
}

export interface CandidateNavigationRecallSuccess {
  readonly kind: 'recalled'
  readonly sourceRevision: Sha256Digest
  /** Sorted by locatorId for deterministic serialization, never ranked. */
  readonly locatorIds: readonly string[]
  /** The model-visible neutral subset; never includes trusted-fact bodies. */
  readonly navigation: readonly NavigationItem[]
  readonly diagnostic: CandidateNavigationRecallDiagnostic
}

export type CandidateNavigationRecallResult =
  | CandidateNavigationRecallSuccess
  | CandidateNavigationRecallFailure

export type CandidateNavigationRecallBuildResult =
  | { readonly kind: 'ready'; readonly index: CandidateNavigationRecall }
  | CandidateNavigationRecallFailure

type IndexKey = string

const TARGET_KEY_PREFIX = 'target:'
const SOURCE_KEY_PREFIX = 'source:'
const TOPIC_KEY_PREFIX = 'topic:'
const RELATION_KEY_PREFIX = 'relation:'
const DIMENSIONS: readonly FactDimension[] = [
  'content_value',
  'argument_quality',
  'factual_accuracy',
]

/**
 * Pure host-side use case for deterministic candidate-local navigation recall.
 * Construction pins and indexes one neutral snapshot; calls do not read the
 * source again, inspect fact bodies, or perform semantic matching.
 */
export class CandidateNavigationRecall {
  readonly sourceRevision: Sha256Digest
  readonly #itemsByLocator: ReadonlyMap<string, NavigationItem>
  readonly #locatorsByKey: ReadonlyMap<IndexKey, ReadonlySet<string>>

  private constructor(
    sourceRevision: Sha256Digest,
    itemsByLocator: ReadonlyMap<string, NavigationItem>,
    locatorsByKey: ReadonlyMap<IndexKey, ReadonlySet<string>>,
  ) {
    this.sourceRevision = sourceRevision
    this.#itemsByLocator = itemsByLocator
    this.#locatorsByKey = locatorsByKey
    Object.freeze(this)
  }

  /**
   * Build one immutable index from a pinned navigation snapshot.  All failure
   * cases are returned as data so callers can fail closed before assessment.
   */
  static fromSnapshot(snapshotValue: unknown): CandidateNavigationRecallBuildResult {
    try {
      const snapshot = pinNavigationSnapshot(snapshotValue)
      if (!isCanonicalText(snapshot.sourceRevision)) {
        return createFailure(
          'navigation-recall-index-invalid',
          'Pinned navigation snapshot revision is not canonical.',
        )
      }
      return buildIndex(snapshot, (sourceRevision, itemsByLocator, locatorsByKey) => new CandidateNavigationRecall(
        sourceRevision,
        itemsByLocator,
        locatorsByKey,
      ))
    } catch (error) {
      return createFailure(
        'navigation-recall-index-invalid',
        errorMessage(error, 'Pinned navigation snapshot is invalid.'),
      )
    }
  }

  recall(requestValue: unknown): CandidateNavigationRecallResult {
    const requestResult = validateRequest(requestValue)
    if (!requestResult.ok) return requestResult.failure

    const request = requestResult.value
    if (request.sourceRevision !== this.sourceRevision) {
      return createFailure(
        'navigation-recall-revision-mismatch',
        'Candidate recall revision does not match the pinned navigation snapshot.',
      )
    }

    const explicitKeys = [
      ...request.targetIds.map(targetKey),
      ...request.canonicalSources.map(sourceKey),
      ...request.topics.map(topicKey),
      ...request.relationKeys.map(relationKey),
    ]
    if (explicitKeys.length === 0) {
      return createFailure(
        'needs-explicit-recall-key',
        'Candidate recall requires at least one exact target, source, topic, or relation key; dimensions alone are not recall keys.',
      )
    }

    const exactUnion = collectExactUnion(this.#locatorsByKey, explicitKeys)
    applyDimensionIntersection(exactUnion.locatorIds, this.#itemsByLocator, request.dimensions)
    return createRecallSuccess(
      this.sourceRevision,
      this.#itemsByLocator,
      exactUnion.locatorIds,
      explicitKeys.length,
      exactUnion.matchingKeyCount,
      request.dimensions.length > 0,
    )
  }
}

/** Factory form keeps snapshot validation at the composition boundary. */
export function createCandidateNavigationRecall(snapshot: unknown): CandidateNavigationRecallBuildResult {
  return CandidateNavigationRecall.fromSnapshot(snapshot)
}

function buildIndex(
  snapshot: NavigationSnapshot,
  createIndex: (
    sourceRevision: Sha256Digest,
    itemsByLocator: ReadonlyMap<string, NavigationItem>,
    locatorsByKey: ReadonlyMap<IndexKey, ReadonlySet<string>>,
  ) => CandidateNavigationRecall,
): CandidateNavigationRecallBuildResult {
  const itemsByLocator = new Map<string, NavigationItem>()
  const mutableLocatorsByKey = new Map<IndexKey, Set<string>>()

  for (const item of snapshot.items) {
    const itemError = validateIndexItem(item)
    if (itemError !== undefined) {
      return createFailure('navigation-recall-index-invalid', itemError)
    }

    const locatorId = item.locator.locatorId
    if (itemsByLocator.has(locatorId)) {
      return createFailure(
        'navigation-recall-index-invalid',
        `Navigation recall index contains duplicate locatorId ${locatorId}.`,
      )
    }
    itemsByLocator.set(locatorId, item)

    const keys = itemKeys(item)
    for (const key of keys) {
      const locators = mutableLocatorsByKey.get(key) ?? new Set<string>()
      locators.add(locatorId)
      mutableLocatorsByKey.set(key, locators)
    }
  }

  const locatorsByKey = new Map<IndexKey, ReadonlySet<string>>()
  for (const [key, locators] of mutableLocatorsByKey) {
    locatorsByKey.set(key, Object.freeze(new Set(locators)))
  }
  return {
    kind: 'ready',
    index: createIndex(
      snapshot.sourceRevision,
      new Map(itemsByLocator),
      new Map(locatorsByKey),
    ),
  }
}

function validateIndexItem(item: NavigationItem): string | undefined {
  if (!isCanonicalText(item.locator.locatorId)) return 'Navigation locatorId is not canonical.'

  const seenKeys = new Set<string>()
  for (const targetRef of item.hints.targetRefs) {
    if (!isCanonicalText(targetRef.targetId) || !isCanonicalText(targetRef.canonicalSource)) {
      return 'Navigation target references must be canonical.'
    }
    const targetKeyValue = targetKey(targetRef.targetId)
    const sourceKeyValue = sourceKey(targetRef.canonicalSource)
    if (seenKeys.has(targetKeyValue) || seenKeys.has(sourceKeyValue)) {
      return `Navigation locator ${item.locator.locatorId} repeats a neutral target/source key.`
    }
    seenKeys.add(targetKeyValue)
    seenKeys.add(sourceKeyValue)
  }
  for (const topic of item.hints.topics) {
    if (!isCanonicalText(topic)) return 'Navigation topics must be canonical.'
    const key = topicKey(topic)
    if (seenKeys.has(key)) return `Navigation locator ${item.locator.locatorId} repeats a topic key.`
    seenKeys.add(key)
  }
  for (const relation of item.hints.relations) {
    if (!isCanonicalText(relation.targetId)) return 'Navigation relations must be canonical.'
    const key = relationKey(relation.targetId)
    if (seenKeys.has(key)) return `Navigation locator ${item.locator.locatorId} repeats a relation key.`
    seenKeys.add(key)
  }
  return undefined
}

function itemKeys(item: NavigationItem): readonly IndexKey[] {
  return [
    ...item.hints.targetRefs.flatMap(targetRef => [
      targetKey(targetRef.targetId),
      sourceKey(targetRef.canonicalSource),
    ]),
    ...item.hints.topics.map(topicKey),
    ...item.hints.relations.map(relation => relationKey(relation.targetId)),
  ]
}

function collectExactUnion(
  locatorsByKey: ReadonlyMap<IndexKey, ReadonlySet<string>>,
  keys: readonly IndexKey[],
): { readonly locatorIds: Set<string>; readonly matchingKeyCount: number } {
  const locatorIds = new Set<string>()
  let matchingKeyCount = 0
  for (const key of keys) {
    const locators = locatorsByKey.get(key)
    if (locators === undefined || locators.size === 0) continue
    matchingKeyCount += 1
    for (const locatorId of locators) locatorIds.add(locatorId)
  }
  return { locatorIds, matchingKeyCount }
}

function applyDimensionIntersection(
  locatorIds: Set<string>,
  itemsByLocator: ReadonlyMap<string, NavigationItem>,
  dimensions: readonly FactDimension[],
): void {
  if (dimensions.length === 0) return
  const allowedDimensions = new Set(dimensions)
  for (const locatorId of locatorIds) {
    const item = itemsByLocator.get(locatorId)
    if (item === undefined || !allowedDimensions.has(item.hints.dimension)) locatorIds.delete(locatorId)
  }
}

function createRecallSuccess(
  sourceRevision: Sha256Digest,
  itemsByLocator: ReadonlyMap<string, NavigationItem>,
  selected: Set<string>,
  explicitKeyCount: number,
  matchingKeyCount: number,
  dimensionFilterApplied: boolean,
): CandidateNavigationRecallSuccess {
  const locatorIds = [...selected].sort(compareLocatorIds)
  const navigation = locatorIds.map(locatorId => itemsByLocator.get(locatorId) as NavigationItem)
  return Object.freeze({
    kind: 'recalled',
    sourceRevision,
    locatorIds: Object.freeze(locatorIds),
    navigation: Object.freeze(navigation),
    diagnostic: Object.freeze({
      explicitKeyCount,
      matchingKeyCount,
      matchedLocatorCount: locatorIds.length,
      dimensionFilterApplied,
    }),
  })
}

function validateRequest(value: unknown):
  | { readonly ok: true; readonly value: CandidateNavigationRecallRequest }
  | { readonly ok: false; readonly failure: CandidateNavigationRecallFailure } {
  if (!isRecord(value) || !hasExactKeys(value, [
    'sourceRevision',
    'targetIds',
    'canonicalSources',
    'topics',
    'relationKeys',
    'dimensions',
  ])) {
    return invalidRequest('Candidate recall request contains only the pinned revision and neutral candidate keys.')
  }
  if (!isSha256Digest(value.sourceRevision) || !isCanonicalText(value.sourceRevision)) {
    return invalidRequest('Candidate recall request has an invalid source revision.')
  }

  const targetIds = validateCanonicalArray(value.targetIds, 'targetIds')
  if (!targetIds.ok) return targetIds
  const canonicalSources = validateCanonicalArray(value.canonicalSources, 'canonicalSources')
  if (!canonicalSources.ok) return canonicalSources
  const topics = validateCanonicalArray(value.topics, 'topics')
  if (!topics.ok) return topics
  const relationKeys = validateRelationKeys(value.relationKeys)
  if (!relationKeys.ok) return relationKeys
  const dimensions = validateDimensions(value.dimensions)
  if (!dimensions.ok) return dimensions

  if (targetIds.value.length === 0 && canonicalSources.value.length === 0
    && topics.value.length === 0 && relationKeys.value.length === 0) {
    return {
      ok: false,
      failure: createFailure(
        'needs-explicit-recall-key',
        'Candidate recall requires an explicit neutral key; a dimension cannot be used alone.',
      ),
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      sourceRevision: value.sourceRevision,
      targetIds: targetIds.value,
      canonicalSources: canonicalSources.value,
      topics: topics.value,
      relationKeys: relationKeys.value,
      dimensions: dimensions.value,
    }),
  }
}

function validateCanonicalArray(
  value: unknown,
  field: string,
): { readonly ok: true; readonly value: readonly string[] } | { readonly ok: false; readonly failure: CandidateNavigationRecallFailure } {
  if (!Array.isArray(value)) return invalidRequest(`${field} must be an array of canonical strings.`)
  const values: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isCanonicalText(entry)) return invalidRequest(`${field} contains a malformed or noncanonical key.`)
    if (seen.has(entry)) return invalidRequest(`${field} contains a duplicate key.`)
    seen.add(entry)
    values.push(entry)
  }
  return { ok: true, value: Object.freeze(values) }
}

function validateRelationKeys(value: unknown):
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false; readonly failure: CandidateNavigationRecallFailure } {
  const result = validateCanonicalArray(value, 'relationKeys')
  if (!result.ok) return result
  for (const relation of result.value) {
    if (!relation.startsWith('about-target:') || !isCanonicalText(relation.slice('about-target:'.length))) {
      return invalidRequest('relationKeys must use the exact neutral about-target:<targetId> form.')
    }
  }
  return result
}

function validateDimensions(value: unknown):
  | { readonly ok: true; readonly value: readonly FactDimension[] }
  | { readonly ok: false; readonly failure: CandidateNavigationRecallFailure } {
  if (!Array.isArray(value)) return invalidRequest('dimensions must be an array of known dimensions.')
  const values: FactDimension[] = []
  const seen = new Set<FactDimension>()
  for (const entry of value) {
    if (!isDimension(entry) || seen.has(entry)) return invalidRequest('dimensions contains an invalid or duplicate dimension.')
    seen.add(entry)
    values.push(entry)
  }
  values.sort()
  return { ok: true, value: Object.freeze(values) }
}

function targetKey(targetId: string): IndexKey {
  return `${TARGET_KEY_PREFIX}${targetId}`
}

function sourceKey(source: string): IndexKey {
  return `${SOURCE_KEY_PREFIX}${source}`
}

function topicKey(topic: string): IndexKey {
  return `${TOPIC_KEY_PREFIX}${topic}`
}

function relationKey(targetId: string): IndexKey {
  return `${RELATION_KEY_PREFIX}about-target:${targetId}`
}

function isCanonicalText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function isDimension(value: unknown): value is FactDimension {
  return DIMENSIONS.includes(value as FactDimension)
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:.+$/.test(value)
}

function compareLocatorIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function invalidRequest(message: string): { readonly ok: false; readonly failure: CandidateNavigationRecallFailure } {
  return { ok: false, failure: createFailure('invalid-candidate-recall-key', message) }
}

function createFailure(
  code: CandidateNavigationRecallFailureCode,
  message: string,
): CandidateNavigationRecallFailure {
  return Object.freeze({ kind: 'recall-failure', code, message })
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => keys.includes(key))
}
