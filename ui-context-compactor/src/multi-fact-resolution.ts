/** Pure exact-two mechanics shared by F03-T2's private resolution path. */

export type ExactTwo<Item> = readonly [Item, Item]

export interface ExactFactRequirementShape {
  readonly fact: string
  readonly neededFor: readonly string[]
}

export interface ExactFactConclusionShape {
  readonly fact: string
}

export interface ExactFactProvenanceShape<Conclusion extends ExactFactConclusionShape> {
  readonly conclusion: Conclusion
}

export interface ExactTwoFactItem<
  Requirement extends ExactFactRequirementShape,
  Conclusion extends ExactFactConclusionShape,
  Provenance extends ExactFactProvenanceShape<Conclusion>,
> {
  readonly requirement: Requirement
  readonly conclusion: Conclusion
  readonly provenance: Provenance
}

export interface ExactTwoFactProjection<
  Requirement extends ExactFactRequirementShape,
  Conclusion extends ExactFactConclusionShape,
  Provenance extends ExactFactProvenanceShape<Conclusion>,
> {
  readonly requirements: ExactTwo<Requirement>
  readonly conclusions: ExactTwo<Conclusion>
  readonly provenances: ExactTwo<Provenance>
  readonly usableFacts: readonly Conclusion[]
  readonly unresolvedFacts: readonly Conclusion[]
  readonly neededFor: ExactTwo<{
    readonly fact: Requirement['fact']
    readonly actions: Requirement['neededFor']
  }>
}

export function exactTwo<Item>(items: readonly Item[]): ExactTwo<Item> | undefined {
  const first = items[0]
  const second = items[1]
  return items.length === 2 && first !== undefined && second !== undefined
    ? Object.freeze([first, second])
    : undefined
}

export function sameExactStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && new Set(expected).size === expected.length
    && actual.every(value => expected.includes(value))
}

/** Validate one member of each identity while preserving the caller's order. */
export function exactTwoDistinctBy<Item>(
  items: readonly Item[],
  identify: (item: Item) => 'a' | 'b' | undefined,
): ExactTwo<Item> | undefined {
  const pair = exactTwo(items)
  if (pair === undefined) return undefined
  const first = identify(pair[0])
  const second = identify(pair[1])
  return first !== undefined && second !== undefined && first !== second ? pair : undefined
}

/**
 * Validate and project two already-concluded facts without changing order or
 * acquiring evidence, action, presentation, or lifecycle authority.
 */
export function projectExactTwoFactResults<
  Requirement extends ExactFactRequirementShape,
  Conclusion extends ExactFactConclusionShape,
  Provenance extends ExactFactProvenanceShape<Conclusion>,
>(
  requirements: readonly Requirement[],
  items: readonly ExactTwoFactItem<Requirement, Conclusion, Provenance>[],
  isUsable: (conclusion: Conclusion) => boolean,
): ExactTwoFactProjection<Requirement, Conclusion, Provenance> | undefined {
  const exactRequirements = exactTwo(requirements)
  const exactItems = exactTwo(items)
  if (exactRequirements === undefined || exactItems === undefined
    || exactItems[0].requirement !== exactRequirements[0]
    || exactItems[1].requirement !== exactRequirements[1]
    || exactItems[0].conclusion.fact !== exactRequirements[0].fact
    || exactItems[1].conclusion.fact !== exactRequirements[1].fact
    || exactItems[0].provenance.conclusion !== exactItems[0].conclusion
    || exactItems[1].provenance.conclusion !== exactItems[1].conclusion) return undefined
  const conclusions: ExactTwo<Conclusion> = Object.freeze([
    exactItems[0].conclusion,
    exactItems[1].conclusion,
  ])
  const provenances: ExactTwo<Provenance> = Object.freeze([
    exactItems[0].provenance,
    exactItems[1].provenance,
  ])
  const usableFacts = conclusions.filter(isUsable)
  const unresolvedFacts = conclusions.filter(conclusion => !isUsable(conclusion))
  const neededFor: ExactTwo<{
    readonly fact: Requirement['fact']
    readonly actions: Requirement['neededFor']
  }> = Object.freeze([
    Object.freeze({ fact: exactRequirements[0].fact, actions: exactRequirements[0].neededFor }),
    Object.freeze({ fact: exactRequirements[1].fact, actions: exactRequirements[1].neededFor }),
  ])
  return Object.freeze({
    requirements: exactRequirements,
    conclusions,
    provenances,
    usableFacts: Object.freeze(usableFacts),
    unresolvedFacts: Object.freeze(unresolvedFacts),
    neededFor,
  })
}
