/**
 * The model-facing surface for one X cron run.
 *
 * The tool list is intentionally small and run-local. It has no shell, file,
 * session, browser, web-search, feedback, receipt, or shown-marking route.
 */

import {
  ToolArgsError,
  type JsonSchemaNode,
  type ToolDefinition,
  type ToolRunContext,
  validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools'
import type { XFeedInsightPackage, XFeedPreparedArtifact } from './python-ports.ts'

export type XFeedRunToolFailure = {
  readonly ok: false
  readonly code: string
  readonly message: string
}

export type XFeedRunToolSuccess = {
  readonly ok: true
  readonly [key: string]: unknown
}

export type XFeedRunToolResult = XFeedRunToolSuccess | XFeedRunToolFailure

const SEARCH_RESULT_MAX_UTF8_BYTES = 4_000
const EXPLORE_RESULT_MAX_UTF8_BYTES = 2_000
const SEARCH_ITEM_KEYS = ['id', 'url', 'text', 'time', 'user', 'topic', 'anchor', 'hop'] as const
type SearchItemKey = typeof SEARCH_ITEM_KEYS[number]
type ProjectedSearchItem = Partial<Record<SearchItemKey, string | number>> & {
  readonly id: string
  readonly url: string
  readonly text: string
}

/**
 * Project one raw search package to the closed, bounded model-facing DTO.
 * This is deliberately a pure function: the Python port and tool lifecycle
 * remain unchanged until the result budget has its own acceptance tests.
 */
export function projectSearchToolResult(value: XFeedInsightPackage | XFeedRunToolResult): XFeedRunToolResult {
  if (isRunToolFailure(value)) return value
  const items: ProjectedSearchItem[] = Array.isArray(value.items)
    ? value.items.flatMap(item => {
      const projected = projectSearchItem(item)
      return projected === undefined ? [] : [projected]
    })
    : []
  const originalBytes = utf8Bytes(JSON.stringify({ items })).length
  const totalItems = items.length
  const fullPayload = searchPayload(items, false, originalBytes, totalItems)
  if (utf8Bytes(JSON.stringify({ ok: true, result: fullPayload })).length <= SEARCH_RESULT_MAX_UTF8_BYTES) {
    return { ok: true, result: fullPayload }
  }

  const chosen: ProjectedSearchItem[] = []
  let truncated = false
  for (const item of items) {
    const fullCandidate = [...chosen, item]
    if (fitsSearchPayload(fullCandidate, true, originalBytes, totalItems)) {
      chosen.push(item)
      continue
    }
    const shortened = fitSearchItem(item, chosen, originalBytes, totalItems)
    if (shortened === undefined) {
      truncated = true
      break
    }
    chosen.push(shortened)
    truncated = true
    break
  }
  if (chosen.length === 0) return searchResultTooLarge()

  const payload = searchPayload(chosen, truncated || chosen.length !== items.length, originalBytes, totalItems)
  if (utf8Bytes(JSON.stringify({ ok: true, result: payload })).length > SEARCH_RESULT_MAX_UTF8_BYTES) {
    return searchResultTooLarge()
  }
  return { ok: true, result: payload }
}

/** Project one raw explore package to the closed, bounded model-facing DTO. */
export function projectExploreToolResult(value: XFeedInsightPackage | XFeedRunToolResult): XFeedRunToolResult {
  if (isRunToolFailure(value)) return value
  if (typeof value.title !== 'string' || typeof value.body !== 'string' || !isStringArray(value.urls)) {
    return { ok: false, code: 'invalid-tool-result', message: 'X explore result has an invalid shape.' }
  }
  const original = { title: value.title, body: value.body, urls: value.urls }
  const originalBytes = utf8Bytes(JSON.stringify(original)).length
  const fullPayload = explorePayload(original.title, original.body, original.urls, false, originalBytes)
  if (utf8Bytes(JSON.stringify({ ok: true, result: fullPayload })).length <= EXPLORE_RESULT_MAX_UTF8_BYTES) {
    return { ok: true, result: fullPayload }
  }

  let low = 0
  let high = utf8Bytes(original.body).length
  let best: string | undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const body = truncateUtf8(original.body, middle)
    const candidate = explorePayload(original.title, body, original.urls, true, originalBytes)
    if (utf8Bytes(JSON.stringify({ ok: true, result: candidate })).length <= EXPLORE_RESULT_MAX_UTF8_BYTES) {
      best = body
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (best === undefined) return exploreResultTooLarge()
  return {
    ok: true,
    result: explorePayload(original.title, best, original.urls, true, originalBytes),
  }
}

export function projectThemeToolResult(value: XFeedInsightPackage | XFeedRunToolResult, requestedTheme: string): XFeedRunToolResult {
  if (isRunToolFailure(value)) return boundedToolFailure(value)
  if (typeof requestedTheme !== 'string' || typeof value !== 'object' || value === null) {
    return invalidToolResult()
  }
  return { ok: true, theme: requestedTheme }
}

export function projectPrepareToolResult(value: XFeedInsightPackage | XFeedRunToolResult, urlCount: number): XFeedRunToolResult {
  if (isRunToolFailure(value)) return boundedToolFailure(value)
  if (!Number.isInteger(urlCount) || urlCount < 0 || typeof value !== 'object' || value === null) {
    return invalidToolResult()
  }
  return { ok: true, prepared: true, urlCount }
}

function isRunToolFailure(value: XFeedInsightPackage | XFeedRunToolResult): value is XFeedRunToolFailure {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function invalidToolResult(): XFeedRunToolFailure {
  return { ok: false, code: 'invalid-tool-result', message: 'Tool returned an invalid result.' }
}

function boundedToolFailure(value: XFeedRunToolFailure): XFeedRunToolFailure {
  const code = value.code.trim()
  if (code.length === 0) return invalidToolResult()
  const message = typeof value.message === 'string' ? truncateUtf8(value.message, 256) : ''
  return { ok: false, code, message }
}

function explorePayload(
  title: string,
  body: string,
  urls: readonly string[],
  truncated: boolean,
  originalBytes: number,
): Record<string, unknown> {
  const retainedBytes = utf8Bytes(JSON.stringify({ title, body, urls })).length
  return { title, body, urls, truncated, originalBytes, retainedBytes }
}

function projectSearchItem(value: unknown): ProjectedSearchItem | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.url !== 'string' || typeof raw.text !== 'string') return undefined
  const item: Record<string, string | number> = { id: raw.id, url: raw.url, text: raw.text }
  for (const key of SEARCH_ITEM_KEYS.slice(3)) {
    const field = raw[key]
    if (typeof field === 'string' || (typeof field === 'number' && Number.isFinite(field))) item[key] = field
  }
  return item as ProjectedSearchItem
}

function searchPayload(
  items: readonly ProjectedSearchItem[],
  truncated: boolean,
  originalBytes: number,
  totalItems: number,
): Record<string, unknown> {
  const retainedBytes = utf8Bytes(JSON.stringify({ items })).length
  return {
    items,
    truncated,
    originalBytes,
    retainedBytes,
    totalItems,
    returnedItems: items.length,
  }
}

function fitsSearchPayload(
  items: readonly ProjectedSearchItem[],
  truncated: boolean,
  originalBytes: number,
  totalItems: number,
): boolean {
  const payload = searchPayload(items, truncated, originalBytes, totalItems)
  return utf8Bytes(JSON.stringify({ ok: true, result: payload })).length <= SEARCH_RESULT_MAX_UTF8_BYTES
}

function fitSearchItem(
  item: ProjectedSearchItem,
  prefix: readonly ProjectedSearchItem[],
  originalBytes: number,
  totalItems: number,
): ProjectedSearchItem | undefined {
  let low = 0
  let high = utf8Bytes(item.text).length
  let best: ProjectedSearchItem | undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = { ...item, text: truncateUtf8(item.text, middle) }
    if (fitsSearchPayload([...prefix, candidate], true, originalBytes, totalItems)) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value).length <= maxBytes) return value
  let bytes = 0
  let result = ''
  for (const character of value) {
    const size = utf8Bytes(character).length
    if (bytes + size > maxBytes) break
    result += character
    bytes += size
  }
  return result
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function searchResultTooLarge(): XFeedRunToolFailure {
  return {
    ok: false,
    code: 'tool-result-too-large',
    message: 'X search result cannot fit the 4000-byte model-result bound.',
  }
}

