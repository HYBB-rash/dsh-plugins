/**
 * Pure single-session route state: strict event decoding, replay, rendering,
 * source attribution, and bounded reducer input extraction.
 *
 * This module deliberately owns no Cordis service.  The append-only Session
 * log is the only durable authority; runtime plugins are adapters around this
 * deterministic fold.
 */

import {
  createUserMessage,
  type ContentBlock,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Standard message-source identity owned by this plugin. */
export const ROUTE_CONTEXT_SOURCE = 'context-route' as const

/** Current-route confidence. */
export type RouteStatus = 'confirmed' | 'tentative'

/** Why an earlier route is no longer current. */
export type RetiredRouteStatus = 'superseded' | 'rejected'

/** Original source kinds a detail pointer may prefer. */
export type DetailSourceKind = 'user' | 'tool'

/** Safe diagnostic categories for rejected model-produced route bodies. */
export type RouteBodyFailureCode =
  | 'invalid-json'
  | 'secret-like-output'
  | 'output-size'
  | 'source-attribution'
  | 'evolution'
  | 'schema'

/** One concise claim and the original Session events supporting it. */
export interface RouteStatement {
  readonly text: string
  readonly sourceSeqs: number[]
}

/** A confirmed or tentative route decision. */
export interface RouteDecision extends RouteStatement {
  readonly status: RouteStatus
}

/** The current route plus its reason and confidence. */
export interface CurrentRoute extends RouteStatement {
  readonly reason: string
  readonly status: RouteStatus
}

/** A route that must not silently become current again. */
export interface RetiredRoute extends RouteStatement {
  readonly reason: string
  readonly status: RetiredRouteStatus
}

/** An exact pointer into original Session history, never a copied detail. */
export interface DetailReference {
  readonly label: string
  readonly why: string
  readonly sourceSeqs: number[]
  readonly preferredSourceKinds: DetailSourceKind[]
  readonly fallbackQuery?: string
}

/** Complete current projection; every revision is a full replacement snapshot. */
export interface RouteSnapshot {
  readonly revision: number
  readonly asOfSeq: number
  readonly rootGoal: RouteStatement
  readonly successCriteria: RouteStatement[]
  readonly currentRoute: CurrentRoute
  readonly decisions: RouteDecision[]
  readonly retiredRoutes: RetiredRoute[]
  readonly currentNode: RouteStatement
  readonly nextDecision: RouteStatement | null
  readonly reviewTriggers: RouteStatement[]
  readonly detailRefs: DetailReference[]
}

/** Model-produced body before the host stamps monotonic revision metadata. */
export type RouteBody = Omit<RouteSnapshot, 'revision' | 'asOfSeq'>

/** One validated route revision before it is wrapped in a standard message. */
export interface RouteRevisionData {
  readonly version: 1
  readonly operation: 'create' | 'update'
  readonly snapshot: RouteSnapshot
}

/** Why one standard message publishes its complete route snapshot. */
export type RoutePublication = 'create' | 'update' | 'rearm'

/**
 * Structured source stored inside the upstream-standard `user/message` event.
 * `form: snapshot` declares that a later publication supersedes earlier ones.
 */
export interface RouteContextSource {
  readonly kind: typeof ROUTE_CONTEXT_SOURCE
  readonly form: 'snapshot'
  readonly version: 1
  readonly publication: RoutePublication
  readonly sessionId: string
  readonly snapshot: RouteSnapshot
  readonly sections: readonly [{ readonly name: typeof ROUTE_CONTEXT_SOURCE; readonly text: string }]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Complete, replaceable route state for one single-root Session. */
    'context-route': RouteContextSource
  }
}

/** A folded snapshot and the event that committed it. */
export interface RouteProjection {
  readonly snapshot: RouteSnapshot
  readonly eventSeq: number
}

const MAX_STATEMENT_CHARS = 600
const MAX_REASON_CHARS = 800
const MAX_QUERY_CHARS = 180
const MAX_ROUTE_JSON_CHARS = 18_000
const MAX_SUCCESS_CRITERIA = 12
const MAX_DECISIONS = 20
const MAX_RETIRED_ROUTES = 16
const MAX_REVIEW_TRIGGERS = 12
const MAX_DETAIL_REFS = 20
const MAX_SOURCE_SEQS = 12
const MIN_REDUCER_INPUT_CHARS = 32_000
const SYSTEM_PROMPT_SOURCE = '@deepseek-ai/dsh-system-prompt'

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_\-.]{10,}/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\b(?:api[ _-]?key|access[ _-]?token|password|passwd|secret|credential|密钥|密码|口令|令牌)\s*[:=]\s*["']?[^\s"',;]{8,}/i,
  /[?&](?:token|key|secret|password)=[^&#\s]{8,}/i,
]

/** Whether text resembles a credential that must never enter route state. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text))
}

/** Collapse whitespace so route snapshots stay compact and deterministic. */
function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function fail(message: string): never {
  throw new Error(`context-route: ${message}`)
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const admitted = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!admitted.has(key)) fail(`${label} has unknown key "${key}"`)
  }
  for (const key of required) {
    if (!(key in value)) fail(`${label} is missing "${key}"`)
  }
}

