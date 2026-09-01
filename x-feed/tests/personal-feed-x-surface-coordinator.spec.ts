import { getEventListeners } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  createPersonalFeedV2CandidateLifecycle,
  createPersonalFeedV2RequestCoordinator,
} from '@herman/personal-feed'
import { createPersonalFeedXSurfaceObserver } from '../src/personal-feed/x-surface-observer.ts'

describe('Personal Feed X surface to coordinator cross-package contract', () => {
  it('joins real X observation, R2, R3, and R5 into body-free business empty with deduplication and terminal cleanup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-x-surface-coordinator-'))
    const request = Object.freeze({
      requestId: 'telegram:17:23',
      cutoff: '2026-08-31T02:00:00.000Z',
      shanghaiDay: '2026-08-31',
    })
    const canaryA = 'RAW_X_BODY_CANARY_A'
    const canaryB = 'RAW_X_BODY_CANARY_B'
    const raw = Object.freeze({
      schemaVersion: 1,
      kind: 'complete' as const,
      ...request,
      startedAt: '2026-08-31T02:00:00.100Z',
      completedAt: '2026-08-31T02:00:03.900Z',
      surfaces: Object.freeze([
        Object.freeze({
          kind: 'complete' as const,
          surface: 'for_you' as const,
          surfaceOrdinal: 0,
          startedAt: '2026-08-31T02:00:00.200Z',
          completedAt: '2026-08-31T02:00:01.000Z',
          occurrences: Object.freeze([Object.freeze({
            sourceUrl: 'https://x.com/alpha/status/101',
            body: Object.freeze({ kind: 'sufficient' as const, text: canaryA }),
            occurrenceOrdinal: 0,
            capturedAt: '2026-08-31T02:00:00.400Z',
            authorHandle: 'alpha',
            publishedAt: '2026-08-31T02:00:00.400Z',
          })]),
        }),
        Object.freeze({
          kind: 'complete' as const,
          surface: 'following' as const,
          surfaceOrdinal: 1,
          startedAt: '2026-08-31T02:00:01.100Z',
          completedAt: '2026-08-31T02:00:02.000Z',
          occurrences: Object.freeze([Object.freeze({
            sourceUrl: 'https://x.com/alpha/status/101',
            body: Object.freeze({ kind: 'sufficient' as const, text: canaryB }),
            occurrenceOrdinal: 0,
            capturedAt: '2026-08-31T02:00:01.300Z',
            authorHandle: 'alpha',
            publishedAt: '2026-08-31T02:00:01.300Z',
          })]),
        }),
        Object.freeze({
          kind: 'natural_zero' as const,
          surface: 'explore' as const,
          surfaceOrdinal: 2,
          startedAt: '2026-08-31T02:00:02.100Z',
          completedAt: '2026-08-31T02:00:03.000Z',
          occurrences: Object.freeze([]),
        }),
      ]),
    })
    const order: string[] = []
    let childCalls = 0
    const child = Object.freeze({
      observe: async (input: unknown) => {
        childCalls += 1
        expect(input).toEqual(expect.objectContaining({ request }))
        return raw
      },
    })
    const surfaceObserver = createPersonalFeedXSurfaceObserver({ child })
    const signalController = new AbortController()
    const baselineAbortListeners = getEventListeners(signalController.signal, 'abort').length
    let r2CloseCalls = 0
    let processedCalls = 0
    let processedStableIds: string[] = []
    let r5InputGraph = ''
    let finalizationClaim: unknown
    try {
      const coordinator = createPersonalFeedV2RequestCoordinator({
        ledgerPath: join(directory, 'requests.jsonl'),
        clock: { now: () => new Date('2026-08-31T02:00:00.000Z') },
        r4: { snapshot: async () => ({ kind: 'sufficient', snapshot: Object.freeze({ context: 'safe' }) }) },
        r2: {
          observe: async (input) => {
            order.push('r2')
            const observed = await surfaceObserver.observe(input)
            const record = observed as { readonly kind?: unknown; readonly window?: unknown; readonly close?: unknown }
            expect(Object.keys(record).sort()).toEqual(['close', 'kind', 'window'])
            if (record.kind !== 'complete' || typeof record.close !== 'function') throw new Error('surface observer did not complete')
            const owner = record
            const close = record.close as () => Promise<void>
            return Object.freeze({
              kind: 'complete' as const,
              window: record.window,
              close: async function (this: object) {
                r2CloseCalls += 1
                order.push('r2-close')
                await Reflect.apply(close, owner, [])
              },
            })
          },
        },
        r3: {
          admit: async (input) => {
            order.push('r3')
            const lifecycle = createPersonalFeedV2CandidateLifecycle({
              completionLedgerPath: join(directory, 'candidate-completions.jsonl'),
              clock: { now: () => new Date('2026-08-31T02:00:04.000Z') },
              processedQuery: async (queryInput, querySignal) => {
                processedCalls += 1
                processedStableIds.push((queryInput as { readonly stableId: string }).stableId)
                expect(querySignal).toBe(input.signal)
                return { kind: 'unprocessed' as const }
              },
            })
            const admitted = await lifecycle.admit(input)
            if (admitted.kind !== 'admitted') throw new Error('real candidate lifecycle did not admit')
            const originalFinalize = admitted.cursor.finalize
            const cursor = Object.freeze({
              borrowCurrent: admitted.cursor.borrowCurrent,
              finalize: async (claim: unknown) => {
                finalizationClaim = claim
                return Reflect.apply(originalFinalize, admitted.cursor, [claim])
              },
              close: admitted.cursor.close,
            })
            return Object.freeze({ kind: 'admitted' as const, cursor })
          },
        },
        r5: {
          judge: async (input) => {
            order.push('r5')
            expect(Object.keys(input).sort()).toEqual(['candidates', 'request', 'signal', 'snapshot'])
            expect(Object.keys(input.candidates as object)).toEqual(['borrowCurrent'])
            r5InputGraph = JSON.stringify(input)
            expect(r5InputGraph).not.toContain(canaryA)
            expect(r5InputGraph).not.toContain(canaryB)
            expect(r5InputGraph).not.toContain('surfaces')
            const first = await input.candidates.borrowCurrent({ signal: input.signal })
            expect(first.kind).toBe('candidate')
            if (first.kind !== 'candidate') throw new Error('expected one unprocessed candidate')
            const receipt = await first.lease.completeCurrent({ judgment: 'not_qualified' })
            expect(await input.candidates.borrowCurrent({ signal: input.signal })).toEqual({ kind: 'done' })
            return Object.freeze({ kind: 'none' as const, completed: Object.freeze([receipt]) })
          },
        },
      })

      const prepared = await coordinator.prepare({ chatId: 17, messageId: 23, signal: signalController.signal }) as {
        readonly kind: 'prepared'
        readonly outcome: { readonly kind: string; readonly finalText: string }
        readonly settle: (receipt: unknown) => void
      }
      expect(prepared.kind).toBe('prepared')
      expect(processedCalls).toBe(1)
      expect(processedStableIds).toEqual(['x-status:101'])
      expect(order).toEqual(['r2', 'r3', 'r2-close', 'r5'])
      expect(finalizationClaim).toMatchObject({ kind: 'none' })
      expect(r2CloseCalls).toBe(1)
      expect(prepared.outcome.kind).toBe('business_empty')
      expect(prepared.outcome.finalText).toBe('这次没有值得看的内容。')
      expect(order.indexOf('r3')).toBeLessThan(order.indexOf('r2-close'))
      expect(order.indexOf('r2-close')).toBeLessThan(order.indexOf('r5'))
      expect(JSON.stringify(finalizationClaim)).not.toContain(canaryA)
      expect(JSON.stringify(finalizationClaim)).not.toContain(canaryB)
      const completionLedger = existsSync(join(directory, 'candidate-completions.jsonl'))
        ? readFileSync(join(directory, 'candidate-completions.jsonl'), 'utf8')
        : ''
      const requestLedger = readFileSync(join(directory, 'requests.jsonl'), 'utf8')
      expect(completionLedger).not.toContain(canaryA)
      expect(completionLedger).not.toContain(canaryB)
      expect(requestLedger).not.toContain(canaryA)
      expect(requestLedger).not.toContain(canaryB)

      const fakeDelivery = (outcome: unknown): never => {
        const bodyFree = JSON.stringify(outcome)
        expect(bodyFree).not.toContain(canaryA)
        expect(bodyFree).not.toContain(canaryB)
        throw new Error('fake delivery failure')
      }
      expect(() => fakeDelivery(prepared.outcome)).toThrow('fake delivery failure')
      await expect(coordinator.prepare({ chatId: 17, messageId: 23, signal: signalController.signal })).resolves.toEqual({ kind: 'duplicate_consumed' })
      expect(childCalls).toBe(1)
      expect(r2CloseCalls).toBe(1)
      expect(getEventListeners(signalController.signal, 'abort').length).toBe(baselineAbortListeners)
    } finally {
      await surfaceObserver.shutdown()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
