import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCandidateMaterialProjection,
  createCrossSourceEditor,
  createCurrentContextProjection,
  createMechanicalAdmission,
  createPersonalFeedScopeService,
  sourceIdentity,
  type C11Result,
  type CurrentContextProjectionPeriodScopeEstablished,
  type CurrentContextResult,
  type CrossSourceEditorOptions,
  type ExternalPeriodScopeInput,
} from '../src/index.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function input(): ExternalPeriodScopeInput {
  const x = sourceIdentity('x')
  return {
    requestIdentity: 'dsh-cron:cron-feed:todo04-context-run-1',
    trigger: 'scheduled',
    scheduledFor: '2026-08-24T13:30:00.000Z',
    claimedAt: '2026-08-24T13:30:01.000Z',
    runId: 'cron-feed@2026-08-24T13:30:00.000Z',
    requiredSources: [x],
    reportingWindowClosesAt: '2026-08-24T13:35:00.000Z',
  }
}

async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'personal-feed-todo04-context-'))
  temporaryDirectories.push(directory)

  const periodScopeLedgerPath = join(directory, 'period-scopes.jsonl')
  const candidatePeriodLedgerPath = join(directory, 'candidate-period-facts.jsonl')
  const editingInputLedgerPath = join(directory, 'editing-inputs.jsonl')
  const currentContextInputLedgerPath = join(directory, 'current-context-inputs.jsonl')
  const x = sourceIdentity('x')
  const scopeService = createPersonalFeedScopeService({
    ledgerPath: periodScopeLedgerPath,
    sourceScopes: [{
      source: x,
      mechanicalAdmission: createMechanicalAdmission(x),
      candidateMaterialProjection: createCandidateMaterialProjection(x),
    }],
    currentContextProjection: createCurrentContextProjection(),
  })
  const established = await scopeService.establishExternalPeriodScope(input())
  const scope = established.c33.value

  const createEditor = () => createCrossSourceEditor({
    periodScopeLedgerPath,
    candidatePeriodLedgerPath,
    editingInputLedgerPath,
    currentContextInputLedgerPath,
  })

  return {
    periodScopeLedgerPath,
    candidatePeriodLedgerPath,
    editingInputLedgerPath,
    currentContextInputLedgerPath,
    established,
    scope,
    createEditor,
  }
}

function available(scope: CurrentContextProjectionPeriodScopeEstablished): CurrentContextResult {
  return availableWithCurrentFact(scope, 'todo04-private-current-fact-sentinel')
}

function availableWithCurrentFact(
  scope: CurrentContextProjectionPeriodScopeEstablished,
  currentFact: unknown,
): CurrentContextResult {
  return {
    kind: 'available',
    context: {
      scope,
      period: scope.period,
      clues: [{
        factOwner: 'todo04-private-fact-owner-sentinel',
        originalAttribution: 'todo04-private-original-attribution-sentinel',
        exactLookup: 'todo04-private-exact-lookup-sentinel',
        currentFact,
      }],
    },
  }
}

function unavailable(scope: CurrentContextProjectionPeriodScopeEstablished): CurrentContextResult {
  return {
    kind: 'unavailable',
    value: {
      scope,
      period: scope.period,
      unavailableFact: {
        kind: 'no_configured_authorized_context_source',
        reason: 'no-current-context-established-by-fixture',
      },
    },
  }
}

function periodMismatch(scope: CurrentContextProjectionPeriodScopeEstablished): CurrentContextResult {
  const result = available(scope)
  return {
    ...result,
    context: {
      ...result.context,
      period: {
        ...result.context.period,
        period: 'period-not-established-by-c33' as typeof result.context.period['period'],
      },
    },
  }
}

function scopeMismatch(scope: CurrentContextProjectionPeriodScopeEstablished): CurrentContextResult {
  const result = available(scope)
  return {
    ...result,
    context: {
      ...result.context,
      scope: {
        period: {
          ...result.context.scope.period,
          period: 'scope-period-not-established-by-c33' as typeof result.context.scope.period['period'],
        },
      },
    },
  }
}

function contextResults(path: string): unknown[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8').trim()
  return text === '' ? [] : text.split('\n').map(line => JSON.parse(line) as unknown)
}

