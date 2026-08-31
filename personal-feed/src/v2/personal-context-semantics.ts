export interface PersonalContextSpan {
  readonly startUtf16: number
  readonly endUtf16: number
}

export interface PersonalContextProtectedSpans {
  readonly subject: readonly PersonalContextSpan[]
  readonly polarity: readonly PersonalContextSpan[]
  readonly conditions: readonly PersonalContextSpan[]
  readonly modality: readonly PersonalContextSpan[]
  readonly attribution: readonly PersonalContextSpan[]
  readonly temporal: readonly PersonalContextSpan[]
  readonly applicability: readonly PersonalContextSpan[]
}

export interface PersonalContextAttitude {
  readonly speaker: 'user' | 'other' | 'ambiguous'
  readonly polarity: 'affirmed' | 'denied'
  readonly modality: 'committed' | 'uncertain' | 'hypothetical'
  readonly attribution: 'own_statement' | 'reported_statement' | 'mere_mention'
  readonly temporal: 'current' | 'future' | 'past' | 'unspecified'
  readonly qualification: 'unqualified' | 'conditioned' | 'scope_limited'
}

export interface PersonalContextInterestProposal {
  readonly lane: 'long_term_interest'
  readonly stance: 'include' | 'exclude'
  readonly focusSpan: PersonalContextSpan
  readonly protectedSpans: PersonalContextProtectedSpans
  readonly attitude: PersonalContextAttitude
  readonly operation: PersonalContextRevisionOperation
  readonly targetFactIds: readonly string[]
}

export interface PersonalContextKnowledgeProposal {
  readonly lane: 'existing_knowledge'
  readonly epistemic: 'asserted' | 'uncertain'
  readonly focusSpan: PersonalContextSpan
  readonly protectedSpans: PersonalContextProtectedSpans
  readonly attitude: PersonalContextAttitude
  readonly operation: PersonalContextRevisionOperation
  readonly targetFactIds: readonly string[]
}

export type PersonalContextFactProposal = PersonalContextInterestProposal | PersonalContextKnowledgeProposal

export type PersonalContextRevisionOperation = 'assert' | 'confirm' | 'correct' | 'replace' | 'retract'

export type PersonalContextNoFactReason =
  | 'not_personal_fact'
  | 'insufficient_long_term_signal'
  | 'object_feedback_without_long_term_scope'
  | 'not_concrete_proposition'
  | 'reported_or_mentioned'
  | 'hypothetical_only'

export interface PersonalContextUseAuthorization {
  readonly policyId: 'personal-feed-direct-telegram-v1'
  readonly purpose: 'personal_feed_context'
  readonly sourceKind: 'telegram_inbound'
}

export const PERSONAL_CONTEXT_USE_AUTHORIZATION: PersonalContextUseAuthorization = Object.freeze({
  policyId: 'personal-feed-direct-telegram-v1',
  purpose: 'personal_feed_context',
  sourceKind: 'telegram_inbound',
})

export interface PersonalContextClassifierInput {
  readonly sourceKey: string
  readonly rawText: string
  readonly useAuthorization: PersonalContextUseAuthorization
  readonly activeFacts: readonly PersonalContextActiveFact[]
}

export interface PersonalContextCanonicalInterestFact {
  readonly lane: 'long_term_interest'
  readonly stance: 'include' | 'exclude'
  readonly attitude: PersonalContextAttitude
}

export interface PersonalContextCanonicalKnowledgeFact {
  readonly lane: 'existing_knowledge'
  readonly epistemic: 'asserted' | 'uncertain'
  readonly attitude: PersonalContextAttitude
}

export type PersonalContextCanonicalFact =
  | PersonalContextCanonicalInterestFact
  | PersonalContextCanonicalKnowledgeFact

export interface PersonalContextActiveFact {
  readonly factId: string
  readonly fact: PersonalContextTerminalFact
  readonly basisRevisionIds: readonly string[]
}

export interface PersonalContextCanonicalRevision {
  readonly operation: PersonalContextRevisionOperation
  readonly targetFacts: readonly PersonalContextActiveFact[]
  readonly priorActiveFacts: readonly PersonalContextActiveFact[]
}

export interface PersonalContextEntailmentTarget {
  readonly focusSpanWithinEvidence: PersonalContextSpan
  readonly exactFocusText: string
  readonly protectedSpansWithinEvidence: PersonalContextProtectedSpans
}

