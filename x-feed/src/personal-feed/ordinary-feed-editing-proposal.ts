import type {
  CompleteCandidateEditingDecisions,
  CrossSourceEditor,
  EditedFeedContent,
  PeriodIdentity,
  SourceCandidateReference,
} from '@herman/personal-feed'
import { CurrentRunItemRegistry } from '../x-cron/current-run-item-registry.ts'
import { renderDigest } from '../x-cron/digest-renderer.ts'
import {
  COMPOSER_SUMMARY_MAX_UTF8_BYTES,
  isValidComposerPlainText,
  validateComposerDto,
} from '../x-cron/two-call-contract.ts'
import { parseXStatusIdentity } from '../x-cron/x-status-identity.ts'
import { X_FEED_SOURCE_IDENTITY } from '../feed-scope-adapter.ts'

export type OrdinaryFeedEditingProposalEditor = Pick<CrossSourceEditor, 'listAcceptedInputs'>

export interface OrdinaryFeedEditingProposalOptions {
  readonly period: PeriodIdentity
  readonly editor: OrdinaryFeedEditingProposalEditor
}

export interface OrdinaryFeedModelMaterial {
  readonly itemId: string
  readonly text: string
  readonly authorHandle: string
}

export type OrdinaryFeedModelMaterialsResult =
  | {
      readonly status: 'accepted'
      readonly value: { readonly materials: readonly OrdinaryFeedModelMaterial[] }
    }
  | { readonly status: 'failed' }

export type OrdinaryFeedEditingProposalValidationResult =
  | {
      readonly status: 'accepted'
      readonly value: {
        readonly content: EditedFeedContent
        readonly decisions: CompleteCandidateEditingDecisions
      }
    }
  | { readonly status: 'rejected'; readonly input: unknown }
  | { readonly status: 'failed'; readonly input: unknown }

export interface OrdinaryFeedEditingProposalRuntime {
  readonly readModelMaterials: () => OrdinaryFeedModelMaterialsResult
  readonly validateProposal: (input: unknown) => OrdinaryFeedEditingProposalValidationResult
}

interface CurrentMaterial {
  readonly period: PeriodIdentity
  readonly candidate: SourceCandidateReference
  readonly itemId: string
  readonly canonicalUrl: string
  readonly text: string
  readonly authorHandle: string
}

interface CurrentMaterialProjection {
  readonly materials: readonly CurrentMaterial[]
  readonly registry: CurrentRunItemRegistry
}

type ProposalDecision =
  | { readonly kind: 'selected'; readonly itemId: string }
  | { readonly kind: 'not_selected'; readonly itemId: string; readonly semanticReason: string }

interface PlainProposalItem {
  readonly itemId: unknown
  readonly summary: unknown
}

interface PlainProposalSection {
  readonly kind: unknown
  readonly items: readonly PlainProposalItem[]
}

type PlainProposalDecision =
  | { readonly itemId: unknown; readonly kind: 'selected' }
  | { readonly itemId: unknown; readonly kind: 'not_selected'; readonly semanticReason: unknown }

interface PlainProposal {
  readonly title: unknown
  readonly sections: readonly PlainProposalSection[]
  readonly decisions: readonly PlainProposalDecision[]
}

export function createOrdinaryFeedEditingProposalValidator(
  options: OrdinaryFeedEditingProposalOptions,
): OrdinaryFeedEditingProposalRuntime {
  return Object.freeze({
    readModelMaterials: (): OrdinaryFeedModelMaterialsResult => {
      const projection = readCurrentMaterials(options)
      if (projection === undefined) return { status: 'failed' }
      return deepFreeze({
        status: 'accepted',
        value: {
          materials: projection.materials.map(material => ({
            itemId: material.itemId,
            text: material.text,
            authorHandle: material.authorHandle,
          })),
        },
      })
    },
    validateProposal: (input: unknown): OrdinaryFeedEditingProposalValidationResult => {
      const projection = readCurrentMaterials(options)
      if (projection === undefined) return { status: 'failed', input }
      return validateProposal(input, projection)
    },
  })
}

function readCurrentMaterials(
  options: OrdinaryFeedEditingProposalOptions,
): CurrentMaterialProjection | undefined {
  try {
    const acceptedInputs = readPlainDataArray(options.editor.listAcceptedInputs())
    if (acceptedInputs === undefined) return undefined
    const current: CurrentMaterial[] = []
    for (const input of acceptedInputs) {
      const projected = readXMaterial(input)
      if (projected === undefined) return undefined
      if (!samePeriod(projected.period, options.period)) continue
      current.push(projected)
    }
    if (current.length === 0) return undefined
    const registry = new CurrentRunItemRegistry(current.map(material => ({
      id: material.candidate.candidate,
      source: material.canonicalUrl,
      content: material.text,
      topics: [],
    })))
    return { materials: current, registry }
  } catch {
    return undefined
  }
}

