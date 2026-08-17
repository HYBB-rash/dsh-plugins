import { describe, expect, it } from 'vitest'
import {
  classifyAddress,
  classifyUrl,
  isExactXStatusUrl,
  normalizeXStatusUrl,
} from '../src/policy.ts'

describe('browser read policy', () => {
  it('accepts only bounded public-web URLs', () => {
    expect(classifyUrl('https://Example.COM/article?q=1').ok).toBe(true)
    expect(classifyUrl('http://example.com:8080/').ok).toBe(false)
    expect(classifyUrl('file:///etc/passwd').code).toBe('invalid_url')
    expect(classifyUrl('https://user:pass@example.com/').code).toBe('invalid_url')
    expect(classifyUrl('https://localhost/').code).toBe('blocked_address')
    expect(classifyUrl('https://127.0.0.1/').code).toBe('blocked_address')
    expect(classifyUrl('https://[::1]/').code).toBe('blocked_address')
    expect(classifyUrl('https://api.local/').code).toBe('blocked_address')
    expect(classifyUrl('https://metadata.google.internal/').code).toBe('blocked_address')
  })

  it('rejects every non-global address class, including mapped IPv4', () => {
    for (const address of [
      '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
      '172.16.0.1', '192.168.0.1', '224.0.0.1', '192.0.2.1',
      '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1',
    ]) expect(classifyAddress(address).ok).toBe(false)
    expect(classifyAddress('8.8.8.8').ok).toBe(true)
    expect(classifyAddress('2606:4700:4700::1111').ok).toBe(true)
  })

  it('normalizes only exact public X status paths', () => {
    expect(normalizeXStatusUrl('https://twitter.com/example/status/123/?q=x#frag')).toBe('https://x.com/example/status/123')
    expect(normalizeXStatusUrl('https://x.com:444/example/status/123')).toBeUndefined()
    expect(isExactXStatusUrl('https://x.com/example/status/123')).toBe(true)
    for (const url of [
      'https://x.com/messages/compose', 'https://x.com/settings/account',
      'https://x.com/example/status/not-a-number', 'https://x.com/i/status/123',
      'https://x.com/example/status/123/extra',
    ]) expect(isExactXStatusUrl(url)).toBe(false)
  })
})