function boundedText(
  value: unknown,
  label: string,
  maxChars: number,
  canonicalize: boolean,
): string {
  if (typeof value !== 'string') fail(`${label} must be a string`)
  const normalized = normalizeLine(value)
  if (normalized.length === 0) fail(`${label} must not be blank`)
  if (normalized.length > maxChars) fail(`${label} exceeds ${maxChars} characters`)
  if (!canonicalize && value !== normalized) fail(`${label} is not in canonical one-line form`)
  if (containsSecret(normalized)) fail(`${label} contains secret-like material`)
  return normalized
}

function sourceSeqs(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SOURCE_SEQS) {
    return fail(`${label} must contain 1-${MAX_SOURCE_SEQS} source seqs`)
  }
  const seen = new Set<number>()
  const decoded: number[] = []
  for (const item of value) {
    if (!Number.isSafeInteger(item) || (item as number) < 0) fail(`${label} contains an invalid seq`)
    const seq = item as number
    if (seen.has(seq)) fail(`${label} contains duplicate seq ${seq}`)
    seen.add(seq)
    decoded.push(seq)
  }
  return decoded
}

function statement(value: unknown, label: string, canonicalize: boolean): RouteStatement {
  const record = objectValue(value, label)
  assertExactKeys(record, ['text', 'sourceSeqs'], [], label)
  return {
    text: boundedText(record.text, `${label}.text`, MAX_STATEMENT_CHARS, canonicalize),
    sourceSeqs: sourceSeqs(record.sourceSeqs, `${label}.sourceSeqs`),
  }
}

function currentRoute(value: unknown, canonicalize: boolean): CurrentRoute {
  const label = 'currentRoute'
  const record = objectValue(value, label)
  assertExactKeys(record, ['text', 'reason', 'status', 'sourceSeqs'], [], label)
  if (record.status !== 'confirmed' && record.status !== 'tentative') {
    fail('currentRoute.status must be "confirmed" or "tentative"')
  }
  return {
    text: boundedText(record.text, 'currentRoute.text', MAX_STATEMENT_CHARS, canonicalize),
    reason: boundedText(record.reason, 'currentRoute.reason', MAX_REASON_CHARS, canonicalize),
    status: record.status,
    sourceSeqs: sourceSeqs(record.sourceSeqs, 'currentRoute.sourceSeqs'),
  }
}

function decision(value: unknown, index: number, canonicalize: boolean): RouteDecision {
  const label = `decisions[${index}]`
  const record = objectValue(value, label)
  assertExactKeys(record, ['text', 'status', 'sourceSeqs'], [], label)
  if (record.status !== 'confirmed' && record.status !== 'tentative') {
    fail(`${label}.status must be "confirmed" or "tentative"`)
  }
  return {
    text: boundedText(record.text, `${label}.text`, MAX_STATEMENT_CHARS, canonicalize),
    status: record.status,
    sourceSeqs: sourceSeqs(record.sourceSeqs, `${label}.sourceSeqs`),
  }
}

function retiredRoute(value: unknown, index: number, canonicalize: boolean): RetiredRoute {
  const label = `retiredRoutes[${index}]`
  const record = objectValue(value, label)
  assertExactKeys(record, ['text', 'reason', 'status', 'sourceSeqs'], [], label)
  if (record.status !== 'superseded' && record.status !== 'rejected') {
    fail(`${label}.status must be "superseded" or "rejected"`)
  }
  return {
    text: boundedText(record.text, `${label}.text`, MAX_STATEMENT_CHARS, canonicalize),
    reason: boundedText(record.reason, `${label}.reason`, MAX_REASON_CHARS, canonicalize),
    status: record.status,
    sourceSeqs: sourceSeqs(record.sourceSeqs, `${label}.sourceSeqs`),
  }
}

function detailReference(value: unknown, index: number, canonicalize: boolean): DetailReference {
  const label = `detailRefs[${index}]`
  const record = objectValue(value, label)
  assertExactKeys(
    record,
    ['label', 'why', 'sourceSeqs', 'preferredSourceKinds'],
    ['fallbackQuery'],
    label,
  )
  if (!Array.isArray(record.preferredSourceKinds)
    || record.preferredSourceKinds.length === 0
    || record.preferredSourceKinds.length > 2) {
    fail(`${label}.preferredSourceKinds must contain "user" and/or "tool"`)
  }
  const preferredSourceKinds: DetailSourceKind[] = []
  for (const kind of record.preferredSourceKinds) {
    if (kind !== 'user' && kind !== 'tool') fail(`${label}.preferredSourceKinds contains an invalid kind`)
    if (preferredSourceKinds.includes(kind)) fail(`${label}.preferredSourceKinds contains duplicate kind "${kind}"`)
    preferredSourceKinds.push(kind)
  }
  return {
    label: boundedText(record.label, `${label}.label`, MAX_STATEMENT_CHARS, canonicalize),
    why: boundedText(record.why, `${label}.why`, MAX_REASON_CHARS, canonicalize),
    sourceSeqs: sourceSeqs(record.sourceSeqs, `${label}.sourceSeqs`),
    preferredSourceKinds,
    ...record.fallbackQuery === undefined ? {} : {
      fallbackQuery: boundedText(
        record.fallbackQuery,
        `${label}.fallbackQuery`,
        MAX_QUERY_CHARS,
        canonicalize,
      ),
    },
  }
}

function boundedArray<T>(
  value: unknown,
  label: string,
  maxItems: number,
  decode: (item: unknown, index: number) => T,
  minimum = 0,
): T[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maxItems) {
    fail(`${label} must contain ${minimum}-${maxItems} items`)
  }
  return value.map(decode)
}

