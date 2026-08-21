import type { FactDimension, TrustedFact } from './model.ts'

export const NAVIGATION_SCHEMA_VERSION = 1 as const

export type Sha256Digest = `sha256:${string}`

export interface TrustedFactLocator {
  readonly schemaVersion: typeof NAVIGATION_SCHEMA_VERSION
  readonly locatorId: string
  readonly persistence: {
    readonly sourceKind: 'trusted-fact-repository'
    readonly sourceKey: string
    readonly lineNumber: number
    readonly canonicalDigest: Sha256Digest
  }
}

export interface LocatedTrustedFact {
  readonly locator: TrustedFactLocator
  readonly fact: TrustedFact
}

export interface LocatedTrustedFactSnapshot {
  readonly sourceRevision: Sha256Digest
  readonly facts: readonly LocatedTrustedFact[]
}

export interface NavigationTargetRef {
  readonly targetId: string
  readonly canonicalSource: string
}

export type NavigationRelation = {
  readonly kind: 'about-target'
  readonly targetId: string
}

export interface NavigationHints {
  readonly topics: readonly string[]
  readonly targetRefs: readonly NavigationTargetRef[]
  readonly dimension: FactDimension
  readonly relations: readonly NavigationRelation[]
}

export interface NavigationDerivation {
  readonly method: string
  readonly version: string
}

export interface NavigationItem {
  readonly schemaVersion: typeof NAVIGATION_SCHEMA_VERSION
  readonly kind: 'trusted-fact-navigation'
  readonly origin: 'machine-derived'
  readonly derivation: NavigationDerivation
  readonly locator: TrustedFactLocator
  readonly hints: NavigationHints
}

export interface NavigationSnapshot {
  readonly schemaVersion: typeof NAVIGATION_SCHEMA_VERSION
  readonly sourceRevision: Sha256Digest
  readonly items: readonly NavigationItem[]
}

export interface NavigationHintDeriver {
  derive(locatedFact: LocatedTrustedFact): Pick<NavigationHints, 'topics' | 'relations'>
}

export interface LocatedTrustedFactReader {
  readLocatedSnapshot(): LocatedTrustedFactSnapshot
}

export interface NavigationSnapshotWriter {
  replace(snapshot: NavigationSnapshot): void
}