export interface PersonalContextEntailmentInput {
  readonly fullRawText: string
  readonly evidenceSpan: PersonalContextSpan
  readonly exactEvidenceText: string
  readonly target: PersonalContextEntailmentTarget
  readonly canonicalFact: PersonalContextCanonicalFact
  readonly revision: PersonalContextCanonicalRevision
}

export interface PersonalContextNoFactInput {
  readonly fullRawText: string
  readonly proposedReason: PersonalContextNoFactReason
  readonly useAuthorization: PersonalContextUseAuthorization
}

export interface PersonalContextSemanticPorts {
  readonly classifier: (input: PersonalContextClassifierInput) => unknown | Promise<unknown>
  readonly entailmentValidator: (input: PersonalContextEntailmentInput) => unknown | Promise<unknown>
  readonly noFactValidator: (input: PersonalContextNoFactInput) => unknown | Promise<unknown>
}

export interface PersonalContextTerminalEvidence {
  readonly sourceKey: string
  readonly evidenceSpan: PersonalContextSpan
  readonly exactEvidenceText: string
  readonly focusSpanWithinEvidence: PersonalContextSpan
  readonly protectedSpansWithinEvidence: PersonalContextProtectedSpans
  readonly attitude: PersonalContextAttitude
}

export interface PersonalContextTerminalInterestFact {
  readonly lane: 'long_term_interest'
  readonly stance: 'include' | 'exclude'
  readonly evidence: PersonalContextTerminalEvidence
  readonly useAuthorization: PersonalContextUseAuthorization
}

export interface PersonalContextTerminalKnowledgeFact {
  readonly lane: 'existing_knowledge'
  readonly epistemic: 'asserted' | 'uncertain'
  readonly evidence: PersonalContextTerminalEvidence
  readonly useAuthorization: PersonalContextUseAuthorization
}

export type PersonalContextTerminalFact =
  | PersonalContextTerminalInterestFact
  | PersonalContextTerminalKnowledgeFact

export type PersonalContextTerminalDisposition =
  | {
      readonly schemaVersion: 2
      readonly status: 'applied'
      readonly changes: readonly PersonalContextTerminalChange[]
    }
  | {
      readonly schemaVersion: 2
      readonly status: 'ignored'
      readonly reason: PersonalContextNoFactReason
    }

export interface PersonalContextTerminalChange {
  readonly operation: PersonalContextRevisionOperation
  readonly targetFactIds: readonly string[]
  readonly fact: PersonalContextTerminalFact
  readonly validationInputDigest: string
}

type ParsedClassifierOutput =
  | { readonly kind: 'facts'; readonly facts: readonly PersonalContextFactProposal[] }
  | { readonly kind: 'no_fact'; readonly reason: PersonalContextNoFactReason }

export interface PreparedPersonalContextFact {
  readonly canonicalFact: PersonalContextCanonicalFact
  readonly validatorInput: PersonalContextEntailmentInput
  readonly terminalFact: PersonalContextTerminalFact
}

const PROTECTED_KEYS = [
  'subject',
  'polarity',
  'conditions',
  'modality',
  'attribution',
  'temporal',
  'applicability',
] as const

type ProtectedKey = (typeof PROTECTED_KEYS)[number]

const NO_FACT_REASONS = new Set<PersonalContextNoFactReason>([
  'not_personal_fact',
  'insufficient_long_term_signal',
  'object_feedback_without_long_term_scope',
  'not_concrete_proposition',
  'reported_or_mentioned',
  'hypothetical_only',
])

