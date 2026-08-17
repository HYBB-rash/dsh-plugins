import { canonicalizeUrl } from './canonical-url.ts'

export type ExplorationState = 'active' | 'dismissed'
export type ExplorationOperation = 'keep' | 'dismiss' | 'update'
export type ExplorationSignal = 'explicit_interest' | 'explicit_disinterest' | 'assistant_judgment'
export interface ExplorationItem { id: string; state: ExplorationState; revision: number; canonicalUrl?: string; sourceUrl?: string; title: string; hook?: string; currentFinding: string; nextQuestion?: string; citations: string[]; lastSignal: ExplorationSignal; createdAt: string; updatedAt: string }
export interface ExplorationEventV1 { schemaVersion: 1; eventId: string; occurredAt: string; operation: ExplorationOperation; signal: ExplorationSignal; item: ExplorationItem }
export interface Integrity { status: 'ok' | 'degraded'; skippedLines: number; skippedEvents: number; trailingPartial: boolean }
export interface FoldResult { itemsById: ReadonlyMap<string, ExplorationItem>; integrity: Integrity }
export type RecordFailureCode = 'invalid_input' | 'evidence_required' | 'invalid_signal' | 'invalid_transition' | 'not_found' | 'ambiguous_target' | 'target_conflict'
export interface RecordInput { operation: ExplorationOperation; itemId?: string; sourceUrl?: string; title: string; hook?: string; currentFinding: string; nextQuestion?: string; citations?: string[]; signal: ExplorationSignal }
export type Candidate = Pick<ExplorationItem, 'id' | 'title' | 'state' | 'canonicalUrl'>
export type PreparedRecord = { ok: true; created: boolean; item: ExplorationItem; operation: ExplorationOperation; signal: ExplorationSignal } | { ok: false; code: RecordFailureCode; message: string; candidates?: Candidate[] }

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX = { title: 200, hook: 1_000, finding: 4_000, question: 1_000 }
const count = (value: string): number => Array.from(value).length
const text = (value: unknown, max: number): string | undefined => typeof value === 'string' && count(value.trim()) <= max ? value.trim() || undefined : undefined
export const normalizeTitle = (value: string): string => value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
function signalAllowed(operation: ExplorationOperation, signal: ExplorationSignal): boolean { return signal === 'explicit_interest' ? operation === 'keep' : signal === 'explicit_disinterest' ? operation === 'dismiss' : true }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function validItem(value: unknown): value is ExplorationItem {
  if (!isObject(value)) return false
  const item = value as Partial<ExplorationItem>
  if (typeof item.id !== 'string' || !UUID_V4.test(item.id) || !Number.isInteger(item.revision) || item.revision === undefined || item.revision < 1 || (item.state !== 'active' && item.state !== 'dismissed') || (item.lastSignal !== 'explicit_interest' && item.lastSignal !== 'explicit_disinterest' && item.lastSignal !== 'assistant_judgment')) return false
  if (text(item.title, MAX.title) === undefined || text(item.currentFinding, MAX.finding) === undefined || !Array.isArray(item.citations) || item.citations.length > 8 || item.citations.some(value => typeof value !== 'string' || canonicalizeUrl(value) === undefined)) return false
  if (item.canonicalUrl !== undefined && (typeof item.canonicalUrl !== 'string' || canonicalizeUrl(item.canonicalUrl) !== item.canonicalUrl)) return false
  if (item.sourceUrl !== undefined && (typeof item.sourceUrl !== 'string' || canonicalizeUrl(item.sourceUrl) !== item.sourceUrl)) return false
  if (item.state === 'active' && (text(item.hook, MAX.hook) === undefined || text(item.nextQuestion, MAX.question) === undefined || item.citations.length === 0)) return false
  return typeof item.createdAt === 'string' && typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.createdAt)) && Number.isFinite(Date.parse(item.updatedAt))
}
function eventMatches(value: unknown, previous: ExplorationItem | undefined): value is ExplorationEventV1 {
  if (!isObject(value)) return false
  const event = value as Partial<ExplorationEventV1>
  if (event.schemaVersion !== 1 || typeof event.eventId !== 'string' || !UUID_V4.test(event.eventId) || (event.operation !== 'keep' && event.operation !== 'dismiss' && event.operation !== 'update') || (event.signal !== 'explicit_interest' && event.signal !== 'explicit_disinterest' && event.signal !== 'assistant_judgment') || !signalAllowed(event.operation, event.signal) || !validItem(event.item) || event.item.lastSignal !== event.signal || typeof event.occurredAt !== 'string' || !Number.isFinite(Date.parse(event.occurredAt))) return false
  if (previous === undefined) {
    return event.item.revision === 1
      && (event.operation === 'keep' && event.item.state === 'active'
        || event.operation === 'dismiss' && event.item.state === 'dismissed')
  }
  if (event.item.revision !== previous.revision + 1 || event.item.createdAt !== previous.createdAt || Date.parse(event.item.updatedAt) < Date.parse(previous.updatedAt)) return false
  if (previous.state === 'active') {
    return (event.operation === 'keep' || event.operation === 'update') ? event.item.state === 'active' : event.operation === 'dismiss' && event.item.state === 'dismissed'
  }
  return event.operation === 'keep' && event.item.state === 'active' || event.operation === 'dismiss' && event.item.state === 'dismissed'
}
export function foldEvents(lines: readonly string[], trailingPartial = false): FoldResult {
  const items = new Map<string, ExplorationItem>(); const eventIds = new Set<string>(); let skippedLines = 0; let skippedEvents = 0
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > 65_536) { skippedLines++; continue }
    let event: unknown
    try { event = JSON.parse(line) } catch { skippedLines++; continue }
    const eventId = isObject(event) && typeof event.eventId === 'string' ? event.eventId : undefined
    if (eventId !== undefined && eventIds.has(eventId)) { skippedEvents++; continue }
    const itemId = isObject(event) && isObject(event.item) && typeof event.item.id === 'string' ? event.item.id : undefined
    if (!eventMatches(event, itemId === undefined ? undefined : items.get(itemId))) { skippedEvents++; continue }
    eventIds.add(event.eventId)
    items.set(event.item.id, { ...event.item, citations: [...event.item.citations] })
  }
  const degraded = skippedLines > 0 || skippedEvents > 0 || trailingPartial
  return { itemsById: items, integrity: { status: degraded ? 'degraded' : 'ok', skippedLines, skippedEvents, trailingPartial } }
}
function candidates(items: Iterable<ExplorationItem>): Candidate[] { return [...items].slice(0, 5).map(({ id, title, state, canonicalUrl }) => ({ ...(canonicalUrl === undefined ? {} : { canonicalUrl }), id, title, state })) }
export function prepareRecord(itemsById: ReadonlyMap<string, ExplorationItem>, input: RecordInput, now: string, nextUuid: () => string): PreparedRecord {
  if (!['keep', 'dismiss', 'update'].includes(input.operation) || !['explicit_interest', 'explicit_disinterest', 'assistant_judgment'].includes(input.signal)) return { ok: false, code: 'invalid_input', message: 'operation 或 signal 无效' }
  if (!signalAllowed(input.operation, input.signal)) return { ok: false, code: 'invalid_signal', message: 'signal 与 operation 不匹配' }
  const title = text(input.title, MAX.title); const finding = text(input.currentFinding, MAX.finding); const hook = input.hook === undefined ? undefined : text(input.hook, MAX.hook); const nextQuestion = input.nextQuestion === undefined ? undefined : text(input.nextQuestion, MAX.question)
  if (title === undefined || finding === undefined || (input.hook !== undefined && hook === undefined) || (input.nextQuestion !== undefined && nextQuestion === undefined)) return { ok: false, code: 'invalid_input', message: '文本字段为空或超出上限' }
  const rawCitations = input.citations ?? []; if (!Array.isArray(rawCitations) || rawCitations.length > 8) return { ok: false, code: 'invalid_input', message: 'citations 超出上限' }
  const citations: string[] = []; for (const raw of rawCitations) { const value = canonicalizeUrl(raw); if (value === undefined) return { ok: false, code: 'invalid_input', message: 'citation 必须是 HTTP(S) URL' }; if (!citations.includes(value)) citations.push(value) }
  const canonicalUrl = input.sourceUrl === undefined ? undefined : canonicalizeUrl(input.sourceUrl); if (input.sourceUrl !== undefined && canonicalUrl === undefined) return { ok: false, code: 'invalid_input', message: 'sourceUrl 必须是有界 HTTP(S) URL' }; if (input.itemId !== undefined && !UUID_V4.test(input.itemId)) return { ok: false, code: 'invalid_input', message: 'itemId 必须是小写 UUID v4' }
  let target: ExplorationItem | undefined
  if (input.itemId !== undefined) { target = itemsById.get(input.itemId); if (target === undefined) return { ok: false, code: 'not_found', message: '未找到 itemId' }; if (canonicalUrl !== undefined) { const conflicts = [...itemsById.values()].filter(item => item.canonicalUrl === canonicalUrl && item.id !== target!.id); if (conflicts.length > 0) return { ok: false, code: 'target_conflict', message: 'sourceUrl 指向另一个条目', candidates: candidates(conflicts) } } } else if (canonicalUrl !== undefined) { const matches = [...itemsById.values()].filter(item => item.canonicalUrl === canonicalUrl); if (matches.length > 1) return { ok: false, code: 'ambiguous_target', message: 'sourceUrl 匹配多个条目', candidates: candidates(matches) }; target = matches[0] } else { const matches = [...itemsById.values()].filter(item => normalizeTitle(item.title) === normalizeTitle(title)); if (matches.length > 1) return { ok: false, code: 'ambiguous_target', message: 'title 匹配多个条目', candidates: candidates(matches) }; target = matches[0] }
  if (target === undefined && input.operation === 'update') return { ok: false, code: 'not_found', message: 'update 需要已有条目' }; if (target?.state === 'dismissed' && input.operation === 'update') return { ok: false, code: 'invalid_transition', message: 'dismissed 条目必须 keep 才能恢复' }
  const state: ExplorationState = input.operation === 'dismiss' ? 'dismissed' : 'active'; if (state === 'active' && (hook === undefined || nextQuestion === undefined || citations.length === 0)) return { ok: false, code: 'evidence_required', message: 'active 条目需要 hook、nextQuestion 和 citation' }
  const id = target?.id ?? nextUuid(); if (!UUID_V4.test(id)) throw new Error('UUID seam returned non-v4 UUID')
  const item: ExplorationItem = { id, state, revision: (target?.revision ?? 0) + 1, ...(canonicalUrl === undefined ? target?.canonicalUrl === undefined ? {} : { canonicalUrl: target.canonicalUrl } : { canonicalUrl }), ...(canonicalUrl === undefined ? target?.sourceUrl === undefined ? {} : { sourceUrl: target.sourceUrl } : { sourceUrl: canonicalUrl }), title, ...(hook === undefined ? {} : { hook }), currentFinding: finding, ...(nextQuestion === undefined ? {} : { nextQuestion }), citations, lastSignal: input.signal, createdAt: target?.createdAt ?? now, updatedAt: now }
  return { ok: true, created: target === undefined, item, operation: input.operation, signal: input.signal }
}
