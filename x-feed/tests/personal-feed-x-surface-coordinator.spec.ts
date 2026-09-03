import { getEventListeners } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  createPersonalFeedV2CandidateStateOwner,
  createPersonalFeedV2RequestCoordinator,
} from '@herman/personal-feed'
import { createPersonalFeedXSurfaceObserver } from '../src/personal-feed/x-surface-observer.ts'

describe('Personal Feed X surface to coordinator contract', () => {
  it('runs the real R2 and candidate-state owner with body-free persistence, deduplication, cleanup, and restart-safe processed filtering', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-x-surface-coordinator-'))
    const statePath = join(directory, 'candidate-state.jsonl')
    const request = Object.freeze({
      requestId: 'telegram:17:23',
      cutoff: '2026-08-31T02:00:00.000Z',
      shanghaiDay: '2026-08-31',
    })
    const canaryA = 'RAW_X_BODY_CANARY_A'
    const canaryB = 'RAW_X_BODY_CANARY_B'
    const raw = Object.freeze({
      schemaVersion: 1,
      kind: 'complete',
      ...request,
      startedAt: '2026-08-31T02:00:00.100Z',
      completedAt: '2026-08-31T02:00:03.900Z',
      surfaces: Object.freeze([
        Object.freeze({
          kind: 'complete', surface: 'for_you', surfaceOrdinal: 0,
          startedAt: '2026-08-31T02:00:00.200Z', completedAt: '2026-08-31T02:00:01.000Z',
          occurrences: Object.freeze([Object.freeze({
            sourceUrl: 'https://x.com/alpha/status/101',
            body: Object.freeze({ kind: 'sufficient', text: canaryA }),
            occurrenceOrdinal: 0, capturedAt: '2026-08-31T02:00:00.400Z',
            authorHandle: 'alpha', publishedAt: '2026-08-30T02:00:00.000Z',
          })]),
        }),
        Object.freeze({
          kind: 'complete', surface: 'following', surfaceOrdinal: 1,
          startedAt: '2026-08-31T02:00:01.100Z', completedAt: '2026-08-31T02:00:02.000Z',
          occurrences: Object.freeze([Object.freeze({
            sourceUrl: 'https://x.com/alpha/status/101',
            body: Object.freeze({ kind: 'sufficient', text: canaryB }),
            occurrenceOrdinal: 0, capturedAt: '2026-08-31T02:00:01.300Z',
            authorHandle: 'alpha', publishedAt: '2026-08-30T02:00:00.000Z',
          })]),
        }),
        Object.freeze({
          kind: 'natural_zero', surface: 'explore', surfaceOrdinal: 2,
          startedAt: '2026-08-31T02:00:02.100Z', completedAt: '2026-08-31T02:00:03.000Z',
          occurrences: Object.freeze([]),
        }),
      ]),
    })
    const order: string[] = []
    let observerCalls = 0
    let outerCloseCalls = 0
    let judgeCalls = 0
    const surfaceObserver = createPersonalFeedXSurfaceObserver({
      pythonBin: '/usr/bin/python3',
      observerCliPath: '/opt/dsh/runtime/x-feed/python/x_personal_feed_observer_cli.py',
      clock: { now: () => new Date('2026-08-31T02:00:00.000Z') },
      run: async () => {
        observerCalls += 1
        return { stdout: `${JSON.stringify(raw)}\n`, stderr: '' }
      },
    })
    const candidateState = createPersonalFeedV2CandidateStateOwner({
      statePath,
      clock: { now: () => new Date('2026-08-31T02:00:04.000Z') },
    })
    const r3 = Object.freeze({
      evaluate: async (input: Parameters<typeof candidateState.evaluate>[0]) => {
        order.push('r3')
        return candidateState.evaluate(input)
      },
    })
    const coordinator = createPersonalFeedV2RequestCoordinator({
      clock: { now: () => new Date('2026-08-31T02:00:00.000Z') },
      r4: { snapshot: async () => ({ kind: 'sufficient', snapshot: Object.freeze({ context: 'safe' }) }) },
      r2: {
        observe: async input => {
          order.push('r2')
          const observed = await surfaceObserver.observe(input) as { readonly kind?: unknown; readonly window?: unknown; readonly close?: unknown }
          if (observed.kind !== 'complete' || typeof observed.close !== 'function') return { kind: 'incomplete' }
          return Object.freeze({
            kind: 'complete',
            window: observed.window,
            close: async () => {
              outerCloseCalls += 1
              order.push('r2-close')
              await Reflect.apply(observed.close as () => Promise<void>, observed, [])
            },
          })
        },
      },
      r3,
      r5: {
        judgeOne: async input => {
          judgeCalls += 1
          order.push('r5')
          expect(Object.keys(input).sort()).toEqual(['candidate', 'request', 'signal', 'snapshot'])
          expect(Object.keys(input.candidate).sort()).toEqual(['body', 'canonicalUrl', 'provenance', 'stableId'])
          expect(input.candidate.body).toBe(canaryA)
          expect(input.candidate.provenance).toHaveLength(2)
          expect(JSON.stringify(input)).not.toContain('surfaces')
          return { kind: 'not_qualified' }
        },
      },
    })
    const signalController = new AbortController()
    const baselineAbortListeners = getEventListeners(signalController.signal, 'abort').length
    try {
      const first = await coordinator.prepare({ chatId: 17, messageId: 23, signal: signalController.signal })
      expect(first.outcome).toEqual({ kind: 'business_empty', finalText: '这次没有值得看的内容。' })
      expect(order).toEqual(['r2', 'r3', 'r5', 'r2-close'])
      expect(observerCalls).toBe(1)
      expect(judgeCalls).toBe(1)
      expect(outerCloseCalls).toBe(1)
      const persisted = readFileSync(statePath, 'utf8')
      expect(persisted).toContain('candidate_first_captured')
      expect(persisted).toContain('candidate_processed')
      expect(persisted).not.toContain(canaryA)
      expect(persisted).not.toContain(canaryB)

      order.length = 0
      const restartedOwner = createPersonalFeedV2CandidateStateOwner({
        statePath,
        clock: { now: () => new Date('2026-08-31T02:00:04.000Z') },
      })
      const restarted = createPersonalFeedV2RequestCoordinator({
        clock: { now: () => new Date('2026-08-31T02:00:00.000Z') },
        r4: { snapshot: async () => ({ kind: 'sufficient', snapshot: {} }) },
        r2: coordinatorR2(surfaceObserver, order, () => { outerCloseCalls += 1 }),
        r3: restartedOwner,
        r5: { judgeOne: async () => { judgeCalls += 1; return { kind: 'qualified' } } },
      })
      const second = await restarted.prepare({ chatId: 17, messageId: 23, signal: signalController.signal })
      expect(second.outcome).toEqual({ kind: 'business_empty', finalText: '这次没有值得看的内容。' })
      expect(observerCalls).toBe(2)
      expect(judgeCalls).toBe(1)
      expect(outerCloseCalls).toBe(2)
      expect(readFileSync(statePath, 'utf8')).toBe(persisted)
      expect(getEventListeners(signalController.signal, 'abort')).toHaveLength(baselineAbortListeners)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function coordinatorR2(
  observer: Readonly<{ readonly observe: (input: any) => Promise<unknown> }>,
  order: string[],
  closed: () => void,
) {
  return Object.freeze({
    observe: async (input: any) => {
      order.push('r2')
      const result = await observer.observe(input) as { readonly kind?: unknown; readonly window?: unknown; readonly close?: unknown }
      if (result.kind !== 'complete' || typeof result.close !== 'function') return { kind: 'incomplete' }
      return Object.freeze({
        kind: 'complete',
        window: result.window,
        close: async () => { closed(); order.push('r2-close'); await Reflect.apply(result.close as () => Promise<void>, result, []) },
      })
    },
  })
}
