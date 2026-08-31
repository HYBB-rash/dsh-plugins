import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

type Lane = 'long_term_interest' | 'existing_knowledge'
type Operation = 'assert' | 'confirm' | 'correct' | 'replace' | 'retract'
type Span = { readonly startUtf16: number; readonly endUtf16: number }
type ProtectedSpans = {
  readonly subject: readonly Span[]
  readonly polarity: readonly Span[]
  readonly conditions: readonly Span[]
  readonly modality: readonly Span[]
  readonly attribution: readonly Span[]
  readonly temporal: readonly Span[]
  readonly applicability: readonly Span[]
}
type Attitude = {
  readonly speaker: 'user' | 'other' | 'ambiguous'
  readonly polarity: 'affirmed' | 'denied'
  readonly modality: 'committed' | 'uncertain' | 'hypothetical'
  readonly attribution: 'own_statement' | 'reported_statement' | 'mere_mention'
  readonly temporal: 'current' | 'future' | 'past' | 'unspecified'
  readonly qualification: 'unqualified' | 'conditioned' | 'scope_limited'
}
type Evidence = {
  readonly sourceKey: string
  readonly evidenceSpan: Span
  readonly exactEvidenceText: string
  readonly focusSpanWithinEvidence: Span
  readonly protectedSpansWithinEvidence: ProtectedSpans
  readonly attitude: Attitude
}
type Fact =
  | { readonly lane: 'long_term_interest'; readonly stance: 'include' | 'exclude'; readonly evidence: Evidence; readonly useAuthorization: UseAuthorization }
  | { readonly lane: 'existing_knowledge'; readonly epistemic: 'asserted' | 'uncertain'; readonly evidence: Evidence; readonly useAuthorization: UseAuthorization }
type ActiveFact = { readonly factId: string; readonly fact: Fact; readonly basisRevisionIds: readonly string[] }
type Proposal = {
  readonly lane: Lane
  readonly stance?: 'include' | 'exclude'
  readonly epistemic?: 'asserted' | 'uncertain'
  readonly focusSpan: Span
  readonly protectedSpans: ProtectedSpans
  readonly attitude: Attitude
  readonly operation: Operation
  readonly targetFactIds: readonly string[]
}
type UseAuthorization = {
  readonly policyId: 'personal-feed-direct-telegram-v1'
  readonly purpose: 'personal_feed_context'
  readonly sourceKind: 'telegram_inbound'
}
type ClassifierInput = {
  readonly sourceKey: string
  readonly rawText: string
  readonly useAuthorization: UseAuthorization
  readonly activeFacts: readonly ActiveFact[]
}
type RevisionInput = {
  readonly operation: Operation
  readonly targetFacts: readonly ActiveFact[]
  readonly priorActiveFacts: readonly ActiveFact[]
}
type EntailmentInput = {
  readonly fullRawText: string
  readonly evidenceSpan: Span
  readonly exactEvidenceText: string
  readonly target: {
    readonly focusSpanWithinEvidence: Span
    readonly exactFocusText: string
    readonly protectedSpansWithinEvidence: ProtectedSpans
  }
  readonly canonicalFact: { readonly lane: Lane; readonly stance?: 'include' | 'exclude'; readonly epistemic?: 'asserted' | 'uncertain'; readonly attitude: Attitude }
  readonly revision: RevisionInput
}
type SemanticPorts = {
  readonly classifier: (input: ClassifierInput) => unknown | Promise<unknown>
  readonly entailmentValidator: (input: EntailmentInput) => unknown | Promise<unknown>
  readonly noFactValidator: (input: unknown) => unknown | Promise<unknown>
}
type Fence = {
  readonly schemaVersion: number
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
  readonly storeId: string
  readonly maxCaptureSequence: number
  readonly maxTerminalTransactionSequence: number
  readonly digest: string
}
type Coverage = { readonly sourceKey: string; readonly status: string; readonly [key: string]: unknown }
type Owner = {
  readonly capture: (input: { readonly locator: { readonly kind: 'telegram_inbound'; readonly chatId: number; readonly messageId: number }; readonly rawText: string; readonly reference: null; readonly excludedRequestId?: string }) => { readonly source: { readonly sourceKey: string; readonly captureSequence: number; readonly occurredAt: string }; readonly coverage: Coverage }
  readonly settle: (input: { readonly sourceKey: string }) => Promise<Coverage>
  readonly freezeFence: (input: { readonly request: { readonly requestId: string; readonly cutoff: string; readonly shanghaiDay: string } }) => Fence
  readonly snapshot: (input: { readonly fence: Fence }) => unknown
  readonly read: () => { readonly sources: readonly { readonly sourceKey: string; readonly rawText: string | null; readonly captureSequence: number }[]; readonly coverage: readonly Coverage[] }
  readonly close: () => void
}
type ProductionModule = {
  readonly createPersonalContextOwner?: (options: { readonly databasePath: string; readonly clock: { readonly now: () => Date }; readonly semantics: SemanticPorts }) => Owner
}

