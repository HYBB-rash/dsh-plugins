import type {
  LocatedTrustedFact,
  NavigationDerivation,
  NavigationHintDeriver,
  NavigationItem,
  NavigationRelation,
  NavigationTargetRef,
} from './navigation-contract.ts'

export class TrustedFactNavigationProjector {
  constructor(
    private readonly hintDeriver: NavigationHintDeriver,
    private readonly derivation: NavigationDerivation,
  ) {}

  project(locatedFact: LocatedTrustedFact): NavigationItem {
    const derivedHints = this.hintDeriver.derive(locatedFact)
    const targetRefs = this.createTargetRefs(locatedFact)
    const topics = this.normalizeTopics(derivedHints.topics)
    const relations = this.normalizeRelations(derivedHints.relations)

    return Object.freeze({
      schemaVersion: 1,
      kind: 'trusted-fact-navigation',
      origin: 'machine-derived',
      derivation: Object.freeze({ ...this.derivation }),
      locator: locatedFact.locator,
      hints: Object.freeze({
        topics: Object.freeze(topics),
        targetRefs: Object.freeze(targetRefs),
        dimension: locatedFact.fact.dimension,
        relations: Object.freeze(relations),
      }),
    })
  }

  private createTargetRefs(locatedFact: LocatedTrustedFact): readonly NavigationTargetRef[] {
    return [
      Object.freeze({
        targetId: locatedFact.fact.target.id,
        canonicalSource: locatedFact.fact.target.source,
      }),
    ]
  }

  private normalizeTopics(topics: readonly string[]): readonly string[] {
    const seen = new Set<string>()
    const normalized: string[] = []
    for (const topic of topics) {
      if (typeof topic !== 'string') continue
      const trimmed = topic.trim()
      if (trimmed.length === 0 || seen.has(trimmed)) continue
      seen.add(trimmed)
      normalized.push(trimmed)
    }
    return normalized
  }

  private normalizeRelations(relations: readonly NavigationRelation[]): readonly NavigationRelation[] {
    const seen = new Set<string>()
    const normalized: NavigationRelation[] = []
    for (const relation of relations) {
      if (!relation || relation.kind !== 'about-target' || typeof relation.targetId !== 'string') continue
      if (relation.targetId.length === 0 || seen.has(relation.targetId)) continue
      seen.add(relation.targetId)
      normalized.push(Object.freeze({ kind: 'about-target', targetId: relation.targetId }))
    }
    return normalized
  }
}
