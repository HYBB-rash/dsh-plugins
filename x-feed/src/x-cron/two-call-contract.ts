/** Strict, side-effect-free DTO boundaries for the planner and composer calls. */

export const PLANNER_MAX_SELECTED_CANDIDATES = 20
export const COMPOSER_TITLE_MAX_UTF8_BYTES = 160
export const COMPOSER_SUMMARY_MAX_UTF8_BYTES = 400

export type PlannerExploration =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'search'; topicId: string }>
  | Readonly<{ kind: 'explore'; candidateId: string }>

export interface PlannerDto {
  readonly selectedCandidateIds: readonly string[]
  readonly themeId: string
  readonly exploration: PlannerExploration
}

export type ComposerSectionKind = 'highlight' | 'timeline' | 'wander' | 'focus' | 'source'

export interface ComposerItem {
  readonly itemId: string
  readonly summary: string
}

export interface ComposerSection {
  readonly kind: ComposerSectionKind
  readonly items: readonly ComposerItem[]
}

export interface ComposerDto {
  readonly title: string
  readonly sections: readonly ComposerSection[]
}

export interface PlannerValidationContext {
  readonly candidateIds: readonly string[]
  readonly allowedTopicIds: readonly string[]
}

export interface ComposerValidationContext {
  readonly itemIds: readonly string[]
}

export type TwoCallContractCode =
  | 'invalid-json'
  | 'invalid-allowlist'
  | 'not-object'
  | 'missing-key'
  | 'unknown-key'
  | 'invalid-selected-candidate-ids'
  | 'selected-candidates-empty'
  | 'selected-candidates-limit'
  | 'duplicate-selected-candidate-id'
  | 'unknown-selected-candidate-id'
  | 'invalid-theme-id'
  | 'unknown-theme-id'
  | 'invalid-exploration'
  | 'unknown-exploration-topic'
  | 'unknown-exploration-candidate'
  | 'invalid-composer-title'
  | 'composer-title-too-large'
  | 'forbidden-composer-content'
  | 'invalid-sections'
  | 'empty-sections'
  | 'invalid-section'
  | 'unknown-section-kind'
  | 'duplicate-section-kind'
  | 'invalid-items'
  | 'empty-items'
  | 'invalid-item'
  | 'unknown-item-id'
  | 'duplicate-item-id'
  | 'invalid-summary'
  | 'summary-too-large'

export interface TwoCallContractFailure {
  readonly ok: false
  readonly code: TwoCallContractCode
  readonly message: string
}

export interface TwoCallContractSuccess<T> {
  readonly ok: true
  readonly value: Readonly<T>
}

export type TwoCallContractResult<T> = TwoCallContractSuccess<T> | TwoCallContractFailure

type ParsedJsonResult =
  | Readonly<{ ok: true; value: unknown }>
  | TwoCallContractFailure

const PLANNER_KEYS = ['selectedCandidateIds', 'themeId', 'exploration'] as const
const COMPOSER_KEYS = ['title', 'sections'] as const
const EXPLORATION_KINDS = ['none', 'search', 'explore'] as const
const SECTION_KEYS = ['kind', 'items'] as const
const SECTION_KINDS = ['highlight', 'timeline', 'wander', 'focus', 'source'] as const
const ITEM_KEYS = ['itemId', 'summary'] as const

type PlainRecord = Record<PropertyKey, unknown>

function failure(code: TwoCallContractCode, message: string): TwoCallContractFailure {
  return Object.freeze({ ok: false, code, message })
}

function success<T extends object>(value: T): TwoCallContractSuccess<T> {
  return Object.freeze({ ok: true, value: deepFreeze(value) }) as TwoCallContractSuccess<T>
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value as Readonly<T>
}

function isRecord(value: unknown): value is PlainRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value: PlainRecord, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function hasExactlyKeys(value: PlainRecord, expected: readonly string[]): 'missing' | 'unknown' | undefined {
  if (expected.some(key => !hasOwn(value, key))) return 'missing'
  const expectedSet = new Set<PropertyKey>(expected)
  if (Reflect.ownKeys(value).some(key => !expectedSet.has(key))) return 'unknown'
  return undefined
}