const temporaryDirectories: string[] = []
const authorization: UseAuthorization = {
  policyId: 'personal-feed-direct-telegram-v1', purpose: 'personal_feed_context', sourceKind: 'telegram_inbound',
}
const approved = { kind: 'target_and_revision_confirmed' } as const
const confirmedNoFact = { kind: 'confirmed_no_fact' } as const
const attitude: Attitude = {
  speaker: 'user', polarity: 'affirmed', modality: 'committed', attribution: 'own_statement', temporal: 'current', qualification: 'unqualified',
}
const digestPattern = /^sha256:[0-9a-f]{64}$/

function protectedSpans(subject: readonly Span[] = []): ProtectedSpans {
  return { subject, polarity: [], conditions: [], modality: [], attribution: [], temporal: [], applicability: [] }
}

function exactKeys(value: unknown, keys: readonly string[]): void {
  expect(value).toBeTypeOf('object')
  expect(value).not.toBeNull()
  expect(Object.keys(value as object).sort()).toEqual([...keys].sort())
}

function interest(rawText: string, focus: string, operation: Operation = 'assert', targetFactIds: readonly string[] = [], stance: 'include' | 'exclude' = 'include'): Proposal {
  const startUtf16 = rawText.indexOf(focus)
  if (startUtf16 < 0) throw new Error(`missing fixture focus: ${focus}`)
  const subjectStart = rawText.lastIndexOf('我', startUtf16)
  const proposalProtectedSpans = protectedSpans(subjectStart < 0 ? [] : [{ startUtf16: subjectStart, endUtf16: subjectStart + 1 }])
  const denialStart = stance === 'exclude' ? rawText.indexOf('不再') : -1
  return {
    lane: 'long_term_interest',
    stance,
    focusSpan: { startUtf16, endUtf16: startUtf16 + focus.length },
    protectedSpans: denialStart < 0
      ? proposalProtectedSpans
      : { ...proposalProtectedSpans, polarity: [{ startUtf16: denialStart, endUtf16: denialStart + 2 }] },
    attitude: stance === 'exclude' ? { ...attitude, polarity: 'denied' } : attitude,
    operation,
    targetFactIds,
  }
}

function knowledge(rawText: string, focus: string, operation: Operation = 'assert', targetFactIds: readonly string[] = [], epistemic: 'asserted' | 'uncertain' = 'asserted'): Proposal {
  const startUtf16 = rawText.indexOf(focus)
  if (startUtf16 < 0) throw new Error(`missing fixture focus: ${focus}`)
  const subjectStart = rawText.lastIndexOf('我', startUtf16)
  return { lane: 'existing_knowledge', epistemic, focusSpan: { startUtf16, endUtf16: startUtf16 + focus.length }, protectedSpans: protectedSpans(subjectStart < 0 ? [] : [{ startUtf16: subjectStart, endUtf16: subjectStart + 1 }]), attitude: epistemic === 'uncertain' ? { ...attitude, modality: 'uncertain' } : attitude, operation, targetFactIds }
}

function facts(...values: readonly Proposal[]): unknown {
  return { kind: 'facts', facts: values }
}

function noFact(): unknown {
  return { kind: 'no_fact', reason: 'not_personal_fact' }
}

async function production(): Promise<ProductionModule> {
  return await import('../src/index.ts') as ProductionModule
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-revisions-'))
  temporaryDirectories.push(directory)
  return join(directory, 'context.sqlite')
}

async function ownerWith(
  classifier: SemanticPorts['classifier'],
  options: { readonly path?: string; readonly clock?: () => Date; readonly validator?: SemanticPorts['entailmentValidator'] } = {},
): Promise<{ readonly owner: Owner; readonly path: string }> {
  const module = await production()
  expect(typeof module.createPersonalContextOwner).toBe('function')
  if (typeof module.createPersonalContextOwner !== 'function') throw new Error('createPersonalContextOwner is unavailable')
  const path = options.path ?? databasePath()
  return {
    path,
    owner: module.createPersonalContextOwner({
      databasePath: path,
      clock: { now: options.clock ?? (() => new Date('2026-08-31T12:00:00.000Z')) },
      semantics: {
        classifier,
        entailmentValidator: options.validator ?? (() => approved),
        noFactValidator: () => confirmedNoFact,
      },
    }),
  }
}

function capture(owner: Owner, rawText: string, messageId: number, excludedRequestId?: string): { readonly sourceKey: string; readonly captureSequence: number } {
  const result = owner.capture({
    locator: { kind: 'telegram_inbound', chatId: 812, messageId }, rawText, reference: null,
    ...(excludedRequestId === undefined ? {} : { excludedRequestId }),
  })
  return result.source
}

