import { validateXFeedRichMarkdown, type XFeedOutputGuardFailure } from './output-contract.ts'
import { CurrentRunItemRegistry } from './current-run-item-registry.ts'

export interface PrepareDigestPorts {
  prepareDelivery(text: string, urls: readonly string[], options: { readonly themeId: string }): Promise<unknown>
}

export interface PrepareDigestInput {
  readonly text: string
  readonly themeId: string
  readonly usedItemIds: readonly string[]
  readonly registry: CurrentRunItemRegistry
  readonly ports: PrepareDigestPorts
}

export interface PrepareDigestSuccess {
  readonly ok: true
  readonly text: string
  readonly themeId: string
  readonly usedItemIds: readonly string[]
  readonly urls: readonly string[]
  readonly pending: true
}

export type PrepareDigestFailure = XFeedOutputGuardFailure | {
  readonly ok: false
  readonly code: 'invalid-item-ids' | 'prepare-failed' | string
  readonly message: string
}

export type PrepareDigestResult = PrepareDigestSuccess | PrepareDigestFailure

/** Validate a rendered artifact, derive URLs, and make exactly one prepare call. */
export async function prepareDigest(input: PrepareDigestInput): Promise<PrepareDigestResult> {
  if (typeof input.themeId !== 'string' || input.themeId.trim() === '' || input.themeId !== input.themeId.trim()) {
    return { ok: false, code: 'invalid-item-ids', message: 'themeId is invalid' }
  }
  if (!Array.isArray(input.usedItemIds) || input.usedItemIds.length === 0
    || input.usedItemIds.some(itemId => typeof itemId !== 'string')) {
    return { ok: false, code: 'invalid-item-ids', message: 'used item IDs are invalid' }
  }
  const seen = new Set<string>()
  const urls: string[] = []
  for (const itemId of input.usedItemIds) {
    if (seen.has(itemId)) return { ok: false, code: 'invalid-item-ids', message: 'used item IDs must be unique' }
    seen.add(itemId)
    const item = input.registry.getByItemId(itemId)
    if (item === undefined) return { ok: false, code: 'invalid-item-ids', message: 'used item ID is not in the current run registry' }
    urls.push(item.canonicalUrl)
  }
  const guarded = validateXFeedRichMarkdown(input.text, { preparedUrls: urls })
  if (!guarded.ok) return guarded
  try {
    const result = await input.ports.prepareDelivery(guarded.text, urls, { themeId: input.themeId })
    if (!isFormalSuccess(result, urls.length)) return prepareFailure('prepare-delivery returned an invalid result')
    return Object.freeze({
      ok: true,
      text: guarded.text,
      themeId: input.themeId,
      usedItemIds: Object.freeze([...input.usedItemIds]),
      urls: Object.freeze([...urls]),
      pending: true,
    })
  } catch (error) {
    return prepareFailure(error instanceof Error ? error.message : String(error))
  }
}

function isFormalSuccess(value: unknown, expectedPrepared: number): boolean {
  return typeof value === 'object' && value !== null
    && (value as { ok?: unknown }).ok === true
    && Number.isSafeInteger((value as { prepared?: unknown }).prepared)
    && (value as { prepared: number }).prepared === expectedPrepared
    && Array.isArray((value as { rejected?: unknown }).rejected)
    && (value as { rejected: unknown[] }).rejected.length === 0
}

function prepareFailure(message: string): PrepareDigestFailure {
  return { ok: false, code: 'prepare-failed', message: boundUtf8(message) }
}

function boundUtf8(value: string): string {
  const source = String(value)
  const encoder = new TextEncoder()
  if (encoder.encode(source).byteLength <= 256) return source
  let result = ''
  let bytes = 0
  for (const character of source) {
    const size = encoder.encode(character).byteLength
    if (bytes + size > 256) break
    result += character
    bytes += size
  }
  return result
}
