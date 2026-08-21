import type { FeedbackTarget, FeedbackTargetCatalog } from './contract.ts'

const STATUS_URL_PATTERN =
  /(?<![\w.-])(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)\/status\/(\d+)(?![A-Za-z0-9_])(?:\/)?(?:[?#][^\s]*)?/giu

export type FeedbackTargetQuickResult =
  | { readonly kind: 'pass' }
  | { readonly kind: 'candidates'; readonly count: number }

export interface FeedbackTargetCatalogResult {
  readonly catalog: FeedbackTargetCatalog
  readonly quick: FeedbackTargetQuickResult
}

/**
 * Collects only directly visible X status URLs. It does not infer intent or
 * choose among candidates; current-message candidates win cross-source dedupe.
 */
export function collectFeedbackTargetCatalog(
  currentMessage: string,
  referenceMessage?: string,
): FeedbackTargetCatalogResult {
  const currentTargets = extractTargets(currentMessage, 'current')
  const currentSources = new Set(currentTargets.map((target) => target.source))
  const referenceTargets = extractTargets(referenceMessage ?? '', 'reference').filter(
    (target) => !currentSources.has(target.source),
  )
  const catalog = { currentMessage: currentTargets, reference: referenceTargets }
  const count = currentTargets.length + referenceTargets.length

  return {
    catalog,
    quick: count === 0 ? { kind: 'pass' } : { kind: 'candidates', count },
  }
}

function extractTargets(text: string, scope: 'current' | 'reference'): readonly FeedbackTarget[] {
  const targets: FeedbackTarget[] = []
  const seenSources = new Set<string>()

  for (const match of text.matchAll(STATUS_URL_PATTERN)) {
    const user = match[1]
    const statusId = match[2]
    if (user === undefined || statusId === undefined) continue

    const source = `https://x.com/${user.toLowerCase()}/status/${statusId}`
    if (seenSources.has(source)) continue
    seenSources.add(source)
    targets.push({
      id: `x-status:${statusId}`,
      content: text,
      source,
      scope,
    })
  }

  return targets
}