function requestId(messageId: number): string {
  return `telegram:812:${messageId}`
}

function freeze(owner: Owner, messageId: number, cutoff = '2026-08-31T13:00:00.000+08:00', shanghaiDay = '2026-08-31'): Fence {
  return owner.freezeFence({ request: { requestId: requestId(messageId), cutoff, shanghaiDay } })
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('expected record')
  return value as Record<string, unknown>
}

function sufficient(value: unknown): Record<string, unknown> {
  const result = asRecord(value)
  expect(result.kind).toBe('sufficient')
  exactKeys(result, ['kind', 'snapshot'])
  return asRecord(result.snapshot)
}

function proofOf(value: unknown): Record<string, unknown> {
  const result = asRecord(value)
  if (result.kind === 'sufficient') return asRecord(asRecord(result.snapshot).proof)
  return asRecord(result.proof)
}

function revisionEntries(value: unknown): readonly Record<string, unknown>[] {
  const revisions = asRecord(proofOf(value).revisions)
  return revisions.entries as readonly Record<string, unknown>[]
}

function assertDigest(value: unknown): void {
  expect(value).toBeTypeOf('string')
  expect(value).toMatch(digestPattern)
}

function mutatePersistedText(
  path: string,
  candidate: (columnName: string, value: string) => string | undefined,
): boolean {
  const database = new DatabaseSync(path)
  try {
    const tables = (database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ readonly name: string }>).map(row => row.name)
    for (const table of tables) {
      const quotedTable = `"${table.replaceAll('"', '""')}"`
      const columns = database.prepare(`PRAGMA table_info(${quotedTable})`).all() as Array<{ readonly name: string }>
      for (const column of columns) {
        const quotedColumn = `"${column.name.replaceAll('"', '""')}"`
        let rows: Array<{ readonly rowid: number; readonly value: unknown }>
        try {
          rows = database.prepare(`SELECT rowid, ${quotedColumn} AS value FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL`).all() as Array<{ readonly rowid: number; readonly value: unknown }>
        } catch {
          continue
        }
        for (const row of rows) {
          if (typeof row.value !== 'string') continue
          const replacement = candidate(column.name, row.value)
          if (replacement === undefined || replacement === row.value) continue
          database.prepare(`UPDATE ${quotedTable} SET ${quotedColumn} = ? WHERE rowid = ?`).run(replacement, row.rowid)
          return true
        }
      }
    }
    return false
  } finally {
    database.close()
  }
}

