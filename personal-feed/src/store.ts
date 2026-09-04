/**
 * X feed feedback ledger: append-only `feedback.jsonl` under the Harness
 * X data directory (§10). Each line is one immutable event; queries fold.
 *
 * Validation contract:
 * - newly appended save/unsave events must have a canonical URL; legacy
 *   topic-only rating rows remain readable for audit compatibility;
 * - X/Twitter URLs are canonicalized to `https://x.com/...` (query/fragment
 *   stripped), same rule as the Python kernel's `canonical_url`;
 * - like/dislike and save/unsave are two independent dimensions: a later
 *   like/dislike for the same URL overrides the earlier preference, a later
 *   save/unsave overrides the saved state — originals are never rewritten;
 * - only short, explicitly expressed notes are stored;
 * - appends flush/fsync; a corrupt line is skipped with a warning and never
 *   prevents the plugin (or the store) from loading.
 *
 * This is a local read-later list, not an X account operation, and not the
 * long-term canary memory.
 * @module @herman/personal-feed
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** One append-only feedback event (§10.1). */
export type XFeedbackEvent = {
  readonly schemaVersion: 1
  readonly id: string
  readonly createdAt: string
  readonly operation: 'like' | 'dislike' | 'save' | 'unsave'
  readonly canonicalUrl?: string
  readonly originalUrl?: string
  readonly title?: string
  readonly topic?: string
  readonly note?: string
}

/** Stable write error value — the model must never claim a record it didn't make. */
export type FeedbackWriteError =
  | { readonly code: 'invalid_operation'; readonly message: string }
  | { readonly code: 'rating_requires_clean_feedback'; readonly message: string }
  | { readonly code: 'missing_target'; readonly message: string }
  | { readonly code: 'write_failed'; readonly message: string }

/** Result of one recordFeedback call. */
export type FeedbackWriteResult =
  | { readonly ok: true; readonly event: XFeedbackEvent }
  | ({ readonly ok: false } & FeedbackWriteError)

/** Folded display-layer state for one URL (or one legacy topic). */
export type FoldedFeedback = {
  readonly key: string
  readonly like: boolean
  readonly saved: boolean
  readonly likedAt?: string
  readonly dislikedAt?: string
  readonly savedAt?: string
  readonly unsavedAt?: string
  readonly title?: string
  readonly note?: string
}

/** One row of the saved (read-later) list. */
export type SavedItem = {
  readonly url?: string
  readonly title?: string
  readonly savedAt: string
  readonly note?: string
}

const WRITABLE_OPERATIONS = new Set(['save', 'unsave'])

/** Resolve the default Harness X data dir under DSH_HOME. */
export function defaultStoreDir(dshHome: string): string {
  return join(dshHome, 'storages', 'dsh-x-feed')
}

/**
 * Canonicalize an X/Twitter URL for display-layer identity (§10.1): host
 * normalized to `x.com`, query and fragment stripped. Non-X URLs keep their
 * host but lose query/fragment. Unparseable values are returned with query
 * and fragment stripped.
 */
export function canonicalizeUrl(raw: string): string {
  const value = String(raw ?? '').trim()
  if (value === '') return ''
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return value.split('?', 1)[0]!.split('#', 1)[0]!.trim()
  }
  let host = parsed.hostname.toLowerCase()
  if (host === 'twitter.com' || host === 'www.twitter.com' || host === 'mobile.twitter.com') {
    host = 'x.com'
  }
  const pathname = parsed.pathname.replace(/\/+$/, '')
  const port = parsed.port === '' ? '' : `:${parsed.port}`
  return `https://${host}${port}${pathname}`
}

/** Fold key: canonical URL when present, else original URL, else topic. */
export function feedbackKey(event: Pick<XFeedbackEvent, 'canonicalUrl' | 'originalUrl' | 'topic'>): string {
  if (event.canonicalUrl !== undefined && event.canonicalUrl !== '') return event.canonicalUrl
  if (event.originalUrl !== undefined && event.originalUrl !== '') return event.originalUrl
  return `topic:${String(event.topic ?? '').trim()}`
}

/** Mutable fold accumulator (display-layer state is exposed read-only). */
type MutableFolded = {
  key: string
  like: boolean
  saved: boolean
  likedAt?: string | undefined
  dislikedAt?: string | undefined
  savedAt?: string | undefined
  unsavedAt?: string | undefined
  title?: string | undefined
  note?: string | undefined
}

