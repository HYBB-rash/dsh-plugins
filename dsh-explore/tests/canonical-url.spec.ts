import { describe, expect, it } from 'vitest'
import { canonicalizeUrl } from '../src/canonical-url.ts'

describe('canonical URL', () => {
  it('normalizes X/Twitter status and drops tracking/fragment', () => {
    expect(canonicalizeUrl('https://mobile.twitter.com/a/status/123?utm_source=x&b=2#part')).toBe('https://x.com/a/status/123?b=2')
  })
  it('rejects credentials and non-http URLs', () => {
    expect(canonicalizeUrl('https://u:p@example.com/a')).toBeUndefined()
    expect(canonicalizeUrl('file:///tmp/a')).toBeUndefined()
  })
  it('normalizes default ports, sorts stable query, drops fragment and preserves non-status Twitter host', () => {
    expect(canonicalizeUrl('HTTP://Example.COM:80/a?z=2&utm_medium=x&a=1#frag')).toBe('http://example.com/a?a=1&z=2')
    expect(canonicalizeUrl('https://twitter.com/messages/1?utm_source=x')).toBe('https://twitter.com/messages/1')
  })
  it('rejects overlong source values without treating arbitrary text as URL', () => {
    expect(canonicalizeUrl(`https://example.com/${'x'.repeat(2_050)}`)).toBeUndefined()
    expect(canonicalizeUrl('not a url')).toBeUndefined()
  })
})