function exploreResultTooLarge(): XFeedRunToolFailure {
  return {
    ok: false,
    code: 'tool-result-too-large',
    message: 'X explore result cannot fit the 2000-byte model-result bound.',
  }
}

export interface XFeedRunToolPort {
  searchTopic(topic: string, signal?: AbortSignal): Promise<XFeedInsightPackage | XFeedRunToolResult>
  exploreCandidate(candidateId: string, signal?: AbortSignal): Promise<XFeedInsightPackage | XFeedRunToolResult>
  setTheme(theme: string, signal?: AbortSignal): Promise<XFeedInsightPackage | XFeedRunToolResult>
  prepareDelivery(text: string, urls: readonly string[], signal?: AbortSignal): Promise<XFeedPreparedArtifact | XFeedRunToolResult>
}

const searchParameters: JsonSchemaNode = {
  type: 'object',
  properties: { topic: { type: 'string' } },
  required: ['topic'],
  additionalProperties: false,
}

const candidateParameters: JsonSchemaNode = {
  type: 'object',
  properties: { candidateId: { type: 'string' } },
  required: ['candidateId'],
  additionalProperties: false,
}

const themeParameters: JsonSchemaNode = {
  type: 'object',
  properties: { theme: { type: 'string' } },
  required: ['theme'],
  additionalProperties: false,
}

