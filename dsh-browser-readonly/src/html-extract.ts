import { parse } from 'parse5'

export interface ExtractedDocument {
  readonly title: string
  readonly visibleText: string
  readonly links: Array<{ title: string; url: string }>
  readonly truncated: boolean
}

export interface ExtractLimits {
  readonly title?: number
  readonly visibleText?: number
  readonly links?: number
  readonly linkTitle?: number
}

const OMIT_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'template', 'form', 'input', 'button',
  'select', 'textarea', 'header', 'nav', 'footer', 'aside',
])

function text(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function cap(value: string, maximum: number): [string, boolean] {
  const points = Array.from(value)
  return points.length > maximum ? [points.slice(0, maximum).join(''), true] : [value, false]
}

function attrs(node: { attrs?: Array<{ name: string; value: string }> }): Map<string, string> {
  return new Map(node.attrs?.map(attribute => [attribute.name.toLowerCase(), attribute.value]) ?? [])
}

/** Extract static source text without running any page code. */
export function extractDocument(source: string, baseUrl: URL, limits: ExtractLimits = {}): ExtractedDocument {
  const maxTitle = limits.title ?? 300
  const maxText = limits.visibleText ?? 24_000
  const maxLinks = limits.links ?? 40
  const maxLinkTitle = limits.linkTitle ?? 200
  const document = parse(source) as unknown as Node
  const chunks: string[] = []
  const links: Array<{ title: string; url: string }> = []
  const seenLinks = new Set<string>()
  let truncated = false

  const visit = (node: Node, suppressed: boolean): void => {
    if (node.nodeName === '#text') {
      if (!suppressed && typeof node.value === 'string') chunks.push(node.value)
      return
    }
    const tag = node.tagName?.toLowerCase()
    const nodeAttrs = attrs(node)
    const hidden = suppressed || tag !== undefined && (
      OMIT_TAGS.has(tag) || nodeAttrs.has('hidden') || nodeAttrs.get('aria-hidden') === 'true'
    )
    if (!hidden && tag === 'a') {
      const href = nodeAttrs.get('href')
      if (href !== undefined) {
        try {
          const target = new URL(href, baseUrl)
          if ((target.protocol === 'http:' || target.protocol === 'https:')) {
            target.hash = ''
            const url = target.toString()
            if (Array.from(url).length > 2_048) {
              truncated = true
            } else if (!seenLinks.has(url) && links.length >= maxLinks) {
              truncated = true
            } else if (!seenLinks.has(url)) {
              const linkText = text(collectText(node))
              const [limitedTitle, titleTruncated] = cap(linkText, maxLinkTitle)
              truncated ||= titleTruncated
              links.push({ title: limitedTitle, url })
              seenLinks.add(url)
            }
          }
        } catch { /* malformed href is not an output link */ }
      }
    }
    for (const child of node.childNodes ?? []) visit(child, hidden)
  }

  const titleNode = findFirst(document, new Set(['title']))
  const main = findFirst(document, new Set(['main']))
  const article = main === undefined ? findFirst(document, new Set(['article'])) : undefined
  const body = main === undefined && article === undefined ? findFirst(document, new Set(['body'])) : undefined
  visit(main ?? article ?? body ?? document, false)
  const [boundedTitle, titleTruncated] = cap(text(titleNode === undefined ? '' : collectText(titleNode)), maxTitle)
  const [boundedText, textTruncated] = cap(text(chunks.join(' ')), maxText)
  return { title: boundedTitle, visibleText: boundedText, links, truncated: truncated || titleTruncated || textTruncated }
}

interface Node {
  readonly nodeName?: string
  readonly tagName?: string
  readonly value?: string
  readonly attrs?: Array<{ name: string; value: string }>
  readonly childNodes?: Node[]
}

function collectText(node: Node): string {
  if (node.nodeName === '#text') return node.value ?? ''
  const tag = node.tagName?.toLowerCase()
  if (tag !== undefined && OMIT_TAGS.has(tag)) return ''
  return (node.childNodes ?? []).map(collectText).join(' ')
}

function findFirst(node: Node, names: ReadonlySet<string>): Node | undefined {
  if (node.tagName !== undefined && names.has(node.tagName.toLowerCase())) return node
  for (const child of node.childNodes ?? []) {
    const found = findFirst(child, names)
    if (found !== undefined) return found
  }
  return undefined
}