function assertUniqueTexts(items: readonly { text: string }[], label: string): void {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.text)) fail(`${label} contains duplicate text`)
    seen.add(item.text)
  }
}

function routeBody(value: unknown, canonicalize: boolean): RouteBody {
  const record = objectValue(value, 'route body')
  assertExactKeys(record, [
    'rootGoal',
    'successCriteria',
    'currentRoute',
    'decisions',
    'retiredRoutes',
    'currentNode',
    'nextDecision',
    'reviewTriggers',
    'detailRefs',
  ], [], 'route body')
  const successCriteria = boundedArray(
    record.successCriteria,
    'successCriteria',
    MAX_SUCCESS_CRITERIA,
    (item, index) => statement(item, `successCriteria[${index}]`, canonicalize),
    1,
  )
  const decisions = boundedArray(
    record.decisions,
    'decisions',
    MAX_DECISIONS,
    (item, index) => decision(item, index, canonicalize),
  )
  const retiredRoutes = boundedArray(
    record.retiredRoutes,
    'retiredRoutes',
    MAX_RETIRED_ROUTES,
    (item, index) => retiredRoute(item, index, canonicalize),
  )
  const reviewTriggers = boundedArray(
    record.reviewTriggers,
    'reviewTriggers',
    MAX_REVIEW_TRIGGERS,
    (item, index) => statement(item, `reviewTriggers[${index}]`, canonicalize),
    1,
  )
  const detailRefs = boundedArray(
    record.detailRefs,
    'detailRefs',
    MAX_DETAIL_REFS,
    (item, index) => detailReference(item, index, canonicalize),
  )
  assertUniqueTexts(successCriteria, 'successCriteria')
  assertUniqueTexts(decisions, 'decisions')
  assertUniqueTexts(retiredRoutes, 'retiredRoutes')
  assertUniqueTexts(reviewTriggers, 'reviewTriggers')
  return {
    rootGoal: statement(record.rootGoal, 'rootGoal', canonicalize),
    successCriteria,
    currentRoute: currentRoute(record.currentRoute, canonicalize),
    decisions,
    retiredRoutes,
    currentNode: statement(record.currentNode, 'currentNode', canonicalize),
    nextDecision: record.nextDecision === null
      ? null
      : statement(record.nextDecision, 'nextDecision', canonicalize),
    reviewTriggers,
    detailRefs,
  }
}

function eventAt(events: readonly SessionEvent[], seq: number): SessionEvent {
  const event = events[seq]
  if (event === undefined || event.seq !== seq) fail(`source seq ${seq} does not exist in the preceding log`)
  return event
}

/** True only for original facts useful to route reduction. */
export function isRouteRelevantEvent(event: SessionEvent): boolean {
  if (event.type === 'user/message') return event.data.source.kind === 'user'
  return event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result'
}

/** Latest original semantic fact represented by a route snapshot. */
export function latestRouteRelevantSeq(events: readonly SessionEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && isRouteRelevantEvent(event)) return event.seq
  }
  return undefined
}

/**
 * Whether a stale route belongs to a turn that has already closed.
 *
 * A multi-step tool turn naturally accumulates assistant/tool facts between
 * pre-step checkpoints. Those facts stay in the visible working tail and must
 * not trigger a route-reducer call after every tool result. A `turn/end`
 * after the latest uncovered semantic event means the normal turn-stopping
 * update failed or the plugin was absent, so the next request must repair it.
 */
export function routeNeedsCompletedTurnRecovery(
  events: readonly SessionEvent[],
  routeAsOfSeq: number,
): boolean {
  const latest = latestRouteRelevantSeq(events)
  if (latest === undefined || latest <= routeAsOfSeq) return false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.seq <= latest) return false
    if (event.type === 'turn/end') return true
  }
  return false
}

function isDirectUserEvent(event: SessionEvent): boolean {
  return event.type === 'user/message' && event.data.source.kind === 'user'
}

function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStructuredHumanAnswer(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 1 || !Array.isArray(record.answers) || record.answers.length === 0) {
    return false
  }
  let hasAnswer = false
  for (const item of record.answers) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
    const answer = item as Record<string, unknown>
    const keys = Object.keys(answer)
    if (keys.some(key => key !== 'id' && key !== 'selected' && key !== 'custom')) return false
    if (!nonBlankString(answer.id) || !Array.isArray(answer.selected)) return false
    if (!answer.selected.every(nonBlankString)) return false
    if (answer.custom !== undefined && typeof answer.custom !== 'string') return false
    if (answer.selected.length > 0 || nonBlankString(answer.custom)) hasAnswer = true
  }
  return hasAnswer
}

/**
 * A successful ask_user_question result is the user's own UI answer even
 * though the agent loop persists it in the ordinary tool-result channel.
 * Correlation, tool identity, success, exact output shape, and non-empty human
 * content are all required; no other tool result gains confirmation authority.
 */
export function isHumanAnswerEvent(
  event: SessionEvent,
  precedingEvents: readonly SessionEvent[],
): boolean {
  if (event.type !== 'tool/result' || event.data.error !== undefined) return false
  const message = event.data.message
  if (message.source.kind !== 'tool' || message.content.length !== 1) return false
  const result = message.content[0]
  if (result?.type !== 'tool-result'
    || result.toolCallId !== message.source.callId
    || result.isError === true
    || result.content.length !== 1
    || result.content[0]?.type !== 'text') return false
  const call = precedingEvents.find(candidate => (
    candidate.seq < event.seq
    && candidate.type === 'tool/call'
    && candidate.data.callId === message.source.callId
  ))
  if (call?.type !== 'tool/call' || call.data.name !== 'ask_user_question') return false
  try {
    return isStructuredHumanAnswer(JSON.parse(result.content[0].text))
  } catch {
    return false
  }
}