function validAllowlist(values: readonly string[]): boolean {
  return Array.isArray(values) && values.every(value => typeof value === 'string' && value.length > 0)
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function containsUrlOrMarkdown(value: string): boolean {
  return /(?:https?:\/\/|ftp:\/\/|www\.)/iu.test(value)
    || /!?(?:\[[^\]]*\]\([^)]*\)|`{1,3}|\*\*|__|(?:^|\n)[ \t]{0,3}#{1,6}[ \t]+|(?:^|\n)[ \t]{0,3}[*+-][ \t]+)/mu.test(value)
}

export function isValidComposerPlainText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string'
    && value.trim() !== ''
    && utf8Bytes(value) <= maxBytes
    && !containsUrlOrMarkdown(value)
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function validateAllowlist(context: PlannerValidationContext | ComposerValidationContext): boolean {
  if ('candidateIds' in context) return validAllowlist(context.candidateIds) && validAllowlist(context.allowedTopicIds)
  return validAllowlist(context.itemIds)
}

function topLevelKeys(value: unknown, expected: readonly string[]): TwoCallContractFailure | undefined {
  if (!isRecord(value)) return failure('not-object', 'DTO must be an object')
  const result = hasExactlyKeys(value, expected)
  if (result === 'missing') return failure('missing-key', 'DTO is missing a required key')
  if (result === 'unknown') return failure('unknown-key', 'DTO contains an unknown key')
  return undefined
}

function nestedKeys(value: PlainRecord, expected: readonly string[], code: TwoCallContractCode, message: string): TwoCallContractFailure | undefined {
  const result = hasExactlyKeys(value, expected)
  return result === undefined ? undefined : failure(code, message)
}

function parseJson(json: string): ParsedJsonResult {
  if (typeof json !== 'string') return failure('invalid-json', 'JSON input must be a string')
  try {
    return { ok: true, value: JSON.parse(json) as unknown }
  } catch {
    return failure('invalid-json', 'JSON input is invalid')
  }
}

/** Validate an already parsed planner DTO without changing it. */
export function validatePlannerDto(value: unknown, context: PlannerValidationContext): TwoCallContractResult<PlannerDto> {
  if (!validateAllowlist(context)) return failure('invalid-allowlist', 'planner allowlist is invalid')
  const topFailure = topLevelKeys(value, PLANNER_KEYS)
  if (topFailure !== undefined) return topFailure
  const object = value as PlainRecord
  const candidateIds = object.selectedCandidateIds
  if (!Array.isArray(candidateIds)) return failure('invalid-selected-candidate-ids', 'selected candidate IDs must be an array')
  if (candidateIds.length === 0) return failure('selected-candidates-empty', 'at least one candidate must be selected')
  if (candidateIds.length > PLANNER_MAX_SELECTED_CANDIDATES) return failure('selected-candidates-limit', 'too many candidates are selected')

  const candidateSet = new Set(context.candidateIds)
  const seenCandidates = new Set<string>()
  for (const candidateId of candidateIds) {
    if (typeof candidateId !== 'string' || candidateId.length === 0) return failure('invalid-selected-candidate-ids', 'selected candidate IDs must be non-empty strings')
    if (seenCandidates.has(candidateId)) return failure('duplicate-selected-candidate-id', 'selected candidate IDs must be unique')
    seenCandidates.add(candidateId)
    if (!candidateSet.has(candidateId)) return failure('unknown-selected-candidate-id', 'a selected candidate is not in the allowlist')
  }

  const themeId = object.themeId
  if (typeof themeId !== 'string' || themeId.length === 0) return failure('invalid-theme-id', 'theme ID must be a non-empty string')
  if (!context.allowedTopicIds.includes(themeId)) return failure('unknown-theme-id', 'theme ID is not in the allowlist')

  const exploration = object.exploration
  if (!isRecord(exploration)) return failure('invalid-exploration', 'exploration must be a strict union value')
  const kind = exploration.kind
  if (!EXPLORATION_KINDS.includes(kind as typeof EXPLORATION_KINDS[number])) return failure('invalid-exploration', 'exploration kind is invalid')
  if (kind === 'none') {
    const nestedFailure = nestedKeys(exploration, ['kind'], 'invalid-exploration', 'none exploration has unexpected fields')
    if (nestedFailure !== undefined) return nestedFailure
  } else if (kind === 'search') {
    const nestedFailure = nestedKeys(exploration, ['kind', 'topicId'], 'invalid-exploration', 'search exploration has unexpected fields')
    if (nestedFailure !== undefined) return nestedFailure
    if (typeof exploration.topicId !== 'string' || !context.allowedTopicIds.includes(exploration.topicId)) {
      return failure('unknown-exploration-topic', 'exploration topic is not in the allowlist')
    }
  } else {
    const nestedFailure = nestedKeys(exploration, ['kind', 'candidateId'], 'invalid-exploration', 'explore exploration has unexpected fields')
    if (nestedFailure !== undefined) return nestedFailure
    if (typeof exploration.candidateId !== 'string' || !candidateSet.has(exploration.candidateId)) {
      return failure('unknown-exploration-candidate', 'exploration candidate is not in the allowlist')
    }
  }

  const copiedExploration = kind === 'none'
    ? { kind: 'none' as const }
    : kind === 'search'
      ? { kind: 'search' as const, topicId: exploration.topicId as string }
      : { kind: 'explore' as const, candidateId: exploration.candidateId as string }
  return success({
    selectedCandidateIds: [...candidateIds] as string[],
    themeId,
    exploration: copiedExploration,
  })
}

/** Parse JSON and validate it as a planner DTO. */
export function parsePlannerDto(json: string, context: PlannerValidationContext): TwoCallContractResult<PlannerDto> {
  const parsed = parseJson(json)
  return parsed.ok ? validatePlannerDto(parsed.value, context) : parsed
}

/** Validate an already parsed composer DTO without changing it. */
export function validateComposerDto(value: unknown, context: ComposerValidationContext): TwoCallContractResult<ComposerDto> {
  if (!validateAllowlist(context)) return failure('invalid-allowlist', 'composer allowlist is invalid')
  const topFailure = topLevelKeys(value, COMPOSER_KEYS)
  if (topFailure !== undefined) return topFailure
  const object = value as PlainRecord
  const title = object.title
  if (typeof title !== 'string' || title.trim().length === 0) return failure('invalid-composer-title', 'composer title must be non-empty text')
  if (utf8Bytes(title) > COMPOSER_TITLE_MAX_UTF8_BYTES) return failure('composer-title-too-large', 'composer title exceeds its UTF-8 limit')
  if (!isValidComposerPlainText(title, COMPOSER_TITLE_MAX_UTF8_BYTES)) return failure('forbidden-composer-content', 'composer text must not contain URLs or Markdown')

  const sections = object.sections
  if (!Array.isArray(sections)) return failure('invalid-sections', 'composer sections must be an array')
  if (sections.length === 0) return failure('empty-sections', 'composer must contain at least one section')
  const itemSet = new Set(context.itemIds)
  const seenKinds = new Set<string>()
  const seenItems = new Set<string>()
  const copiedSections: ComposerSection[] = []
  for (const section of sections) {
    if (!isRecord(section)) return failure('invalid-section', 'composer section must be an exact object')
    const sectionKeysFailure = nestedKeys(section, SECTION_KEYS, 'invalid-section', 'composer section has unexpected fields')
    if (sectionKeysFailure !== undefined) return sectionKeysFailure
    const kind = section.kind
    if (!SECTION_KINDS.includes(kind as ComposerSectionKind)) return failure('unknown-section-kind', 'composer section kind is invalid')
    if (seenKinds.has(kind as string)) return failure('duplicate-section-kind', 'each composer section kind may occur at most once')
    seenKinds.add(kind as string)
    if (!Array.isArray(section.items)) return failure('invalid-items', 'composer section items must be an array')
    if (section.items.length === 0) return failure('empty-items', 'each composer section must contain at least one item')
    const copiedItems: ComposerItem[] = []
    for (const item of section.items) {
      if (!isRecord(item)) return failure('invalid-item', 'composer item must be an exact object')
      const itemKeysFailure = nestedKeys(item, ITEM_KEYS, 'invalid-item', 'composer item has unexpected fields')
      if (itemKeysFailure !== undefined) return itemKeysFailure
      const itemId = item.itemId
      if (typeof itemId !== 'string' || !itemSet.has(itemId)) return failure('unknown-item-id', 'composer item is not in the allowlist')
      if (seenItems.has(itemId)) return failure('duplicate-item-id', 'composer item IDs must be globally unique')
      seenItems.add(itemId)
      const summary = item.summary
      if (typeof summary !== 'string' || summary.trim().length === 0) return failure('invalid-summary', 'composer summary must be non-empty text')
      if (utf8Bytes(summary) > COMPOSER_SUMMARY_MAX_UTF8_BYTES) return failure('summary-too-large', 'composer summary exceeds its UTF-8 limit')
      if (!isValidComposerPlainText(summary, COMPOSER_SUMMARY_MAX_UTF8_BYTES)) return failure('forbidden-composer-content', 'composer text must not contain URLs or Markdown')
      copiedItems.push({ itemId, summary })
    }
    copiedSections.push({ kind: kind as ComposerSectionKind, items: copiedItems })
  }

  return success({ title, sections: copiedSections })
}

/** Parse JSON and validate it as a composer DTO. */
export function parseComposerDto(json: string, context: ComposerValidationContext): TwoCallContractResult<ComposerDto> {
  const parsed = parseJson(json)
  return parsed.ok ? validateComposerDto(parsed.value, context) : parsed
}
