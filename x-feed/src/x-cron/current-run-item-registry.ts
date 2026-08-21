import { parseXStatusIdentity } from './x-status-identity.ts'

export interface CurrentRunCandidateInput {
  readonly id: string
  readonly source: string
  readonly content: string
  readonly topics: readonly string[]
}

export interface CurrentRunItem {
  readonly itemId: string
  readonly canonicalUrl: string
  readonly content: string
  readonly topics: readonly string[]
}

export type CurrentRunRegistryResult =
  | { readonly ok: true; readonly kind: 'search'; readonly items: readonly CurrentRunItem[] }
  | { readonly ok: true; readonly kind: 'explore'; readonly item: CurrentRunItem }
  | { readonly ok: false; readonly code: 'unknown_item' | 'exploration_already_registered' | 'invalid_exploration' | 'duplicate_item' | 'invalid_search' | 'action_already_registered'; readonly message: string }

export type CurrentRunActionResult = CurrentRunRegistryResult

export class CurrentRunItemRegistry {
  readonly #items = new Map<string, CurrentRunItem>()
  readonly #explored = new Set<string>()
  #actionRegistered = false

  constructor(candidates: readonly CurrentRunCandidateInput[]) {
    const seen = new Set<string>()
    for (const candidate of candidates) {
      validateCandidate(candidate)
      if (seen.has(candidate.id)) throw new Error(`duplicate current-run candidate: ${candidate.id}`)
      seen.add(candidate.id)
      const identity = parseXStatusIdentity(candidate.source)
      if (identity === undefined || identity.itemId !== itemIdFor(candidate.id)) {
        throw new Error(`candidate identity does not match URL: ${candidate.id}`)
      }
      const itemId = identity.itemId
      const item = createItem(candidate, itemId, identity.canonicalUrl)
      this.#items.set(itemId, item)
    }
  }

  getByItemId(itemId: string): CurrentRunItem | undefined {
    return this.#items.get(itemId)
  }

  snapshot(): readonly CurrentRunItem[] {
    return Object.freeze([...this.#items.values()])
  }

  /** The only model-facing identity surface: stable item IDs, never content. */
  modelAllowlist(): readonly string[] {
    return Object.freeze([...this.#items.keys()])
  }

  registerExploration(input: unknown): CurrentRunRegistryResult {
    if (!isRecord(input) || (input.kind !== 'search' && input.kind !== 'explore')) {
      return { ok: false, code: 'invalid_exploration', message: 'exploration result is malformed' }
    }
    if (this.#actionRegistered) {
      return { ok: false, code: 'action_already_registered', message: 'current-run search/exploration action was already registered' }
    }
    if (input.kind === 'search') return this.registerSearchBatch(input)
    return this.registerExplore(input)
  }

  private registerSearchBatch(input: Record<string, unknown>): CurrentRunRegistryResult {
    if (!Array.isArray(input.items)) return { ok: false, code: 'invalid_search', message: 'search items are malformed' }
    const prepared: CurrentRunItem[] = []
    const seen = new Set<string>()
    try {
      for (const raw of input.items) {
        if (!isRecord(raw)) throw new Error('search item is malformed')
        validateCandidate(raw as unknown as CurrentRunCandidateInput)
        const candidate = raw as unknown as CurrentRunCandidateInput
        const identity = parseXStatusIdentity(candidate.source)
        if (identity === undefined || identity.itemId !== itemIdFor(candidate.id)) throw new Error('search item identity mismatch')
        if (seen.has(identity.itemId) || this.#items.has(identity.itemId)) return { ok: false, code: 'duplicate_item', message: 'search item is duplicated' }
        seen.add(identity.itemId)
        prepared.push(createItem(candidate, identity.itemId, identity.canonicalUrl))
      }
    } catch {
      return { ok: false, code: 'invalid_search', message: 'search item is malformed or noncanonical' }
    }
    for (const item of prepared) this.#items.set(item.itemId, item)
    this.#actionRegistered = true
    return { ok: true, kind: 'search', items: Object.freeze(prepared) }
  }

  private registerExplore(input: Record<string, unknown>): CurrentRunRegistryResult {
    if (typeof input.itemId !== 'string' || typeof input.content !== 'string' || !Array.isArray(input.topics)
      || input.content.trim() === '' || input.content !== input.content.trim()
      || input.topics.some(topic => typeof topic !== 'string' || topic.trim() === '' || topic !== topic.trim())) {
      return { ok: false, code: 'invalid_exploration', message: 'exploration result is malformed' }
    }
    const item = this.#items.get(input.itemId)
    if (item === undefined) return { ok: false, code: 'unknown_item', message: 'itemId is not in the current run' }
    if (this.#explored.has(input.itemId)) {
      return { ok: false, code: 'exploration_already_registered', message: 'exploration was already registered for this item' }
    }
    const topics = [...new Set([...item.topics, ...(input.topics as string[])])]
    const enhanced = Object.freeze({ itemId: item.itemId, canonicalUrl: item.canonicalUrl, content: input.content, topics: Object.freeze(topics) })
    this.#items.set(input.itemId, enhanced)
    this.#explored.add(input.itemId)
    this.#actionRegistered = true
    return { ok: true, kind: 'explore', item: enhanced }
  }
}

export function itemIdFor(candidateId: string): string {
  if (typeof candidateId !== 'string' || candidateId.trim() === '' || candidateId !== candidateId.trim()) throw new Error('current-run candidate id is invalid')
  return `item:${candidateId}`
}

function validateCandidate(candidate: CurrentRunCandidateInput): void {
  if (!isRecord(candidate)
    || typeof candidate.id !== 'string'
    || typeof candidate.source !== 'string'
    || typeof candidate.content !== 'string'
    || !Array.isArray(candidate.topics)
    || candidate.id.trim() === ''
    || candidate.id !== candidate.id.trim()
    || candidate.content.trim() === ''
    || candidate.content !== candidate.content.trim()
    || candidate.topics.some(topic => typeof topic !== 'string' || topic.trim() === '' || topic !== topic.trim())) {
    throw new Error('current-run candidate is malformed')
  }
  if (parseXStatusIdentity(candidate.source) === undefined) throw new Error('current-run candidate URL is not canonical')
}

function createItem(candidate: CurrentRunCandidateInput, itemId: string, canonicalUrl: string): CurrentRunItem {
  return Object.freeze({
    itemId,
    canonicalUrl,
    content: candidate.content,
    topics: Object.freeze([...candidate.topics]),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