function isHumanDecisionEvent(event: SessionEvent, events: readonly SessionEvent[]): boolean {
  return isDirectUserEvent(event) || isHumanAnswerEvent(event, events)
}

function isDetailSourceEvent(event: SessionEvent): DetailSourceKind | undefined {
  if (isDirectUserEvent(event)) return 'user'
  if (event.type === 'tool/result') return 'tool'
  return undefined
}

function validateStatementSources(
  item: RouteStatement,
  label: string,
  events: readonly SessionEvent[],
  asOfSeq: number,
): SessionEvent[] {
  return item.sourceSeqs.map((seq) => {
    if (seq > asOfSeq) fail(`${label} cites future seq ${seq} beyond asOfSeq ${asOfSeq}`)
    const event = eventAt(events, seq)
    if (!isRouteRelevantEvent(event)) fail(`${label} cites non-semantic seq ${seq}`)
    return event
  })
}

function assertHasDirectUserSource(
  item: RouteStatement,
  label: string,
  events: readonly SessionEvent[],
  asOfSeq: number,
): void {
  const sources = validateStatementSources(item, label, events, asOfSeq)
  if (!sources.some(event => isHumanDecisionEvent(event, events))) {
    fail(`${label} must cite a direct human user/message or verified ask_user_question answer`)
  }
}

function validateBodySources(body: RouteBody, events: readonly SessionEvent[], asOfSeq: number): void {
  assertHasDirectUserSource(body.rootGoal, 'rootGoal', events, asOfSeq)
  body.successCriteria.forEach((item, index) => {
    assertHasDirectUserSource(item, `successCriteria[${index}]`, events, asOfSeq)
  })
  if (body.currentRoute.status === 'confirmed') {
    assertHasDirectUserSource(body.currentRoute, 'currentRoute', events, asOfSeq)
  } else {
    validateStatementSources(body.currentRoute, 'currentRoute', events, asOfSeq)
  }
  body.decisions.forEach((item, index) => {
    if (item.status === 'confirmed') {
      assertHasDirectUserSource(item, `decisions[${index}]`, events, asOfSeq)
    } else {
      validateStatementSources(item, `decisions[${index}]`, events, asOfSeq)
    }
  })
  body.retiredRoutes.forEach((item, index) => {
    validateStatementSources(item, `retiredRoutes[${index}]`, events, asOfSeq)
  })
  validateStatementSources(body.currentNode, 'currentNode', events, asOfSeq)
  if (body.nextDecision !== null) {
    validateStatementSources(body.nextDecision, 'nextDecision', events, asOfSeq)
  }
  body.reviewTriggers.forEach((item, index) => {
    validateStatementSources(item, `reviewTriggers[${index}]`, events, asOfSeq)
  })
  body.detailRefs.forEach((item, index) => {
    const label = `detailRefs[${index}]`
    const sourceKinds = new Set<DetailSourceKind>()
    for (const seq of item.sourceSeqs) {
      if (seq > asOfSeq) fail(`${label} cites future seq ${seq} beyond asOfSeq ${asOfSeq}`)
      const kind = isDetailSourceEvent(eventAt(events, seq))
      if (kind === undefined) fail(`${label} must cite only original user/message or tool/result events`)
      sourceKinds.add(kind)
    }
    for (const kind of item.preferredSourceKinds) {
      if (!sourceKinds.has(kind)) fail(`${label} prefers source kind "${kind}" without citing one`)
    }
  })
}

function validateEvolution(snapshot: RouteSnapshot, previous: RouteSnapshot | undefined): void {
  const expectedRevision = (previous?.revision ?? 0) + 1
  if (snapshot.revision !== expectedRevision) {
    fail(`revision ${snapshot.revision} must be ${expectedRevision}`)
  }
  if (previous === undefined) return
  if (snapshot.asOfSeq < previous.asOfSeq) fail('asOfSeq must not move backward')

  const retainedTexts = new Set(snapshot.retiredRoutes.map(item => item.text))
  for (const retired of previous.retiredRoutes) {
    if (!retainedTexts.has(retired.text)) fail(`retired route "${retired.text}" was dropped`)
  }
  if (snapshot.currentRoute.text !== previous.currentRoute.text
    && !retainedTexts.has(previous.currentRoute.text)) {
    fail('a changed currentRoute must explicitly retire the previous current route')
  }
}

function validateSnapshot(
  snapshot: RouteSnapshot,
  previous: RouteSnapshot | undefined,
  events: readonly SessionEvent[],
): void {
  const expectedAsOf = latestRouteRelevantSeq(events)
  if (expectedAsOf === undefined) fail('a route snapshot needs at least one direct semantic event')
  if (snapshot.asOfSeq !== expectedAsOf) {
    fail(`asOfSeq ${snapshot.asOfSeq} must equal latest semantic seq ${expectedAsOf}`)
  }
  validateEvolution(snapshot, previous)
  validateBodySources(snapshot, events, snapshot.asOfSeq)
  if (JSON.stringify(snapshot).length > MAX_ROUTE_JSON_CHARS) {
    fail(`snapshot exceeds ${MAX_ROUTE_JSON_CHARS} JSON characters`)
  }
}

