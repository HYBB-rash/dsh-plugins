import { isTrustedFact, type TrustedFact } from './model.ts'

/**
 * Explicit selectors for a controlled judgment lookup.
 *
 * `canonicalSources` must already contain the caller's canonical source value.
 * This boundary deliberately performs no URL normalization or semantic lookup.
 */
export interface AutomaticJudgmentFactQuery {
  readonly targetIds?: readonly string[]
  readonly canonicalSources?: readonly string[]
}

/**
 * The only lookup boundary available to future automatic judgment consumers.
 * It has no write operation and no way to request the complete fact history.
 */
export interface AutomaticJudgmentFactSource {
  query(query: AutomaticJudgmentFactQuery): readonly TrustedFact[]
}

/** Persistence port owned by this boundary; file storage implements it. */
export interface TrustedFactReader {
  readAll(): readonly TrustedFact[]
}

/**
 * Read-only adapter from the durable trusted-fact repository to the narrow
 * automatic-judgment port. The repository remains responsible for parsing and
 * re-admitting durable rows through the TrustedFact factory.
 */
export class FileTrustedFactSource implements AutomaticJudgmentFactSource {
  constructor(private readonly repository: TrustedFactReader) {}

  query(query: AutomaticJudgmentFactQuery): readonly TrustedFact[] {
    const targetIds = selectorsFrom(query.targetIds)
    const canonicalSources = selectorsFrom(query.canonicalSources)
    if (targetIds.size === 0 && canonicalSources.size === 0) return []

    return this.repository
      .readAll()
      .filter(isTrustedFact)
      .filter(fact => targetIds.has(fact.target.id) || canonicalSources.has(fact.target.source))
  }
}

function selectorsFrom(values: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((values ?? []).filter(hasNonWhitespaceValue))
}

function hasNonWhitespaceValue(value: string): boolean {
  return value.trim().length > 0
}