async function settleNoFactCurrent(owner: Owner, messageId: number): Promise<{ readonly fence: Fence; readonly result: unknown }> {
  const current = capture(owner, `本次请求 ${messageId} 不含个人事实`, messageId, requestId(messageId))
  const fence = freeze(owner, messageId)
  await owner.settle({ sourceKey: current.sourceKey })
  return { fence, result: owner.snapshot({ fence }) }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Personal Feed v2 group 3 revision fold and causal snapshot', () => {
  it('atomically asserts both lanes and returns one exact sufficient composite while the excluded current source settles only for a future request', async () => {
    const initialRaw = '我关注主题 A；我知道命题 P'
    const currentRaw = '我仍然关注主题 A'
    const classifierInputs: ClassifierInput[] = []
    const validatorInputs: EntailmentInput[] = []
    const fixture = await ownerWith(input => {
      classifierInputs.push(input)
      exactKeys(input, ['sourceKey', 'rawText', 'useAuthorization', 'activeFacts'])
      expect(input.useAuthorization).toEqual(authorization)
      if (input.rawText === initialRaw) return facts(interest(initialRaw, '主题 A'), knowledge(initialRaw, '命题 P'))
      if (input.rawText === currentRaw) {
        const target = input.activeFacts.find(value => value.fact.lane === 'long_term_interest')
        expect(target).toBeDefined()
        return facts(interest(currentRaw, '主题 A', 'confirm', [target!.factId]))
      }
      return noFact()
    }, {
      validator: input => {
        validatorInputs.push(input)
        exactKeys(input, ['fullRawText', 'evidenceSpan', 'exactEvidenceText', 'target', 'canonicalFact', 'revision'])
        exactKeys(input.revision, ['operation', 'targetFacts', 'priorActiveFacts'])
        return approved
      },
    })
    const initial = capture(fixture.owner, initialRaw, 1)
    const initialTerminal = await fixture.owner.settle({ sourceKey: initial.sourceKey })
    exactKeys(initialTerminal, ['sourceKey', 'status', 'disposition', 'terminalTransactionSequence', 'dispositionDigest', 'revisionDigest'])
    const current = capture(fixture.owner, currentRaw, 2, requestId(2))
    const fence = freeze(fixture.owner, 2)
    exactKeys(fence, ['schemaVersion', 'requestId', 'cutoff', 'shanghaiDay', 'storeId', 'maxCaptureSequence', 'maxTerminalTransactionSequence', 'digest'])
    expect(fence.maxCaptureSequence).toBe(current.captureSequence)
    const currentTerminal = await fixture.owner.settle({ sourceKey: current.sourceKey })
    const result = fixture.owner.snapshot({ fence })
    const snapshot = sufficient(result)

    exactKeys(snapshot, ['schemaVersion', 'fence', 'contextCutId', 'longTermInterest', 'existingKnowledge', 'proof', 'digest'])
    expect(snapshot.fence).toEqual(fence)
    assertDigest(snapshot.contextCutId)
    assertDigest(snapshot.digest)
    for (const [key, lane] of [['longTermInterest', 'long_term_interest'], ['existingKnowledge', 'existing_knowledge']] as const) {
      const laneResult = asRecord(snapshot[key])
      exactKeys(laneResult, ['lane', 'contextCutId', 'activeFacts', 'sufficiency', 'digest'])
      expect(laneResult.lane).toBe(lane)
      expect(laneResult.contextCutId).toBe(snapshot.contextCutId)
      assertDigest(laneResult.digest)
      const activeFacts = laneResult.activeFacts as readonly ActiveFact[]
      expect(activeFacts).toHaveLength(1)
      exactKeys(activeFacts[0], ['factId', 'fact', 'basisRevisionIds'])
      expect(activeFacts[0]!.fact.lane).toBe(lane)
      expect(activeFacts[0]!.fact.evidence.exactEvidenceText).toContain(lane === 'long_term_interest' ? '主题 A' : '命题 P')
      const sufficiency = asRecord(laneResult.sufficiency)
      exactKeys(sufficiency, ['status', 'basisFactIds'])
      expect(sufficiency).toEqual({ status: 'sufficient', basisFactIds: [activeFacts[0]!.factId] })
    }
    const proof = asRecord(snapshot.proof)
    exactKeys(proof, ['fenceDigest', 'coverage', 'revisions', 'currentSource'])
    expect(proof.fenceDigest).toBe(fence.digest)
    const currentProof = asRecord(proof.currentSource)
    exactKeys(currentProof, ['status', 'sourceKey', 'excludedRequestId', 'captureSequence', 'terminalTransactionSequence', 'dispositionDigest', 'revisionDigest', 'digest'])
    expect(currentProof).toMatchObject({ status: 'settled_for_future_request', sourceKey: current.sourceKey, excludedRequestId: requestId(2), captureSequence: current.captureSequence })
    expect(currentProof.terminalTransactionSequence).toBe(currentTerminal.terminalTransactionSequence)
    expect(revisionEntries(result)).toHaveLength(2)
    expect(classifierInputs[0]!.activeFacts).toEqual([])
    expect(classifierInputs[1]!.activeFacts).toHaveLength(2)
    expect(validatorInputs.map(input => input.revision.operation)).toEqual(['assert', 'assert', 'confirm'])
    expect(validatorInputs[0]!.revision).toEqual({ operation: 'assert', targetFacts: [], priorActiveFacts: [] })
    expect(validatorInputs[1]!.revision).toEqual({ operation: 'assert', targetFacts: [], priorActiveFacts: [] })
    expect(validatorInputs[2]!.revision.targetFacts).toEqual([classifierInputs[1]!.activeFacts.find(value => value.fact.lane === 'long_term_interest')])
    expect(validatorInputs[2]!.revision.priorActiveFacts).toEqual(classifierInputs[1]!.activeFacts.filter(value => value.fact.lane === 'long_term_interest'))
    expect(JSON.stringify({ classifierInputs, validatorInputs })).not.toMatch(/proposition|scope|topic|summary|reasoning|currentFactId/)
    fixture.owner.close()
  })

  it('folds assert, confirm, correct, replace, and retract with exact identity, basis, retirement, and operation history', async () => {
    const operations: Operation[] = ['assert', 'confirm', 'correct', 'replace', 'retract']
    let step = 0
    const activeSeen: readonly ActiveFact[][] = []
    const seen: ActiveFact[][] = activeSeen as ActiveFact[][]
    const fixture = await ownerWith(input => {
      seen.push([...input.activeFacts])
      if (step >= operations.length) return noFact()
      const operation = operations[step++]!
      const targets = operation === 'assert' ? [] : input.activeFacts.map(value => value.factId)
      return facts(interest(input.rawText, `主题 ${step}`, operation, targets))
    })
    for (let messageId = 10; messageId < 15; messageId += 1) {
      const source = capture(fixture.owner, `我关注主题 ${messageId - 9}`, messageId)
      await expect(fixture.owner.settle({ sourceKey: source.sourceKey })).resolves.toMatchObject({ status: 'applied' })
    }
    const observer = capture(fixture.owner, '本条仅观察 active facts', 15)
    await fixture.owner.settle({ sourceKey: observer.sourceKey })
    expect(seen[0]).toEqual([])
    expect(seen[1]).toHaveLength(1)
    expect(seen[2]![0]!.factId).toBe(seen[1]![0]!.factId)
    expect(seen[2]![0]!.basisRevisionIds).toHaveLength(2)
    expect(seen[3]).toHaveLength(1)
    expect(seen[3]![0]!.factId).not.toBe(seen[2]![0]!.factId)
    expect(seen[4]).toHaveLength(1)
    expect(seen[4]![0]!.factId).not.toBe(seen[3]![0]!.factId)
    expect(seen[5]).toEqual([])

    const current = capture(fixture.owner, '当前请求无事实', 16, requestId(16))
    const fence = freeze(fixture.owner, 16)
    await fixture.owner.settle({ sourceKey: current.sourceKey })
    const result = fixture.owner.snapshot({ fence })
    const entries = revisionEntries(result).slice(0, 5)
    expect(entries.map(entry => entry.operation)).toEqual(operations)
    for (const entry of entries) exactKeys(entry, ['revisionId', 'currentFactId', 'sourceKey', 'factOrdinal', 'lane', 'operation', 'targetFactIds', 'terminalTransactionSequence', 'validationInputDigest', 'operationDigest'])
    expect(entries[0]!.targetFactIds).toEqual([])
    expect(entries[1]!.currentFactId).toBe(entries[0]!.currentFactId)
    expect(entries[1]!.targetFactIds).toEqual([entries[0]!.currentFactId])
    expect(entries[2]!.targetFactIds).toEqual([entries[0]!.currentFactId])
    expect(entries[2]!.currentFactId).not.toBe(entries[0]!.currentFactId)
    expect(entries[3]!.targetFactIds).toEqual([entries[2]!.currentFactId])
    expect(entries[4]!.targetFactIds).toEqual([entries[3]!.currentFactId])
    fixture.owner.close()
  })

  it('rejects invalid target relations, generated text, and unresolved prior coverage atomically with raw input and zero partial terminal transaction', async () => {
    const cases = ['bad', 'unknown', 'future', 'inactive', 'cross-lane', 'duplicate', 'incomplete', 'extra-text', 'prior-pending'] as const
    for (const [caseIndex, name] of cases.entries()) {
      let phase: 'seed' | 'retire' | 'future-seed' | 'probe' | 'bad' = 'seed'
      let retiredFactId: string | undefined
      let futureFactId: string | undefined
      let futureSourceKey: string | undefined
      let badClassifierCalls = 0
      let incompleteRevisionValidated = false
      const fixture = await ownerWith(input => {
        const interestFacts = input.activeFacts.filter(value => value.fact.lane === 'long_term_interest')
        const knowledgeFact = input.activeFacts.find(value => value.fact.lane === 'existing_knowledge')
        if (phase === 'seed') {
          if (input.rawText.endsWith('A')) return facts(interest(input.rawText, 'A'))
          if (input.rawText.endsWith('B')) return facts(interest(input.rawText, 'B'))
          return facts(knowledge(input.rawText, 'P'))
        }
        if (phase === 'retire') {
          retiredFactId = interestFacts[0]!.factId
          return facts(interest(input.rawText, 'C', 'correct', [retiredFactId]))
        }
        if (phase === 'future-seed') {
          return facts(interest(input.rawText, 'F'))
        }
        if (phase === 'probe') {
          futureFactId = interestFacts.find(value => value.fact.evidence.sourceKey === futureSourceKey)?.factId
          expect(futureFactId).toMatch(digestPattern)
          return noFact()
        }
        badClassifierCalls += 1
        if (name === 'prior-pending') return facts(interest(input.rawText, 'Z'))
        if (name === 'future') {
          expect(futureFactId).toMatch(digestPattern)
        }
        const base = interest(input.rawText, 'Z', 'replace', interestFacts.map(value => value.factId))
        const bad = name === 'bad'
          ? { ...base, targetFactIds: ['not-a-fact-id'] }
          : name === 'unknown'
          ? { ...base, targetFactIds: [`sha256:${'f'.repeat(64)}`] }
          : name === 'future'
            ? { ...base, operation: 'confirm' as const, targetFactIds: [futureFactId!] }
            : name === 'inactive'
              ? { ...base, operation: 'confirm' as const, targetFactIds: [retiredFactId!] }
              : name === 'cross-lane'
                ? { ...base, operation: 'confirm' as const, targetFactIds: [knowledgeFact!.factId] }
                : name === 'duplicate'
                  ? { ...base, targetFactIds: [interestFacts[0]!.factId, interestFacts[0]!.factId] }
                  : name === 'incomplete'
                    ? { ...base, targetFactIds: [interestFacts[0]!.factId] }
                    : { ...base, proposition: 'generated', summary: 'generated', reasoning: 'generated' }
        return facts(knowledge(input.rawText, 'R'), bad)
      }, {
        validator: input => {
          if (name === 'incomplete'
            && input.canonicalFact.lane === 'long_term_interest'
            && input.revision.operation === 'replace') {
            incompleteRevisionValidated = true
            expect(input.revision.targetFacts).toHaveLength(1)
            expect(input.revision.priorActiveFacts).toHaveLength(2)
            return { kind: 'unknown' }
          }
          return approved
        },
      })
      const baseId = 100 + caseIndex * 10
      for (const [rawText, offset] of [['我关注 A', 0], ['我关注 B', 1], ['我知道 P', 2]] as const) {
        const seed = capture(fixture.owner, rawText, baseId + offset)
        await fixture.owner.settle({ sourceKey: seed.sourceKey })
      }
      if (name === 'inactive') {
        phase = 'retire'
        const retire = capture(fixture.owner, '我改为关注 C', baseId + 3)
        await fixture.owner.settle({ sourceKey: retire.sourceKey })
        expect(retiredFactId).toMatch(digestPattern)
      }
      let badSource: { readonly sourceKey: string; readonly captureSequence: number }
      if (name === 'future') {
        badSource = capture(fixture.owner, '我仍关注 Z；我知道 R', baseId + 4)
        phase = 'future-seed'
        const later = capture(fixture.owner, '我关注 F', baseId + 5)
        futureSourceKey = later.sourceKey
        await fixture.owner.settle({ sourceKey: later.sourceKey })
        phase = 'probe'
        const probe = capture(fixture.owner, '仅探测 owner active facts', baseId + 6)
        await fixture.owner.settle({ sourceKey: probe.sourceKey })
        expect(futureFactId).toMatch(digestPattern)
        phase = 'bad'
        // The later fact is owner-provided and active, but is causally in the bad source's future.
        expect(later.captureSequence).toBeGreaterThan(badSource.captureSequence)
      } else {
        if (name === 'prior-pending') capture(fixture.owner, '更早普通来源仍待分类', baseId + 4)
        badSource = capture(fixture.owner, '我仍关注 Z；我知道 R', baseId + 5)
        phase = 'bad'
      }
      const before = freeze(fixture.owner, 900 + caseIndex)
      const result = await fixture.owner.settle({ sourceKey: badSource.sourceKey })
      expect(result, name).toMatchObject({ sourceKey: badSource.sourceKey, status: 'pending' })
      const state = fixture.owner.read()
      expect(state.sources.find(value => value.sourceKey === badSource.sourceKey)?.rawText, name).toBe('我仍关注 Z；我知道 R')
      expect(state.coverage.find(value => value.sourceKey === badSource.sourceKey), name).toEqual({ sourceKey: badSource.sourceKey, status: 'pending' })
      const after = fixture.owner.freezeFence({ request: { requestId: before.requestId, cutoff: before.cutoff, shanghaiDay: before.shanghaiDay } })
      expect(after.maxTerminalTransactionSequence, name).toBe(before.maxTerminalTransactionSequence)
      if (name === 'prior-pending') expect(badClassifierCalls).toBe(0)
      if (name === 'incomplete') expect(incompleteRevisionValidated).toBe(true)
      fixture.owner.close()
    }
  })

  it('persists a byte-equivalent request fence, conflicts changed request coordinates, and rejects tampered or unpersisted fences', async () => {
    const fixture = await ownerWith(() => noFact())
    const current = capture(fixture.owner, '当前无事实', 301, requestId(301))
    const fence = freeze(fixture.owner, 301)
    await fixture.owner.settle({ sourceKey: current.sourceKey })
    const first = fixture.owner.snapshot({ fence })
    const later = capture(fixture.owner, '稍后无关来源', 302)
    await fixture.owner.settle({ sourceKey: later.sourceKey })
    expect(JSON.stringify(fixture.owner.snapshot({ fence }))).toBe(JSON.stringify(first))
    expect(() => freeze(fixture.owner, 301, '2026-08-31T14:00:00.000+08:00')).toThrow()
    expect(() => freeze(fixture.owner, 301, fence.cutoff, '2026-09-01')).toThrow()
    expect(() => fixture.owner.snapshot({ fence: { ...fence, maxCaptureSequence: fence.maxCaptureSequence + 1 } })).toThrow()
    expect(() => fixture.owner.snapshot({ fence: { ...fence, requestId: requestId(999), digest: `sha256:${'0'.repeat(64)}` } })).toThrow()
    fixture.owner.close()
  })

  it('keeps an ordinary pre-fence source terminalled after the fence unknown forever and includes it only in a later sequence fence', async () => {
    const times = [new Date('2099-01-01T00:00:00.000Z'), new Date('1900-01-01T00:00:00.000Z'), new Date('1800-01-01T00:00:00.000Z')]
    const fixture = await ownerWith(input => input.rawText.includes('ordinary')
      ? facts(interest(input.rawText, 'A'), knowledge(input.rawText, 'P'))
      : noFact(), { clock: () => times.shift() ?? new Date('1700-01-01T00:00:00.000Z') })
    const ordinary = capture(fixture.owner, 'ordinary 我关注 A 且知道 P', 401)
    const oldCurrent = capture(fixture.owner, '旧请求无事实', 402, requestId(402))
    const oldFence = freeze(fixture.owner, 402, '2026-08-31T13:00:00.000+08:00')
    await fixture.owner.settle({ sourceKey: oldCurrent.sourceKey })
    expect(asRecord(fixture.owner.snapshot({ fence: oldFence })).kind).toBe('unknown')
    expect(asRecord(fixture.owner.snapshot({ fence: oldFence })).reason).toBe('unknown_at_fence')
    await fixture.owner.settle({ sourceKey: ordinary.sourceKey })
    const oldAfterSettlement = fixture.owner.snapshot({ fence: oldFence })
    expect(asRecord(oldAfterSettlement)).toMatchObject({ kind: 'unknown', reason: 'unknown_at_fence' })
    expect(asRecord(asRecord(proofOf(oldAfterSettlement).coverage)).unknownAtFenceSourceKeys).toContain(ordinary.sourceKey)

    const laterCurrent = capture(fixture.owner, '后续请求无事实', 403, requestId(403))
    const laterFence = freeze(fixture.owner, 403)
    await fixture.owner.settle({ sourceKey: laterCurrent.sourceKey })
    expect(asRecord(fixture.owner.snapshot({ fence: laterFence })).kind).toBe('sufficient')
    expect(ordinary.captureSequence).toBeLessThan(laterCurrent.captureSequence)
    fixture.owner.close()
  })

  it('treats the excluded current mixed source as the sole terminal-after-fence exception and exposes pending or failed current sources as unknown', async () => {
    const initialRaw = '我关注 A；我知道 P'
    const mixedRaw = '我关注 B；我知道 Q'
    const fixture = await ownerWith(input => {
      if (input.rawText === initialRaw) return facts(interest(initialRaw, 'A'), knowledge(initialRaw, 'P'))
      if (input.rawText === mixedRaw) return facts(interest(mixedRaw, 'B'), knowledge(mixedRaw, 'Q'))
      return noFact()
    })
    const initial = capture(fixture.owner, initialRaw, 501)
    await fixture.owner.settle({ sourceKey: initial.sourceKey })
    const mixed = capture(fixture.owner, mixedRaw, 502, requestId(502))
    const oldFence = freeze(fixture.owner, 502)
    await fixture.owner.settle({ sourceKey: mixed.sourceKey })
    const oldResult = fixture.owner.snapshot({ fence: oldFence })
    expect(revisionEntries(oldResult)).toHaveLength(2)
    expect(asRecord(proofOf(oldResult).currentSource).status).toBe('settled_for_future_request')
    const next = await settleNoFactCurrent(fixture.owner, 503)
    expect(revisionEntries(next.result)).toHaveLength(4)
    fixture.owner.close()

    for (const mode of ['pending', 'failed'] as const) {
      const pendingFixture = await ownerWith(input => mode === 'failed' && input.rawText.includes('current')
        ? { kind: 'facts', facts: [{ ...interest(input.rawText, 'current'), targetFactIds: ['sha256:bad'] }] }
        : noFact())
      const current = capture(pendingFixture.owner, `${mode} current`, 510 + (mode === 'failed' ? 1 : 0), requestId(510 + (mode === 'failed' ? 1 : 0)))
      const fence = freeze(pendingFixture.owner, 510 + (mode === 'failed' ? 1 : 0))
      if (mode === 'failed') await pendingFixture.owner.settle({ sourceKey: current.sourceKey })
      const result = asRecord(pendingFixture.owner.snapshot({ fence }))
      expect(result).toMatchObject({ kind: 'unknown', reason: 'current_source_pending' })
      exactKeys(asRecord(proofOf(result).currentSource), ['status', 'sourceKey', 'excludedRequestId', 'captureSequence'])
      pendingFixture.owner.close()
    }
  })

  it('computes lane sufficiency independently and never lets exclude-only interest or uncertain knowledge cover the other lane', async () => {
    const fixture = await ownerWith(input => {
      if (input.rawText.includes('不再')) return facts(interest(input.rawText, 'A', 'assert', [], 'exclude'))
      if (input.rawText.includes('uncertain')) return facts(knowledge(input.rawText, 'P', 'assert', [], 'uncertain'))
      if (input.rawText.includes('include')) return facts(interest(input.rawText, 'B'))
      if (input.rawText.includes('asserted')) return facts(knowledge(input.rawText, 'Q'))
      return noFact()
    })
    for (const [rawText, id] of [['我不再关注 A', 601], ['我 uncertain P', 602]] as const) {
      const source = capture(fixture.owner, rawText, id)
      await fixture.owner.settle({ sourceKey: source.sourceKey })
    }
    const insufficient = asRecord((await settleNoFactCurrent(fixture.owner, 603)).result)
    expect(insufficient.kind).toBe('insufficient')
    exactKeys(insufficient, ['kind', 'laneStatus', 'proof'])
    const laneStatus = asRecord(insufficient.laneStatus)
    exactKeys(laneStatus, ['longTermInterest', 'existingKnowledge'])
    expect(laneStatus.longTermInterest).toEqual({ status: 'insufficient', reason: 'no_active_include' })
    expect(laneStatus.existingKnowledge).toEqual({ status: 'insufficient', reason: 'no_asserted_knowledge' })

    const include = capture(fixture.owner, '我 include B', 604)
    await fixture.owner.settle({ sourceKey: include.sourceKey })
    const oneLane = asRecord((await settleNoFactCurrent(fixture.owner, 605)).result)
    expect(asRecord(asRecord(oneLane.laneStatus).longTermInterest).status).toBe('sufficient')
    expect(asRecord(asRecord(oneLane.laneStatus).existingKnowledge).status).toBe('insufficient')
    const asserted = capture(fixture.owner, '我 asserted Q', 606)
    await fixture.owner.settle({ sourceKey: asserted.sourceKey })
    const final = sufficient((await settleNoFactCurrent(fixture.owner, 607)).result)
    const interestLane = asRecord(final.longTermInterest)
    const knowledgeLane = asRecord(final.existingKnowledge)
    expect((interestLane.activeFacts as readonly ActiveFact[]).every(value => value.fact.lane === 'long_term_interest')).toBe(true)
    expect((knowledgeLane.activeFacts as readonly ActiveFact[]).every(value => value.fact.lane === 'existing_knowledge')).toBe(true)
    expect(asRecord(interestLane.sufficiency).status).toBe('sufficient')
    expect(asRecord(knowledgeLane.sufficiency).status).toBe('sufficient')
    fixture.owner.close()
  })

  it('replays deterministic proof bytes across reopen and fails closed on terminal proof digest or operation-target tampering', async () => {
    const path = databasePath()
    const classifier: SemanticPorts['classifier'] = input => input.rawText.includes('facts')
      ? facts(interest(input.rawText, 'A'), knowledge(input.rawText, 'P'))
      : noFact()
    const first = await ownerWith(classifier, { path })
    const source = capture(first.owner, 'facts 我关注 A 且知道 P', 701)
    await first.owner.settle({ sourceKey: source.sourceKey })
    const current = capture(first.owner, 'current no fact', 702, requestId(702))
    const fence = freeze(first.owner, 702)
    await first.owner.settle({ sourceKey: current.sourceKey })
    const baseline = first.owner.snapshot({ fence })
    const baselineBytes = JSON.stringify(baseline)
    const baselineDigest = sufficient(baseline).digest
    first.owner.close()

    const reopened = await ownerWith(classifier, { path })
    expect(JSON.stringify(reopened.owner.snapshot({ fence }))).toBe(baselineBytes)
    expect(sufficient(reopened.owner.snapshot({ fence })).digest).toBe(baselineDigest)
    const unrelated = capture(reopened.owner, 'unrelated no fact', 703)
    await reopened.owner.settle({ sourceKey: unrelated.sourceKey })
    expect(JSON.stringify(reopened.owner.snapshot({ fence }))).toBe(baselineBytes)
    reopened.owner.close()

    const digestPath = join(path, '..', 'tampered-proof-digest.sqlite')
    const operationPath = join(path, '..', 'tampered-operation-target.sqlite')
    copyFileSync(path, digestPath)
    copyFileSync(path, operationPath)
    expect(mutatePersistedText(digestPath, (columnName, value) => (
      /^(?:disposition|revision)_digest$/i.test(columnName) ? `sha256:${'f'.repeat(64)}` : undefined
    ))).toBe(true)
    expect(mutatePersistedText(operationPath, (columnName, value) => {
      if (/^operation$/i.test(columnName) && value === 'assert') return 'confirm'
      if (value.includes('"operation":"assert"')) return value.replace('"operation":"assert"', '"operation":"confirm"')
      return undefined
    })).toBe(true)
    for (const corruptedPath of [digestPath, operationPath]) {
      await expect(async () => {
        const corrupted = await ownerWith(classifier, { path: corruptedPath })
        try { corrupted.owner.snapshot({ fence }) } finally { corrupted.owner.close() }
      }).rejects.toThrow()
    }
  })
})
