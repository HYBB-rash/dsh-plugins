import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FileTrustedFactRepository } from '../x-feedback/trusted-fact-repository.ts'
import { TRUSTED_FACT_NAVIGATION_FILE_NAME } from '../navigation/file-navigation-snapshot-store.ts'
import { isTrustedFact, type FactDimension } from '../trusted-facts/model.ts'
import type {
  LocatedTrustedFact,
  LocatedTrustedFactSnapshot,
  NavigationItem,
  NavigationSnapshot,
  NavigationTargetRef,
  Sha256Digest,
  TrustedFactLocator,
} from '../trusted-facts/navigation-contract.ts'

/** The only fact read operation accepted by the projection preflight. */
export interface FactProjectionSnapshotReader {
  readLocatedSnapshot(): LocatedTrustedFactSnapshot
}

/** The only navigation read operation accepted by the projection preflight. */
export interface NavigationProjectionSnapshotReader {
  readNavigationSnapshot(): NavigationSnapshot
}

export interface FileProjectionSources {
  readonly facts: FactProjectionSnapshotReader
  readonly navigation: NavigationProjectionSnapshotReader
}

/**
 * Read-only file composition for TODO 5.  Each reader pins its first valid
 * snapshot, so a later file change cannot alter a projection already started.
 */
export class FileTrustedFactProjectionSources implements FileProjectionSources {
  readonly facts: FactProjectionSnapshotReader
  readonly navigation: NavigationProjectionSnapshotReader

  constructor(dataDir: string) {
    this.facts = new PinnedFileFactSnapshotReader(new FileTrustedFactRepository(dataDir))
    this.navigation = new PinnedFileNavigationSnapshotReader(
      join(dataDir, TRUSTED_FACT_NAVIGATION_FILE_NAME),
    )
  }
}

export const FileFactProjectionSources = FileTrustedFactProjectionSources

export function createFileProjectionSources(dataDir: string): FileProjectionSources {
  return new FileTrustedFactProjectionSources(dataDir)
}

export const createFileFactProjectionSources = createFileProjectionSources

interface LocatedSnapshotRepository {
  readLocatedSnapshot(): LocatedTrustedFactSnapshot
}

class PinnedFileFactSnapshotReader implements FactProjectionSnapshotReader {
  #repository: LocatedSnapshotRepository
  #pinnedSnapshot: LocatedTrustedFactSnapshot | undefined

  constructor(repository: LocatedSnapshotRepository) {
    this.#repository = repository
  }

  readLocatedSnapshot(): LocatedTrustedFactSnapshot {
    if (this.#pinnedSnapshot !== undefined) return this.#pinnedSnapshot
    const snapshot = this.#repository.readLocatedSnapshot()
    this.#pinnedSnapshot = pinLocatedSnapshot(snapshot)
    return this.#pinnedSnapshot
  }
}

class PinnedFileNavigationSnapshotReader implements NavigationProjectionSnapshotReader {
  #file: string
  #pinnedSnapshot: NavigationSnapshot | undefined

  constructor(file: string) {
    this.#file = file
  }

  readNavigationSnapshot(): NavigationSnapshot {
    if (this.#pinnedSnapshot !== undefined) return this.#pinnedSnapshot
    const parsed: unknown = JSON.parse(readFileSync(this.#file, 'utf8'))
    this.#pinnedSnapshot = pinNavigationSnapshot(parsed)
    return this.#pinnedSnapshot
  }
}

/** Pin an injected fact snapshot without changing the trusted-fact instances. */
export function pinLocatedSnapshot(value: unknown): LocatedTrustedFactSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['sourceRevision', 'facts'])
    || !isSha256Digest(value.sourceRevision) || !Array.isArray(value.facts)) {
    throw new TypeError('Located trusted-fact snapshot has an invalid shape.')
  }

  const facts: LocatedTrustedFact[] = []
  for (const located of value.facts) {
    if (!isLocatedTrustedFact(located)) {
      throw new TypeError('Located trusted-fact snapshot contains an invalid fact or locator.')
    }
    facts.push({
      locator: pinLocator(located.locator),
      fact: located.fact,
    })
  }

  return deepFreeze({ sourceRevision: value.sourceRevision, facts })
}

function parseNavigationSnapshot(value: unknown): NavigationSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'sourceRevision', 'items'])
    || value.schemaVersion !== 1 || !isSha256Digest(value.sourceRevision)
    || !Array.isArray(value.items)) {
    throw new TypeError('Trusted-fact navigation snapshot has an invalid schema.')
  }

  const items = value.items.map(parseNavigationItem)
  return { schemaVersion: 1, sourceRevision: value.sourceRevision, items }
}

/** Validate and deep-freeze one navigation snapshot without reading or writing files. */
export function pinNavigationSnapshot(value: unknown): NavigationSnapshot {
  return deepFreeze(parseNavigationSnapshot(value))
}