function decodeSnapshotValue(value: unknown): RouteSnapshot {
  const snapshotRecord = objectValue(value, 'snapshot')
  assertExactKeys(snapshotRecord, [
    'revision',
    'asOfSeq',
    'rootGoal',
    'successCriteria',
    'currentRoute',
    'decisions',
    'retiredRoutes',
    'currentNode',
    'nextDecision',
    'reviewTriggers',
    'detailRefs',
  ], [], 'snapshot')
  if (!Number.isSafeInteger(snapshotRecord.revision) || (snapshotRecord.revision as number) < 1) {
    fail('snapshot.revision must be a positive safe integer')
  }
  if (!Number.isSafeInteger(snapshotRecord.asOfSeq) || (snapshotRecord.asOfSeq as number) < 0) {
    fail('snapshot.asOfSeq must be a non-negative safe integer')
  }
  const body = routeBody({
    rootGoal: snapshotRecord.rootGoal,
    successCriteria: snapshotRecord.successCriteria,
    currentRoute: snapshotRecord.currentRoute,
    decisions: snapshotRecord.decisions,
    retiredRoutes: snapshotRecord.retiredRoutes,
    currentNode: snapshotRecord.currentNode,
    nextDecision: snapshotRecord.nextDecision,
    reviewTriggers: snapshotRecord.reviewTriggers,
    detailRefs: snapshotRecord.detailRefs,
  }, false)
  return {
    revision: snapshotRecord.revision as number,
    asOfSeq: snapshotRecord.asOfSeq as number,
    ...body,
  }
}

/** Decode and validate one host-stamped complete route revision. */
export function decodeRouteRevision(
  value: unknown,
  previous: RouteSnapshot | undefined,
  precedingEvents: readonly SessionEvent[],
): RouteRevisionData {
  const record = objectValue(value, 'route revision')
  assertExactKeys(record, ['version', 'operation', 'snapshot'], [], 'route revision')
  if (record.version !== 1) fail('route revision version must be 1')
  const expectedOperation = previous === undefined ? 'create' : 'update'
  if (record.operation !== expectedOperation) {
    fail(`route revision operation must be "${expectedOperation}"`)
  }
  const snapshot = decodeSnapshotValue(record.snapshot)
  validateSnapshot(snapshot, previous, precedingEvents)
  return { version: 1, operation: expectedOperation, snapshot }
}

/** Whether an event claims this plugin's standard message source. */
export function isRouteContextEvent(event: SessionEvent): boolean {
  return event.type === 'user/message' && event.data.source.kind === ROUTE_CONTEXT_SOURCE
}

function sameSnapshot(left: RouteSnapshot, right: RouteSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Strictly decode one plugin-owned standard message. Live invariant checks use
 * this before append; tolerant cold replay catches and ignores malformed
 * producer fields so a standard Session never becomes unopenable.
 */
export function decodeRouteMessage(
  event: SessionEvent,
  previous: RouteSnapshot | undefined,
  precedingEvents: readonly SessionEvent[],
): RouteContextSource {
  if (!isRouteContextEvent(event) || event.type !== 'user/message') {
    fail('route message must be a context-route user/message')
  }
  const record = objectValue(event.data.source, 'route message source')
  assertExactKeys(record, [
    'kind',
    'form',
    'version',
    'publication',
    'sessionId',
    'snapshot',
    'sections',
  ], [], 'route message source')
  if (record.kind !== ROUTE_CONTEXT_SOURCE) fail('route message source kind is invalid')
  if (record.form !== 'snapshot') fail('route message source form must be "snapshot"')
  if (record.version !== 1) fail('route message source version must be 1')
  if (record.publication !== 'create'
    && record.publication !== 'update'
    && record.publication !== 'rearm') {
    fail('route message publication must be "create", "update", or "rearm"')
  }
  if (typeof record.sessionId !== 'string'
    || record.sessionId.length === 0
    || record.sessionId.length > 512) {
    fail('route message sessionId must contain 1-512 characters')
  }

  let snapshot: RouteSnapshot
  if (record.publication === 'rearm') {
    snapshot = decodeSnapshotValue(record.snapshot)
    if (previous === undefined || !sameSnapshot(snapshot, previous)) {
      fail('a rearm publication must exactly repeat the latest valid route snapshot')
    }
    const latest = latestRouteRelevantSeq(precedingEvents)
    if (latest !== snapshot.asOfSeq) {
      fail(`rearm snapshot covers seq ${snapshot.asOfSeq}, latest semantic seq is ${String(latest)}`)
    }
  } else {
    snapshot = decodeRouteRevision({
      version: record.version,
      operation: record.publication,
      snapshot: record.snapshot,
    }, previous, precedingEvents).snapshot
  }

  if (!Array.isArray(record.sections) || record.sections.length !== 1) {
    fail('route message sections must contain exactly one section')
  }
  const section = objectValue(record.sections[0], 'route message section')
  assertExactKeys(section, ['name', 'text'], [], 'route message section')
  const rendered = renderRouteContext(record.sessionId, snapshot)
  if (section.name !== ROUTE_CONTEXT_SOURCE || section.text !== rendered) {
    fail('route message section does not match its structured snapshot')
  }
  const [block] = event.data.content
  if (event.data.content.length !== 1 || block?.type !== 'text') {
    fail('route message content must contain exactly one text block')
  }
  if (block.text !== renderRouteMessageContent(record.sessionId, snapshot, record.publication)) {
    fail('route message content does not match its structured snapshot')
  }
  return {
    kind: ROUTE_CONTEXT_SOURCE,
    form: 'snapshot',
    version: 1,
    publication: record.publication,
    sessionId: record.sessionId,
    snapshot,
    sections: [{ name: ROUTE_CONTEXT_SOURCE, text: rendered }],
  }
}

/** Tolerantly replay valid route publications from an append-only Session log. */
export function foldRoute(events: readonly SessionEvent[]): RouteProjection | undefined {
  let projection: RouteProjection | undefined
  const preceding: SessionEvent[] = []
  for (const event of events) {
    if (isRouteContextEvent(event)) {
      try {
        const source = decodeRouteMessage(event, projection?.snapshot, preceding)
        projection = { snapshot: source.snapshot, eventSeq: event.seq }
      } catch {
        // A resumed seed validates only the generic source envelope. Match the
        // upstream skill-catalog posture: ignore unreadable producer fields,
        // keep the last valid state, then rearm it after the bad publication.
      }
    }
    preceding.push(event)
  }
  return projection
}

/** Last event claiming this plugin source, including an unreadable publication. */
export function latestRouteContextSeq(events: readonly SessionEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && isRouteContextEvent(event)) return event.seq
  }
  return
}

