import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'

export const MAX_URL_LENGTH = 2_048

export type ReadFailureCode =
  | 'invalid_url'
  | 'blocked_address'
  | 'blocked_redirect'
  | 'x_path_forbidden'
  | 'unsupported_content'
  | 'response_too_large'
  | 'browser_unavailable'
  | 'not_logged_in'
  | 'lock_timeout'
  | 'timeout'
  | 'aborted'
  | 'navigation_failed'
  | 'extraction_failed'
  | 'cleanup_failed'

export interface PolicyFailure {
  readonly ok: false
  readonly code: ReadFailureCode
  readonly message: string
}

export interface AddressAllowed {
  readonly ok: true
  readonly address: string
  readonly family: 4 | 6
}

export interface UrlAllowed {
  readonly ok: true
  readonly url: URL
  readonly kind: 'static_http' | 'x_cdp'
}

const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'])
const METADATA_HOSTS = new Set([
  'metadata', 'metadata.google', 'metadata.google.internal',
  'instance-data', 'instance-data.ec2.internal',
])

function failure(code: ReadFailureCode, message: string): PolicyFailure {
  return { ok: false, code, message }
}

/** Classify a literal address. Only globally routable unicast is accepted. */
export function classifyAddress(address: string): AddressAllowed | PolicyFailure {
  try {
    let parsed = ipaddr.parse(address)
    if (parsed.kind() === 'ipv6' && 'isIPv4MappedAddress' in parsed && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address()
    if (parsed.range() !== 'unicast') return failure('blocked_address', '目标地址不是公网单播地址')
    const normalized = parsed.toString()
    return { ok: true, address: normalized, family: parsed.kind() === 'ipv4' ? 4 : 6 }
  } catch {
    return failure('blocked_address', '目标地址无效')
  }
}

/** Whether a host spelling is forbidden before any DNS request. */
export function isBlockedHostname(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.+$/, '')
  return normalized === ''
    || normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === 'local'
    || normalized.endsWith('.local')
    || normalized === 'home.arpa'
    || normalized.endsWith('.home.arpa')
    || METADATA_HOSTS.has(normalized)
}

export function isXHost(host: string): boolean {
  return X_HOSTS.has(host.toLowerCase().replace(/\.+$/, ''))
}

/** Return the exact normalized public X status URL, otherwise undefined. */
export function normalizeXStatusUrl(input: string): string | undefined {
  let parsed: URL
  try { parsed = new URL(input) } catch { return undefined }
  if (parsed.protocol !== 'https:' || parsed.port !== '' || !isXHost(parsed.hostname) || parsed.username !== '' || parsed.password !== '') return undefined
  const match = /^\/([^/%\u0000-\u001f]+)\/status\/([0-9]+)\/?$/.exec(parsed.pathname)
  const username = match?.[1]
  const id = match?.[2]
  if (username === undefined || id === undefined || username === '.' || username === '..' || username.toLowerCase() === 'i') return undefined
  return `https://x.com/${username}/status/${id}`
}

export function isExactXStatusUrl(input: string): boolean {
  return normalizeXStatusUrl(input) !== undefined
}

/**
 * Validate one top-level URL before DNS. X domains deliberately never fall
 * back to the static reader: a non-status X route could use the login context.
 */
export function classifyUrl(input: string): UrlAllowed | PolicyFailure {
  if (typeof input !== 'string' || input.length === 0 || Array.from(input).length > MAX_URL_LENGTH) {
    return failure('invalid_url', 'URL 无效或过长')
  }
  let parsed: URL
  try { parsed = new URL(input) } catch { return failure('invalid_url', 'URL 无效') }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '') {
    return failure('invalid_url', '只允许无凭据的 HTTP 或 HTTPS URL')
  }
  if (parsed.port !== '' && !((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443'))) {
    return failure('invalid_url', 'URL 端口不在允许范围')
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (isBlockedHostname(hostname)) return failure('blocked_address', '目标主机不允许访问')
  if (isIP(hostname) !== 0) {
    const classified = classifyAddress(hostname)
    if (!classified.ok) return classified
  }
  if (isXHost(hostname)) {
    const normalized = normalizeXStatusUrl(input)
    if (normalized === undefined) return failure('x_path_forbidden', 'X 只允许公开 status 页面')
    return { ok: true, url: new URL(normalized), kind: 'x_cdp' }
  }
  return { ok: true, url: parsed, kind: 'static_http' }
}

/** Validate a redirect target and make its failure distinguishable to callers. */
export function classifyRedirectUrl(input: string): UrlAllowed | PolicyFailure {
  const result = classifyUrl(input)
  if (result.ok) return result
  if (result.code === 'blocked_address' || result.code === 'invalid_url' || result.code === 'x_path_forbidden') {
    return { ...result, code: 'blocked_redirect', message: '重定向目标不允许访问' }
  }
  return result
}

export function isHttpsDowngrade(from: URL, to: URL): boolean {
  return from.protocol === 'https:' && to.protocol === 'http:'
}
