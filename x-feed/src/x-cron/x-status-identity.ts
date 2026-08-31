import { canonicalizeXStatusIdentity } from '@herman/personal-feed'

/** The one canonical X status identity used by current-run state. */
export interface XStatusIdentity {
  readonly statusId: string
  readonly canonicalUrl: string
  readonly itemId: string
}

/**
 * Parse the shipped X status URL contract without touching stores or I/O.
 * Query/fragment/photo URLs and status IDs with leading zeroes are rejected;
 * x/twitter host and username casing are normalized exactly as the provider
 * package parser does.
 */
export function parseXStatusIdentity(value: unknown): XStatusIdentity | undefined {
  if (typeof value !== 'string') return undefined
  const canonicalUrl = canonicalizeXStatusIdentity(value.trim())
  if (canonicalUrl === undefined) return undefined
  const statusId = canonicalUrl.slice(canonicalUrl.lastIndexOf('/') + 1)
  return Object.freeze({ statusId, canonicalUrl, itemId: `item:x-status:${statusId}` })
}

export const parseCanonicalXStatusIdentity = parseXStatusIdentity