/** Whether the last valid route must be put back at the current surface tail. */
export function routeNeedsRearm(
  events: readonly SessionEvent[],
  surfaceNodes: readonly number[],
): boolean {
  const projection = foldRoute(events)
  if (projection === undefined) return false
  return latestRouteContextSeq(events) !== projection.eventSeq
    || !surfaceNodes.includes(projection.eventSeq)
}

/** Reject compaction unless the latest valid route is fresh and visible. */
export function assertRouteFreshForCompaction(
  events: readonly SessionEvent[],
  surfaceNodes?: readonly number[],
): void {
  const latest = latestRouteRelevantSeq(events)
  if (latest === undefined) return
  const projection = foldRoute(events)
  if (projection === undefined) fail(`compaction is blocked: no route snapshot covers semantic seq ${latest}`)
  if (projection.snapshot.asOfSeq !== latest) {
    fail(
      `compaction is blocked: route snapshot covers seq ${projection.snapshot.asOfSeq}, latest semantic seq is ${latest}`,
    )
  }
  if (surfaceNodes !== undefined && routeNeedsRearm(events, surfaceNodes)) {
    fail('compaction is blocked: latest valid route snapshot must be visible and follow every unreadable route publication')
  }
}

function stripSingleJsonFence(raw: string): string {
  const trimmed = raw.trim()
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)
  return match?.[1]?.trim() ?? trimmed
}

/**
 * Parse model JSON, canonicalize prose, stamp monotonic host metadata, and run
 * the exact same source/evolution validation used during replay.
 */
export function parseRouteBody(
  raw: string,
  previous: RouteSnapshot | undefined,
  asOfSeq: number,
  precedingEvents: readonly SessionEvent[],
): RouteRevisionData {
  if (raw.length > MAX_ROUTE_JSON_CHARS * 3) fail('model output is too large')
  if (containsSecret(raw)) fail('model output contains secret-like material')
  let parsed: unknown
  try {
    parsed = JSON.parse(stripSingleJsonFence(raw))
  } catch {
    return fail('model output is not valid JSON')
  }
  const body = routeBody(parsed, true)
  const snapshot: RouteSnapshot = {
    revision: (previous?.revision ?? 0) + 1,
    asOfSeq,
    ...body,
  }
  validateSnapshot(snapshot, previous, precedingEvents)
  return {
    version: 1,
    operation: previous === undefined ? 'create' : 'update',
    snapshot,
  }
}

/** Map validation failures to fixed, non-secret diagnostic codes. */
export function routeBodyFailureCode(error: unknown): RouteBodyFailureCode {
  if (!(error instanceof Error) || !error.message.startsWith('context-route:')) return 'schema'
  const message = error.message
  if (message.includes('not valid JSON')) return 'invalid-json'
  if (message.includes('secret-like material')) return 'secret-like-output'
  if (message.includes('too large') || message.includes('snapshot exceeds')) return 'output-size'
  if (message.includes('source seq')
    || message.includes('cites future seq')
    || message.includes('must cite')
    || message.includes('prefers source kind')) return 'source-attribution'
  if (message.includes('revision')
    || message.includes('asOfSeq')
    || message.includes('was dropped')
    || message.includes('must explicitly retire')) return 'evolution'
  return 'schema'
}

function refs(item: RouteStatement): string {
  return item.sourceSeqs.join(', ')
}

function statementLines(items: readonly RouteStatement[], empty: string): string[] {
  return items.length === 0
    ? [`- ${empty}`]
    : items.map(item => `- ${item.text}（来源 seq：${refs(item)}）`)
}