const MARKERS: readonly {
  readonly text: string
  readonly categories: readonly ProtectedKey[]
  readonly attitude?: Partial<PersonalContextAttitude>
}[] = [
  { text: '别人说', categories: ['attribution'], attitude: { speaker: 'other', attribution: 'reported_statement' } },
  { text: '只是提及', categories: ['attribution'], attitude: { attribution: 'mere_mention' } },
  { text: '不再', categories: ['polarity'], attitude: { polarity: 'denied' } },
  { text: '不要', categories: ['polarity'], attitude: { polarity: 'denied' } },
  { text: '不是', categories: ['polarity'], attitude: { polarity: 'denied' } },
  { text: '但是', categories: ['polarity'] },
  { text: '而是', categories: ['polarity'] },
  { text: '如果', categories: ['conditions'], attitude: { qualification: 'conditioned' } },
  { text: '除非', categories: ['conditions'], attitude: { qualification: 'conditioned' } },
  { text: '只在', categories: ['conditions', 'applicability'], attitude: { qualification: 'conditioned' } },
  { text: '仅在', categories: ['conditions', 'applicability'], attitude: { qualification: 'conditioned' } },
  { text: '他说', categories: ['attribution'], attitude: { speaker: 'other', attribution: 'reported_statement' } },
  { text: '她说', categories: ['attribution'], attitude: { speaker: 'other', attribution: 'reported_statement' } },
  { text: '听说', categories: ['attribution'], attitude: { attribution: 'reported_statement' } },
  { text: '也许', categories: ['modality'], attitude: { modality: 'uncertain' } },
  { text: '可能', categories: ['modality'], attitude: { modality: 'uncertain' } },
  { text: '或许', categories: ['modality'], attitude: { modality: 'uncertain' } },
  { text: '以后', categories: ['temporal'], attitude: { temporal: 'future' } },
  { text: '之前', categories: ['temporal'], attitude: { temporal: 'past' } },
  { text: '目前', categories: ['temporal'], attitude: { temporal: 'current' } },
  { text: '长期', categories: ['temporal'] },
  { text: '其实', categories: ['polarity'] },
  { text: '但', categories: ['polarity'] },
  { text: '没', categories: ['polarity'], attitude: { polarity: 'denied' } },
  { text: '不', categories: ['polarity'], attitude: { polarity: 'denied' } },
  { text: '只', categories: ['applicability'], attitude: { qualification: 'scope_limited' } },
]

export function parseClassifierOutput(value: unknown, rawText: string): ParsedClassifierOutput | undefined {
  if (!isRecord(value)) return undefined
  if (hasExactlyKeys(value, ['kind', 'facts']) && value.kind === 'facts' && Array.isArray(value.facts) && value.facts.length > 0) {
    const facts: PersonalContextFactProposal[] = []
    for (const fact of value.facts) {
      const parsed = parseFactProposal(fact, rawText)
      if (parsed === undefined) return undefined
      facts.push(parsed)
    }
    return { kind: 'facts', facts }
  }
  if (hasExactlyKeys(value, ['kind', 'reason']) && value.kind === 'no_fact' && isNoFactReason(value.reason)) {
    return { kind: 'no_fact', reason: value.reason }
  }
  return undefined
}

export function parseEntailmentApproval(value: unknown): boolean {
  return isRecord(value)
    && hasExactlyKeys(value, ['kind'])
    && value.kind === 'target_and_revision_confirmed'
}

export function parseNoFactApproval(value: unknown): boolean {
  return isRecord(value)
    && hasExactlyKeys(value, ['kind'])
    && value.kind === 'confirmed_no_fact'
}

export function prepareFact(
  proposal: PersonalContextFactProposal,
  fullRawText: string,
  sourceKey: string,
  revision: PersonalContextCanonicalRevision,
): PreparedPersonalContextFact | undefined {
  if (!passesMechanicalGuard(proposal, fullRawText)) return undefined
  const allSpans = [proposal.focusSpan, ...PROTECTED_KEYS.flatMap(key => proposal.protectedSpans[key])]
  const hullStart = Math.min(...allSpans.map(span => span.startUtf16))
  const hullEnd = Math.max(...allSpans.map(span => span.endUtf16))
  const evidenceSpan = { startUtf16: hullStart, endUtf16: hullEnd }
  const exactEvidenceText = fullRawText.slice(hullStart, hullEnd)
  const focusSpanWithinEvidence = relativeSpan(proposal.focusSpan, hullStart)
  const protectedSpansWithinEvidence = mapProtectedSpans(
    proposal.protectedSpans,
    span => relativeSpan(span, hullStart),
  )
  const target: PersonalContextEntailmentTarget = {
    focusSpanWithinEvidence,
    exactFocusText: exactEvidenceText.slice(
      focusSpanWithinEvidence.startUtf16,
      focusSpanWithinEvidence.endUtf16,
    ),
    protectedSpansWithinEvidence,
  }
  const canonicalFact: PersonalContextCanonicalFact = proposal.lane === 'long_term_interest'
    ? { lane: proposal.lane, stance: proposal.stance, attitude: proposal.attitude }
    : { lane: proposal.lane, epistemic: proposal.epistemic, attitude: proposal.attitude }
  const evidence: PersonalContextTerminalEvidence = {
    sourceKey,
    evidenceSpan,
    exactEvidenceText,
    focusSpanWithinEvidence,
    protectedSpansWithinEvidence,
    attitude: proposal.attitude,
  }
  const terminalFact: PersonalContextTerminalFact = proposal.lane === 'long_term_interest'
    ? { lane: proposal.lane, stance: proposal.stance, evidence, useAuthorization: PERSONAL_CONTEXT_USE_AUTHORIZATION }
    : { lane: proposal.lane, epistemic: proposal.epistemic, evidence, useAuthorization: PERSONAL_CONTEXT_USE_AUTHORIZATION }
  return {
    canonicalFact,
    validatorInput: { fullRawText, evidenceSpan, exactEvidenceText, target, canonicalFact, revision },
    terminalFact,
  }
}