function parseNavigationItem(value: unknown): NavigationItem {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'kind', 'origin', 'derivation', 'locator', 'hints'])
    || value.schemaVersion !== 1 || value.kind !== 'trusted-fact-navigation'
    || value.origin !== 'machine-derived' || !isRecord(value.derivation)
    || !hasExactKeys(value.derivation, ['method', 'version'])
    || !hasText(value.derivation.method) || !hasText(value.derivation.version)
    || !isRecord(value.hints)
    || !hasExactKeys(value.hints, ['topics', 'targetRefs', 'dimension', 'relations'])
    || !Array.isArray(value.hints.topics) || !Array.isArray(value.hints.targetRefs)
    || !isDimension(value.hints.dimension) || !Array.isArray(value.hints.relations)) {
    throw new TypeError('Trusted-fact navigation item has an invalid schema.')
  }

  const locator = parseLocator(value.locator)
  const topics = value.hints.topics.map(parseTopic)
  const targetRefs = value.hints.targetRefs.map(parseTargetRef)
  const relations = value.hints.relations.map(parseRelation)
  return {
    schemaVersion: 1,
    kind: 'trusted-fact-navigation',
    origin: 'machine-derived',
    derivation: { method: value.derivation.method, version: value.derivation.version },
    locator,
    hints: {
      topics,
      targetRefs,
      dimension: value.hints.dimension,
      relations,
    },
  }
}

function parseLocator(value: unknown): TrustedFactLocator {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'locatorId', 'persistence'])
    || value.schemaVersion !== 1 || !hasText(value.locatorId) || !isRecord(value.persistence)
    || !hasExactKeys(value.persistence, ['sourceKind', 'sourceKey', 'lineNumber', 'canonicalDigest'])
    || value.persistence.sourceKind !== 'trusted-fact-repository'
    || !hasText(value.persistence.sourceKey) || !isPositiveInteger(value.persistence.lineNumber)
    || !isSha256Digest(value.persistence.canonicalDigest)) {
    throw new TypeError('Trusted-fact navigation locator has an invalid schema.')
  }
  return {
    schemaVersion: 1,
    locatorId: value.locatorId,
    persistence: {
      sourceKind: 'trusted-fact-repository',
      sourceKey: value.persistence.sourceKey,
      lineNumber: value.persistence.lineNumber,
      canonicalDigest: value.persistence.canonicalDigest,
    },
  }
}

function parseTargetRef(value: unknown): NavigationTargetRef {
  if (!isRecord(value) || !hasExactKeys(value, ['targetId', 'canonicalSource'])
    || !hasText(value.targetId) || !hasText(value.canonicalSource)) {
    throw new TypeError('Trusted-fact navigation target reference has an invalid schema.')
  }
  return { targetId: value.targetId, canonicalSource: value.canonicalSource }
}

function parseRelation(value: unknown): NavigationItem['hints']['relations'][number] {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'targetId'])
    || value.kind !== 'about-target' || !hasText(value.targetId)) {
    throw new TypeError('Trusted-fact navigation relation has an invalid schema.')
  }
  return { kind: 'about-target', targetId: value.targetId }
}

function parseTopic(value: unknown): string {
  if (!hasText(value)) throw new TypeError('Trusted-fact navigation topic must be non-empty.')
  return value
}

function isLocatedTrustedFact(value: unknown): value is LocatedTrustedFact {
  return isRecord(value)
    && hasExactKeys(value, ['locator', 'fact'])
    && isTrustedFact(value.fact)
    && isValidLocator(value.locator)
}

function isValidLocator(value: unknown): value is TrustedFactLocator {
  if (!isRecord(value) || value.schemaVersion !== 1 || !hasText(value.locatorId)
    || !isRecord(value.persistence) || value.persistence.sourceKind !== 'trusted-fact-repository'
    || !hasText(value.persistence.sourceKey) || !isPositiveInteger(value.persistence.lineNumber)
    || !isSha256Digest(value.persistence.canonicalDigest)) return false
  return hasExactKeys(value, ['schemaVersion', 'locatorId', 'persistence'])
    && hasExactKeys(value.persistence, ['sourceKind', 'sourceKey', 'lineNumber', 'canonicalDigest'])
}

function pinLocator(value: TrustedFactLocator): TrustedFactLocator {
  return {
    schemaVersion: 1,
    locatorId: value.locatorId,
    persistence: {
      sourceKind: 'trusted-fact-repository',
      sourceKey: value.persistence.sourceKey,
      lineNumber: value.persistence.lineNumber,
      canonicalDigest: value.persistence.canonicalDigest,
    },
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, any> {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => keys.includes(key))
}

function isDimension(value: unknown): value is FactDimension {
  return value === 'content_value' || value === 'argument_quality' || value === 'factual_accuracy'
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:.+$/.test(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