/** Render only decision-bearing state plus exact detail pointers. */
export function renderRouteContext(sessionId: string, snapshot: RouteSnapshot): string {
  const confirmed = snapshot.decisions.filter(item => item.status === 'confirmed')
  const tentative = snapshot.decisions.filter(item => item.status === 'tentative')
  const retired = snapshot.retiredRoutes.map(item => (
    `- [${item.status}] ${item.text}；原因：${item.reason}（来源 seq：${refs(item)}）`
  ))
  const details = snapshot.detailRefs.map((item) => {
    const fallback = item.fallbackQuery === undefined ? '' : `；后备查询：${item.fallbackQuery}`
    return `- ${item.label}：${item.why}；原始 seq：${item.sourceSeqs.join(', ')}`
      + `；优先来源：${item.preferredSourceKinds.join(' / ')}${fallback}`
  })
  return [
    '## 当前会话路线（内部权威投影）',
    '',
    `Session：${sessionId}；revision：${snapshot.revision}；已处理到原始语义 seq：${snapshot.asOfSeq}。`,
    '这是一会话一根问题的当前路线。较新的直接用户消息或已验证的人机选择优先于本投影；已替代或已拒绝路线不得恢复为默认。',
    '',
    `根目标：${snapshot.rootGoal.text}（来源 seq：${refs(snapshot.rootGoal)}）`,
    '',
    '成功标准：',
    ...statementLines(snapshot.successCriteria, '尚未明确'),
    '',
    `当前路线：[${snapshot.currentRoute.status}] ${snapshot.currentRoute.text}`,
    `路线理由：${snapshot.currentRoute.reason}（来源 seq：${refs(snapshot.currentRoute)}）`,
    '',
    '已确认决定：',
    ...statementLines(confirmed, '无'),
    '',
    '暂定判断：',
    ...statementLines(tentative, '无'),
    '',
    '已替代 / 已拒绝路线：',
    ...(retired.length === 0 ? ['- 无'] : retired),
    '',
    `当前节点：${snapshot.currentNode.text}（来源 seq：${refs(snapshot.currentNode)}）`,
    `下一项决定：${snapshot.nextDecision === null
      ? '无；按当前节点继续'
      : `${snapshot.nextDecision.text}（来源 seq：${refs(snapshot.nextDecision)}）`}`,
    '',
    '重审条件：',
    ...statementLines(snapshot.reviewTriggers, '无'),
    '',
    '细节索引（正文不常驻上下文）：',
    ...(details.length === 0 ? ['- 无'] : details),
    '',
    `需要精确细节时，先对当前 Session ${sessionId} 用 session_event_read 按上述 seq 读取原始事件；`
      + '只有没有精确 seq 时才用 session_event_search 和后备查询词。不要把压缩摘要当作原始事实。',
  ].join('\n')
}

/** Canonical model-facing frame for one complete replaceable route snapshot. */
export function renderRouteMessageContent(
  sessionId: string,
  snapshot: RouteSnapshot,
  publication: RoutePublication,
): string {
  const account = publication === 'create'
    ? '这是当前 Session 的第一份完整路线快照。'
    : publication === 'update'
      ? '这是当前 Session 的完整路线快照，替换本 Session 中所有更早的路线快照；不要继续采用旧路线。'
      : '先前的最新路线快照已被压缩移出当前上下文或被畸形来源遮挡；这是同一份有效快照的重新发布，仍替换所有更早路线快照。'
  return [
    '<system-reminder>',
    account,
    '',
    renderRouteContext(sessionId, snapshot),
    '</system-reminder>',
  ].join('\n')
}

function createRouteMessage(
  sessionId: string,
  snapshot: RouteSnapshot,
  publication: RoutePublication,
): UserMessage {
  const rendered = renderRouteContext(sessionId, snapshot)
  return createUserMessage({
    content: [{ type: 'text', text: renderRouteMessageContent(sessionId, snapshot, publication) }],
    source: {
      kind: ROUTE_CONTEXT_SOURCE,
      form: 'snapshot',
      version: 1,
      publication,
      sessionId,
      snapshot,
      sections: [{ name: ROUTE_CONTEXT_SOURCE, text: rendered }],
    },
  })
}

/** Wrap a newly validated route revision in an upstream-standard durable message. */
export function createRouteRevisionMessage(
  sessionId: string,
  revision: RouteRevisionData,
): UserMessage {
  return createRouteMessage(sessionId, revision.snapshot, revision.operation)
}

/** Re-publish the exact latest valid snapshot without incrementing its revision. */
export function createRouteRearmMessage(sessionId: string, snapshot: RouteSnapshot): UserMessage {
  return createRouteMessage(sessionId, snapshot, 'rearm')
}

/**
 * First-request guard before a durable route revision exists. It prevents an
 * ordinary agent from inventing a second external authority merely to persist
 * its route; explicit user requests for files, TODOs, or Goals still win.
 */
export function renderRouteBootstrapContext(sessionId: string): string {
  return [
    '## 当前会话路线管理（内部政策）',
    '',
    `Session：${sessionId}。本 Session 只处理一个根问题；根问题结束后应新开 Session。`,
    '路线状态由本插件写入带结构化来源的标准 Session 消息，原始 Session 日志是唯一持久权威。',
    '若当前请求已有“当前会话路线”完整快照，以最新一份为准；尚无快照时，以当前直接用户消息为准，正常完成用户请求。',
    '不要仅为了保存、续接或压缩本 Session 的路线而创建外部路线文件、TODO、记忆文件或 Goal；用户明确要求这些交付物时除外。',
  ].join('\n')
}