function readXMaterial(value: unknown): CurrentMaterial | undefined {
  const material = readPlainDataRecord(value)
  if (material === undefined) return undefined
  const materialHasNomination = material.has('nomination')
  if (!hasExactMapKeys(material, materialHasNomination
    ? ['acceptedIntoPeriod', 'period', 'candidate', 'boundedContent', 'attribution', 'exactLookup', 'nomination']
    : ['acceptedIntoPeriod', 'period', 'candidate', 'boundedContent', 'attribution', 'exactLookup'])) return undefined

  const accepted = readPlainDataRecord(material.get('acceptedIntoPeriod'))
  const period = readPeriod(material.get('period'))
  const candidate = readCandidate(material.get('candidate'))
  const boundedContent = readPlainDataRecord(material.get('boundedContent'))
  const attribution = readPlainDataRecord(material.get('attribution'))
  const exactLookup = readPlainDataRecord(material.get('exactLookup'))
  if (accepted === undefined
    || period === undefined
    || candidate === undefined
    || boundedContent === undefined
    || attribution === undefined
    || exactLookup === undefined) return undefined

  const acceptedHasNomination = accepted.has('nomination')
  if (!hasExactMapKeys(accepted, acceptedHasNomination
    ? ['period', 'candidate', 'nomination']
    : ['period', 'candidate'])) return undefined
  const acceptedPeriod = readPeriod(accepted.get('period'))
  const acceptedCandidate = readCandidate(accepted.get('candidate'))
  if (acceptedPeriod === undefined || acceptedCandidate === undefined) return undefined

  const hasTimestamp = boundedContent.has('ts')
  if (!hasExactMapKeys(boundedContent, hasTimestamp
      ? ['kind', 'id', 'url', 'text', 'time', 'media', 'ts']
      : ['kind', 'id', 'url', 'text', 'time', 'media'])
    || !hasExactMapKeys(attribution, ['kind', 'handle'])
    || !hasExactMapKeys(exactLookup, ['kind', 'url'])) return undefined

  const kind = boundedContent.get('kind')
  const id = boundedContent.get('id')
  const url = boundedContent.get('url')
  const text = boundedContent.get('text')
  const time = boundedContent.get('time')
  const media = readPlainDataArray(boundedContent.get('media'))
  const attributionKind = attribution.get('kind')
  const authorHandle = attribution.get('handle')
  const lookupKind = exactLookup.get('kind')
  const lookupUrl = exactLookup.get('url')
  if (kind !== 'x-status'
    || typeof id !== 'string'
    || typeof url !== 'string'
    || typeof text !== 'string'
    || text.trim() === ''
    || typeof time !== 'string'
    || (time !== '' && !Number.isFinite(Date.parse(time)))
    || media === undefined
    || media.some(item => typeof item !== 'string')
    || (hasTimestamp && !isValidEpochSeconds(boundedContent.get('ts')))
    || attributionKind !== 'x-author'
    || typeof authorHandle !== 'string'
    || authorHandle.trim() === ''
    || lookupKind !== 'x-status-lookup'
    || lookupUrl !== url
    || candidate.source !== X_FEED_SOURCE_IDENTITY
    || !samePeriod(acceptedPeriod, period)
    || !sameCandidate(acceptedCandidate, candidate)
    || !sameMapNomination(material, accepted)) return undefined

  const identity = parseXStatusIdentity(url)
  if (identity === undefined
    || url !== identity.canonicalUrl
    || identity.statusId !== id
    || candidate.candidate !== `x-status:${identity.statusId}`
    || candidate.stableReference !== `x:status:${identity.statusId}`) return undefined

  return {
    period,
    candidate,
    itemId: identity.itemId,
    canonicalUrl: identity.canonicalUrl,
    text,
    authorHandle,
  }
}

