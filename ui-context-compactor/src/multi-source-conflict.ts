/** Pure exact-two material/finding mechanics for F03-T3's private path. */

export interface MultiSourceFactNeedShape {
  readonly ref: string
  readonly requirements: readonly {
    readonly fact: string
    readonly neededFor: readonly string[]
  }[]
}

export interface MultiSourceMaterialShape {
  readonly ref: string
  readonly request: string
  readonly fact: string
  readonly source: string
  readonly url: string
  readonly observedAt: string
  readonly publishedAt: string | undefined
}

export interface MultiSourceFindingShape {
  readonly factNeeds: string
  readonly request: string
  readonly material: string
  readonly fact: string
  readonly source: string
  readonly conclusion: string
  readonly appliesWhen: string
  readonly observedAt: string
  readonly publishedAt: string | undefined
  readonly futureUse: string
}

export interface CanonicalMultiSourceItem {
  readonly material: MultiSourceMaterialShape
  readonly finding: MultiSourceFindingShape
}

export type CompleteMultiSourceResolution = {
  readonly kind: 'agree' | 'conditional' | 'conflict'
  readonly items: readonly [CanonicalMultiSourceItem, CanonicalMultiSourceItem]
  readonly meaning: string
  readonly sortedSources: readonly [string, string]
}

export type MultiSourceResolution =
  | CompleteMultiSourceResolution
  | { readonly kind: 'source_incomplete' }

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function validFactNeed(needs: MultiSourceFactNeedShape): boolean {
  const raw = object(needs)
  const requirement = object(needs.requirements[0])
  return raw !== undefined
    && onlyKeys(raw, ['ref', 'requirements'])
    && nonblank(needs.ref)
    && needs.requirements.length === 1
    && requirement !== undefined
    && onlyKeys(requirement, ['fact', 'neededFor'])
    && nonblank(requirement.fact)
    && Array.isArray(requirement.neededFor)
    && requirement.neededFor.length > 0
    && requirement.neededFor.every(nonblank)
    && new Set(requirement.neededFor).size === requirement.neededFor.length
}

function validMaterial(material: MultiSourceMaterialShape): boolean {
  const raw = object(material)
  if (raw === undefined || !onlyKeys(raw, [
    'ref', 'request', 'fact', 'source', 'url', 'observedAt', 'publishedAt',
  ]) || !nonblank(material.ref) || !nonblank(material.request)
    || !nonblank(material.fact) || !nonblank(material.source) || !nonblank(material.url)
    || !nonblank(material.observedAt) || !Number.isFinite(Date.parse(material.observedAt))
    || (material.publishedAt !== undefined
      && (!nonblank(material.publishedAt) || !Number.isFinite(Date.parse(material.publishedAt))))) return false
  try {
    const parsed = new URL(material.url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function validFinding(finding: MultiSourceFindingShape): boolean {
  const raw = object(finding)
  return raw !== undefined
    && onlyKeys(raw, [
      'factNeeds', 'request', 'material', 'fact', 'source', 'conclusion',
      'appliesWhen', 'observedAt', 'publishedAt', 'futureUse',
    ])
    && nonblank(finding.factNeeds)
    && nonblank(finding.request)
    && nonblank(finding.material)
    && nonblank(finding.fact)
    && nonblank(finding.source)
    && nonblank(finding.conclusion)
    && nonblank(finding.appliesWhen)
    && nonblank(finding.observedAt)
    && Number.isFinite(Date.parse(finding.observedAt))
    && (finding.publishedAt === undefined
      || nonblank(finding.publishedAt) && Number.isFinite(Date.parse(finding.publishedAt)))
    && nonblank(finding.futureUse)
}

function matches(
  needs: MultiSourceFactNeedShape,
  material: MultiSourceMaterialShape,
  finding: MultiSourceFindingShape,
): boolean {
  const requirement = needs.requirements[0]
  return requirement !== undefined
    && material.fact === requirement.fact
    && finding.factNeeds === needs.ref
    && finding.request === material.request
    && finding.material === material.ref
    && finding.fact === material.fact
    && finding.source === material.source
    && finding.observedAt === material.observedAt
    && finding.publishedAt === material.publishedAt
}

function canonicalItemOrder(left: CanonicalMultiSourceItem, right: CanonicalMultiSourceItem): number {
  return left.material.source.localeCompare(right.material.source)
    || left.material.url.localeCompare(right.material.url)
    || left.material.ref.localeCompare(right.material.ref)
}

function meaning(
  kind: CompleteMultiSourceResolution['kind'],
  items: readonly [CanonicalMultiSourceItem, CanonicalMultiSourceItem],
): string {
  return JSON.stringify({
    kind,
    sources: items.map(item => ({
      source: item.material.source,
      conclusion: item.finding.conclusion,
      appliesWhen: item.finding.appliesWhen,
      observedAt: item.finding.observedAt,
      publishedAt: item.finding.publishedAt ?? null,
      futureUse: item.finding.futureUse,
    })),
  })
}

/**
 * Validate and canonicalize two already-produced single-material findings.
 * It performs no retrieval, semantic judgment, ranking, or action decision.
 */
export function resolveMultiSourceConflict(
  needs: MultiSourceFactNeedShape,
  materials: readonly MultiSourceMaterialShape[],
  findings: readonly MultiSourceFindingShape[],
): MultiSourceResolution {
  if (!validFactNeed(needs) || materials.length !== 2 || findings.length !== 2) {
    return Object.freeze({ kind: 'source_incomplete' })
  }
  const firstMaterial = materials[0]
  const secondMaterial = materials[1]
  const firstFinding = findings[0]
  const secondFinding = findings[1]
  if (firstMaterial === undefined || secondMaterial === undefined
    || firstFinding === undefined || secondFinding === undefined
    || !validMaterial(firstMaterial) || !validMaterial(secondMaterial)
    || !validFinding(firstFinding) || !validFinding(secondFinding)
    || !matches(needs, firstMaterial, firstFinding)
    || !matches(needs, secondMaterial, secondFinding)
    || firstMaterial.request !== secondMaterial.request
    || firstMaterial.ref === secondMaterial.ref
    || firstMaterial.source === secondMaterial.source
    || firstMaterial.url === secondMaterial.url) return Object.freeze({ kind: 'source_incomplete' })
  const ordered = [
    Object.freeze({ material: firstMaterial, finding: firstFinding }),
    Object.freeze({ material: secondMaterial, finding: secondFinding }),
  ].sort(canonicalItemOrder)
  const first = ordered[0]
  const second = ordered[1]
  if (first === undefined || second === undefined) return Object.freeze({ kind: 'source_incomplete' })
  const items: readonly [CanonicalMultiSourceItem, CanonicalMultiSourceItem] = Object.freeze([first, second])
  const kind: CompleteMultiSourceResolution['kind'] = first.finding.conclusion === second.finding.conclusion
    && first.finding.appliesWhen === second.finding.appliesWhen
    ? 'agree'
    : first.finding.appliesWhen !== second.finding.appliesWhen
      ? 'conditional'
      : 'conflict'
  return Object.freeze({
    kind,
    items,
    meaning: meaning(kind, items),
    sortedSources: Object.freeze([
      first.material.source,
      second.material.source,
    ]) as readonly [string, string],
  })
}
