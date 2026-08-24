import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ContextEnabledCrossSourceEditor,
  ContextEnabledCrossSourceEditorOptions,
  CurrentContextResult,
} from '../../personal-feed/src/index.ts'
import type {
  CurrentContextProjectionOptions,
  CurrentContextProjectionPeriodScopeEstablished,
} from '../../personal-feed/src/types.ts'

type CapturedEditor = {
  readonly editor: ContextEnabledCrossSourceEditor
  readonly acceptCurrentContext: ReturnType<typeof vi.fn>
}

type CapturedProjection = {
  readonly projection: {
    readonly establishPeriodScope: (period: unknown) => unknown
    readonly completeCurrentContextForEstablishedScope: ReturnType<typeof vi.fn>
  }
  readonly completeCurrentContextForEstablishedScope: ReturnType<typeof vi.fn>
}

const { capturedEditors, capturedProjections, controls } = vi.hoisted(() => ({
  capturedEditors: [] as CapturedEditor[],
  capturedProjections: [] as CapturedProjection[],
  controls: { c11Status: 'accepted' as 'accepted' | 'rejected' | 'failed' | 'unknown' },
}))

vi.mock('@herman/personal-feed', async importOriginal => {
  const actual = await import('../../personal-feed/src/index.ts')
  return {
    ...actual,
    createCrossSourceEditor: vi.fn((options: ContextEnabledCrossSourceEditorOptions) => {
      const editor: ContextEnabledCrossSourceEditor = actual.createCrossSourceEditor(options)
      const acceptCurrentContext = vi.fn((input: CurrentContextResult) => {
        if (controls.c11Status !== 'accepted') return { status: controls.c11Status, input }
        return editor.acceptCurrentContext(input)
      })
      const wrapped = { ...editor, acceptCurrentContext }
      capturedEditors.push({ editor: wrapped, acceptCurrentContext })
      return wrapped
    }),
    createCurrentContextProjection: vi.fn((options: CurrentContextProjectionOptions) => {
      const actualProjection = actual.createCurrentContextProjection(options)
      const completeCurrentContextForEstablishedScope = vi.fn(
        (scope: CurrentContextProjectionPeriodScopeEstablished) => {
          return actualProjection.completeCurrentContextForEstablishedScope(scope)
        },
      )
      const projection = Object.freeze({
        establishPeriodScope: actualProjection.establishPeriodScope,
        completeCurrentContextForEstablishedScope,
      })
      capturedProjections.push({ projection, completeCurrentContextForEstablishedScope })
      return projection
    }),
  }
})

import { createCronEnvironmentExtension } from '../src/index.ts'
import * as xCronProvider from '../src/x-cron/provider.ts'

afterEach(() => {
  vi.restoreAllMocks()
  capturedEditors.splice(0)
  capturedProjections.splice(0)
  controls.c11Status = 'accepted'
})

function context(): { readonly ctx: { readonly logger: Record<string, () => void> } } {
  return {
    ctx: {
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    },
  }
}

function config(directory: string): Record<string, unknown> {
  return {
    cronJobId: 'cron-x-context',
    dataDir: directory,
    pipelinePath: '/opt/x-feed/python/x_insight_pipeline.py',
    personalFeedDataDir: join(directory, 'personal-feed'),
    personalFeedRequiredSources: ['x'],
    candidateReportingWindowMs: 300_000,
  }
}

const sourceNeutralUnavailable = {
  kind: 'unavailable' as const,
  unavailableFact: { kind: 'no_configured_authorized_context_source' as const },
}

const basePrepareContext = {
  jobId: 'cron-x-context',
  jobKind: 'agent' as const,
  sessionMode: 'per_run' as const,
  gate: 'forbidden' as const,
  runId: 'cron-x-context@once',
  trigger: 'scheduled' as const,
  scheduledFor: '2026-08-24T00:00:00.000Z',
  claimedAt: '2026-08-24T00:00:01.000Z',
}

