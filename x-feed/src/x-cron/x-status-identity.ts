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
  const match = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/([1-9]\d*)$/u.exec(value.trim())
  if (match === null) return undefined
  const statusId = match[2]!
  const canonicalUrl = `https://x.com/${match[1]!.toLowerCase()}/status/${statusId}`
  return Object.freeze({ statusId, canonicalUrl, itemId: `item:x-status:${statusId}` })
}

export const parseCanonicalXStatusIdentity = parseXStatusIdentity