function blockText(block: ContentBlock): string[] {
  if (block.type === 'text') return [block.text]
  if (block.type === 'tool-call') return [`[requested tool ${block.name}]`]
  if (block.type === 'tool-result') return block.content.flatMap(blockText)
  if (block.type === 'image') return ['[image omitted; retrieve the source event if needed]']
  return []
}

function boundedExcerpt(text: string, maxChars: number): string {
  const normalized = normalizeLine(text)
  if (normalized.length === 0) return '[empty text]'
  if (containsSecret(normalized)) return '[sensitive detail omitted; retrieve this source seq only if authorized]'
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`
}

interface MaterialEntry {
  readonly seq: number
  readonly source: 'user' | 'human-answer' | 'assistant' | 'tool'
  readonly text: string
}

function materialEntry(
  event: SessionEvent,
  events: readonly SessionEvent[],
): MaterialEntry | undefined {
  if (event.type === 'user/message') {
    if (event.data.source.kind !== 'user') return undefined
    return {
      seq: event.seq,
      source: 'user',
      text: boundedExcerpt(event.data.content.flatMap(blockText).join('\n'), 4_000),
    }
  }
  if (event.type === 'assistant/message') {
    return {
      seq: event.seq,
      source: 'assistant',
      text: boundedExcerpt(event.data.message.content.flatMap(blockText).join('\n'), 2_500),
    }
  }
  if (event.type === 'tool/call') {
    return { seq: event.seq, source: 'tool', text: `[tool call ${event.data.name}; arguments omitted]` }
  }
  if (event.type === 'tool/result') {
    return {
      seq: event.seq,
      source: isHumanAnswerEvent(event, events) ? 'human-answer' : 'tool',
      text: boundedExcerpt(event.data.message.content.flatMap(blockText).join('\n'), 2_500),
    }
  }
  return undefined
}

/**
 * Build bounded, source-labelled reducer input.  The first human prompt and
 * recent human corrections are favored; raw tool arguments, runtime-context
 * snapshots, compaction checkpoints, reasoning, and secrets are omitted.
 */
export function buildRouteMaterial(
  events: readonly SessionEvent[],
  previous: RouteSnapshot | undefined,
  maxChars: number,
): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < MIN_REDUCER_INPUT_CHARS) {
    fail(`max reducer input must be at least ${MIN_REDUCER_INPUT_CHARS} characters`)
  }
  const lowerBound = previous?.asOfSeq === undefined ? 0 : previous.asOfSeq + 1
  const newEntries = events
    .filter(event => event.seq >= lowerBound)
    .map(event => materialEntry(event, events))
    .filter((entry): entry is MaterialEntry => entry !== undefined)

  // On a newly installed plugin, keep the original root prompt even when a
  // long old Session must otherwise be tail-trimmed.
  const firstUser = previous === undefined
    ? events.map(event => materialEntry(event, events)).find(entry => entry?.source === 'user')
    : undefined
  const entriesBySeq = new Map<number, MaterialEntry>()
  if (firstUser !== undefined) entriesBySeq.set(firstUser.seq, firstUser)
  for (const entry of newEntries) entriesBySeq.set(entry.seq, entry)
  const entries = [...entriesBySeq.values()].sort((a, b) => a.seq - b.seq)

  const previousText = previous === undefined
    ? 'null'
    : JSON.stringify(previous)
  const prefix = `PREVIOUS_ROUTE_SNAPSHOT\n${previousText}\n\nNEW_OR_BOOTSTRAP_SOURCE_EVENTS\n`
  const formatted = entries.map(entry => `[seq ${entry.seq} ${entry.source}] ${entry.text}`)

  // Never make the newest human correction compete with older operational
  // detail for the remaining budget.  A complete previous snapshot is also
  // indivisible: truncating its JSON would make preservation/retirement rules
  // impossible to apply safely.
  const mandatory = new Set<number>()
  if (firstUser !== undefined) mandatory.add(firstUser.seq)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.source !== 'user' && entry?.source !== 'human-answer') continue
    mandatory.add(entry.seq)
    break
  }
  const latestEntry = entries.at(-1)
  if (latestEntry !== undefined) mandatory.add(latestEntry.seq)

  const chosen = new Set<number>()
  let used = prefix.length
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const line = formatted[index]
    if (entry === undefined || line === undefined || !mandatory.has(entry.seq)) continue
    chosen.add(entry.seq)
    used += line.length + 1
  }
  if (used > maxChars) {
    fail('complete prior route plus root/latest source facts exceed the reducer input budget')
  }

  // Spend whatever remains on the newest optional facts first.  Rendering is
  // restored to chronological order after selection so seq attribution stays
  // easy for the reducer to audit.
  for (let index = formatted.length - 1; index >= 0; index -= 1) {
    const line = formatted[index]
    const entry = entries[index]
    if (line === undefined || entry === undefined) continue
    if (chosen.has(entry.seq) || used + line.length + 1 > maxChars) continue
    chosen.add(entry.seq)
    used += line.length + 1
  }
  const selectedLines = entries.flatMap((entry, index) => (
    chosen.has(entry.seq) && formatted[index] !== undefined ? [formatted[index]] : []
  ))
  const result = `${prefix}${selectedLines.join('\n')}`
  if (result.length > maxChars) fail('reducer input selection exceeded its budget')
  return result
}

/** Source marker used only to identify dynamic-context snapshots in tests and extraction audits. */
export function isRuntimeContextSource(event: SessionEvent): boolean {
  return event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === SYSTEM_PROMPT_SOURCE
}