describe('TODO04 cron assembly: C11 current-context result', () => {
  it.each([
    ['scheduled', 'skip'],
    ['manual', 'skip'],
    ['scheduled', 'throw'],
    ['manual', 'throw'],
  ] as const)('establishes and persists the source-neutral Unavailable result before X %s provider %s', async (trigger, providerOutcome) => {
    const directory = mkdtempSync(join(tmpdir(), 'x-feed-todo04-context-'))
    const skip = Object.freeze({
      kind: 'skip' as const,
      outcome: Object.freeze({ text: undefined, error: undefined }),
    })
    const contextLedgerPath = join(directory, 'personal-feed', 'current-context-inputs.jsonl')
    const providerPrepare = vi.fn(async () => {
      // The provider is deliberately the first later-stage observation. If
      // C11 is not accepted durably before this call, the test fails before
      // the provider's own skip/throw outcome can hide the missing wiring.
      const persistedBeforeProvider = existsSync(contextLedgerPath)
        ? readFileSync(contextLedgerPath, 'utf8').trim()
        : ''
      if (persistedBeforeProvider === '') throw new Error('C11 was not durably accepted before X provider')
      if (providerOutcome === 'throw') throw new Error('X provider failed after C11')
      return skip
    })
    const legacyPrepare = vi.fn(async () => {
      throw new Error('legacy X cron provider must not prepare ordinary Feed runs')
    })
    vi.spyOn(xCronProvider, 'createXFeedCronEnvironmentProvider').mockReturnValue({
      marker: 'dsh-x-feed/v1',
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      prepare: legacyPrepare,
    } as never)
    const ordinaryFactory = vi.spyOn(xCronProvider, 'createXFeedCronEnvironmentProviderForOrdinaryFeed')
      .mockReturnValue({
        marker: 'dsh-x-feed/v1',
        requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
        prepare: providerPrepare,
      } as never)

    try {
      const extension = createCronEnvironmentExtension(context().ctx as never, config(directory))
      const prepareContext = {
        ...basePrepareContext,
        trigger,
        runId: `${trigger}:cron-x-context:once`,
      }

      if (providerOutcome === 'throw') {
        await expect(extension.prepare(prepareContext)).rejects.toThrow('X provider failed after C11')
      } else {
        await expect(extension.prepare(prepareContext)).resolves.toBe(skip)
      }
      const editorCapture = capturedEditors.at(-1)
      expect(editorCapture).toBeDefined()
      expect(editorCapture!.acceptCurrentContext).toHaveBeenCalledOnce()
      const projectionCapture = capturedProjections.at(-1)
      expect(projectionCapture).toBeDefined()
      expect(Object.keys(projectionCapture!.projection)).toEqual([
        'establishPeriodScope',
        'completeCurrentContextForEstablishedScope',
      ])
      expect(projectionCapture!.projection).not.toHaveProperty('projectCurrentContext')
      expect(projectionCapture!.projection).not.toHaveProperty('submitCurrentContext')
      expect(projectionCapture!.completeCurrentContextForEstablishedScope).toHaveBeenCalledOnce()
      expect(projectionCapture!.completeCurrentContextForEstablishedScope.mock.invocationCallOrder[0])
        .toBeLessThan(providerPrepare.mock.invocationCallOrder[0]!)
      expect(ordinaryFactory).toHaveBeenCalledOnce()
      expect(providerPrepare).toHaveBeenCalledOnce()
      expect(legacyPrepare).not.toHaveBeenCalled()

      const [acceptedContext] = editorCapture!.acceptCurrentContext.mock.calls[0]!
      const periodScopeLedgerPath = join(directory, 'personal-feed', 'period-scopes.jsonl')
      const [periodScope] = readFileSync(periodScopeLedgerPath, 'utf8')
        .trim().split('\n').map(line => JSON.parse(line))
      expect(acceptedContext).toEqual({
        kind: 'unavailable',
        value: {
          scope: periodScope.c33.value,
          period: periodScope.c01.value.period,
          unavailableFact: sourceNeutralUnavailable.unavailableFact,
        },
      })
      const serializedAcceptedContext = JSON.stringify(acceptedContext)
      for (const privateField of ['current_collection', 'telegram', 'dsh-assistant', 'memory']) {
        expect(serializedAcceptedContext.toLowerCase()).not.toContain(privateField)
      }

      const persisted = readFileSync(contextLedgerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toMatchObject({
        event: 'current_context_accepted',
        period: periodScope.c01.value.period,
        scope: periodScope.c33.value,
        branch: 'unavailable',
      })
      expect(persisted[0]).not.toHaveProperty('unavailableFactKind')
      const serializedPersistedContext = JSON.stringify(persisted[0])
      expect(serializedPersistedContext).not.toContain('no_configured_authorized_context_source')
      for (const privateField of ['current_collection', 'telegram', 'dsh-assistant', 'memory']) {
        expect(serializedPersistedContext.toLowerCase()).not.toContain(privateField)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['rejected', 'failed', 'unknown'] as const)(
    'fails closed on a %s C11 result without entering the X provider',
    async c11Status => {
      const directory = mkdtempSync(join(tmpdir(), 'x-feed-todo04-context-rejected-'))
      const providerPrepare = vi.fn(async () => ({
        kind: 'skip' as const,
        outcome: { text: undefined, error: undefined },
      }))
      const legacyPrepare = vi.fn(async () => {
        throw new Error('legacy X cron provider must not prepare ordinary Feed runs')
      })
      vi.spyOn(xCronProvider, 'createXFeedCronEnvironmentProvider').mockReturnValue({
        marker: 'dsh-x-feed/v1',
        requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
        prepare: legacyPrepare,
      } as never)
      const ordinaryFactory = vi.spyOn(xCronProvider, 'createXFeedCronEnvironmentProviderForOrdinaryFeed')
        .mockReturnValue({
          marker: 'dsh-x-feed/v1',
          requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
          prepare: providerPrepare,
        } as never)
      controls.c11Status = c11Status

      try {
        const extension = createCronEnvironmentExtension(context().ctx as never, config(directory))

        await expect(extension.prepare({
          ...basePrepareContext,
          trigger: 'scheduled',
          runId: `scheduled:cron-x-context:c11-${c11Status}`,
        })).rejects.toThrow('x-feed C11 current-context result was not accepted')
        expect(providerPrepare).not.toHaveBeenCalled()
        expect(ordinaryFactory).not.toHaveBeenCalled()
        expect(legacyPrepare).not.toHaveBeenCalled()
        expect(capturedProjections.at(-1)?.completeCurrentContextForEstablishedScope).toHaveBeenCalledOnce()
        expect(capturedEditors.at(-1)?.acceptCurrentContext).toHaveBeenCalledOnce()
        expect(existsSync(join(directory, 'personal-feed', 'current-context-inputs.jsonl'))).toBe(false)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})