describe('TODO 04 current context result / C11', () => {
  it('accepts one Available result carrying exactly the C33 period scope', async () => {
    const fixture = await createFixture()
    const result = available(fixture.scope)
    const editor = fixture.createEditor()

    expect(editor.acceptCurrentContext(result)).toEqual({ status: 'accepted', value: result })
    expect(result.context.scope).toBe(fixture.established.c33.value)
    expect(result.context.period).toEqual(fixture.established.c01.value.period)
    const persisted = contextResults(fixture.currentContextInputLedgerPath)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      schemaVersion: 1,
      event: 'current_context_accepted',
    })
    expect(Object.keys(persisted[0] as Record<string, unknown>).sort()).toEqual([
      'branch',
      'digest',
      'event',
      'period',
      'schemaVersion',
      'scope',
    ])
    const receipt = JSON.stringify(persisted[0])
    expect(receipt).toContain('available')
    expect(receipt).toContain(fixture.scope.period.run)
    expect(receipt).toContain(fixture.scope.period.period)
    expect(receipt).not.toContain('todo04-private-fact-owner-sentinel')
    expect(receipt).not.toContain('todo04-private-original-attribution-sentinel')
    expect(receipt).not.toContain('todo04-private-exact-lookup-sentinel')
    expect(receipt).not.toContain('todo04-private-current-fact-sentinel')
    expect(receipt).not.toContain('clues')
    expect(receipt).not.toContain('factOwner')
    expect(receipt).not.toContain('originalAttribution')
    expect(receipt).not.toContain('exactLookup')
    expect(receipt).not.toContain('currentFact')
  })

  it('accepts one Unavailable result as a normal C11 result with an explicit source-neutral fact', async () => {
    const fixture = await createFixture()
    const result = unavailable(fixture.scope)
    const editor = fixture.createEditor()

    expect(editor.acceptCurrentContext(result)).toEqual({ status: 'accepted', value: result })
    expect(result.value.scope).toBe(fixture.established.c33.value)
    expect(result.value.period).toEqual(fixture.established.c01.value.period)
    expect(result.value.unavailableFact).toEqual({
      kind: 'no_configured_authorized_context_source',
      reason: 'no-current-context-established-by-fixture',
    })
    expect(contextResults(fixture.currentContextInputLedgerPath)).toHaveLength(1)
  })

  it('replays the same C11 result idempotently without appending a second period result', async () => {
    const fixture = await createFixture()
    const result = available(fixture.scope)
    const editor = fixture.createEditor()

    const first = editor.acceptCurrentContext(result)
    const replay = editor.acceptCurrentContext(result)

    expect(first).toEqual({ status: 'accepted', value: result })
    expect(replay).toEqual(first)
    expect(contextResults(fixture.currentContextInputLedgerPath)).toHaveLength(1)
  })

  it('rejects a conflicting second C11 result for the same period without changing the first result', async () => {
    const fixture = await createFixture()
    const first = available(fixture.scope)
    const conflict = unavailable(fixture.scope)
    const editor = fixture.createEditor()

    expect(editor.acceptCurrentContext(first)).toEqual({ status: 'accepted', value: first })
    expect(editor.acceptCurrentContext(conflict)).toEqual({ status: 'rejected', input: conflict })
    expect(contextResults(fixture.currentContextInputLedgerPath)).toHaveLength(1)
    expect(editor.acceptCurrentContext(first)).toEqual({ status: 'accepted', value: first })
  })

  it('rejects a C11 result whose period differs from the accepted C33 identity without appending it', async () => {
    const fixture = await createFixture()
    const result = periodMismatch(fixture.scope)
    const editor = fixture.createEditor()

    expect(editor.acceptCurrentContext(result)).toEqual({ status: 'rejected', input: result })
    expect(contextResults(fixture.currentContextInputLedgerPath)).toHaveLength(0)
  })

  it('rejects a C11 result whose scope differs from the accepted C33 scope without appending it', async () => {
    const fixture = await createFixture()
    const result = scopeMismatch(fixture.scope)
    const editor = fixture.createEditor()

    expect(editor.acceptCurrentContext(result)).toEqual({ status: 'rejected', input: result })
    expect(contextResults(fixture.currentContextInputLedgerPath)).toHaveLength(0)
  })

  it('recognizes a same-value C11 receipt and digest after recreating the editor', async () => {
    const fixture = await createFixture()
    const result = unavailable(fixture.scope)

    const firstEditor = fixture.createEditor()
    const first = firstEditor.acceptCurrentContext(result)
    const rebuiltEditor = fixture.createEditor()

    expect(rebuiltEditor.acceptCurrentContext(result)).toEqual(first)
    expect(contextResults(fixture.currentContextInputLedgerPath)).toHaveLength(1)
  })

  it('rejects a different Available payload after recreating the editor without appending it', async () => {
    const fixture = await createFixture()
    const first = availableWithCurrentFact(fixture.scope, { topic: 'first-context' })
    const conflict = availableWithCurrentFact(fixture.scope, { topic: 'different-context' })

    expect(fixture.createEditor().acceptCurrentContext(first)).toEqual({ status: 'accepted', value: first })
    expect(fixture.createEditor().acceptCurrentContext(conflict)).toEqual({ status: 'rejected', input: conflict })
    expect(contextResults(fixture.currentContextInputLedgerPath)).toHaveLength(1)
  })

  it('rejects a different Unavailable fact after recreating the editor without appending it', async () => {
    const fixture = await createFixture()
    const first = unavailable(fixture.scope)
    const conflict: CurrentContextResult = {
      kind: 'unavailable',
      value: {
        ...first.value,
        unavailableFact: {
          kind: 'no_configured_authorized_context_source',
          reason: 'different-unavailable-fact',
        },
      },
    }

    expect(fixture.createEditor().acceptCurrentContext(first)).toEqual({ status: 'accepted', value: first })
    expect(fixture.createEditor().acceptCurrentContext(conflict)).toEqual({ status: 'rejected', input: conflict })
    expect(contextResults(fixture.currentContextInputLedgerPath)).toHaveLength(1)
  })

  it.each([
    ['undefined and null', null, undefined],
    ['NaN and null', null, Number.NaN],
    ['Date and an empty object', {}, new Date('2026-08-24T00:00:00.000Z')],
  ] as const)(
    'fails closed when different Available clues could collide as %s after rebuilding the editor',
    async (_case, persistedFact, conflictingFact) => {
      const fixture = await createFixture()
      const first = availableWithCurrentFact(fixture.scope, persistedFact)
      const conflict = availableWithCurrentFact(fixture.scope, conflictingFact)

      expect(fixture.createEditor().acceptCurrentContext(first)).toEqual({ status: 'accepted', value: first })
      expect(fixture.createEditor().acceptCurrentContext(conflict)).toEqual({ status: 'rejected', input: conflict })
      expect(contextResults(fixture.currentContextInputLedgerPath)).toHaveLength(1)
    },
  )

  it('keeps C11 context persistence separate from the C10 editing-input ledger and key', async () => {
    const fixture = await createFixture()
    const result = available(fixture.scope)
    const editor = fixture.createEditor()

    expect(editor.acceptCurrentContext(result)).toEqual({ status: 'accepted', value: result })
    expect(fixture.currentContextInputLedgerPath).not.toBe(fixture.editingInputLedgerPath)
    expect(editor.listAcceptedInputs()).toEqual([])
    expect(existsSync(fixture.editingInputLedgerPath)).toBe(false)
    expect(contextResults(fixture.currentContextInputLedgerPath)).toHaveLength(1)
    expect(contextResults(fixture.currentContextInputLedgerPath)[0]).toMatchObject({
      schemaVersion: 1,
      event: 'current_context_accepted',
    })
    expect(contextResults(fixture.currentContextInputLedgerPath)[0]).not.toHaveProperty('material')
    expect(contextResults(fixture.currentContextInputLedgerPath)[0]).not.toHaveProperty('candidate')
  })

  it('fails closed on a persisted C11 receipt with fields outside the exact schema', async () => {
    const fixture = await createFixture()
    const result = unavailable(fixture.scope)
    expect(fixture.createEditor().acceptCurrentContext(result)).toEqual({ status: 'accepted', value: result })

    const [persisted] = contextResults(fixture.currentContextInputLedgerPath) as Record<string, unknown>[]
    const unsupported = { ...persisted, unavailableFactKind: 'legacy-extra-field' }
    writeFileSync(fixture.currentContextInputLedgerPath, `${JSON.stringify(unsupported)}\n`)

    expect(fixture.createEditor().acceptCurrentContext(result)).toEqual({ status: 'failed', input: result })
    expect(contextResults(fixture.currentContextInputLedgerPath)).toEqual([unsupported])
  })

  it('keeps the scope-only C33 projection from exposing a fabricated TODO 04 result', () => {
    const projection = createCurrentContextProjection()

    expect(Object.keys(projection)).toEqual(['establishPeriodScope'])
    expect(projection).not.toHaveProperty('projectCurrentContext')
    expect(projection).not.toHaveProperty('currentContext')
  })

  it('exposes one atomic completion runner instead of the internal projection and C11 steps', async () => {
    const fixture = await createFixture()
    const result = unavailable(fixture.scope)
    const calls: string[] = []
    const receiver = vi.fn((input: CurrentContextResult): C11Result => {
      calls.push('receiver')
      return { status: 'accepted', value: input }
    })
    const projection = createCurrentContextProjection({
      resultProducer: {
        produceCurrentContextResult: () => {
          calls.push('producer')
          return result
        },
      },
      c11Receiver: { acceptCurrentContext: receiver },
    })

    expect(Object.keys(projection)).toEqual([
      'establishPeriodScope',
      'completeCurrentContextForEstablishedScope',
    ])
    expect(projection).not.toHaveProperty('projectCurrentContext')
    expect(projection).not.toHaveProperty('submitCurrentContext')
    await expect(projection.completeCurrentContextForEstablishedScope(fixture.scope)).resolves.toEqual({
      status: 'accepted',
      value: result,
    })
    expect(calls).toEqual(['producer', 'receiver'])
    expect(receiver).toHaveBeenCalledOnce()
    expect(receiver).toHaveBeenCalledWith(result)
  })

  it('propagates a producer failure without invoking C11 or fabricating Unavailable', async () => {
    const fixture = await createFixture()
    const sentinel = new Error('todo04-result-producer-sentinel')
    const receiver = vi.fn()
    const projection = createCurrentContextProjection({
      resultProducer: {
        produceCurrentContextResult: () => { throw sentinel },
      },
      c11Receiver: { acceptCurrentContext: receiver },
    })

    await expect(projection.completeCurrentContextForEstablishedScope(fixture.scope)).rejects.toBe(sentinel)
    expect(receiver).not.toHaveBeenCalled()
  })

  it('passes a receiver rejection through without self-accepting the projected result', async () => {
    const fixture = await createFixture()
    const result = unavailable(fixture.scope)
    const receiver = vi.fn((input: CurrentContextResult): C11Result => ({
      status: 'rejected',
      input,
    }))
    const projection = createCurrentContextProjection({
      resultProducer: { produceCurrentContextResult: () => result },
      c11Receiver: { acceptCurrentContext: receiver },
    })

    await expect(projection.completeCurrentContextForEstablishedScope(fixture.scope)).resolves.toEqual({
      status: 'rejected',
      input: result,
    })
    expect(receiver).toHaveBeenCalledOnce()
  })

  it('keeps a pure C10 editor runtime surface free of the C11 receiver', () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-todo04-c10-editor-'))
    temporaryDirectories.push(directory)
    const editor = createCrossSourceEditor({
      candidatePeriodLedgerPath: join(directory, 'candidate-period-facts.jsonl'),
      editingInputLedgerPath: join(directory, 'editing-inputs.jsonl'),
    })

    expect(Object.keys(editor)).toEqual(['acceptCandidateMaterial', 'listAcceptedInputs'])
    expect(editor).not.toHaveProperty('acceptCurrentContext')
  })

  it('fails fast when a forced C11 editor configuration supplies only one C11 ledger path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-todo04-partial-c11-'))
    temporaryDirectories.push(directory)
    const partialOptions = {
      candidatePeriodLedgerPath: join(directory, 'candidate-period-facts.jsonl'),
      editingInputLedgerPath: join(directory, 'editing-inputs.jsonl'),
      periodScopeLedgerPath: join(directory, 'period-scopes.jsonl'),
    }

    expect(() => createCrossSourceEditor(
      partialOptions as unknown as CrossSourceEditorOptions,
    )).toThrow('personal Feed C11 requires both periodScopeLedgerPath and currentContextInputLedgerPath')
  })
})
