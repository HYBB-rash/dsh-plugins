/**
 * TODO05 ordinary-feed editing proposal validator RED contract.
 *
 * The fixture enters through real X C03/C08/C09 -> C36 -> C26/C16/C10
 * production seams. It does not seed editing facts or implement validation.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCandidateMaterialProjection,
  createCrossSourceEditor,
  createCurrentContextProjection,
  createMechanicalAdmission,
  createPeriodBusinessFinalizer,
  createPersonalFeedScopeService,
  sourceIdentity,
} from '@herman/personal-feed'
import type {
  CandidateMaterial,
  ExternalPeriodScopeInput,
  PeriodIdentity,
  PeriodReference,
  RunIdentity,
} from '@herman/personal-feed'
import {
  createXSourceCandidateReportPorts,
  prepareAndSubmitXSourceCandidateReport,
} from '../src/x-cron/source-candidate-report.ts'
import {
  projectXAcceptedReportIntoEditingInputs,
} from '../src/x-cron/candidate-editing-input.ts'
import type {
  XSourceCollectionEvidence,
  XSourceCollectionItem,
} from '../src/x-cron/source-candidate-report.ts'
import {
  createOrdinaryFeedEditingProposalValidator,
  type OrdinaryFeedEditingProposalEditor,
  type OrdinaryFeedEditingProposalOptions,
  type OrdinaryFeedEditingProposalRuntime,
  type OrdinaryFeedEditingProposalValidationResult,
  type OrdinaryFeedModelMaterial,
  type OrdinaryFeedModelMaterialsResult,
} from '../src/personal-feed/ordinary-feed-editing-proposal.ts'
type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value
type _OptionsKeys = Assert<Equal<keyof OrdinaryFeedEditingProposalOptions, 'period' | 'editor'>>
type _EditorKeys = Assert<Equal<keyof OrdinaryFeedEditingProposalEditor, 'listAcceptedInputs'>>
type _RuntimeKeys = Assert<Equal<keyof OrdinaryFeedEditingProposalRuntime, 'readModelMaterials' | 'validateProposal'>>
type _ModelMaterialKeys = Assert<Equal<keyof OrdinaryFeedModelMaterial, 'itemId' | 'text' | 'authorHandle'>>
type _FactoryOptions = Assert<Equal<Parameters<typeof createOrdinaryFeedEditingProposalValidator>[0], OrdinaryFeedEditingProposalOptions>>
type _FactoryRuntime = Assert<Equal<ReturnType<typeof createOrdinaryFeedEditingProposalValidator>, OrdinaryFeedEditingProposalRuntime>>
type _ReadResult = Assert<Equal<ReturnType<OrdinaryFeedEditingProposalRuntime['readModelMaterials']>, OrdinaryFeedModelMaterialsResult>>
type _ValidationResult = Assert<Equal<ReturnType<OrdinaryFeedEditingProposalRuntime['validateProposal']>, OrdinaryFeedEditingProposalValidationResult>>

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function snapshotDirectory(directory: string): readonly [string, Buffer][] {
  return readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name))])
}

function samePeriod(left: PeriodIdentity, right: PeriodIdentity): boolean {
  return left.run === right.run && left.period === right.period
}

function externalInput(suffix: string): ExternalPeriodScopeInput {
  return {
    requestIdentity: `todo05-ordinary-feed-${suffix}`,
    trigger: 'scheduled',
    scheduledFor: '2026-08-24T00:00:00.000Z',
    claimedAt: '2026-08-24T00:00:01.000Z',
    runId: `todo05-ordinary-feed-${suffix}-run`,
    requiredSources: ['x'],
    reportingWindowClosesAt: '2026-08-25T00:00:00.000Z',
  }
}

interface OrdinaryFeedFixture {
  readonly directory: string
  readonly period: PeriodIdentity
  readonly editor: OrdinaryFeedEditingProposalEditor
  readonly materials: readonly CandidateMaterial[]
  readonly c10Calls: number
}

function xItem(id: string, text: string, user: string): XSourceCollectionItem {
  return {
    id,
    url: `https://x.com/${user}/status/${id}`,
    text,
    time: '2026-08-24T00:00:00.000Z',
    user,
    media: [],
    ts: 1_755_961_200,
  }
}

function xItemWithUrl(
  id: string,
  text: string,
  user: string,
  url: string,
): XSourceCollectionItem {
  return { ...xItem(id, text, user), url }
}

interface OrdinaryFeedFixtureCollections {
  readonly target?: readonly XSourceCollectionItem[]
  readonly other?: readonly XSourceCollectionItem[]
}

function xEvidence(suffix: string): XSourceCollectionEvidence {
  const collectionPath = `/tmp/todo05-x-editor-${suffix}/collection.jsonl`
  return {
    runId: `todo05-x-editor-${suffix}`,
    source: 'x',
    collectionPath,
    collectionBatch: collectionPath,
    deliveryId: `delivery-${suffix}`,
    ts: 1_755_961_200,
  }
}

async function createOrdinaryFeedFixture(
  additionalTargetItems: readonly XSourceCollectionItem[] = [],
  collections: OrdinaryFeedFixtureCollections = {},
): Promise<OrdinaryFeedFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'x-feed-todo05-ordinary-editor-'))
  temporaryDirectories.push(directory)
  const periodScopeLedgerPath = join(directory, 'period-scopes.jsonl')
  const reportLedgerPath = join(directory, 'source-candidate-reports.jsonl')
  const candidatePeriodLedgerPath = join(directory, 'candidate-period-facts.jsonl')
  const editingInputLedgerPath = join(directory, 'editing-inputs.jsonl')
  const periodBusinessLedgerPath = join(directory, 'period-business.jsonl')
  const source = sourceIdentity('x')
  const scopeService = createPersonalFeedScopeService({
    ledgerPath: periodScopeLedgerPath,
    sourceScopes: [{
      source,
      mechanicalAdmission: createMechanicalAdmission(source),
      candidateMaterialProjection: createCandidateMaterialProjection(source),
    }],
    currentContextProjection: createCurrentContextProjection(),
  })
  const targetScope = await scopeService.establishExternalPeriodScope(externalInput('target'))
  const otherScope = await scopeService.establishExternalPeriodScope(externalInput('other'))
  const finalizer = createPeriodBusinessFinalizer({
    periodScopeLedgerPath,
    reportLedgerPath,
    candidatePeriodLedgerPath,
    editingInputLedgerPath,
    periodBusinessLedgerPath,
    now: () => '2026-08-24T01:00:00.000Z',
  })
  const editor = createCrossSourceEditor({ candidatePeriodLedgerPath, editingInputLedgerPath, periodBusinessLedgerPath })
  const targetCollection = collections.target ?? [
    xItem('1001', 'A target text', 'alice'),
    xItem('1002', 'B target text', 'bob'),
    ...additionalTargetItems,
  ]
  const otherCollection = collections.other ?? [xItem('2001', 'C other-period text', 'carol')]
  const candidatePorts = createXSourceCandidateReportPorts()
  const targetReport = await prepareAndSubmitXSourceCandidateReport({
    period: targetScope.c01.value.period,
    mechanicalAdmissionScope: targetScope.c32.find(scope => scope.value.source === source)!.value,
    materialProjectionReportScope: targetScope.c35.find(scope => scope.value.scope.source === source)!.value,
    collectionEvidence: xEvidence('target'),
    currentCollection: targetCollection,
    candidatePort: candidatePorts,
    reportPort: { submitSourceCandidateReport: report => finalizer.acceptSourceCandidateReport(report) },
  })
  const targetProjected = await projectXAcceptedReportIntoEditingInputs({
    period: targetScope.c01.value.period,
    collectionEvidence: xEvidence('target'),
    acceptedReport: targetReport,
    currentCollection: targetCollection,
    periodFinalizer: finalizer,
    crossSourceEditor: editor,
  })
  const otherPorts = createXSourceCandidateReportPorts()
  const otherReport = await prepareAndSubmitXSourceCandidateReport({
    period: otherScope.c01.value.period,
    mechanicalAdmissionScope: otherScope.c32.find(scope => scope.value.source === source)!.value,
    materialProjectionReportScope: otherScope.c35.find(scope => scope.value.scope.source === source)!.value,
    collectionEvidence: xEvidence('other'),
    currentCollection: otherCollection,
    candidatePort: otherPorts,
    reportPort: { submitSourceCandidateReport: report => finalizer.acceptSourceCandidateReport(report) },
  })
  const otherProjected = await projectXAcceptedReportIntoEditingInputs({
    period: otherScope.c01.value.period,
    collectionEvidence: xEvidence('other'),
    acceptedReport: otherReport,
    currentCollection: otherCollection,
    periodFinalizer: finalizer,
    crossSourceEditor: editor,
  })
  const materials = editor.listAcceptedInputs()
  const c10Calls = targetProjected.length + otherProjected.length
  expect(c10Calls).toBe(targetCollection.length + otherCollection.length)
  return {
    directory,
    period: targetScope.c01.value.period,
    editor,
    materials,
    c10Calls,
  }
}

function targetMaterials(fixture: OrdinaryFeedFixture): readonly CandidateMaterial[] {
  return fixture.materials.filter(material => samePeriod(material.period, fixture.period))
}

function modelMaterialsFor(): readonly OrdinaryFeedModelMaterial[] {
  return [
    { itemId: 'item:x-status:1001', text: 'A target text', authorHandle: 'alice' },
    { itemId: 'item:x-status:1002', text: 'B target text', authorHandle: 'bob' },
  ]
}

function editingProposalFor(fixture: OrdinaryFeedFixture) {
  const materials = targetMaterials(fixture)
  expect(materials.slice(0, 2).map(material => material.boundedContent)).toEqual([
    expect.objectContaining({ kind: 'x-status', id: '1001', text: 'A target text' }),
    expect.objectContaining({ kind: 'x-status', id: '1002', text: 'B target text' }),
  ])
  return {
    title: 'Ordinary target feed',
    sections: [{
      kind: 'highlight',
      items: [{ itemId: 'item:x-status:1001', summary: 'A target insight' }],
    }],
    decisions: [
      { itemId: 'item:x-status:1001', kind: 'selected' },
      {
        itemId: 'item:x-status:1002',
        kind: 'not_selected',
        semanticReason: 'Lower relevance for this period.',
      },
    ],
  }
}

function expectedEditingDecisions(fixture: OrdinaryFeedFixture) {
  const [first, second] = targetMaterials(fixture)
  return {
    candidatesInJudgment: [first!.candidate, second!.candidate],
    decisions: [
      { kind: 'selected', candidate: first!.candidate },
      {
        kind: 'not_selected',
        candidate: second!.candidate,
        semanticReason: 'Lower relevance for this period.',
      },
    ],
  }
}

interface MutableProposal {
  title?: unknown
  sections?: unknown
  decisions?: unknown
  extra?: unknown
}

interface ProposalNegativeCase {
  readonly name: string
  readonly mutate: (input: MutableProposal) => void
}

function mutableProposalFor(fixture: OrdinaryFeedFixture): MutableProposal {
  return structuredClone(editingProposalFor(fixture)) as MutableProposal
}

type MutableRecord = Record<PropertyKey, unknown>

function mutableRecord(value: unknown): MutableRecord {
  expect(value).toBeTypeOf('object')
  expect(value).not.toBeNull()
  expect(Array.isArray(value)).toBe(false)
  return value as MutableRecord
}

function nestedRecord(value: MutableRecord, key: string): MutableRecord {
  return mutableRecord(value[key])
}

function clonedAcceptedInputs(fixture: OrdinaryFeedFixture): CandidateMaterial[] {
  return structuredClone(fixture.materials) as CandidateMaterial[]
}

interface C10MutationCase {
  readonly name: string
  readonly mutate: (material: MutableRecord) => void
}

function c10MutationCases(): readonly C10MutationCase[] {
  return [
    { name: 'material top-level extra field', mutate: material => { material.extra = true } },
    { name: 'material missing exactLookup', mutate: material => { delete material.exactLookup } },
    {
      name: 'period extra field',
      mutate: material => { nestedRecord(material, 'period').extra = true },
    },
    {
      name: 'acceptedIntoPeriod extra field',
      mutate: material => { nestedRecord(material, 'acceptedIntoPeriod').extra = true },
    },
    {
      name: 'acceptedIntoPeriod missing candidate',
      mutate: material => { delete nestedRecord(material, 'acceptedIntoPeriod').candidate },
    },
    {
      name: 'candidate extra field',
      mutate: material => { nestedRecord(material, 'candidate').extra = true },
    },
    {
      name: 'boundedContent extra field',
      mutate: material => { nestedRecord(material, 'boundedContent').extra = true },
    },
    {
      name: 'boundedContent missing media',
      mutate: material => { delete nestedRecord(material, 'boundedContent').media },
    },
    {
      name: 'attribution extra field',
      mutate: material => { nestedRecord(material, 'attribution').extra = true },
    },
    {
      name: 'attribution missing handle',
      mutate: material => { delete nestedRecord(material, 'attribution').handle },
    },
    {
      name: 'exactLookup extra field',
      mutate: material => { nestedRecord(material, 'exactLookup').extra = true },
    },
    {
      name: 'exactLookup missing kind',
      mutate: material => { delete nestedRecord(material, 'exactLookup').kind },
    },
    {
      name: 'invalid X status URL parser result',
      mutate: material => {
        nestedRecord(material, 'boundedContent').url = 'https://example.com/alice/status/1001'
        nestedRecord(material, 'exactLookup').url = 'https://example.com/alice/status/1001'
      },
    },
    {
      name: 'nonpositive observation epoch',
      mutate: material => { nestedRecord(material, 'boundedContent').ts = 0 },
    },
    {
      name: 'unsafe observation epoch',
      mutate: material => { nestedRecord(material, 'boundedContent').ts = Number.MAX_SAFE_INTEGER + 1 },
    },
    {
      name: 'invalid nonempty observation time',
      mutate: material => { nestedRecord(material, 'boundedContent').time = 'not-a-time' },
    },
    {
      name: 'nonstring media member',
      mutate: material => { nestedRecord(material, 'boundedContent').media = [42] },
    },
    {
      name: 'acceptedIntoPeriod period diverges from material period',
      mutate: material => {
        nestedRecord(nestedRecord(material, 'acceptedIntoPeriod'), 'period').period = 'different-period'
      },
    },
    {
      name: 'acceptedIntoPeriod candidate diverges from material candidate',
      mutate: material => {
        nestedRecord(nestedRecord(material, 'acceptedIntoPeriod'), 'candidate').stableReference = 'x:status:different'
      },
    },
    {
      name: 'bounded status id diverges from candidate',
      mutate: material => { nestedRecord(material, 'boundedContent').id = '9999' },
    },
    {
      name: 'exact lookup diverges from bounded URL',
      mutate: material => { nestedRecord(material, 'exactLookup').url = 'https://x.com/alice/status/9999' },
    },
    {
      name: 'material nomination exists without accepted nomination',
      mutate: material => { material.nomination = { kind: 'fixture-nomination', value: 'material' } },
    },
    {
      name: 'accepted nomination exists without material nomination',
      mutate: material => {
        nestedRecord(material, 'acceptedIntoPeriod').nomination = { kind: 'fixture-nomination', value: 'accepted' }
      },
    },
    {
      name: 'material and accepted nominations diverge',
      mutate: material => {
        material.nomination = { kind: 'fixture-nomination', value: 'material' }
        nestedRecord(material, 'acceptedIntoPeriod').nomination = { kind: 'fixture-nomination', value: 'accepted' }
      },
    },
  ]
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectDeepFrozen(child, seen)
}

function proposalNegativeCases(): readonly ProposalNegativeCase[] {
  return [
    { name: 'top-level missing title', mutate: input => { delete input.title } },
    { name: 'top-level extra field', mutate: input => { input.extra = true } },
    {
      name: 'section missing kind',
      mutate: input => { delete (input.sections as Array<Record<string, unknown>>)[0]!.kind },
    },
    {
      name: 'section extra field',
      mutate: input => { (input.sections as Array<Record<string, unknown>>)[0]!.extra = true },
    },
    {
      name: 'item missing itemId',
      mutate: input => {
        const section = (input.sections as Array<Record<string, unknown>>)[0]!
        delete (section.items as Array<Record<string, unknown>>)[0]!.itemId
      },
    },
    {
      name: 'item extra field',
      mutate: input => {
        const section = (input.sections as Array<Record<string, unknown>>)[0]!
        ;(section.items as Array<Record<string, unknown>>)[0]!.extra = true
      },
    },
    {
      name: 'decision missing itemId',
      mutate: input => { delete (input.decisions as Array<Record<string, unknown>>)[0]!.itemId },
    },
    {
      name: 'decision extra field',
      mutate: input => { (input.decisions as Array<Record<string, unknown>>)[0]!.extra = true },
    },
    {
      name: 'decision coverage missing',
      mutate: input => { (input.decisions as Array<Record<string, unknown>>).pop() },
    },
    {
      name: 'decision duplicate',
      mutate: input => {
        const decisions = input.decisions as Array<Record<string, unknown>>
        decisions.push(structuredClone(decisions[0]))
      },
    },
    {
      name: 'decision outsider',
      mutate: input => { (input.decisions as Array<Record<string, unknown>>)[0]!.itemId = 'item:outsider' },
    },
    {
      name: 'zero selected',
      mutate: input => {
        const decision = (input.decisions as Array<Record<string, unknown>>)[0]!
        decision.kind = 'not_selected'
        decision.semanticReason = 'Also lower relevance for this period.'
        input.sections = []
      },
    },
    {
      name: 'not-selected reason missing',
      mutate: input => { delete (input.decisions as Array<Record<string, unknown>>)[1]!.semanticReason },
    },
    {
      name: 'not-selected reason empty',
      mutate: input => { (input.decisions as Array<Record<string, unknown>>)[1]!.semanticReason = '' },
    },
    {
      name: 'not-selected reason non-string',
      mutate: input => { (input.decisions as Array<Record<string, unknown>>)[1]!.semanticReason = 42 },
    },
    {
      name: 'not-selected reason URL',
      mutate: input => { (input.decisions as Array<Record<string, unknown>>)[1]!.semanticReason = 'https://x.com/a/status/1' },
    },
    {
      name: 'section kind unsupported by the mechanical renderer',
      mutate: input => { (input.sections as Array<Record<string, unknown>>)[0]!.kind = 'unknown' },
    },
    {
      name: 'item summary rejected by the mechanical renderer contract',
      mutate: input => {
        const section = (input.sections as Array<Record<string, unknown>>)[0]!
        ;(section.items as Array<Record<string, unknown>>)[0]!.summary = 'https://x.com/outsider/status/9'
      },
    },
    {
      name: 'not-selected reason over 400 UTF-8 bytes',
      mutate: input => { (input.decisions as Array<Record<string, unknown>>)[1]!.semanticReason = 'x'.repeat(401) },
    },
    {
      name: 'section references not-selected item',
      mutate: input => {
        const section = (input.sections as Array<Record<string, unknown>>)[0]!
        ;(section.items as Array<Record<string, unknown>>)[0]!.itemId = 'item:x-status:1002'
      },
    },
    {
      name: 'selected section missing',
      mutate: input => {
        const section = (input.sections as Array<Record<string, unknown>>)[0]!
        section.items = []
      },
    },
    {
      name: 'selected section item duplicate',
      mutate: input => {
        const section = (input.sections as Array<Record<string, unknown>>)[0]!
        const items = section.items as Array<Record<string, unknown>>
        items.push(structuredClone(items[0]))
      },
    },
    {
      name: 'selected section item outsider',
      mutate: input => {
        const section = (input.sections as Array<Record<string, unknown>>)[0]!
        ;(section.items as Array<Record<string, unknown>>)[0]!.itemId = 'item:9999'
      },
    },
  ]
}

function proposalSection(input: MutableProposal): MutableRecord {
  return mutableRecord((input.sections as unknown[])[0])
}

function proposalItem(input: MutableProposal): MutableRecord {
  return mutableRecord((proposalSection(input).items as unknown[])[0])
}

function proposalDecision(input: MutableProposal, index = 0): MutableRecord {
  return mutableRecord((input.decisions as unknown[])[index])
}

function defineReturningAccessor(record: MutableRecord, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    get: () => value,
  })
}

function utf8PlainText(bytes: number): string {
  const value = `${'界'.repeat(Math.floor(bytes / 3))}${'a'.repeat(bytes % 3)}`
  expect(new TextEncoder().encode(value)).toHaveLength(bytes)
  return value
}

type ProposalTextField = 'title' | 'summary' | 'semanticReason'

function setProposalText(input: MutableProposal, field: ProposalTextField, value: string): void {
  if (field === 'title') input.title = value
  else if (field === 'summary') proposalItem(input).summary = value
  else proposalDecision(input, 1).semanticReason = value
}

interface NominationCanonicalCase {
  readonly name: string
  readonly expected: 'accepted' | 'failed'
  readonly create: () => readonly [unknown, unknown]
}

function nominationCanonicalCases(): readonly NominationCanonicalCase[] {
  return [
    {
      name: 'same plain object with different key order',
      expected: 'accepted',
      create: () => [{ alpha: 1, nested: { enabled: true } }, { nested: { enabled: true }, alpha: 1 }],
    },
    { name: 'same finite number', expected: 'accepted', create: () => [42, 42] },
    { name: 'same boolean', expected: 'accepted', create: () => [true, true] },
    { name: 'same string', expected: 'accepted', create: () => ['nomination', 'nomination'] },
    { name: 'same null', expected: 'accepted', create: () => [null, null] },
    {
      name: 'same dense array',
      expected: 'accepted',
      create: () => [[1, true, 'value', null, { nested: 2 }], [1, true, 'value', null, { nested: 2 }]],
    },
    {
      name: 'same nested plain object',
      expected: 'accepted',
      create: () => [{ values: [1, 2], state: 'ready' }, { values: [1, 2], state: 'ready' }],
    },
    { name: 'negative zero equals negative zero', expected: 'accepted', create: () => [-0, -0] },
    { name: 'negative zero conflicts with zero', expected: 'failed', create: () => [-0, 0] },
    { name: 'present undefined values', expected: 'failed', create: () => [undefined, undefined] },
    { name: 'NaN values', expected: 'failed', create: () => [Number.NaN, Number.NaN] },
    { name: 'positive infinity values', expected: 'failed', create: () => [Infinity, Infinity] },
    { name: 'negative infinity values', expected: 'failed', create: () => [-Infinity, -Infinity] },
    {
      name: 'Date instances',
      expected: 'failed',
      create: () => [new Date('2026-08-24T00:00:00.000Z'), new Date('2026-08-24T00:00:00.000Z')],
    },
    {
      name: 'Map instances',
      expected: 'failed',
      create: () => [new Map([['key', 'value']]), new Map([['key', 'value']])],
    },
    {
      name: 'nonplain prototypes',
      expected: 'failed',
      create: () => {
        const prototype = { inherited: true }
        return [Object.assign(Object.create(prototype), { value: 1 }), Object.assign(Object.create(prototype), { value: 1 })]
      },
    },
    {
      name: 'sparse arrays',
      expected: 'failed',
      create: () => {
        const left = Array<unknown>(2)
        const right = Array<unknown>(2)
        left[1] = 'value'
        right[1] = 'value'
        return [left, right]
      },
    },
    {
      name: 'arrays with extra keys',
      expected: 'failed',
      create: () => {
        const left = [1] as unknown[] & { extra?: boolean }
        const right = [1] as unknown[] & { extra?: boolean }
        left.extra = true
        right.extra = true
        return [left, right]
      },
    },
    {
      name: 'symbol keys',
      expected: 'failed',
      create: () => {
        const left: MutableRecord = { value: 1 }
        const right: MutableRecord = { value: 1 }
        left[Symbol('hidden')] = true
        right[Symbol('hidden')] = true
        return [left, right]
      },
    },
    {
      name: 'cyclic objects',
      expected: 'failed',
      create: () => {
        const left: MutableRecord = {}
        const right: MutableRecord = {}
        left.self = left
        right.self = right
        return [left, right]
      },
    },
    { name: 'one invalid side', expected: 'failed', create: () => [Number.NaN, 1] },
    {
      name: 'different legal values',
      expected: 'failed',
      create: () => [{ value: 1 }, { value: 2 }],
    },
  ]
}

function inputsWithNominations(
  fixture: OrdinaryFeedFixture,
  materialNomination: unknown,
  acceptedNomination: unknown,
): CandidateMaterial[] {
  const inputs = clonedAcceptedInputs(fixture)
  const first = inputs.find(material => samePeriod(material.period, fixture.period))
  expect(first).toBeDefined()
  const mutable = first as unknown as MutableRecord
  mutable.nomination = materialNomination
  nestedRecord(mutable, 'acceptedIntoPeriod').nomination = acceptedNomination
  return inputs
}

type C10RecordLevel =
  | 'material'
  | 'acceptedIntoPeriod'
  | 'period'
  | 'candidate'
  | 'boundedContent'
  | 'attribution'
  | 'exactLookup'

const c10RecordLevels: readonly C10RecordLevel[] = [
  'material',
  'acceptedIntoPeriod',
  'period',
  'candidate',
  'boundedContent',
  'attribution',
  'exactLookup',
]

function firstTargetRecord(fixture: OrdinaryFeedFixture, inputs: CandidateMaterial[]): MutableRecord {
  const first = inputs.find(material => samePeriod(material.period, fixture.period))
  expect(first).toBeDefined()
  return first as unknown as MutableRecord
}

function c10RecordAt(material: MutableRecord, level: C10RecordLevel): MutableRecord {
  if (level === 'material') return material
  if (level === 'acceptedIntoPeriod') return nestedRecord(material, 'acceptedIntoPeriod')
  return nestedRecord(material, level)
}

function accessorKeyFor(level: C10RecordLevel): string {
  if (level === 'material') return 'boundedContent'
  if (level === 'acceptedIntoPeriod') return 'candidate'
  if (level === 'period') return 'run'
  if (level === 'candidate') return 'stableReference'
  if (level === 'boundedContent') return 'text'
  if (level === 'attribution') return 'handle'
  return 'url'
}

function expectC10OwnerFailure(
  fixture: OrdinaryFeedFixture,
  inputs: CandidateMaterial[],
  getterCalls: () => number = () => 0,
): void {
  const listAcceptedInputs = vi.fn<OrdinaryFeedEditingProposalEditor['listAcceptedInputs']>(() => inputs)
  const runtime = createOrdinaryFeedEditingProposalValidator({
    period: fixture.period,
    editor: { listAcceptedInputs },
  })
  const proposal = editingProposalFor(fixture)
  const before = snapshotDirectory(fixture.directory)

  expect(runtime.readModelMaterials()).toEqual({ status: 'failed' })
  expect(runtime.validateProposal(proposal)).toEqual({ status: 'failed', input: proposal })
  expect(getterCalls()).toBe(0)
  expect(listAcceptedInputs).toHaveBeenCalledTimes(2)
  expect(snapshotDirectory(fixture.directory)).toEqual(before)
}

describe('TODO05 ordinary-feed editing proposal validator RED', () => {
  it('reads only target-period C10 materials in stable C10 order', async () => {
    const fixture = await createOrdinaryFeedFixture()
    const runtime = createOrdinaryFeedEditingProposalValidator({
      period: fixture.period,
      editor: fixture.editor,
    })
    const before = snapshotDirectory(fixture.directory)
    const result = runtime.readModelMaterials()
    expect(result).toEqual({ status: 'accepted', value: { materials: modelMaterialsFor() } })
    expect(fixture.c10Calls).toBe(3)
    expect(targetMaterials(fixture)).toHaveLength(2)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('accepts a complete proposal and maps decisions to the same target C10 references', async () => {
    const fixture = await createOrdinaryFeedFixture()
    const runtime = createOrdinaryFeedEditingProposalValidator({ period: fixture.period, editor: fixture.editor })
    const input = editingProposalFor(fixture)
    const before = snapshotDirectory(fixture.directory)
    const result = runtime.validateProposal(input)
    expect(result).toEqual({
      status: 'accepted',
      value: {
        content: {
          body: '📦 X 洞察 Ordinary target feed\n\n⭐ 高优先级\n- A target insight (https://x.com/alice/status/1001)',
        },
        decisions: expectedEditingDecisions(fixture),
      },
    })
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('preserves legal bounded C10 whitespace for the model while rendering its selected canonical URL', async () => {
    const rawText = '  A target text with intentional outer whitespace  '
    const fixture = await createOrdinaryFeedFixture([], {
      target: [
        xItem('1001', rawText, 'alice'),
        xItem('1002', 'B target text', 'bob'),
      ],
    })
    const authoritativeInputs = fixture.editor.listAcceptedInputs()
    expect(authoritativeInputs
      .filter(material => samePeriod(material.period, fixture.period))
      .map(material => material.boundedContent.text))
      .toEqual([rawText, 'B target text'])

    const runtime = createOrdinaryFeedEditingProposalValidator({ period: fixture.period, editor: fixture.editor })
    const proposal = {
      title: 'Ordinary target feed',
      sections: [{
        kind: 'highlight',
        items: [{ itemId: 'item:x-status:1001', summary: 'A target insight' }],
      }],
      decisions: [
        { itemId: 'item:x-status:1001', kind: 'selected' },
        {
          itemId: 'item:x-status:1002',
          kind: 'not_selected',
          semanticReason: 'Lower relevance for this period.',
        },
      ],
    }
    const before = snapshotDirectory(fixture.directory)

    const modelResult = runtime.readModelMaterials()
    expect(modelResult).toEqual({
      status: 'accepted',
      value: {
        materials: [
          { itemId: 'item:x-status:1001', text: rawText, authorHandle: 'alice' },
          { itemId: 'item:x-status:1002', text: 'B target text', authorHandle: 'bob' },
        ],
      },
    })
    if (modelResult.status !== 'accepted') throw new Error('expected accepted whitespace-preserving model materials')
    for (const material of modelResult.value.materials) {
      expect(Reflect.ownKeys(material).sort()).toEqual(['authorHandle', 'itemId', 'text'])
      expect('url' in material).toBe(false)
    }

    expect(runtime.validateProposal(proposal)).toEqual({
      status: 'accepted',
      value: {
        content: {
          body: '📦 X 洞察 Ordinary target feed\n\n⭐ 高优先级\n- A target insight (https://x.com/alice/status/1001)',
        },
        decisions: expectedEditingDecisions(fixture),
      },
    })
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it.each(proposalNegativeCases())('rejects malformed proposal: $name', async ({ mutate }) => {
    const fixture = await createOrdinaryFeedFixture()
    const runtime = createOrdinaryFeedEditingProposalValidator({ period: fixture.period, editor: fixture.editor })
    const input = mutableProposalFor(fixture)
    mutate(input)
    const before = snapshotDirectory(fixture.directory)
    const result = runtime.validateProposal(input)
    expect(result).toEqual({ status: 'rejected', input })
    expect(fixture.c10Calls).toBe(3)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('re-reads the sole C10 port and fails closed when this period has no inputs', () => {
    const listAcceptedInputs = vi.fn<OrdinaryFeedEditingProposalEditor['listAcceptedInputs']>(() => [])
    const period: PeriodIdentity = {
      run: 'todo05-ordinary-feed-editing-proposal-run' as RunIdentity,
      period: 'todo05-ordinary-feed-editing-proposal-period' as PeriodReference,
    }
    const runtime = createOrdinaryFeedEditingProposalValidator({
      period,
      editor: { listAcceptedInputs },
    })
    expect(Object.isFrozen(runtime)).toBe(true)
    expect(Object.keys(runtime)).toEqual(['readModelMaterials', 'validateProposal'])
    expect(runtime.readModelMaterials()).toEqual({ status: 'failed' })
    expect(listAcceptedInputs).toHaveBeenCalledTimes(1)

    const input = Object.freeze({ title: 'bootstrap proposal', sections: [], decisions: [] })
    const result = runtime.validateProposal(input)
    expect(result).toEqual({ status: 'failed', input })
    expect(result.input).toBe(input)
    expect(listAcceptedInputs).toHaveBeenCalledTimes(2)
  })
})

describe('TODO05 ordinary-feed proposal X URL compatibility RED', () => {
  it.each([
    {
      name: 'twitter.com host with uppercase username',
      rawUrl: 'https://twitter.com/Alice/status/1001',
      canonicalUrl: 'https://x.com/alice/status/1001',
    },
    {
      name: 'x.com host with uppercase username',
      rawUrl: 'https://x.com/Alice/status/1001',
      canonicalUrl: 'https://x.com/alice/status/1001',
    },
  ])('accepts a real C10 row with $name and renders the derived canonical URL', async ({ rawUrl, canonicalUrl }) => {
    const fixture = await createOrdinaryFeedFixture([], {
      target: [
        xItemWithUrl('1001', 'A target text', 'alice', rawUrl),
        xItem('1002', 'B target text', 'bob'),
      ],
    })
    const [first] = targetMaterials(fixture)
    expect(first).toBeDefined()
    expect(first!.boundedContent).toEqual(expect.objectContaining({
      kind: 'x-status',
      id: '1001',
      url: rawUrl,
    }))
    expect(first!.exactLookup).toEqual({ kind: 'x-status-lookup', url: rawUrl })
    expect(first!.candidate).toEqual({
      source: 'x',
      candidate: 'x-status:1001',
      stableReference: 'x:status:1001',
    })

    const runtime = createOrdinaryFeedEditingProposalValidator({ period: fixture.period, editor: fixture.editor })
    const modelResult = runtime.readModelMaterials()
    expect(modelResult).toEqual({ status: 'accepted', value: { materials: modelMaterialsFor() } })
    if (modelResult.status !== 'accepted') throw new Error('expected accepted model material projection')
    for (const material of modelResult.value.materials) {
      expect(Reflect.ownKeys(material).sort()).toEqual(['authorHandle', 'itemId', 'text'])
      expect('url' in material).toBe(false)
      expect('canonicalUrl' in material).toBe(false)
    }

    const result = runtime.validateProposal(editingProposalFor(fixture))
    expect(result).toEqual({
      status: 'accepted',
      value: {
        content: {
          body: `📦 X 洞察 Ordinary target feed\n\n⭐ 高优先级\n- A target insight (${canonicalUrl})`,
        },
        decisions: expectedEditingDecisions(fixture),
      },
    })
    if (result.status === 'accepted') {
      expect(result.value.content.body).toContain(canonicalUrl)
      expect(result.value.content.body).not.toContain(rawUrl)
    }
  })

  it('does not let a real parseable noncanonical other-period C10 row poison this period', async () => {
    const rawUrl = 'https://twitter.com/Carol/status/2001'
    const fixture = await createOrdinaryFeedFixture([], {
      other: [xItemWithUrl('2001', 'C other-period text', 'carol', rawUrl)],
    })
    const other = fixture.materials.find(material => !samePeriod(material.period, fixture.period))
    expect(other).toBeDefined()
    expect(other!.boundedContent).toEqual(expect.objectContaining({ id: '2001', url: rawUrl }))
    expect(other!.exactLookup).toEqual({ kind: 'x-status-lookup', url: rawUrl })

    const runtime = createOrdinaryFeedEditingProposalValidator({ period: fixture.period, editor: fixture.editor })
    expect(runtime.readModelMaterials()).toEqual({ status: 'accepted', value: { materials: modelMaterialsFor() } })
    expect(runtime.validateProposal(editingProposalFor(fixture)).status).toBe('accepted')
  })
})

describe('TODO05 ordinary-feed proposal C10 projection hardening RED', () => {
  it.each(c10MutationCases())('fails closed for malformed authoritative C10: $name', async ({ mutate }) => {
    const fixture = await createOrdinaryFeedFixture()
    const inputs = clonedAcceptedInputs(fixture)
    const first = inputs.find(material => samePeriod(material.period, fixture.period))
    expect(first).toBeDefined()
    mutate(first as unknown as MutableRecord)
    const listAcceptedInputs = vi.fn<OrdinaryFeedEditingProposalEditor['listAcceptedInputs']>(() => inputs)
    const runtime = createOrdinaryFeedEditingProposalValidator({
      period: fixture.period,
      editor: { listAcceptedInputs },
    })
    const proposal = editingProposalFor(fixture)
    const before = snapshotDirectory(fixture.directory)

    expect(runtime.readModelMaterials()).toEqual({ status: 'failed' })
    expect(runtime.validateProposal(proposal)).toEqual({ status: 'failed', input: proposal })
    expect(listAcceptedInputs).toHaveBeenCalledTimes(2)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('accepts one exact nomination value mirrored by material and acceptedIntoPeriod', async () => {
    const fixture = await createOrdinaryFeedFixture()
    const inputs = clonedAcceptedInputs(fixture)
    const first = inputs.find(material => samePeriod(material.period, fixture.period))
    expect(first).toBeDefined()
    const mutable = first as unknown as MutableRecord
    const nomination = { kind: 'fixture-nomination', value: 'same' }
    mutable.nomination = structuredClone(nomination)
    nestedRecord(mutable, 'acceptedIntoPeriod').nomination = structuredClone(nomination)
    const listAcceptedInputs = vi.fn<OrdinaryFeedEditingProposalEditor['listAcceptedInputs']>(() => inputs)
    const runtime = createOrdinaryFeedEditingProposalValidator({
      period: fixture.period,
      editor: { listAcceptedInputs },
    })
    const proposal = editingProposalFor(fixture)
    const before = snapshotDirectory(fixture.directory)

    expect(runtime.readModelMaterials()).toEqual({
      status: 'accepted',
      value: { materials: modelMaterialsFor() },
    })
    expect(runtime.validateProposal(proposal).status).toBe('accepted')
    expect(listAcceptedInputs).toHaveBeenCalledTimes(2)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('fails closed when one exact C10 identity is duplicated as item, candidate, and URL', async () => {
    const fixture = await createOrdinaryFeedFixture()
    const inputs = clonedAcceptedInputs(fixture)
    const first = inputs.find(material => samePeriod(material.period, fixture.period))
    expect(first).toBeDefined()
    inputs.push(structuredClone(first!))
    const listAcceptedInputs = vi.fn<OrdinaryFeedEditingProposalEditor['listAcceptedInputs']>(() => inputs)
    const runtime = createOrdinaryFeedEditingProposalValidator({
      period: fixture.period,
      editor: { listAcceptedInputs },
    })
    const proposal = editingProposalFor(fixture)
    const before = snapshotDirectory(fixture.directory)

    expect(runtime.readModelMaterials()).toEqual({ status: 'failed' })
    expect(runtime.validateProposal(proposal)).toEqual({ status: 'failed', input: proposal })
    expect(listAcceptedInputs).toHaveBeenCalledTimes(2)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })
})

describe('TODO05 ordinary-feed proposal reader and rebuild hardening RED', () => {
  it('classifies a throwing C10 reader as failed without changing durable facts', async () => {
    const fixture = await createOrdinaryFeedFixture()
    const listAcceptedInputs = vi.fn<OrdinaryFeedEditingProposalEditor['listAcceptedInputs']>(() => {
      throw new Error('reader unavailable')
    })
    const runtime = createOrdinaryFeedEditingProposalValidator({
      period: fixture.period,
      editor: { listAcceptedInputs },
    })
    const proposal = editingProposalFor(fixture)
    const before = snapshotDirectory(fixture.directory)

    expect(runtime.readModelMaterials()).toEqual({ status: 'failed' })
    expect(runtime.validateProposal(proposal)).toEqual({ status: 'failed', input: proposal })
    expect(listAcceptedInputs).toHaveBeenCalledTimes(2)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('classifies a nonarray C10 reader result as failed without changing durable facts', async () => {
    const fixture = await createOrdinaryFeedFixture()
    const listAcceptedInputs = vi.fn<OrdinaryFeedEditingProposalEditor['listAcceptedInputs']>(
      () => 'not-an-array' as never,
    )
    const runtime = createOrdinaryFeedEditingProposalValidator({
      period: fixture.period,
      editor: { listAcceptedInputs },
    })
    const proposal = editingProposalFor(fixture)
    const before = snapshotDirectory(fixture.directory)

    expect(runtime.readModelMaterials()).toEqual({ status: 'failed' })
    expect(runtime.validateProposal(proposal)).toEqual({ status: 'failed', input: proposal })
    expect(listAcceptedInputs).toHaveBeenCalledTimes(2)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('re-reads a newly formed same-period C10 and rejects the now-incomplete old proposal', async () => {
    const fixture = await createOrdinaryFeedFixture([
      xItem('1003', 'D newly formed target text', 'dora'),
    ])
    const allInputs = fixture.materials
    const firstView = allInputs.filter(material => material.candidate.candidate !== 'x-status:1003')
    const listAcceptedInputs = vi.fn<OrdinaryFeedEditingProposalEditor['listAcceptedInputs']>(() =>
      listAcceptedInputs.mock.calls.length === 1 ? firstView : allInputs)
    const runtime = createOrdinaryFeedEditingProposalValidator({
      period: fixture.period,
      editor: { listAcceptedInputs },
    })
    const proposal = editingProposalFor(fixture)
    const before = snapshotDirectory(fixture.directory)

    expect(runtime.readModelMaterials()).toEqual({
      status: 'accepted',
      value: { materials: modelMaterialsFor() },
    })
    expect(runtime.validateProposal(proposal)).toEqual({ status: 'rejected', input: proposal })
    expect(runtime.readModelMaterials()).toEqual({
      status: 'accepted',
      value: {
        materials: [
          ...modelMaterialsFor(),
          { itemId: 'item:x-status:1003', text: 'D newly formed target text', authorHandle: 'dora' },
        ],
      },
    })
    expect(listAcceptedInputs).toHaveBeenCalledTimes(3)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('re-reads same-period C10 corruption instead of reusing a successful projection', async () => {
    const fixture = await createOrdinaryFeedFixture()
    const corrupted = clonedAcceptedInputs(fixture)
    const first = corrupted.find(material => samePeriod(material.period, fixture.period))
    expect(first).toBeDefined()
    nestedRecord(first as unknown as MutableRecord, 'boundedContent').extra = true
    const listAcceptedInputs = vi.fn<OrdinaryFeedEditingProposalEditor['listAcceptedInputs']>(() =>
      listAcceptedInputs.mock.calls.length === 1 ? fixture.materials : corrupted)
    const runtime = createOrdinaryFeedEditingProposalValidator({
      period: fixture.period,
      editor: { listAcceptedInputs },
    })
    const proposal = editingProposalFor(fixture)
    const before = snapshotDirectory(fixture.directory)

    expect(runtime.readModelMaterials().status).toBe('accepted')
    expect(runtime.validateProposal(proposal)).toEqual({ status: 'failed', input: proposal })
    expect(listAcceptedInputs).toHaveBeenCalledTimes(2)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('fails when an other-period C10 row is malformed rather than filtering it away', async () => {
    const fixture = await createOrdinaryFeedFixture()
    const corrupted = clonedAcceptedInputs(fixture)
    const other = corrupted.find(material => !samePeriod(material.period, fixture.period))
    expect(other).toBeDefined()
    nestedRecord(other as unknown as MutableRecord, 'boundedContent').extra = true
    const listAcceptedInputs = vi.fn<OrdinaryFeedEditingProposalEditor['listAcceptedInputs']>(() => corrupted)
    const runtime = createOrdinaryFeedEditingProposalValidator({
      period: fixture.period,
      editor: { listAcceptedInputs },
    })
    const proposal = editingProposalFor(fixture)
    const before = snapshotDirectory(fixture.directory)

    expect(runtime.readModelMaterials()).toEqual({ status: 'failed' })
    expect(runtime.validateProposal(proposal)).toEqual({ status: 'failed', input: proposal })
    expect(listAcceptedInputs).toHaveBeenCalledTimes(2)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('returns exact URL-free frozen model material and deep-frozen accepted decisions', async () => {
    const fixture = await createOrdinaryFeedFixture()
    const runtime = createOrdinaryFeedEditingProposalValidator({ period: fixture.period, editor: fixture.editor })
    const before = snapshotDirectory(fixture.directory)

    const modelResult = runtime.readModelMaterials()
    expect(modelResult).toEqual({ status: 'accepted', value: { materials: modelMaterialsFor() } })
    expectDeepFrozen(modelResult)
    if (modelResult.status !== 'accepted') throw new Error('expected accepted model material projection')
    for (const material of modelResult.value.materials) {
      expect(Reflect.ownKeys(material).sort()).toEqual(['authorHandle', 'itemId', 'text'])
      expect('url' in material).toBe(false)
      expect('canonicalUrl' in material).toBe(false)
    }

    const proposalResult = runtime.validateProposal(editingProposalFor(fixture))
    expect(proposalResult.status).toBe('accepted')
    expectDeepFrozen(proposalResult)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })
})

describe('TODO05 ordinary-feed proposal plain-data hardening RED', () => {
  const cases: readonly ProposalNegativeCase[] = [
    {
      name: 'top-level custom prototype',
      mutate: input => { Object.setPrototypeOf(input, { inherited: true }) },
    },
    {
      name: 'section custom prototype',
      mutate: input => { Object.setPrototypeOf(proposalSection(input), { inherited: true }) },
    },
    {
      name: 'item custom prototype',
      mutate: input => { Object.setPrototypeOf(proposalItem(input), { inherited: true }) },
    },
    {
      name: 'decision custom prototype',
      mutate: input => { Object.setPrototypeOf(proposalDecision(input), { inherited: true }) },
    },
    {
      name: 'top-level returning accessor',
      mutate: input => { defineReturningAccessor(input, 'title', input.title) },
    },
    {
      name: 'section returning accessor',
      mutate: input => { defineReturningAccessor(proposalSection(input), 'kind', 'highlight') },
    },
    {
      name: 'item returning accessor',
      mutate: input => { defineReturningAccessor(proposalItem(input), 'summary', 'A target insight') },
    },
    {
      name: 'decision returning accessor',
      mutate: input => { defineReturningAccessor(proposalDecision(input), 'kind', 'selected') },
    },
    {
      name: 'throwing accessor',
      mutate: input => {
        Object.defineProperty(input, 'title', {
          configurable: true,
          enumerable: true,
          get: () => { throw new Error('untrusted getter executed') },
        })
      },
    },
    {
      name: 'top-level symbol field',
      mutate: input => { (input as MutableRecord)[Symbol('extra')] = true },
    },
    {
      name: 'section symbol field',
      mutate: input => { proposalSection(input)[Symbol('extra')] = true },
    },
    {
      name: 'item symbol field',
      mutate: input => { proposalItem(input)[Symbol('extra')] = true },
    },
    {
      name: 'decision symbol field',
      mutate: input => { proposalDecision(input)[Symbol('extra')] = true },
    },
    {
      name: 'sections array extra field',
      mutate: input => { (input.sections as unknown as MutableRecord).extra = true },
    },
    {
      name: 'items array extra field',
      mutate: input => { (proposalSection(input).items as unknown as MutableRecord).extra = true },
    },
    {
      name: 'decisions array extra field',
      mutate: input => { (input.decisions as unknown as MutableRecord).extra = true },
    },
    {
      name: 'sparse sections array',
      mutate: input => { delete (input.sections as unknown[])[0] },
    },
    {
      name: 'sparse items array',
      mutate: input => { delete (proposalSection(input).items as unknown[])[0] },
    },
    {
      name: 'sparse decisions array',
      mutate: input => { delete (input.decisions as unknown[])[0] },
    },
  ]

  it.each(cases)('rejects non-plain proposal data without throwing: $name', async ({ mutate }) => {
    const fixture = await createOrdinaryFeedFixture()
    const listAcceptedInputs = vi.fn<OrdinaryFeedEditingProposalEditor['listAcceptedInputs']>(
      () => fixture.materials,
    )
    const runtime = createOrdinaryFeedEditingProposalValidator({
      period: fixture.period,
      editor: { listAcceptedInputs },
    })
    const input = mutableProposalFor(fixture)
    mutate(input)
    const before = snapshotDirectory(fixture.directory)
    let result: OrdinaryFeedEditingProposalValidationResult | undefined

    expect(() => { result = runtime.validateProposal(input) }).not.toThrow()
    expect(result).toEqual({ status: 'rejected', input })
    expect(listAcceptedInputs).toHaveBeenCalledTimes(1)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })
})

describe('TODO05 ordinary-feed proposal UTF-8 and plain-text hardening RED', () => {
  const boundaries: readonly {
    readonly name: string
    readonly field: ProposalTextField
    readonly bytes: number
    readonly status: 'accepted' | 'rejected'
  }[] = [
    { name: 'title at 160 UTF-8 bytes', field: 'title', bytes: 160, status: 'accepted' },
    { name: 'title at 161 UTF-8 bytes', field: 'title', bytes: 161, status: 'rejected' },
    { name: 'summary at 400 UTF-8 bytes', field: 'summary', bytes: 400, status: 'accepted' },
    { name: 'summary at 401 UTF-8 bytes', field: 'summary', bytes: 401, status: 'rejected' },
    { name: 'semantic reason at 400 UTF-8 bytes', field: 'semanticReason', bytes: 400, status: 'accepted' },
    { name: 'semantic reason at 401 UTF-8 bytes', field: 'semanticReason', bytes: 401, status: 'rejected' },
  ]

  it.each(boundaries)('$status: $name', async ({ field, bytes, status }) => {
    const fixture = await createOrdinaryFeedFixture()
    const runtime = createOrdinaryFeedEditingProposalValidator({ period: fixture.period, editor: fixture.editor })
    const input = mutableProposalFor(fixture)
    setProposalText(input, field, utf8PlainText(bytes))
    const before = snapshotDirectory(fixture.directory)
    const result = runtime.validateProposal(input)

    if (status === 'accepted') expect(result.status).toBe('accepted')
    else expect(result).toEqual({ status: 'rejected', input })
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  const forbidden: readonly {
    readonly name: string
    readonly field: ProposalTextField
    readonly value: string
  }[] = (['title', 'summary', 'semanticReason'] as const).flatMap(field => [
    { name: `${field} URL`, field, value: 'https://x.com/alice/status/1001' },
    { name: `${field} Markdown`, field, value: '**model emphasis**' },
    { name: `${field} control character`, field, value: 'model\u0000text' },
  ])

  it.each(forbidden)('rejects $name as untrusted proposal input', async ({ field, value }) => {
    const fixture = await createOrdinaryFeedFixture()
    const runtime = createOrdinaryFeedEditingProposalValidator({ period: fixture.period, editor: fixture.editor })
    const input = mutableProposalFor(fixture)
    setProposalText(input, field, value)
    const before = snapshotDirectory(fixture.directory)

    expect(runtime.validateProposal(input)).toEqual({ status: 'rejected', input })
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })
})

describe('TODO05 ordinary-feed proposal nomination canonical hardening RED', () => {
  it.each(nominationCanonicalCases())('$expected: $name', async ({ create, expected }) => {
    const fixture = await createOrdinaryFeedFixture()
    const [materialNomination, acceptedNomination] = create()
    const inputs = inputsWithNominations(fixture, materialNomination, acceptedNomination)
    const listAcceptedInputs = vi.fn<OrdinaryFeedEditingProposalEditor['listAcceptedInputs']>(() => inputs)
    const runtime = createOrdinaryFeedEditingProposalValidator({
      period: fixture.period,
      editor: { listAcceptedInputs },
    })
    const proposal = editingProposalFor(fixture)
    const before = snapshotDirectory(fixture.directory)
    const readResult = runtime.readModelMaterials()
    const validationResult = runtime.validateProposal(proposal)

    if (expected === 'accepted') {
      expect(readResult).toEqual({ status: 'accepted', value: { materials: modelMaterialsFor() } })
      expect(validationResult.status).toBe('accepted')
    } else {
      expect(readResult).toEqual({ status: 'failed' })
      expect(validationResult).toEqual({ status: 'failed', input: proposal })
    }
    expect(listAcceptedInputs).toHaveBeenCalledTimes(2)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('rejects nomination accessors without executing either getter', async () => {
    const fixture = await createOrdinaryFeedFixture()
    let getterCalls = 0
    const left: MutableRecord = {}
    const right: MutableRecord = {}
    for (const value of [left, right]) {
      Object.defineProperty(value, 'fact', {
        enumerable: true,
        get: () => {
          getterCalls += 1
          return 'same'
        },
      })
    }
    const inputs = inputsWithNominations(fixture, left, right)
    const listAcceptedInputs = vi.fn<OrdinaryFeedEditingProposalEditor['listAcceptedInputs']>(() => inputs)
    const runtime = createOrdinaryFeedEditingProposalValidator({
      period: fixture.period,
      editor: { listAcceptedInputs },
    })
    const proposal = editingProposalFor(fixture)
    const before = snapshotDirectory(fixture.directory)

    expect(runtime.readModelMaterials()).toEqual({ status: 'failed' })
    expect(runtime.validateProposal(proposal)).toEqual({ status: 'failed', input: proposal })
    expect(getterCalls).toBe(0)
    expect(listAcceptedInputs).toHaveBeenCalledTimes(2)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })
})

describe('TODO05 ordinary-feed C10 plain-owner hardening RED', () => {
  it('rejects a listAcceptedInputs array with a custom prototype', async () => {
    const fixture = await createOrdinaryFeedFixture()
    const inputs = clonedAcceptedInputs(fixture)
    Object.setPrototypeOf(inputs, Object.create(Array.prototype))
    expectC10OwnerFailure(fixture, inputs)
  })

  it('rejects a sparse listAcceptedInputs array', async () => {
    const fixture = await createOrdinaryFeedFixture()
    const inputs = clonedAcceptedInputs(fixture)
    delete inputs[0]
    expectC10OwnerFailure(fixture, inputs)
  })

  it('rejects a listAcceptedInputs array with a string extra key', async () => {
    const fixture = await createOrdinaryFeedFixture()
    const inputs = clonedAcceptedInputs(fixture) as CandidateMaterial[] & { extra?: boolean }
    inputs.extra = true
    expectC10OwnerFailure(fixture, inputs)
  })

  it('rejects a listAcceptedInputs array with a symbol key', async () => {
    const fixture = await createOrdinaryFeedFixture()
    const inputs = clonedAcceptedInputs(fixture) as CandidateMaterial[] & MutableRecord
    inputs[Symbol('extra')] = true
    expectC10OwnerFailure(fixture, inputs)
  })

  it.each(['returning', 'throwing'] as const)('rejects a %s list item accessor without executing it', async kind => {
    const fixture = await createOrdinaryFeedFixture()
    const inputs = clonedAcceptedInputs(fixture)
    const original = inputs[0]
    let calls = 0
    Object.defineProperty(inputs, '0', {
      configurable: true,
      enumerable: true,
      get: () => {
        calls += 1
        if (kind === 'throwing') throw new Error('list getter executed')
        return original
      },
    })
    expectC10OwnerFailure(fixture, inputs, () => calls)
  })

  it.each(c10RecordLevels)('rejects a %s record with a custom prototype', async level => {
    const fixture = await createOrdinaryFeedFixture()
    const inputs = clonedAcceptedInputs(fixture)
    Object.setPrototypeOf(c10RecordAt(firstTargetRecord(fixture, inputs), level), { inherited: true })
    expectC10OwnerFailure(fixture, inputs)
  })

  it.each(c10RecordLevels)('rejects a %s record returning accessor without executing it', async level => {
    const fixture = await createOrdinaryFeedFixture()
    const inputs = clonedAcceptedInputs(fixture)
    const record = c10RecordAt(firstTargetRecord(fixture, inputs), level)
    const key = accessorKeyFor(level)
    const original = record[key]
    let calls = 0
    Object.defineProperty(record, key, {
      configurable: true,
      enumerable: true,
      get: () => {
        calls += 1
        return original
      },
    })
    expectC10OwnerFailure(fixture, inputs, () => calls)
  })

  it.each(c10RecordLevels)('rejects a %s record throwing accessor without executing it', async level => {
    const fixture = await createOrdinaryFeedFixture()
    const inputs = clonedAcceptedInputs(fixture)
    const record = c10RecordAt(firstTargetRecord(fixture, inputs), level)
    const key = accessorKeyFor(level)
    let calls = 0
    Object.defineProperty(record, key, {
      configurable: true,
      enumerable: true,
      get: () => {
        calls += 1
        throw new Error('C10 getter executed')
      },
    })
    expectC10OwnerFailure(fixture, inputs, () => calls)
  })

  it.each(c10RecordLevels)('keeps a %s symbol extra fail-closed', async level => {
    const fixture = await createOrdinaryFeedFixture()
    const inputs = clonedAcceptedInputs(fixture)
    c10RecordAt(firstTargetRecord(fixture, inputs), level)[Symbol('extra')] = true
    expectC10OwnerFailure(fixture, inputs)
  })

  it.each(['custom prototype', 'sparse', 'extra', 'symbol', 'returning accessor', 'throwing accessor'] as const)(
    'rejects a media array with %s without executing accessors',
    async kind => {
      const fixture = await createOrdinaryFeedFixture()
      const inputs = clonedAcceptedInputs(fixture)
      const bounded = nestedRecord(firstTargetRecord(fixture, inputs), 'boundedContent')
      const media = ['https://example.invalid/media'] as string[] & MutableRecord
      let calls = 0
      if (kind === 'custom prototype') Object.setPrototypeOf(media, Object.create(Array.prototype))
      else if (kind === 'sparse') delete media[0]
      else if (kind === 'extra') media.extra = true
      else if (kind === 'symbol') media[Symbol('extra')] = true
      else {
        const original = media[0]
        Object.defineProperty(media, '0', {
          configurable: true,
          enumerable: true,
          get: () => {
            calls += 1
            if (kind === 'throwing accessor') throw new Error('media getter executed')
            return original
          },
        })
      }
      bounded.media = media
      expectC10OwnerFailure(fixture, inputs, () => calls)
    },
  )

  it.each([
    ['material returning accessor', 'material', 'returning'],
    ['material throwing accessor', 'material', 'throwing'],
    ['accepted returning accessor', 'accepted', 'returning'],
    ['accepted throwing accessor', 'accepted', 'throwing'],
    ['material nonenumerable data property', 'material', 'nonenumerable'],
    ['accepted nonenumerable data property', 'accepted', 'nonenumerable'],
  ] as const)('rejects a nomination %s without executing accessors', async (_name, side, kind) => {
    const fixture = await createOrdinaryFeedFixture()
    const inputs = clonedAcceptedInputs(fixture)
    const material = firstTargetRecord(fixture, inputs)
    const accepted = nestedRecord(material, 'acceptedIntoPeriod')
    const nomination = { fact: 'same' }
    material.nomination = structuredClone(nomination)
    accepted.nomination = structuredClone(nomination)
    const owner = side === 'material' ? material : accepted
    let calls = 0
    Object.defineProperty(owner, 'nomination', {
      configurable: true,
      enumerable: kind !== 'nonenumerable',
      ...(kind === 'nonenumerable'
        ? { writable: true, value: structuredClone(nomination) }
        : {
            get: () => {
              calls += 1
              if (kind === 'throwing') throw new Error('nomination getter executed')
              return structuredClone(nomination)
            },
          }),
    })
    expectC10OwnerFailure(fixture, inputs, () => calls)
  })

  it('accepts ordinary C10 records whose direct prototype is null', async () => {
    const fixture = await createOrdinaryFeedFixture()
    const inputs = clonedAcceptedInputs(fixture)
    const material = firstTargetRecord(fixture, inputs)
    const accepted = nestedRecord(material, 'acceptedIntoPeriod')
    for (const record of [
      material,
      nestedRecord(material, 'period'),
      nestedRecord(material, 'candidate'),
      accepted,
      nestedRecord(accepted, 'period'),
      nestedRecord(accepted, 'candidate'),
      nestedRecord(material, 'boundedContent'),
      nestedRecord(material, 'attribution'),
      nestedRecord(material, 'exactLookup'),
    ]) Object.setPrototypeOf(record, null)
    const nominationLeft = Object.assign(Object.create(null), { fact: 'same' })
    const nominationRight = Object.assign(Object.create(null), { fact: 'same' })
    material.nomination = nominationLeft
    accepted.nomination = nominationRight
    const listAcceptedInputs = vi.fn<OrdinaryFeedEditingProposalEditor['listAcceptedInputs']>(() => inputs)
    const runtime = createOrdinaryFeedEditingProposalValidator({
      period: fixture.period,
      editor: { listAcceptedInputs },
    })
    const proposal = editingProposalFor(fixture)
    const before = snapshotDirectory(fixture.directory)

    expect(runtime.readModelMaterials()).toEqual({ status: 'accepted', value: { materials: modelMaterialsFor() } })
    expect(runtime.validateProposal(proposal).status).toBe('accepted')
    expect(listAcceptedInputs).toHaveBeenCalledTimes(2)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })
})