export function parseTerminalDisposition(value: unknown): PersonalContextTerminalDisposition | undefined {
  if (!isRecord(value) || value.schemaVersion !== 2) return undefined
  if (hasExactlyKeys(value, ['schemaVersion', 'status', 'reason']) && value.status === 'ignored' && isNoFactReason(value.reason)) {
    return { schemaVersion: 2, status: 'ignored', reason: value.reason }
  }
  if (!hasExactlyKeys(value, ['schemaVersion', 'status', 'changes']) || value.status !== 'applied' || !Array.isArray(value.changes) || value.changes.length === 0) {
    return undefined
  }
  const changes: PersonalContextTerminalChange[] = []
  for (const change of value.changes) {
    if (!isRecord(change) || !hasExactlyKeys(change, ['operation', 'targetFactIds', 'fact', 'validationInputDigest'])) return undefined
    const operation = parseOperation(change.operation)
    const targetFactIds = parseTargetFactIds(change.targetFactIds, operation)
    const fact = parseTerminalFact(change.fact)
    if (operation === undefined || targetFactIds === undefined || fact === undefined
      || typeof change.validationInputDigest !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(change.validationInputDigest)) return undefined
    changes.push({ operation, targetFactIds, fact, validationInputDigest: change.validationInputDigest })
  }
  return { schemaVersion: 2, status: 'applied', changes }
}

function parseFactProposal(value: unknown, rawText: string): PersonalContextFactProposal | undefined {
  if (!isRecord(value)) return undefined
  const common = parseFactCommon(value, rawText)
  if (common === undefined) return undefined
  if (value.lane === 'long_term_interest'
    && hasExactlyKeys(value, ['lane', 'stance', 'focusSpan', 'protectedSpans', 'attitude', 'operation', 'targetFactIds'])
    && isOneOf(value.stance, ['include', 'exclude'])) {
    const operation = parseOperation(value.operation)
    const targetFactIds = parseTargetFactIds(value.targetFactIds, operation)
    if (operation === undefined || targetFactIds === undefined) return undefined
    return {
      lane: value.lane,
      stance: value.stance,
      focusSpan: common.focusSpan,
      protectedSpans: common.protectedSpans,
      attitude: common.attitude,
      operation,
      targetFactIds,
    }
  }
  if (value.lane === 'existing_knowledge'
    && hasExactlyKeys(value, ['lane', 'epistemic', 'focusSpan', 'protectedSpans', 'attitude', 'operation', 'targetFactIds'])
    && isOneOf(value.epistemic, ['asserted', 'uncertain'])) {
    const operation = parseOperation(value.operation)
    const targetFactIds = parseTargetFactIds(value.targetFactIds, operation)
    if (operation === undefined || targetFactIds === undefined) return undefined
    return {
      lane: value.lane,
      epistemic: value.epistemic,
      focusSpan: common.focusSpan,
      protectedSpans: common.protectedSpans,
      attitude: common.attitude,
      operation,
      targetFactIds,
    }
  }
  return undefined
}

function parseOperation(value: unknown): PersonalContextRevisionOperation | undefined {
  return isOneOf(value, ['assert', 'confirm', 'correct', 'replace', 'retract']) ? value : undefined
}

