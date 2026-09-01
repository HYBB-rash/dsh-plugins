import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPersonalFeedV2CandidateLifecycle } from '../src/index.ts'

const REQUEST_ID = 'telegram:4242:9001'
const CAPTURE_AT_DAY_ONE_START = '2026-08-31T16:00:00.000Z'
const CAPTURE_AT_DAY_ONE_END = '2026-09-01T15:59:59.000Z'
const CAPTURE_AT_DAY_SEVEN_END = '2026-09-07T15:59:59.999Z'
const CAPTURE_AT_DAY_EIGHT_START = '2026-09-07T16:00:00.000Z'
const CAPTURE_AT_DAY_NINE_START = '2026-09-08T16:00:00.000Z'
const REQUEST_CUTOFF = CAPTURE_AT_DAY_ONE_START
const SHANGHAI_DAY = '2026-09-01'

const FIRST_BODY = 'CANARY_X_STATUS_123_FIRST_7f3c9a2e11d04b8e'
const RICHER_DUPLICATE_BODY = 'CANARY_X_STATUS_123_LATER_RICHER_91e8b7c4d20a6f35'
const SECOND_REQUEST_BODY = 'CANARY_X_STATUS_123_SECOND_REQUEST_4d8a1f6c90be3275'

interface CaptureCounters {
  take: number
  close: number
}

type BodyCapture =
  | {
      readonly kind: 'sufficient'
      readonly capture: {
        readonly take: () => string
        readonly close: () => void
      }
    }
  | {
      readonly kind: 'insufficient' | 'failed' | 'unknown'
      readonly close: () => void
    }

function sufficientBody(body: string, counters: CaptureCounters): BodyCapture {
  return {
    kind: 'sufficient',
    capture: {
      take: () => {
        counters.take += 1
        return body
      },
      close: () => {
        counters.close += 1
      },
    },
  }
}

function request(
  requestId = REQUEST_ID,
  cutoff = REQUEST_CUTOFF,
  shanghaiDay = SHANGHAI_DAY,
) {
  return {
    requestId,
    cutoff,
    shanghaiDay,
  } as const
}

function occurrence(
  url: string,
  body: BodyCapture,
  capturedAt: string,
  occurrenceOrdinal = 0,
) {
  return {
    sourceUrl: url,
    body,
    occurrenceOrdinal,
    capturedAt,
    authorHandle: 'first_author_9f4c',
    publishedAt: '2026-08-30T12:34:56.000Z',
  } as const
}

function completeWindow(
  counters: CaptureCounters[],
  body = FIRST_BODY,
  firstCapturedAt = CAPTURE_AT_DAY_ONE_START,
  boundRequest = request(),
  duplicateCapturedAt = CAPTURE_AT_DAY_ONE_END,
) {
  return {
    requestId: boundRequest.requestId,
    cutoff: boundRequest.cutoff,
    shanghaiDay: boundRequest.shanghaiDay,
    surfaces: [
      {
        kind: 'complete',
        surface: 'for_you',
        surfaceOrdinal: 0,
        occurrences: [
          occurrence(
            'https://x.com/Alice/status/123',
            sufficientBody(body, counters[0]),
            firstCapturedAt,
          ),
        ],
      },
      {
        kind: 'complete',
        surface: 'following',
        surfaceOrdinal: 1,
        occurrences: [
          occurrence(
            'https://twitter.com/DifferentUser/status/123/photo/1/?utm_source=fixture#fragment',
            sufficientBody(RICHER_DUPLICATE_BODY, counters[1]),
            duplicateCapturedAt,
          ),
        ],
      },
      {
        kind: 'complete',
        surface: 'explore',
        surfaceOrdinal: 2,
        occurrences: [
          occurrence(
            'https://x.com/ThirdUser/status/123/video/2/',
            sufficientBody(RICHER_DUPLICATE_BODY, counters[2]),
            duplicateCapturedAt,
          ),
        ],
      },
    ] as const,
  } as const
}

function signal(): AbortSignal {
  return new AbortController().signal
}

async function expectNoLease(cursor: { borrowCurrent(input: { signal: AbortSignal }): unknown }) {
  const borrowed = await cursor.borrowCurrent({ signal: signal() })
  expect(borrowed).toMatchObject({ kind: 'incomplete' })
  return borrowed
}

