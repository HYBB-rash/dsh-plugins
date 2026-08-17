const TRACKING = new Set(['gclid', 'fbclid', 'msclkid'])

export function canonicalizeUrl(raw: string): string | undefined {
  if (Array.from(raw).length > 2_048) return undefined
  let url: URL
  try { url = new URL(raw.trim()) } catch { return undefined }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') return undefined
  url.protocol = url.protocol.toLowerCase()
  url.hostname = url.hostname.toLowerCase()
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = ''
  if (url.pathname === '') url.pathname = '/'
  const host = url.hostname
  if ((host === 'twitter.com' || host === 'www.twitter.com' || host === 'mobile.twitter.com') && /^\/[^/]+\/status\/\d+\/?$/.test(url.pathname)) { url.protocol = 'https:'; url.hostname = 'x.com'; url.port = '' }
  const parameters = [...url.searchParams.entries()].filter(([key]) => !key.toLowerCase().startsWith('utm_') && !TRACKING.has(key.toLowerCase())).sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
  url.search = ''
  for (const [key, value] of parameters) url.searchParams.append(key, value)
  url.hash = ''
  return url.toString()
}