function validateProposal(
  input: unknown,
  projection: CurrentMaterialProjection,
): OrdinaryFeedEditingProposalValidationResult {
  let proposal: PlainProposal | undefined
  try {
    proposal = readPlainProposal(input)
  } catch {
    return { status: 'rejected', input }
  }
  if (proposal === undefined) return { status: 'rejected', input }
  const decisions = validateDecisions(proposal.decisions, projection.materials)
  if (decisions === undefined) return { status: 'rejected', input }
  const selectedItemIds = decisions
    .filter((decision): decision is Extract<ProposalDecision, { kind: 'selected' }> => decision.kind === 'selected')
    .map(decision => decision.itemId)
  if (selectedItemIds.length === 0) return { status: 'rejected', input }

  const composer = validateComposerDto(
    { title: proposal.title, sections: proposal.sections },
    { itemIds: selectedItemIds },
  )
  if (!composer.ok) return { status: 'rejected', input }
  const sectionItemIds = composer.value.sections.flatMap(section => section.items.map(item => item.itemId))
  if (!sameStringSet(sectionItemIds, selectedItemIds)) return { status: 'rejected', input }

  const rendered = renderDigest(composer.value, projection.registry)
  if (!rendered.ok || !sameStringSet(rendered.usedItemIds, selectedItemIds)) {
    return { status: 'rejected', input }
  }

  const proposalDecisions = new Map(decisions.map(decision => [decision.itemId, decision]))
  const candidatesInJudgment = projection.materials.map(material => copyCandidate(material.candidate))
  const authoritativeDecisions: CompleteCandidateEditingDecisions['decisions'] = projection.materials.map(material => {
    const decision = proposalDecisions.get(material.itemId)!
    const candidate = copyCandidate(material.candidate)
    return decision.kind === 'selected'
      ? { kind: 'selected', candidate }
      : { kind: 'not_selected', candidate, semanticReason: decision.semanticReason }
  })
  const content: EditedFeedContent = { body: rendered.text }
  const completeDecisions: CompleteCandidateEditingDecisions = {
    candidatesInJudgment,
    decisions: authoritativeDecisions,
  }
  return deepFreeze({
    status: 'accepted',
    value: { content, decisions: completeDecisions },
  })
}

function readPlainProposal(input: unknown): PlainProposal | undefined {
  const top = readPlainDataRecord(input)
  if (top === undefined || !hasExactMapKeys(top, ['title', 'sections', 'decisions'])) return undefined
  const rawSections = readPlainDataArray(top.get('sections'))
  const rawDecisions = readPlainDataArray(top.get('decisions'))
  if (rawSections === undefined || rawDecisions === undefined) return undefined

  const sections: PlainProposalSection[] = []
  for (const rawSection of rawSections) {
    const section = readPlainDataRecord(rawSection)
    if (section === undefined || !hasExactMapKeys(section, ['kind', 'items'])) return undefined
    const rawItems = readPlainDataArray(section.get('items'))
    if (rawItems === undefined) return undefined
    const items: PlainProposalItem[] = []
    for (const rawItem of rawItems) {
      const item = readPlainDataRecord(rawItem)
      if (item === undefined || !hasExactMapKeys(item, ['itemId', 'summary'])) return undefined
      items.push({ itemId: item.get('itemId'), summary: item.get('summary') })
    }
    sections.push({ kind: section.get('kind'), items })
  }

  const decisions: PlainProposalDecision[] = []
  for (const rawDecision of rawDecisions) {
    const decision = readPlainDataRecord(rawDecision)
    if (decision === undefined) return undefined
    const kind = decision.get('kind')
    if (kind === 'selected') {
      if (!hasExactMapKeys(decision, ['itemId', 'kind'])) return undefined
      decisions.push({ itemId: decision.get('itemId'), kind })
      continue
    }
    if (kind !== 'not_selected'
      || !hasExactMapKeys(decision, ['itemId', 'kind', 'semanticReason'])) return undefined
    decisions.push({
      itemId: decision.get('itemId'),
      kind,
      semanticReason: decision.get('semanticReason'),
    })
  }
  return { title: top.get('title'), sections, decisions }
}

function readPlainDataRecord(value: unknown): ReadonlyMap<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string')) return undefined
  const fields = new Map<string, unknown>()
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined
    fields.set(key, descriptor.value)
  }
  return fields
}

function readPlainDataArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined
  const keys = Reflect.ownKeys(value)
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (lengthDescriptor === undefined
    || lengthDescriptor.enumerable
    || !('value' in lengthDescriptor)
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || keys.length !== lengthDescriptor.value + 1) return undefined
  const items: unknown[] = []
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const key = String(index)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined
    items.push(descriptor.value)
  }
  const allowedKeys = new Set(['length', ...items.map((_, index) => String(index))])
  if (keys.some(key => typeof key !== 'string' || !allowedKeys.has(key))) return undefined
  return items
}

function hasExactMapKeys(value: ReadonlyMap<string, unknown>, expected: readonly string[]): boolean {
  return value.size === expected.length && expected.every(key => value.has(key))
}