async function expectDone(cursor: { borrowCurrent(input: { signal: AbortSignal }): unknown }) {
  const borrowed = await cursor.borrowCurrent({ signal: signal() })
  expect(borrowed).toEqual({ kind: 'done' })
  return borrowed
}

function replaceFirstSourceUrl(window: ReturnType<typeof completeWindow>, sourceUrl: string) {
  return {
    ...window,
    surfaces: [
      {
        ...window.surfaces[0],
        occurrences: [{ ...window.surfaces[0].occurrences[0], sourceUrl }],
      },
      window.surfaces[1],
      window.surfaces[2],
    ],
  } as const
}

function replaceFirstCapturedAt(window: ReturnType<typeof completeWindow>, capturedAt: string) {
  return {
    ...window,
    surfaces: [
      {
        ...window.surfaces[0],
        occurrences: [{ ...window.surfaces[0].occurrences[0], capturedAt }],
      },
      window.surfaces[1],
      window.surfaces[2],
    ],
  } as const
}

function replaceFirstBody(window: ReturnType<typeof completeWindow>, body: BodyCapture) {
  return {
    ...window,
    surfaces: [
      {
        ...window.surfaces[0],
        occurrences: [{ ...window.surfaces[0].occurrences[0], body }],
      },
      window.surfaces[1],
      window.surfaces[2],
    ],
  } as const
}

function replaceAllBodies(window: ReturnType<typeof completeWindow>, bodies: readonly BodyCapture[]) {
  return {
    ...window,
    surfaces: [
      {
        ...window.surfaces[0],
        occurrences: [{ ...window.surfaces[0].occurrences[0], body: bodies[0] }],
      },
      {
        ...window.surfaces[1],
        occurrences: [{ ...window.surfaces[1].occurrences[0], body: bodies[1] }],
      },
      {
        ...window.surfaces[2],
        occurrences: [{ ...window.surfaces[2].occurrences[0], body: bodies[2] }],
      },
    ],
  } as const
}

function observedSufficientBody(body: string, counters: CaptureCounters, onTake: () => void): BodyCapture {
  return {
    kind: 'sufficient',
    capture: {
      take: () => {
        counters.take += 1
        onTake()
        return body
      },
      close: () => {
        counters.close += 1
      },
    },
  }
}

function unavailableBody(kind: 'insufficient' | 'failed' | 'unknown', counters: CaptureCounters): BodyCapture {
  return {
    kind,
    close: () => {
      counters.close += 1
    },
  }
}

function malformedTakenBody(value: unknown, counters: CaptureCounters, onTake: () => void = () => {}): BodyCapture {
  return {
    kind: 'sufficient',
    capture: {
      take: () => {
        counters.take += 1
        onTake()
        return value as string
      },
      close: () => {
        counters.close += 1
      },
    },
  }
}

type FirstBodyFactory = (
  counters: CaptureCounters,
  requestController: AbortController,
  querySettled: () => boolean,
) => BodyCapture

interface InvalidFixture {
  readonly window: unknown
  readonly ownedCounters: readonly CaptureCounters[]
}