const prepareParameters: JsonSchemaNode = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    urls: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'urls'],
  additionalProperties: false,
}

const resultSchema: JsonSchemaNode = {
  type: 'object',
  additionalProperties: true,
}

function renderResult(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

function asFailure(error: unknown): XFeedRunToolFailure {
  const candidate = error as { code?: unknown; message?: unknown }
  return {
    ok: false,
    code: typeof candidate.code === 'string' ? candidate.code : 'run-failed',
    message: candidate.message instanceof Error
      ? candidate.message.message
      : typeof candidate.message === 'string' ? candidate.message : String(error),
  }
}

function strictTool(
  name: string,
  description: string,
  parameters: JsonSchemaNode,
  execute: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<XFeedRunToolResult>,
): ToolDefinition {
  return {
    name,
    description,
    parameters: parameters as Record<string, unknown>,
    output: { schema: resultSchema, render: renderResult },
    async execute(args: unknown, exec: ToolRunContext): Promise<XFeedRunToolResult> {
      const violations = validateJsonSchemaValue(parameters, args, '')
      if (violations.length > 0) throw new ToolArgsError(violations)
      return execute(args as Record<string, unknown>, exec)
    },
  }
}

/** Create the exact model-visible tools for a single prepared X run. */
export function createXFeedRunTools(port: XFeedRunToolPort): ToolDefinition[] {
  return [
    strictTool(
      'x_feed_search_topic',
      'Search one topic already present in this run capability state.',
      searchParameters,
      async (args, exec) => {
        try {
          return projectSearchToolResult(await port.searchTopic(args.topic as string, exec.signal))
        } catch (error) {
          return asFailure(error)
        }
      },
    ),
    strictTool(
      'x_feed_explore_candidate',
      'Explore one current candidate already present in this run capability state.',
      candidateParameters,
      async (args, exec) => {
        try {
          return projectExploreToolResult(await port.exploreCandidate(args.candidateId as string, exec.signal))
        } catch (error) {
          return asFailure(error)
        }
      },
    ),
    strictTool(
      'x_feed_set_run_theme',
      'Record the selected theme for this run from its current topic allowlist.',
      themeParameters,
      async (args, exec) => {
        try {
          return projectThemeToolResult(await port.setTheme(args.theme as string, exec.signal), args.theme as string)
        } catch (error) {
          return projectThemeToolResult(asFailure(error), args.theme as string)
        }
      },
    ),
    strictTool(
      'x_feed_prepare_delivery',
      'Validate and prepare the final Rich Markdown artifact and its current-run URLs. This never sends Telegram and never marks shown.',
      prepareParameters,
      async (args, exec) => {
        try {
          return projectPrepareToolResult(await port.prepareDelivery(
            args.text as string,
            args.urls as readonly string[],
            exec.signal,
          ), (args.urls as readonly string[]).length)
        } catch (error) {
          return projectPrepareToolResult(asFailure(error), (args.urls as readonly string[]).length)
        }
      },
    ),
  ]
}
