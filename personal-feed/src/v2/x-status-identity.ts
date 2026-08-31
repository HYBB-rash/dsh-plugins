/** Return the only X status URL shape accepted by the v2 delivery boundary. */
export function canonicalizeXStatusIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^https:\/\/(x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status\/([1-9][0-9]*)$/.exec(value)
  if (match === null) return undefined
  const username = match[2]
  const statusId = match[3]
  if (username === undefined || statusId === undefined) return undefined
  return `https://x.com/${username.toLowerCase()}/status/${statusId}`
}