function invalidFixture(
  mutate: (window: ReturnType<typeof completeWindow>) => unknown,
  ownedIndexes: readonly number[] = [0, 1, 2],
): InvalidFixture {
  const counters: CaptureCounters[] = [{ take: 0, close: 0 }, { take: 0, close: 0 }, { take: 0, close: 0 }]
  const window = completeWindow(counters)
  return { window: mutate(window), ownedCounters: ownedIndexes.map(index => counters[index]) }
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Personal Feed v2 candidate lifecycle contract', () => {
  it('admits one complete three-surface window with stable X identity, first provenance, and Shanghai-day expiry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-candidate-lifecycle-'))
    temporaryDirectories.push(directory)
    const completionLedgerPath = join(directory, 'completion.jsonl')
    let now = new Date('2026-09-01T15:59:59.500Z')
    const owner = createPersonalFeedV2CandidateLifecycle({
      completionLedgerPath,
      clock: { now: () => new Date(now) },
    })

    const invalidWindows: readonly [string, () => InvalidFixture][] = [
      ['missing surface', () => invalidFixture(window => ({ ...window, surfaces: window.surfaces.slice(0, 2) }), [0, 1])],
      ['wrong surface order', () => invalidFixture(window => ({ ...window, surfaces: [window.surfaces[1], window.surfaces[0], window.surfaces[2]] }))],
      ['sparse surface tuple', () => invalidFixture(window => ({ ...window, surfaces: [window.surfaces[0], undefined, window.surfaces[2]] }), [0, 2])],
      ['wrong surface ordinal', () => invalidFixture(window => ({ ...window, surfaces: [{ ...window.surfaces[0], surfaceOrdinal: 1 }, window.surfaces[1], window.surfaces[2]] }))],
      ['wrong occurrence ordinal', () => invalidFixture(window => ({ ...window, surfaces: [{ ...window.surfaces[0], occurrences: [{ ...window.surfaces[0].occurrences[0], occurrenceOrdinal: 1 }] }, window.surfaces[1], window.surfaces[2]] }))],
      ['wrong request binding', () => invalidFixture(window => ({ ...window, requestId: 'telegram:other:9001' }))],
      ['wrong cutoff binding', () => invalidFixture(window => ({ ...window, cutoff: '2026-08-31T16:00:00.001Z' }))],
      ['wrong Shanghai day binding', () => invalidFixture(window => ({ ...window, shanghaiDay: '2026-09-02' }))],
      ['future capture', () => invalidFixture(window => replaceFirstCapturedAt(window, '2026-09-01T15:59:59.750Z'))],
      ['unexpected window key', () => invalidFixture(window => ({ ...window, unexpected: 'CANARY_UNEXPECTED_WINDOW_KEY' }))],
      ['non-HTTPS source URL', () => invalidFixture(window => replaceFirstSourceUrl(window, 'http://x.com/Alice/status/123'))],
      ['non-X source host', () => invalidFixture(window => replaceFirstSourceUrl(window, 'https://example.com/Alice/status/123'))],
      ['zero status ID', () => invalidFixture(window => replaceFirstSourceUrl(window, 'https://x.com/Alice/status/0'))],
      ['leading-zero status ID', () => invalidFixture(window => replaceFirstSourceUrl(window, 'https://x.com/Alice/status/0123'))],
      ['unapproved status path', () => invalidFixture(window => replaceFirstSourceUrl(window, 'https://x.com/Alice/status/123/analytics'))],
    ]
    for (const [label, createFixture] of invalidWindows) {
      const fixture = createFixture()
      const result = await owner.admit({ request: request(), window: fixture.window as never, signal: signal() })
      expect(result, label).toMatchObject({ kind: 'incomplete' })
      for (const counters of fixture.ownedCounters) {
        expect(counters, label).toEqual({ take: 0, close: 1 })
      }
    }

    const baseCounters: CaptureCounters[] = [{ take: 0, close: 0 }, { take: 0, close: 0 }, { take: 0, close: 0 }]
    const validWindow = completeWindow(baseCounters)
    const admitted = await owner.admit({ request: request(), window: validWindow as never, signal: signal() })
    expect(admitted.kind).toBe('admitted')
    if (admitted.kind !== 'admitted') throw new Error('complete window was not admitted')

    now = new Date(CAPTURE_AT_DAY_SEVEN_END)
    const firstBorrow = await admitted.cursor.borrowCurrent({ signal: signal() })
    expect(firstBorrow).toMatchObject({ kind: 'candidate' })
    if (firstBorrow.kind !== 'candidate') throw new Error('complete window did not yield a candidate')
    const firstLease = firstBorrow.lease as {
      readonly stableId: string
      readonly canonicalUrl: string
      readonly position: unknown
      readonly body: string
      readonly provenance: Record<string, unknown>
    }
    expect(firstLease).toMatchObject({
      stableId: 'x-status:123',
      canonicalUrl: 'https://x.com/alice/status/123',
      body: FIRST_BODY,
      provenance: {
        surface: 'for_you',
        surfaceOrdinal: 0,
        occurrenceOrdinal: 0,
        capturedAt: CAPTURE_AT_DAY_ONE_START,
        canonicalUrl: 'https://x.com/alice/status/123',
        authorHandle: 'first_author_9f4c',
        publishedAt: '2026-08-30T12:34:56.000Z',
      },
    })
    expect(firstLease.position).toBe(0)
    expect(firstBorrow).not.toHaveProperty('window')
    expect(firstBorrow).not.toHaveProperty('surfaces')
    expect(JSON.stringify(firstBorrow)).not.toContain(RICHER_DUPLICATE_BODY)
    expect(JSON.stringify(firstBorrow)).not.toContain('CANARY_UNEXPECTED_WINDOW_KEY')
    expect(baseCounters[0].take).toBe(1)
    expect(baseCounters[1].take).toBe(0)
    expect(baseCounters[2].take).toBe(0)
    await admitted.cursor.close('consumed')
    expect(baseCounters).toEqual([{ take: 1, close: 1 }, { take: 0, close: 1 }, { take: 0, close: 1 }])
    await expectDone(admitted.cursor)

    const lateCounters: CaptureCounters[] = [{ take: 0, close: 0 }, { take: 0, close: 0 }, { take: 0, close: 0 }]
    const lateRequest = request('telegram:4242:9002')
    const lateWindow = completeWindow(lateCounters, FIRST_BODY, CAPTURE_AT_DAY_ONE_END, lateRequest)
    const lateAdmitted = await owner.admit({ request: lateRequest, window: lateWindow as never, signal: signal() })
    expect(lateAdmitted.kind).toBe('admitted')
    if (lateAdmitted.kind !== 'admitted') throw new Error('late complete window was not admitted')
    expect(lateCounters[0].take).toBe(1)
    now = new Date(CAPTURE_AT_DAY_EIGHT_START)
    await expectNoLease(lateAdmitted.cursor)
    await lateAdmitted.cursor.close('expired')
    await expectDone(lateAdmitted.cursor)
    expect(lateCounters[0].take).toBe(1)
    expect(lateCounters.every(counter => counter.close === 1)).toBe(true)

    const newRequest = request('telegram:4242:9003', CAPTURE_AT_DAY_NINE_START, '2026-09-09')
    const newCounters: CaptureCounters[] = [{ take: 0, close: 0 }, { take: 0, close: 0 }, { take: 0, close: 0 }]
    const newWindow = completeWindow(newCounters, SECOND_REQUEST_BODY, CAPTURE_AT_DAY_NINE_START, newRequest, CAPTURE_AT_DAY_NINE_START)
    now = new Date(CAPTURE_AT_DAY_NINE_START)
    const newAdmitted = await owner.admit({ request: newRequest, window: newWindow as never, signal: signal() })
    expect(newAdmitted.kind).toBe('admitted')
    if (newAdmitted.kind !== 'admitted') throw new Error('new request was not admitted')
    const newBorrow = await newAdmitted.cursor.borrowCurrent({ signal: signal() })
    expect(newBorrow).toMatchObject({ kind: 'candidate' })
    if (newBorrow.kind !== 'candidate') throw new Error('new request did not yield a candidate')
    const newLease = newBorrow.lease as { readonly stableId: string; readonly body: string; readonly provenance: Record<string, unknown> }
    expect(newLease).toMatchObject({
      stableId: 'x-status:123',
      body: SECOND_REQUEST_BODY,
      provenance: { capturedAt: CAPTURE_AT_DAY_NINE_START, surface: 'for_you', surfaceOrdinal: 0, occurrenceOrdinal: 0 },
    })
    await newAdmitted.cursor.close('consumed')
    await expectDone(newAdmitted.cursor)

    const completionLedger = existsSync(completionLedgerPath) ? readFileSync(completionLedgerPath, 'utf8') : ''
    expect(completionLedger.trim()).toBe('')
  })

  it('queries processed state before body capture and fails closed for processed/query/body failures', async () => {
    const R4_MARKER = 'R4_PRIVATE_MARKER_2a7f9c4e'
    const queryCases: readonly {
      readonly name: string
      readonly queryResult?: unknown
      readonly queryThrows?: boolean
      readonly deferred?: boolean
      readonly expected: 'processed' | 'candidate' | 'incomplete'
      readonly unavailableBodyKind?: 'insufficient' | 'failed' | 'unknown'
      readonly firstBody?: FirstBodyFactory
    }[] = [
      { name: 'processed', queryResult: { kind: 'processed' }, expected: 'processed' },
      { name: 'unprocessed sufficient', queryResult: { kind: 'unprocessed' }, deferred: true, expected: 'candidate' },
      { name: 'unprocessed insufficient', queryResult: { kind: 'unprocessed' }, expected: 'incomplete', unavailableBodyKind: 'insufficient' },
      { name: 'unprocessed failed body', queryResult: { kind: 'unprocessed' }, expected: 'incomplete', unavailableBodyKind: 'failed' },
      { name: 'unprocessed unknown body', queryResult: { kind: 'unprocessed' }, expected: 'incomplete', unavailableBodyKind: 'unknown' },
      { name: 'query failed', queryResult: { kind: 'failed' }, expected: 'incomplete' },
      { name: 'query unknown', queryResult: { kind: 'unknown' }, expected: 'incomplete' },
      { name: 'query aborted', queryResult: { kind: 'aborted' }, expected: 'incomplete' },
      { name: 'query throw', queryThrows: true, expected: 'incomplete' },
      { name: 'query malformed', queryResult: { kind: 'processed', extra: R4_MARKER }, expected: 'incomplete' },
      {
        name: 'capture take throw',
        queryResult: { kind: 'unprocessed' },
        expected: 'incomplete',
        firstBody: (counters, _requestController, querySettled) => ({
          kind: 'sufficient',
          capture: {
            take: () => {
              counters.take += 1
              expect(querySettled()).toBe(true)
              throw new Error('capture take failed')
            },
            close: () => {
              counters.close += 1
            },
          },
        }),
      },
      {
        name: 'capture take abort',
        queryResult: { kind: 'unprocessed' },
        expected: 'incomplete',
        firstBody: (counters, requestController, querySettled) => ({
          kind: 'sufficient',
          capture: {
            take: () => {
              counters.take += 1
              expect(querySettled()).toBe(true)
              requestController.abort()
              throw new Error('capture take aborted')
            },
            close: () => {
              counters.close += 1
            },
          },
        }),
      },
      { name: 'capture take empty', queryResult: { kind: 'unprocessed' }, expected: 'incomplete', firstBody: (counters, _requestController, querySettled) => malformedTakenBody('', counters, () => expect(querySettled()).toBe(true)) },
      { name: 'capture take non-string', queryResult: { kind: 'unprocessed' }, expected: 'incomplete', firstBody: (counters, _requestController, querySettled) => malformedTakenBody({ [R4_MARKER]: true }, counters, () => expect(querySettled()).toBe(true)) },
    ]

    for (const queryCase of queryCases) {
      const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-processed-query-'))
      temporaryDirectories.push(directory)
      const completionLedgerPath = join(directory, 'completion.jsonl')
      const requestController = new AbortController()
      const counters: CaptureCounters[] = [{ take: 0, close: 0 }, { take: 0, close: 0 }, { take: 0, close: 0 }]
      let queryInput: { readonly stableId: string } | undefined
      let querySignal: AbortSignal | undefined
      let queryCalls = 0
      let querySettled = false
      let releaseDeferredQuery: (() => void) | undefined
      const owner = createPersonalFeedV2CandidateLifecycle({
        completionLedgerPath,
        clock: { now: () => new Date(CAPTURE_AT_DAY_ONE_END) },
        processedQuery: (input, signal) => {
          queryCalls += 1
          queryInput = input
          querySignal = signal
          if (queryCase.deferred) {
            return new Promise<unknown>(resolve => {
              releaseDeferredQuery = () => {
                querySettled = true
                resolve(queryCase.queryResult as never)
              }
            })
          }
          querySettled = true
          if (queryCase.queryThrows) throw new Error('processed query failed')
          return queryCase.queryResult as never
        },
      })
      const complete = completeWindow(counters)
      const firstBody = queryCase.firstBody?.(counters[0], requestController, () => querySettled)
      const window = queryCase.unavailableBodyKind !== undefined
        ? replaceAllBodies(complete, counters.map(counter => unavailableBody(queryCase.unavailableBodyKind!, counter)))
        : firstBody === undefined
          ? replaceFirstBody(complete, observedSufficientBody(FIRST_BODY, counters[0], () => {
            expect(querySettled, queryCase.name).toBe(true)
          }))
          : replaceFirstBody(complete, firstBody)
      const admissionPromise = owner.admit({ request: request(), window: window as never, signal: requestController.signal })
      if (queryCase.deferred) {
        await Promise.resolve()
        expect(querySettled, queryCase.name).toBe(false)
        expect(counters.every(counter => counter.take === 0), queryCase.name).toBe(true)
        expect(releaseDeferredQuery, queryCase.name).toBeTypeOf('function')
        releaseDeferredQuery?.()
      }
      const result = await admissionPromise

      expect(queryInput, queryCase.name).toEqual({ stableId: 'x-status:123' })
      expect(Object.keys(queryInput ?? {}), queryCase.name).toEqual(['stableId'])
      expect(JSON.stringify(queryInput), queryCase.name).not.toContain(R4_MARKER)
      expect(querySignal, queryCase.name).toBe(requestController.signal)
      expect(queryCalls, queryCase.name).toBe(1)

      if (queryCase.expected === 'processed') {
        expect(result, queryCase.name).toMatchObject({ kind: 'admitted' })
        if (result.kind !== 'admitted') throw new Error('processed result was not admitted')
        const borrowed = await result.cursor.borrowCurrent({ signal: requestController.signal })
        expect(borrowed, queryCase.name).toEqual({ kind: 'done' })
        expect(JSON.stringify(borrowed), queryCase.name).not.toContain(FIRST_BODY)
        expect(JSON.stringify(borrowed), queryCase.name).not.toContain(RICHER_DUPLICATE_BODY)
        await result.cursor.close('processed')
        expect(counters).toEqual([{ take: 0, close: 1 }, { take: 0, close: 1 }, { take: 0, close: 1 }])
      } else if (queryCase.expected === 'candidate') {
        expect(result, queryCase.name).toMatchObject({ kind: 'admitted' })
        if (result.kind !== 'admitted') throw new Error('unprocessed result was not admitted')
        const borrowed = await result.cursor.borrowCurrent({ signal: requestController.signal })
        expect(borrowed, queryCase.name).toMatchObject({ kind: 'candidate' })
        if (borrowed.kind !== 'candidate') throw new Error('unprocessed sufficient result was not a candidate')
        expect(borrowed.lease.body, queryCase.name).toBe(FIRST_BODY)
        expect(JSON.stringify(borrowed), queryCase.name).not.toContain(RICHER_DUPLICATE_BODY)
        await result.cursor.close('candidate')
        expect(counters).toEqual([{ take: 1, close: 1 }, { take: 0, close: 1 }, { take: 0, close: 1 }])
      } else {
        expect(result, queryCase.name).toMatchObject({ kind: 'incomplete' })
        expect(JSON.stringify(result), queryCase.name).not.toContain(FIRST_BODY)
        expect(JSON.stringify(result), queryCase.name).not.toContain(RICHER_DUPLICATE_BODY)
        expect(JSON.stringify(result), queryCase.name).not.toContain(R4_MARKER)
      }

      for (const counter of counters) {
        expect(counter.close, queryCase.name).toBe(1)
        expect(counter.take, queryCase.name).toBeLessThanOrEqual(1)
      }
      if (queryCase.name === 'processed') {
        expect(counters).toEqual([{ take: 0, close: 1 }, { take: 0, close: 1 }, { take: 0, close: 1 }])
      }
      const persisted = readdirSync(directory).map(file => readFileSync(join(directory, file), 'utf8')).join('\n')
      expect(persisted, queryCase.name).not.toContain(FIRST_BODY)
      expect(persisted, queryCase.name).not.toContain(RICHER_DUPLICATE_BODY)
      expect(persisted, queryCase.name).not.toContain(R4_MARKER)
      const completionLedger = existsSync(completionLedgerPath) ? readFileSync(completionLedgerPath, 'utf8') : ''
      expect(completionLedger, queryCase.name).toBe('')
    }
  })
})
