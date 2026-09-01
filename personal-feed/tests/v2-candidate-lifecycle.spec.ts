import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
})