/** Fold the full append-only ledger into per-key display-layer state. */
export function foldFeedback(events: readonly XFeedbackEvent[]): Map<string, FoldedFeedback> {
  const folded = new Map<string, MutableFolded>()
  for (const event of events) {
    const key = feedbackKey(event)
    let state = folded.get(key)
    if (state === undefined) {
      state = { key, like: false, saved: false }
      folded.set(key, state)
    }
    if (event.operation === 'like') {
      state.like = true
      state.likedAt = event.createdAt
      state.dislikedAt = undefined
    } else if (event.operation === 'dislike') {
      state.like = false
      state.dislikedAt = event.createdAt
      state.likedAt = undefined
    } else if (event.operation === 'save') {
      state.saved = true
      state.savedAt = event.createdAt
      state.unsavedAt = undefined
      state.title = event.title === undefined || event.title === '' ? undefined : event.title
      state.note = event.note === undefined || event.note === '' ? undefined : event.note
    } else if (event.operation === 'unsave') {
      state.saved = false
      state.unsavedAt = event.createdAt
      state.savedAt = undefined
    }
  }
  return new Map([...folded.entries()].map(([key, s]) => [key, {
    key: s.key,
    like: s.like,
    saved: s.saved,
    ...(s.likedAt === undefined ? {} : { likedAt: s.likedAt }),
    ...(s.dislikedAt === undefined ? {} : { dislikedAt: s.dislikedAt }),
    ...(s.savedAt === undefined ? {} : { savedAt: s.savedAt }),
    ...(s.unsavedAt === undefined ? {} : { unsavedAt: s.unsavedAt }),
    ...(s.title === undefined ? {} : { title: s.title }),
    ...(s.note === undefined ? {} : { note: s.note }),
  }]))
}

/** Append-only feedback store over `<dataDir>/feedback.jsonl`. */
export class XFeedbackStore {
  constructor(private readonly dataDir: string) {}

  private file(): string {
    return join(this.dataDir, 'feedback.jsonl')
  }

  /** Read every parseable event; corrupt lines are skipped (never fatal). */
  readAll(warn?: (message: string) => void): XFeedbackEvent[] {
    const file = this.file()
    if (!existsSync(file)) return []
    const events: XFeedbackEvent[] = []
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed) as XFeedbackEvent
        if (typeof parsed !== 'object' || parsed === null || parsed.operation === undefined) continue
        events.push(parsed)
      } catch {
        warn?.(`personal-feed: skipping corrupt feedback.jsonl line: ${trimmed.slice(0, 120)}`)
      }
    }
    return events
  }

  /** Append one validated, normalized save/unsave event as one durable JSONL line. */
  append(input: {
    operation: 'save' | 'unsave'
    url?: string
    title?: string
    note?: string
    now?: () => number
  }): FeedbackWriteResult {
    const operation = (input as { operation: string }).operation
    if (operation === 'like' || operation === 'dislike') {
      return {
        ok: false,
        code: 'rating_requires_clean_feedback',
        message: 'like/dislike 必须经过 Telegram clean feedback 与 TrustedFact 链，不能写入旧反馈账本',
      }
    }
    if (!WRITABLE_OPERATIONS.has(input.operation)) {
      return { ok: false, code: 'invalid_operation', message: `operation must be one of save|unsave, got "${String(input.operation)}"` }
    }
    const originalUrl = input.url !== undefined ? String(input.url).trim() : ''
    const canonical = originalUrl === '' ? '' : canonicalizeUrl(originalUrl)
    if (originalUrl === '') {
      return { ok: false, code: 'missing_target', message: '收藏必须提供 URL，才能定位收藏对象' }
    }
    const event: XFeedbackEvent = {
      schemaVersion: 1,
      id: randomUUID(),
      createdAt: new Date(input.now === undefined ? Date.now() : input.now()).toISOString(),
      operation: input.operation,
      ...(canonical === '' ? {} : { canonicalUrl: canonical }),
      ...(originalUrl === '' ? {} : { originalUrl: originalUrl }),
      ...(input.title !== undefined && String(input.title).trim() !== ''
        ? { title: String(input.title).trim() }
        : {}),
      ...(input.note !== undefined && String(input.note).trim() !== ''
        ? { note: String(input.note).trim() }
        : {}),
    }
    try {
      this.appendLine(event)
    } catch (error) {
      return {
        ok: false,
        code: 'write_failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
    return { ok: true, event }
  }

  /** Folded per-key display-layer state. */
  fold(warn?: (message: string) => void): Map<string, FoldedFeedback> {
    return foldFeedback(this.readAll(warn))
  }

  /** The saved read-later list: still-saved items, newest save first. */
  listSaved(limit = 20, warn?: (message: string) => void): SavedItem[] {
    const folded = this.fold(warn)
    const items: Array<{ savedAt: string; item: SavedItem }> = []
    for (const state of folded.values()) {
      if (!state.saved || state.savedAt === undefined) continue
      items.push({
        savedAt: state.savedAt,
        item: {
          ...(state.key.startsWith('topic:') ? {} : { url: state.key }),
          ...(state.title === undefined ? {} : { title: state.title }),
          savedAt: state.savedAt,
          ...(state.note === undefined ? {} : { note: state.note }),
        },
      })
    }
    items.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0))
    return items.slice(0, Math.max(0, limit)).map(entry => entry.item)
  }

  private appendLine(event: XFeedbackEvent): void {
    const file = this.file()
    mkdirSync(dirname(file), { recursive: true })
    const line = `${JSON.stringify(event)}\n`
    // O_APPEND plus one synchronous write preserves every existing byte and
    // serializes same-process callers without reconstructing the ledger.
    const descriptor = openSync(file, 'a', 0o600)
    try {
      const written = writeSync(descriptor, line, undefined, 'utf8')
      if (written !== Buffer.byteLength(line)) {
        throw new Error(`personal-feed: incomplete feedback append (${written}/${Buffer.byteLength(line)} bytes)`)
      }
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }
}
