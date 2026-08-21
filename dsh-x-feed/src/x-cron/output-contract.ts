/** Mechanical last-mile guard for the X cron Rich Markdown response. */

export type XFeedOutputGuardCode =
  | 'empty'
  | 'title-missing'
  | 'title-spacing'
  | 'section-spacing'
  | 'section-not-list'
  | 'trailing-blank'
  | 'too-many-lines'
  | 'too-large'
  | 'item-url-missing'
  | 'item-url-multiple'
  | 'invalid-url'
  | 'duplicate-url'
  | 'url-set-mismatch'
  | 'internal-protocol'

export interface XFeedOutputGuardFailure {
  readonly ok: false
  readonly code: XFeedOutputGuardCode
  readonly message: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface XFeedOutputGuardSuccess {
  readonly ok: true
  readonly text: string
  readonly urls: readonly string[]
  readonly nonEmptyLineCount: number
  readonly utf16CodeUnits: number
}

export type XFeedOutputGuardResult = XFeedOutputGuardSuccess | XFeedOutputGuardFailure

export interface XFeedOutputGuardOptions {
  readonly preparedUrls: readonly string[]
  readonly maxUtf16CodeUnits?: number
  readonly maxNonEmptyLines?: number
}

const DEFAULT_MAX_UTF16_CODE_UNITS = 3500
const DEFAULT_MAX_NON_EMPTY_LINES = 20
const SECTION_MARKERS = ['⭐', '🌊', '🔄', '🎯', '📌'] as const
const URL_PATTERN = /https?:\/\/[^\s<>()]+/g
const INTERNAL_PROTOCOL_FAILURE_MESSAGE = 'X output contains internal protocol material'
const INTERNAL_PROTOCOL_MARKER_PATTERN = /\binternal_protocol\b/iu
const INTERNAL_PROTOCOL_TOOL_MARKER_PATTERN = /\btool(?:[-_ ]+)(?:call|result)\b/iu
const INTERNAL_PROTOCOL_TOOL_NAME_PATTERN = /\bx_feed_[a-z0-9_]+\b/iu
const INTERNAL_PROTOCOL_COMMAND_PATTERN = /\b(?:prepare-delivery|confirm-prepared|mark-delivered)\b/iu
const INTERNAL_PROTOCOL_FILE_NAMES = [
  'browser_start.py',
  'insight_engine.py',
  'x_browser.py',
  'x_explorer.py',
  'x_insight_pipeline.py',
  'x_neighborhood.py',
  'x_paths.py',
  'x_timeline_collector.py',
  'x_timeline_dedup.py',
  'x_timeline_migrate_explore.py',
  'x_timeline_store.py',
  'x_topic_search.py',
  'x_insight_package.json',
  'x_shown.json',
  'collection.jsonl',
  'topic-search.jsonl',
  'feedback.jsonl',
  'trusted-facts.jsonl',
  'trusted-fact-navigation.json',
  'legacy-x-preferences.md',
  'x_timeline.jsonl',
  'x_explore_items.jsonl',
  'x_last_theme.json',
  'x_interest_graph.json',
  'x_topic_aliases.json',
  'x_wander_state.json',
  'x_preferences.md',
] as const
const INTERNAL_PROTOCOL_FILE_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_.-])(?:${INTERNAL_PROTOCOL_FILE_NAMES.map(escapeRegExp).join('|')})(?![A-Za-z0-9_.-])`,
  'iu',
)
const INTERNAL_PROTOCOL_LOCAL_PATH_PATTERN = /(?:\/home\/|\/tmp\/|~\/\.dsh\/|file:\/\/)/iu

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function failure(code: XFeedOutputGuardCode, message: string, details?: Readonly<Record<string, unknown>>): XFeedOutputGuardFailure {
  return { ok: false, code, message, ...(details === undefined ? {} : { details }) }
}

function isSectionHeading(line: string): boolean {
  return SECTION_MARKERS.some(marker => line.startsWith(marker))
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.length > 0
  } catch {
    return false
  }
}

function extractedUrls(text: string): string[] {
  return text.match(URL_PATTERN) ?? []
}

function containsInternalProtocol(text: string): boolean {
  return [
    INTERNAL_PROTOCOL_MARKER_PATTERN,
    INTERNAL_PROTOCOL_TOOL_MARKER_PATTERN,
    INTERNAL_PROTOCOL_TOOL_NAME_PATTERN,
    INTERNAL_PROTOCOL_COMMAND_PATTERN,
    INTERNAL_PROTOCOL_FILE_PATTERN,
    INTERNAL_PROTOCOL_LOCAL_PATH_PATTERN,
  ].some(pattern => pattern.test(text))
}

function validateSections(lines: readonly string[]): XFeedOutputGuardFailure | undefined {
  if (!lines[0]?.startsWith('📦 X 洞察')) return failure('title-missing', 'X output must start with the 📦 X 洞察 title')
  if (lines[1] !== '') return failure('title-spacing', 'the title must be followed by one blank line')
  if (lines[2] === '') return failure('title-spacing', 'the title must be followed by exactly one blank line')
  if (lines.at(-1) === '') return failure('trailing-blank', 'X output must not end with a blank line')

  const headingIndexes = lines.reduce<number[]>((indexes, line, index) => {
    if (index > 1 && isSectionHeading(line)) indexes.push(index)
    return indexes
  }, [])
  for (const headingIndex of headingIndexes) {
    if (lines[headingIndex - 1] !== '') {
      return failure('section-spacing', 'each present section must be preceded by one blank line', { headingIndex })
    }
    if (lines[headingIndex - 2] === '') {
      return failure('section-spacing', 'each present section must be preceded by exactly one blank line', { headingIndex })
    }
  }
  if (headingIndexes.length === 0) return failure('section-not-list', 'at least one X section is required')

  const firstHeading = headingIndexes[0]!
  for (const line of lines.slice(2, firstHeading)) {
    if (line !== '') return failure('section-not-list', 'content between the title and first section must be a list section')
  }

  for (let index = 0; index < headingIndexes.length; index++) {
    const headingIndex = headingIndexes[index]!
    const nextHeadingIndex = headingIndexes[index + 1] ?? lines.length
    const body = lines.slice(headingIndex + 1, nextHeadingIndex)
    while (body.at(-1) === '') body.pop()
    if (body.length === 0 || body.some(line => line === '' || !line.startsWith('- '))) {
      return failure('section-not-list', 'each present section must contain a continuous list of - items', { headingIndex })
    }
    for (const line of body) {
      const urls = extractedUrls(line)
      if (urls.length === 0) return failure('item-url-missing', 'every X list item must contain exactly one prepared URL', { headingIndex, line })
      if (urls.length > 1) return failure('item-url-multiple', 'every X list item must contain exactly one prepared URL', { headingIndex, line })
    }
  }

  const lastHeading = headingIndexes.at(-1)!
  if (lines.slice(lastHeading + 1).some(line => line !== '' && !line.startsWith('- '))) {
    return failure('section-not-list', 'content after the final section must remain a list item')
  }
  return undefined
}

/** Validate the exact text that the cron run will hand to the delivery owner. */
export function validateXFeedRichMarkdown(text: string, options: XFeedOutputGuardOptions): XFeedOutputGuardResult {
  if (typeof text !== 'string' || text.length === 0) return failure('empty', 'X output must be a non-empty string')
  if (containsInternalProtocol(text)) return failure('internal-protocol', INTERNAL_PROTOCOL_FAILURE_MESSAGE)
  const utf16CodeUnits = text.length
  const maxUtf16CodeUnits = options.maxUtf16CodeUnits ?? DEFAULT_MAX_UTF16_CODE_UNITS
  if (utf16CodeUnits > maxUtf16CodeUnits) {
    return failure('too-large', 'X output exceeds the UTF-16 delivery budget', { utf16CodeUnits, maxUtf16CodeUnits })
  }
  const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const nonEmptyLineCount = lines.filter(line => line.trim().length > 0).length
  const maxNonEmptyLines = options.maxNonEmptyLines ?? DEFAULT_MAX_NON_EMPTY_LINES
  if (nonEmptyLineCount > maxNonEmptyLines) {
    return failure('too-many-lines', 'X output exceeds the non-empty line budget', { nonEmptyLineCount, maxNonEmptyLines })
  }

  const sectionFailure = validateSections(lines)
  if (sectionFailure !== undefined) return sectionFailure

  const preparedUrls = [...options.preparedUrls]
  if (preparedUrls.some(url => !validUrl(url))) return failure('invalid-url', 'prepared URL list contains an invalid URL')
  const preparedSet = new Set(preparedUrls)
  if (preparedSet.size !== preparedUrls.length) return failure('duplicate-url', 'prepared URL list contains duplicates')

  const urls = extractedUrls(text)
  if (urls.some(url => !validUrl(url))) return failure('invalid-url', 'X output contains an invalid URL')
  const urlSet = new Set(urls)
  if (urlSet.size !== urls.length) return failure('duplicate-url', 'X output repeats a prepared URL')
  if (urlSet.size !== preparedSet.size || urls.some(url => !preparedSet.has(url))) {
    return failure('url-set-mismatch', 'X output URLs must exactly equal the prepared URL set', {
      preparedUrls,
      outputUrls: urls,
    })
  }

  return { ok: true, text, urls, nonEmptyLineCount, utf16CodeUnits }
}

/** Throwing form for composition roots that must fail closed before delivery. */
export function assertValidXFeedRichMarkdown(text: string, options: XFeedOutputGuardOptions): XFeedOutputGuardSuccess {
  const result = validateXFeedRichMarkdown(text, options)
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
  return result
}
