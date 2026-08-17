import { describe, expect, it } from 'vitest'
import { extractDocument } from '../src/html-extract.ts'

describe('static HTML extraction', () => {
  it('drops executable and navigational content and bounds text and links', () => {
    const output = extractDocument(`<!doctype html><html><head><title>  A title  </title></head>
      <body><nav>navigation</nav><script>ignore()</script><form>form secret</form>
      <main>Hello <a href="/next#piece">next link</a><span hidden>hidden</span></main></body></html>`, new URL('https://example.com/article'))
    expect(output.title).toBe('A title')
    expect(output.visibleText).toContain('Hello')
    expect(output.visibleText).not.toContain('navigation')
    expect(output.visibleText).not.toContain('form secret')
    expect(output.links).toEqual([{ title: 'next link', url: 'https://example.com/next' }])
  })

  it('marks links beyond the cap or URL length cap as truncated', () => {
    const links = Array.from({ length: 42 }, (_, index) => `<a href="/item-${index}">item ${index}</a>`).join('')
    const tooLong = `<a href="/${'x'.repeat(2_050)}">long</a>`
    const output = extractDocument(`<main>${links}${tooLong}</main>`, new URL('https://example.com/'))
    expect(output.links).toHaveLength(40)
    expect(output.links.every(link => Array.from(link.url).length <= 2_048)).toBe(true)
    expect(output.truncated).toBe(true)
  })
})