function parseTargetFactIds(
  value: unknown,
  operation: PersonalContextRevisionOperation | undefined,
): readonly string[] | undefined {
  if (operation === undefined || !Array.isArray(value)) return undefined
  if (value.some(id => typeof id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(id))) return undefined
  const ids = value as string[]
  if (new Set(ids).size !== ids.length) return undefined
  if ((operation === 'assert') !== (ids.length === 0)) return undefined
  if (operation === 'confirm' && ids.length !== 1) return undefined
  return [...ids]
}

function parseFactCommon(value: Record<string, unknown>, rawText: string): {
  readonly focusSpan: PersonalContextSpan
  readonly protectedSpans: PersonalContextProtectedSpans
  readonly attitude: PersonalContextAttitude
} | undefined {
  const focusSpan = parseSpan(value.focusSpan, rawText)
  const protectedSpans = parseProtectedSpans(value.protectedSpans, rawText)
  const attitude = parseAttitude(value.attitude)
  if (focusSpan === undefined || protectedSpans === undefined || attitude === undefined) return undefined
  const focusText = rawText.slice(focusSpan.startUtf16, focusSpan.endUtf16)
  if (focusText.trim() === '' || isOnlyPunctuation(focusText)) return undefined
  return { focusSpan, protectedSpans, attitude }
}

function parseProtectedSpans(value: unknown, rawText: string): PersonalContextProtectedSpans | undefined {
  if (!isRecord(value) || !hasExactlyKeys(value, PROTECTED_KEYS)) return undefined
  const parsed = {} as Record<ProtectedKey, readonly PersonalContextSpan[]>
  for (const key of PROTECTED_KEYS) {
    const spans = value[key]
    if (!Array.isArray(spans)) return undefined
    const parsedSpans: PersonalContextSpan[] = []
    for (const span of spans) {
      const parsedSpan = parseSpan(span, rawText)
      if (parsedSpan === undefined) return undefined
      parsedSpans.push(parsedSpan)
    }
    parsed[key] = parsedSpans
  }
  return parsed as unknown as PersonalContextProtectedSpans
}

function parseAttitude(value: unknown): PersonalContextAttitude | undefined {
  if (!isRecord(value) || !hasExactlyKeys(value, [
    'speaker', 'polarity', 'modality', 'attribution', 'temporal', 'qualification',
  ])) return undefined
  if (!isOneOf(value.speaker, ['user', 'other', 'ambiguous'])
    || !isOneOf(value.polarity, ['affirmed', 'denied'])
    || !isOneOf(value.modality, ['committed', 'uncertain', 'hypothetical'])
    || !isOneOf(value.attribution, ['own_statement', 'reported_statement', 'mere_mention'])
    || !isOneOf(value.temporal, ['current', 'future', 'past', 'unspecified'])
    || !isOneOf(value.qualification, ['unqualified', 'conditioned', 'scope_limited'])) return undefined
  return {
    speaker: value.speaker,
    polarity: value.polarity,
    modality: value.modality,
    attribution: value.attribution,
    temporal: value.temporal,
    qualification: value.qualification,
  }
}

function parseSpan(value: unknown, rawText: string): PersonalContextSpan | undefined {
  if (!isRecord(value) || !hasExactlyKeys(value, ['startUtf16', 'endUtf16'])) return undefined
  if (!Number.isSafeInteger(value.startUtf16) || !Number.isSafeInteger(value.endUtf16)) return undefined
  const startUtf16 = value.startUtf16 as number
  const endUtf16 = value.endUtf16 as number
  if (startUtf16 < 0 || endUtf16 <= startUtf16 || endUtf16 > rawText.length) return undefined
  if (!isUtf16Boundary(rawText, startUtf16) || !isUtf16Boundary(rawText, endUtf16)) return undefined
  return { startUtf16, endUtf16 }
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
}