function validateDecisions(
  value: unknown,
  materials: readonly CurrentMaterial[],
): readonly ProposalDecision[] | undefined {
  if (!Array.isArray(value) || value.length !== materials.length) return undefined
  const known = new Set(materials.map(material => material.itemId))
  const seen = new Set<string>()
  const decisions: ProposalDecision[] = []
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.itemId !== 'string' || !known.has(raw.itemId) || seen.has(raw.itemId)) {
      return undefined
    }
    seen.add(raw.itemId)
    if (raw.kind === 'selected') {
      if (!hasExactKeys(raw, ['itemId', 'kind'])) return undefined
      decisions.push({ kind: 'selected', itemId: raw.itemId })
      continue
    }
    if (raw.kind !== 'not_selected'
      || !hasExactKeys(raw, ['itemId', 'kind', 'semanticReason'])
      || !isValidComposerPlainText(raw.semanticReason, COMPOSER_SUMMARY_MAX_UTF8_BYTES)) return undefined
    decisions.push({
      kind: 'not_selected',
      itemId: raw.itemId,
      semanticReason: raw.semanticReason,
    })
  }
  return seen.size === known.size ? decisions : undefined
}

function sameMapNomination(
  material: ReadonlyMap<string, unknown>,
  accepted: ReadonlyMap<string, unknown>,
): boolean {
  const materialHasNomination = material.has('nomination')
  const acceptedHasNomination = accepted.has('nomination')
  if (materialHasNomination !== acceptedHasNomination) return false
  if (!materialHasNomination) return true
  const materialValue = encodeStableNomination(material.get('nomination'))
  const acceptedValue = encodeStableNomination(accepted.get('nomination'))
  return materialValue !== undefined && materialValue === acceptedValue
}

function encodeStableNomination(value: unknown, ancestors = new Set<object>()): string | undefined {
  if (value === null) return 'z'
  if (typeof value === 'string') return `s${value.length}:${value}`
  if (typeof value === 'boolean') return value ? 'b1' : 'b0'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    return Object.is(value, -0) ? 'n-0' : `n${String(value)}`
  }
  if (typeof value !== 'object' || ancestors.has(value)) return undefined

  if (Array.isArray(value)) {
    const items = readPlainDataArray(value)
    if (items === undefined) return undefined
    ancestors.add(value)
    try {
      const encoded: string[] = []
      for (const item of items) {
        const child = encodeStableNomination(item, ancestors)
        if (child === undefined) return undefined
        encoded.push(`${child.length}:${child}`)
      }
      return `a${encoded.length}:${encoded.join('')}`
    } finally {
      ancestors.delete(value)
    }
  }

  const fields = readPlainDataRecord(value)
  if (fields === undefined) return undefined
  ancestors.add(value)
  try {
    const encoded: string[] = []
    for (const key of [...fields.keys()].sort()) {
      const child = encodeStableNomination(fields.get(key), ancestors)
      if (child === undefined) return undefined
      encoded.push(`${key.length}:${key}${child.length}:${child}`)
    }
    return `o${encoded.length}:${encoded.join('')}`
  } finally {
    ancestors.delete(value)
  }
}

function isValidEpochSeconds(value: unknown): boolean {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && Number.isFinite(new Date(value * 1_000).getTime())
}

function readPeriod(value: unknown): PeriodIdentity | undefined {
  const fields = readPlainDataRecord(value)
  if (fields === undefined || !hasExactMapKeys(fields, ['run', 'period'])) return undefined
  const run = fields.get('run')
  const period = fields.get('period')
  if (typeof run !== 'string' || typeof period !== 'string') return undefined
  return {
    run: run as PeriodIdentity['run'],
    period: period as PeriodIdentity['period'],
  }
}

function readCandidate(value: unknown): SourceCandidateReference | undefined {
  const fields = readPlainDataRecord(value)
  if (fields === undefined || !hasExactMapKeys(fields, ['source', 'candidate', 'stableReference'])) return undefined
  const source = fields.get('source')
  const candidate = fields.get('candidate')
  const stableReference = fields.get('stableReference')
  if (typeof source !== 'string' || typeof candidate !== 'string' || typeof stableReference !== 'string') {
    return undefined
  }
  return {
    source: source as SourceCandidateReference['source'],
    candidate: candidate as SourceCandidateReference['candidate'],
    stableReference: stableReference as SourceCandidateReference['stableReference'],
  }
}

function samePeriod(left: PeriodIdentity, right: PeriodIdentity): boolean {
  return left.run === right.run && left.period === right.period
}

function sameCandidate(left: SourceCandidateReference, right: SourceCandidateReference): boolean {
  return left.source === right.source
    && left.candidate === right.candidate
    && left.stableReference === right.stableReference
}

function copyCandidate(candidate: SourceCandidateReference): SourceCandidateReference {
  return {
    source: candidate.source,
    candidate: candidate.candidate,
    stableReference: candidate.stableReference,
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every(value => right.includes(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && keys.every(key => typeof key === 'string' && expected.includes(key))
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}