function passesMechanicalGuard(proposal: PersonalContextFactProposal, rawText: string): boolean {
  const segment = semanticSegment(rawText, proposal.focusSpan)
  for (const key of PROTECTED_KEYS) {
    if (proposal.protectedSpans[key].some(span => span.startUtf16 < segment.startUtf16 || span.endUtf16 > segment.endUtf16)) {
      return false
    }
  }
  if (!markersAreProtectedAndConsistent(rawText, segment, proposal)) return false
  const attitude = proposal.attitude
  if (attitude.speaker !== 'user' || attitude.attribution !== 'own_statement') return false
  if (proposal.lane === 'long_term_interest') {
    if (proposal.stance === 'include') {
      return attitude.polarity === 'affirmed'
        && attitude.modality === 'committed'
        && (attitude.temporal === 'current' || attitude.temporal === 'future' || attitude.temporal === 'unspecified')
    }
    return attitude.polarity === 'denied'
      && attitude.modality === 'committed'
      && attitude.temporal !== 'past'
  }
  if (proposal.epistemic === 'asserted') {
    return attitude.modality === 'committed'
      && attitude.temporal !== 'future'
  }
  return attitude.polarity === 'affirmed'
    && attitude.modality === 'uncertain'
    && attitude.temporal !== 'future'
}

function markersAreProtectedAndConsistent(
  rawText: string,
  segment: PersonalContextSpan,
  proposal: PersonalContextFactProposal,
): boolean {
  if (proposal.protectedSpans.subject.some(span => rawText.slice(span.startUtf16, span.endUtf16) !== '我')) {
    return false
  }
  const occupied = new Set<number>()
  for (const marker of MARKERS) {
    let from = segment.startUtf16
    while (from < segment.endUtf16) {
      const start = rawText.indexOf(marker.text, from)
      if (start < 0 || start >= segment.endUtf16) break
      const end = start + marker.text.length
      from = start + Math.max(marker.text.length, 1)
      if (end > segment.endUtf16) continue
      const positions = Array.from({ length: marker.text.length }, (_, index) => start + index)
      if (positions.some(position => occupied.has(position))) continue
      for (const category of marker.categories) {
        if (!proposal.protectedSpans[category].some(span => span.startUtf16 <= start && span.endUtf16 >= end)) return false
      }
      if (marker.attitude !== undefined && !attitudeMatches(proposal.attitude, marker.attitude)) return false
      positions.forEach(position => occupied.add(position))
    }
  }
  const subjectMatches = findAll(rawText, '我', segment)
  if (subjectMatches.some(span => !proposal.protectedSpans.subject.some(candidate => (
    candidate.startUtf16 === span.startUtf16 && candidate.endUtf16 === span.endUtf16
  )))) return false
  return true
}

function semanticSegment(rawText: string, focus: PersonalContextSpan): PersonalContextSpan {
  const separators = /[。！？；;\n]|[，,](?:而且|并且|同时)/gu
  let startUtf16 = 0
  let endUtf16 = rawText.length
  for (const match of rawText.matchAll(separators)) {
    const matchStart = match.index
    const matchEnd = matchStart + match[0].length
    if (matchEnd <= focus.startUtf16) startUtf16 = matchEnd
    else if (matchStart >= focus.endUtf16) {
      endUtf16 = matchStart
      break
    }
  }
  return { startUtf16, endUtf16 }
}

function parseTerminalFact(value: unknown): PersonalContextTerminalFact | undefined {
  if (!isRecord(value)) return undefined
  const common = parseTerminalFactCommon(value)
  if (common === undefined) return undefined
  if (value.lane === 'long_term_interest'
    && hasExactlyKeys(value, ['lane', 'stance', 'evidence', 'useAuthorization'])
    && isOneOf(value.stance, ['include', 'exclude'])) {
    return { lane: value.lane, stance: value.stance, ...common }
  }
  if (value.lane === 'existing_knowledge'
    && hasExactlyKeys(value, ['lane', 'epistemic', 'evidence', 'useAuthorization'])
    && isOneOf(value.epistemic, ['asserted', 'uncertain'])) {
    return { lane: value.lane, epistemic: value.epistemic, ...common }
  }
  return undefined
}

function parseTerminalFactCommon(value: Record<string, unknown>): {
  readonly evidence: PersonalContextTerminalEvidence
  readonly useAuthorization: PersonalContextUseAuthorization
} | undefined {
  if (!isUseAuthorization(value.useAuthorization) || !isRecord(value.evidence) || !hasExactlyKeys(value.evidence, [
    'sourceKey', 'evidenceSpan', 'exactEvidenceText', 'focusSpanWithinEvidence',
    'protectedSpansWithinEvidence', 'attitude',
  ])) return undefined
  const evidence = value.evidence
  if (typeof evidence.sourceKey !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(evidence.sourceKey)
    || typeof evidence.exactEvidenceText !== 'string' || evidence.exactEvidenceText.length === 0) return undefined
  const evidenceSpan = parseAbsoluteEvidenceSpan(evidence.evidenceSpan, evidence.exactEvidenceText.length)
  const focusSpanWithinEvidence = parseSpan(evidence.focusSpanWithinEvidence, evidence.exactEvidenceText)
  const protectedSpansWithinEvidence = parseProtectedSpans(evidence.protectedSpansWithinEvidence, evidence.exactEvidenceText)
  const attitude = parseAttitude(evidence.attitude)
  if (evidenceSpan === undefined || evidenceSpan.endUtf16 - evidenceSpan.startUtf16 !== evidence.exactEvidenceText.length
    || focusSpanWithinEvidence === undefined || protectedSpansWithinEvidence === undefined || attitude === undefined) return undefined
  return {
    evidence: {
      sourceKey: evidence.sourceKey,
      evidenceSpan,
      exactEvidenceText: evidence.exactEvidenceText,
      focusSpanWithinEvidence,
      protectedSpansWithinEvidence,
      attitude,
    },
    useAuthorization: PERSONAL_CONTEXT_USE_AUTHORIZATION,
  }
}

function parseAbsoluteEvidenceSpan(value: unknown, evidenceLength: number): PersonalContextSpan | undefined {
  if (!isRecord(value) || !hasExactlyKeys(value, ['startUtf16', 'endUtf16'])) return undefined
  if (!Number.isSafeInteger(value.startUtf16) || !Number.isSafeInteger(value.endUtf16)) return undefined
  const startUtf16 = value.startUtf16 as number
  const endUtf16 = value.endUtf16 as number
  if (startUtf16 < 0 || endUtf16 <= startUtf16 || endUtf16 - startUtf16 !== evidenceLength) return undefined
  return { startUtf16, endUtf16 }
}

function isUseAuthorization(value: unknown): value is PersonalContextUseAuthorization {
  return isRecord(value)
    && hasExactlyKeys(value, ['policyId', 'purpose', 'sourceKind'])
    && value.policyId === PERSONAL_CONTEXT_USE_AUTHORIZATION.policyId
    && value.purpose === PERSONAL_CONTEXT_USE_AUTHORIZATION.purpose
    && value.sourceKind === PERSONAL_CONTEXT_USE_AUTHORIZATION.sourceKind
}

function relativeSpan(span: PersonalContextSpan, start: number): PersonalContextSpan {
  return { startUtf16: span.startUtf16 - start, endUtf16: span.endUtf16 - start }
}

function mapProtectedSpans(
  value: PersonalContextProtectedSpans,
  map: (span: PersonalContextSpan) => PersonalContextSpan,
): PersonalContextProtectedSpans {
  return {
    subject: value.subject.map(map),
    polarity: value.polarity.map(map),
    conditions: value.conditions.map(map),
    modality: value.modality.map(map),
    attribution: value.attribution.map(map),
    temporal: value.temporal.map(map),
    applicability: value.applicability.map(map),
  }
}

function findAll(rawText: string, needle: string, within: PersonalContextSpan): PersonalContextSpan[] {
  const found: PersonalContextSpan[] = []
  let from = within.startUtf16
  while (from < within.endUtf16) {
    const startUtf16 = rawText.indexOf(needle, from)
    if (startUtf16 < 0 || startUtf16 >= within.endUtf16) break
    found.push({ startUtf16, endUtf16: startUtf16 + needle.length })
    from = startUtf16 + needle.length
  }
  return found
}

function attitudeMatches(attitude: PersonalContextAttitude, expected: Partial<PersonalContextAttitude>): boolean {
  return Object.entries(expected).every(([key, value]) => attitude[key as keyof PersonalContextAttitude] === value)
}

function isOnlyPunctuation(value: string): boolean {
  return /^[\p{P}\p{S}\s]+$/u.test(value)
}

function isNoFactReason(value: unknown): value is PersonalContextNoFactReason {
  return typeof value === 'string' && NO_FACT_REASONS.has(value as PersonalContextNoFactReason)
}

function isOneOf<const T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === 'string' && choices.includes(value as T)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactlyKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some(key => typeof key !== 'string')) return false
  const keys = ownKeys as string[]
  return keys.length === required.length
    && required.every(key => Object.prototype.hasOwnProperty.call(value, key))
}
