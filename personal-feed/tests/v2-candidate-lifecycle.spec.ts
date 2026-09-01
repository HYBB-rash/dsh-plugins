import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeCanonicalJson } from '../src/canonical-json.ts'
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
  const topCompletedAt = Date.parse(firstCapturedAt) >= Date.parse(duplicateCapturedAt)
    ? firstCapturedAt
    : duplicateCapturedAt
  return {
    requestId: boundRequest.requestId,
    cutoff: boundRequest.cutoff,
    shanghaiDay: boundRequest.shanghaiDay,
    startedAt: boundRequest.cutoff,
    completedAt: topCompletedAt,
    surfaces: [
      {
        kind: 'complete',
        surface: 'for_you',
        surfaceOrdinal: 0,
        startedAt: boundRequest.cutoff,
        completedAt: firstCapturedAt,
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
        startedAt: firstCapturedAt,
        completedAt: duplicateCapturedAt,
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
        startedAt: duplicateCapturedAt,
        completedAt: duplicateCapturedAt,
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
  const shiftedDuplicateCapturedAt = Date.parse(capturedAt) > Date.parse(window.surfaces[1].completedAt)
    ? capturedAt
    : window.surfaces[1].completedAt
  return {
    ...window,
    completedAt: shiftedDuplicateCapturedAt,
    surfaces: [
      {
        ...window.surfaces[0],
        completedAt: capturedAt,
        occurrences: [{ ...window.surfaces[0].occurrences[0], capturedAt }],
      },
      {
        ...window.surfaces[1],
        startedAt: capturedAt,
        completedAt: shiftedDuplicateCapturedAt,
        occurrences: [{ ...window.surfaces[1].occurrences[0], capturedAt: shiftedDuplicateCapturedAt }],
      },
      {
        ...window.surfaces[2],
        startedAt: shiftedDuplicateCapturedAt,
        completedAt: shiftedDuplicateCapturedAt,
        occurrences: [{ ...window.surfaces[2].occurrences[0], capturedAt: shiftedDuplicateCapturedAt }],
      },
    ],
  } as const
}

function mixedNaturalZeroWindow(
  counters: CaptureCounters[],
  boundRequest = request(),
) {
  const capturedAt = boundRequest.cutoff
  return {
    requestId: boundRequest.requestId,
    cutoff: boundRequest.cutoff,
    shanghaiDay: boundRequest.shanghaiDay,
    startedAt: capturedAt,
    completedAt: capturedAt,
    surfaces: [
      {
        kind: 'natural_zero',
        surface: 'for_you',
        surfaceOrdinal: 0,
        startedAt: capturedAt,
        completedAt: capturedAt,
        occurrences: [],
      },
      {
        kind: 'complete',
        surface: 'following',
        surfaceOrdinal: 1,
        startedAt: capturedAt,
        completedAt: capturedAt,
        occurrences: [
          occurrence(
            'https://x.com/Following/status/4242',
            sufficientBody('CANARY_R3_FOLLOWING_STATUS_4242_7f3c9a2e', counters[1]),
            capturedAt,
          ),
        ],
      },
      {
        kind: 'natural_zero',
        surface: 'explore',
        surfaceOrdinal: 2,
        startedAt: capturedAt,
        completedAt: capturedAt,
        occurrences: [],
      },
    ] as const,
  } as const
}

function allNaturalZeroWindow(boundRequest = request()) {
  const capturedAt = boundRequest.cutoff
  const naturalZero = (surface: 'for_you' | 'following' | 'explore', surfaceOrdinal: number) => ({
    kind: 'natural_zero' as const,
    surface,
    surfaceOrdinal,
    startedAt: capturedAt,
    completedAt: capturedAt,
    occurrences: [],
  })
  return {
    requestId: boundRequest.requestId,
    cutoff: boundRequest.cutoff,
    shanghaiDay: boundRequest.shanghaiDay,
    startedAt: capturedAt,
    completedAt: capturedAt,
    surfaces: [
      naturalZero('for_you', 0),
      naturalZero('following', 1),
      naturalZero('explore', 2),
    ] as const,
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
  it('Group3B-1 validates exact R3 window handoff for mixed and all-natural-zero surfaces', async () => {
    const makeOwner = (now: string) => {
      const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-r3-group3b1-'))
      temporaryDirectories.push(directory)
      const completionLedgerPath = join(directory, 'completion.jsonl')
      return createPersonalFeedV2CandidateLifecycle({
        completionLedgerPath,
        clock: { now: () => new Date(now) },
      })
    }

    const mixedCounters: CaptureCounters[] = [{ take: 0, close: 0 }, { take: 0, close: 0 }, { take: 0, close: 0 }]
    const mixedOwner = makeOwner(CAPTURE_AT_DAY_ONE_END)
    const mixedWindow = mixedNaturalZeroWindow(mixedCounters)
    const mixedAdmission = await mixedOwner.admit({ request: request(), window: mixedWindow as never, signal: signal() })
    expect(mixedAdmission).toMatchObject({ kind: 'admitted' })
    if (mixedAdmission.kind !== 'admitted') throw new Error('Group3B-1 mixed window was not admitted')
    const mixedBorrow = await mixedAdmission.cursor.borrowCurrent({ signal: signal() })
    expect(mixedBorrow).toMatchObject({
      kind: 'candidate',
      lease: {
        position: 0,
        provenance: {
          surface: 'following',
          surfaceOrdinal: 1,
          occurrenceOrdinal: 0,
          capturedAt: REQUEST_CUTOFF,
        },
      },
    })
    await mixedAdmission.cursor.close('group3b1-mixed')
    expect(mixedCounters).toEqual([{ take: 0, close: 0 }, { take: 1, close: 1 }, { take: 0, close: 0 }])

    const allZeroOwner = makeOwner(CAPTURE_AT_DAY_ONE_END)
    const allZeroRequest = request('telegram:4242:9004')
    const allZeroWindow = allNaturalZeroWindow(allZeroRequest)
    const allZeroAdmission = await allZeroOwner.admit({ request: allZeroRequest, window: allZeroWindow as never, signal: signal() })
    expect(allZeroAdmission).toMatchObject({ kind: 'admitted' })
    if (allZeroAdmission.kind !== 'admitted') throw new Error('Group3B-1 all-natural-zero window was not admitted')
    expect(await allZeroAdmission.cursor.borrowCurrent({ signal: signal() })).toEqual({ kind: 'done' })
    await allZeroAdmission.cursor.close('group3b1-all-natural-zero')
    expect(allZeroWindow.surfaces.every(surface => surface.occurrences.length === 0)).toBe(true)

    const invalidWindows: readonly [string, () => InvalidFixture][] = [
      ['old schema missing top times', () => invalidFixture(window => {
        const { startedAt: _startedAt, completedAt: _completedAt, ...withoutTopTimes } = window
        return withoutTopTimes
      })],
      ['top started before cutoff', () => invalidFixture(window => ({ ...window, startedAt: '2026-08-31T15:59:59.999Z' }))],
      ['top completed at Shanghai midnight', () => invalidFixture(window => ({ ...window, completedAt: '2026-09-01T16:00:00.000Z' }))],
      ['top reversed', () => invalidFixture(window => ({ ...window, startedAt: CAPTURE_AT_DAY_ONE_END, completedAt: REQUEST_CUTOFF }))],
      ['face outside top', () => invalidFixture(window => ({
        ...window,
        surfaces: [
          { ...window.surfaces[0], completedAt: '2026-09-01T15:59:59.001Z' },
          window.surfaces[1],
          window.surfaces[2],
        ],
      }))],
      ['surface time overlap violating frozen order', () => invalidFixture(window => ({
        ...window,
        surfaces: [
          { ...window.surfaces[0], completedAt: CAPTURE_AT_DAY_ONE_END },
          { ...window.surfaces[1], startedAt: CAPTURE_AT_DAY_ONE_START },
          window.surfaces[2],
        ],
      }))],
      ['surface time reverse violating frozen order', () => invalidFixture(window => ({
        ...window,
        surfaces: [
          window.surfaces[0],
          { ...window.surfaces[1], startedAt: CAPTURE_AT_DAY_ONE_END, completedAt: CAPTURE_AT_DAY_ONE_START },
          window.surfaces[2],
        ],
      }))],
      ['capturedAt outside face', () => invalidFixture(window => ({
        ...window,
        surfaces: [
          {
            ...window.surfaces[0],
            occurrences: [{ ...window.surfaces[0].occurrences[0], capturedAt: CAPTURE_AT_DAY_ONE_END }],
          },
          window.surfaces[1],
          window.surfaces[2],
        ],
      }))],
      ['complete empty', () => invalidFixture(window => ({
        ...window,
        surfaces: [
          { ...window.surfaces[0], occurrences: [] },
          window.surfaces[1],
          window.surfaces[2],
        ],
      }), [1, 2])],
      ['natural_zero nonempty', () => invalidFixture(window => ({
        ...window,
        surfaces: [
          { ...window.surfaces[0], kind: 'natural_zero' },
          window.surfaces[1],
          window.surfaces[2],
        ],
      }))],
      ['extra top key', () => invalidFixture(window => ({ ...window, unexpected: 'CANARY_R3_TOP_EXTRA' }))],
      ['extra face key', () => invalidFixture(window => ({
        ...window,
        surfaces: [
          { ...window.surfaces[0], unexpected: 'CANARY_R3_FACE_EXTRA' },
          window.surfaces[1],
          window.surfaces[2],
        ],
      }))],
      ['noncanonical time', () => invalidFixture(window => ({ ...window, startedAt: '2026-09-01T00:00:00Z' }))],
      ['wrong-type time', () => invalidFixture(window => ({ ...window, completedAt: 123 }))],
    ]
    for (const [label, createFixture] of invalidWindows) {
      const fixture = createFixture()
      const owner = makeOwner(CAPTURE_AT_DAY_SEVEN_END)
      const result = await owner.admit({ request: request(), window: fixture.window as never, signal: signal() })
      expect(result, label).toMatchObject({ kind: 'incomplete' })
      for (const counters of fixture.ownedCounters) {
        expect(counters, label).toEqual({ take: 0, close: 1 })
      }
    }
  })

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

  it('owns ordered completion, canonical processed persistence, and exact final claims', async () => {
    const R4_MARKER = 'R4_PRIVATE_MARKER_2a7f9c4e'
    type CompletionReceipt = {
      readonly kind: 'candidate_judgment_completed'
      readonly stableId: string
      readonly requestId: string
      readonly position: number
      readonly judgment: 'qualified' | 'not_qualified'
      readonly completedAt: string
    }
    type Cursor = {
      readonly borrowCurrent: (input: { readonly signal: AbortSignal }) => Promise<unknown>
      readonly finalize: (claim: unknown) => Promise<unknown>
      readonly close: (reason: string) => unknown
    }

    const canaries = {
      101: 'CANARY_X_STATUS_101_7f3c9a2e11d04b8e',
      202: 'CANARY_X_STATUS_202_91e8b7c4d20a6f35',
      303: 'CANARY_X_STATUS_303_4d8a1f6c90be3275',
    } as const
    const requestFor = (requestId: string, capturedAt: string, shanghaiDay: string) => ({
      requestId,
      cutoff: capturedAt,
      shanghaiDay,
    } as const)
    const threeCandidateWindow = (counters: CaptureCounters[], request: ReturnType<typeof requestFor>) => ({
      requestId: request.requestId,
      cutoff: request.cutoff,
      shanghaiDay: request.shanghaiDay,
      startedAt: request.cutoff,
      completedAt: request.cutoff,
      surfaces: [
        {
          kind: 'complete',
          surface: 'for_you',
          surfaceOrdinal: 0,
          startedAt: request.cutoff,
          completedAt: request.cutoff,
          occurrences: [{
            sourceUrl: 'https://x.com/alpha/status/101',
            body: sufficientBody(canaries[101], counters[0]),
            occurrenceOrdinal: 0,
            capturedAt: request.cutoff,
            authorHandle: 'alpha_author_101',
            publishedAt: '2026-08-30T12:34:56.000Z',
          }],
        },
        {
          kind: 'complete',
          surface: 'following',
          surfaceOrdinal: 1,
          startedAt: request.cutoff,
          completedAt: request.cutoff,
          occurrences: [{
            sourceUrl: 'https://twitter.com/beta/status/202/photo/1',
            body: sufficientBody(canaries[202], counters[1]),
            occurrenceOrdinal: 0,
            capturedAt: request.cutoff,
            authorHandle: 'beta_author_202',
            publishedAt: '2026-08-30T12:35:56.000Z',
          }],
        },
        {
          kind: 'complete',
          surface: 'explore',
          surfaceOrdinal: 2,
          startedAt: request.cutoff,
          completedAt: request.cutoff,
          occurrences: [{
            sourceUrl: 'https://x.com/gamma/status/303/video/2',
            body: sufficientBody(canaries[303], counters[2]),
            occurrenceOrdinal: 0,
            capturedAt: request.cutoff,
            authorHandle: 'gamma_author_303',
            publishedAt: '2026-08-30T12:36:56.000Z',
          }],
        },
      ] as const,
    } as const)
    const canonicalEvent = (receipt: CompletionReceipt) => {
      const encoded = encodeCanonicalJson({
        schemaVersion: 1,
        event: 'candidate_judgment_completed',
        stableId: receipt.stableId,
        requestId: receipt.requestId,
        position: receipt.position,
        judgment: receipt.judgment,
        completedAt: receipt.completedAt,
      })
      expect(encoded).not.toBeUndefined()
      return `${encoded}\n`
    }
    const signalFor = () => new AbortController().signal
    const makeFixture = (now: string, requestId: string, shanghaiDay: string, processedQuery?: (input: { readonly stableId: string }, signal: AbortSignal) => unknown) => {
      const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-completion-'))
      temporaryDirectories.push(directory)
      const counters: CaptureCounters[] = [{ take: 0, close: 0 }, { take: 0, close: 0 }, { take: 0, close: 0 }]
      const completionLedgerPath = join(directory, 'completion.jsonl')
      const request = requestFor(requestId, now, shanghaiDay)
      let currentNow = new Date(now)
      const options = {
        completionLedgerPath,
        clock: { now: () => new Date(currentNow) },
        ...(processedQuery === undefined ? {} : { processedQuery: processedQuery as never }),
      }
      const owner = createPersonalFeedV2CandidateLifecycle(options)
      return { directory, completionLedgerPath, counters, request, window: threeCandidateWindow(counters, request), owner, setNow: (value: string) => { currentNow = new Date(value) } }
    }
    const invalidCompletionInput = async (requestId: string, input: unknown) => {
      const fixture = makeFixture('2026-08-31T16:00:00.000Z', requestId, '2026-09-01', () => ({ kind: 'unprocessed' }))
      const admission = await fixture.owner.admit({ request: fixture.request, window: fixture.window as never, signal: signalFor() })
      if (admission.kind !== 'admitted') throw new Error('invalid completion fixture was not admitted')
      const borrowed = await admission.cursor.borrowCurrent({ signal: signalFor() })
      if (borrowed.kind !== 'candidate') throw new Error('invalid completion candidate missing')
      expect(await borrowed.lease.completeCurrent(input as never)).toMatchObject({ kind: 'incomplete' })
      expect(existsSync(fixture.completionLedgerPath)).toBe(false)
      await admission.cursor.close('invalid-completion')
    }

    const first = makeFixture('2026-08-31T16:00:00.000Z', 'telegram:4242:9101', '2026-09-01', () => ({ kind: 'unprocessed' }))
    const firstAdmission = await first.owner.admit({ request: first.request, window: first.window as never, signal: signalFor() })
    expect(firstAdmission.kind).toBe('admitted')
    if (firstAdmission.kind !== 'admitted') throw new Error('ordered fixture was not admitted')
    const firstCursor = firstAdmission.cursor as Cursor
    const firstBorrow = await firstCursor.borrowCurrent({ signal: signalFor() })
    expect(firstBorrow).toMatchObject({ kind: 'candidate' })
    if (firstBorrow.kind !== 'candidate') throw new Error('first candidate was not borrowable')
    const firstLease = firstBorrow.lease as { readonly stableId: string; readonly position: number; readonly completeCurrent: (input: { readonly judgment: 'qualified' | 'not_qualified' }) => Promise<unknown> }
    expect(firstLease).toMatchObject({ stableId: 'x-status:101', position: 0, body: canaries[101] })
    const secondBorrowSame = await firstCursor.borrowCurrent({ signal: signalFor() })
    expect(secondBorrowSame).toMatchObject({ kind: 'candidate' })
    if (secondBorrowSame.kind !== 'candidate') throw new Error('repeat borrow did not yield a candidate')
    expect(secondBorrowSame.lease).toBe(firstLease)
    await invalidCompletionInput('telegram:4242:9130', { judgment: 'not_qualified', extra: 'CANARY_INVALID_COMPLETION_EXTRA' })
    await invalidCompletionInput('telegram:4242:9131', Object.assign(Object.create({ extra: 'CANARY_INVALID_COMPLETION_PROTO' }), { judgment: 'not_qualified' }))
    await invalidCompletionInput('telegram:4242:9132', { judgment: 'not_qualified', stableId: 'x-status:101', requestId: first.request.requestId, position: 0, time: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:00:00.000Z', canonicalUrl: 'https://x.com/alpha/status/101', body: canaries[101], signal: signalFor() })
    first.setNow('2026-08-31T16:00:01.000Z')
    const firstReceipt = await firstLease.completeCurrent({ judgment: 'not_qualified' }) as CompletionReceipt
    expect(firstReceipt).toMatchObject({ kind: 'candidate_judgment_completed', stableId: 'x-status:101', position: 0, judgment: 'not_qualified', requestId: first.request.requestId, completedAt: '2026-08-31T16:00:01.000Z' })
    expect(Object.isFrozen(firstReceipt)).toBe(true)
    expect(Object.getOwnPropertySymbols(firstReceipt)).toEqual([])
    expect(Object.keys(firstReceipt).sort()).toEqual(['completedAt', 'judgment', 'kind', 'position', 'requestId', 'stableId'])
    expect(canonicalEvent(firstReceipt)).toBe(`{"completedAt":"2026-08-31T16:00:01.000Z","event":"candidate_judgment_completed","judgment":"not_qualified","position":0,"requestId":"${first.request.requestId}","schemaVersion":1,"stableId":"x-status:101"}\n`)
    const firstLedger = readFileSync(first.completionLedgerPath, 'utf8')
    expect(firstLedger).toBe(canonicalEvent(firstReceipt))
    expect(statSync(first.completionLedgerPath).mode & 0o777).toBe(0o600)

    const secondBorrow = await firstCursor.borrowCurrent({ signal: signalFor() })
    expect(secondBorrow).toMatchObject({ kind: 'candidate' })
    if (secondBorrow.kind !== 'candidate') throw new Error('second candidate was not borrowable')
    const secondLease = secondBorrow.lease as { readonly stableId: string; readonly position: number; readonly completeCurrent: (input: { readonly judgment: 'qualified' | 'not_qualified' }) => Promise<unknown> }
    expect(secondLease).toMatchObject({ stableId: 'x-status:202', position: 1, body: canaries[202] })
    first.setNow('2026-08-31T16:00:02.000Z')
    const secondReceipt = await secondLease.completeCurrent({ judgment: 'qualified' }) as CompletionReceipt
    expect(secondReceipt).toMatchObject({ kind: 'candidate_judgment_completed', stableId: 'x-status:202', position: 1, judgment: 'qualified' })
    expect(Object.isFrozen(secondReceipt)).toBe(true)
    expect(Object.getOwnPropertySymbols(secondReceipt)).toEqual([])
    const replayBefore = readFileSync(first.completionLedgerPath, 'utf8')
    expect(await secondLease.completeCurrent({ judgment: 'qualified' })).toBe(secondReceipt)
    expect(readFileSync(first.completionLedgerPath, 'utf8')).toBe(replayBefore)
    expect(await firstCursor.borrowCurrent({ signal: signalFor() })).toMatchObject({ kind: 'done' })
    const selectedResult = await firstCursor.finalize({ kind: 'selected', completed: [firstReceipt, secondReceipt], selected: secondReceipt })
    expect(selectedResult).toMatchObject({ kind: 'selected', selected: { stableId: secondReceipt.stableId, canonicalUrl: 'https://x.com/beta/status/202', position: 1 } })
    await firstAdmission.cursor.close('terminal')
    expect(first.counters[0].close).toBe(1)
    expect(first.counters[1].close).toBe(1)
    expect(first.counters[2].close).toBe(1)
    expect(first.counters.every(counter => counter.take <= 1)).toBe(true)

    const expired = makeFixture('2026-08-31T16:00:00.000Z', 'telegram:4242:9113', '2026-09-01', () => ({ kind: 'unprocessed' }))
    const expiredAdmission = await expired.owner.admit({ request: expired.request, window: expired.window as never, signal: signalFor() })
    if (expiredAdmission.kind !== 'admitted') throw new Error('expired fixture was not admitted')
    const expiredBorrow = await expiredAdmission.cursor.borrowCurrent({ signal: signalFor() })
    if (expiredBorrow.kind !== 'candidate') throw new Error('expired candidate missing')
    expired.setNow('2026-09-07T16:00:00.000Z')
    expect(await expiredBorrow.lease.completeCurrent({ judgment: 'not_qualified' })).toMatchObject({ kind: 'incomplete' })
    expect(existsSync(expired.completionLedgerPath)).toBe(false)
    await expiredAdmission.cursor.close('expired')

    const boundary = makeFixture('2026-08-31T16:00:00.000Z', 'telegram:4242:9133', '2026-09-01', () => ({ kind: 'unprocessed' }))
    const boundaryAdmission = await boundary.owner.admit({ request: boundary.request, window: boundary.window as never, signal: signalFor() })
    if (boundaryAdmission.kind !== 'admitted') throw new Error('day-seven boundary fixture was not admitted')
    const boundaryBorrow = await boundaryAdmission.cursor.borrowCurrent({ signal: signalFor() })
    if (boundaryBorrow.kind !== 'candidate') throw new Error('day-seven boundary candidate missing')
    boundary.setNow('2026-09-07T15:59:59.999Z')
    const boundaryReceipt = await boundaryBorrow.lease.completeCurrent({ judgment: 'not_qualified' }) as CompletionReceipt
    expect(boundaryReceipt).toMatchObject({ kind: 'candidate_judgment_completed', judgment: 'not_qualified' })
    expect(readFileSync(boundary.completionLedgerPath, 'utf8')).toBe(canonicalEvent(boundaryReceipt))
    expect(readdirSync(boundary.directory).some(file => file.endsWith('.tmp'))).toBe(false)
    await boundaryAdmission.cursor.close('boundary')

    const replayBytes = readFileSync(first.completionLedgerPath, 'utf8')
    expect(replayBytes).toBe(`${canonicalEvent(firstReceipt)}${canonicalEvent(secondReceipt)}`)
    const firstPersisted = readdirSync(first.directory).map(file => readFileSync(join(first.directory, file), 'utf8')).join('\n')
    for (const canary of Object.values(canaries)) expect(firstPersisted).not.toContain(canary)

    const conflictFixture = makeFixture('2026-08-31T16:00:00.000Z', 'telegram:4242:9135', '2026-09-01', () => ({ kind: 'unprocessed' }))
    const conflictAdmission = await conflictFixture.owner.admit({ request: conflictFixture.request, window: conflictFixture.window as never, signal: signalFor() })
    if (conflictAdmission.kind !== 'admitted') throw new Error('conflict fixture was not admitted')
    const conflictBorrow = await conflictAdmission.cursor.borrowCurrent({ signal: signalFor() })
    if (conflictBorrow.kind !== 'candidate') throw new Error('conflict candidate missing')
    await conflictBorrow.lease.completeCurrent({ judgment: 'not_qualified' })
    const conflictBytes = readFileSync(conflictFixture.completionLedgerPath, 'utf8')
    expect(await conflictBorrow.lease.completeCurrent({ judgment: 'qualified' })).toMatchObject({ kind: 'incomplete', reason: 'completion_conflict' })
    expect(readFileSync(conflictFixture.completionLedgerPath, 'utf8')).toBe(conflictBytes)
    await conflictAdmission.cursor.close('conflict')

    const allNotQualified = makeFixture('2026-08-31T16:00:00.000Z', 'telegram:4242:9102', '2026-09-01', () => ({ kind: 'unprocessed' }))
    const allAdmission = await allNotQualified.owner.admit({ request: allNotQualified.request, window: allNotQualified.window as never, signal: signalFor() })
    if (allAdmission.kind !== 'admitted') throw new Error('all-not-qualified fixture was not admitted')
    const allReceipts: CompletionReceipt[] = []
    for (const position of [0, 1, 2]) {
      const borrowed = await allAdmission.cursor.borrowCurrent({ signal: signalFor() })
      expect(borrowed).toMatchObject({ kind: 'candidate' })
      if (borrowed.kind !== 'candidate') throw new Error('all-not-qualified candidate missing')
      expect((borrowed.lease as { readonly position: number }).position).toBe(position)
      allReceipts.push(await borrowed.lease.completeCurrent({ judgment: 'not_qualified' }) as CompletionReceipt)
    }
    expect(await allAdmission.cursor.borrowCurrent({ signal: signalFor() })).toMatchObject({ kind: 'done' })
    expect(await allAdmission.cursor.finalize({ kind: 'none', completed: allReceipts })).toEqual({ kind: 'none' })
    await allAdmission.cursor.close('terminal')

    for (const [requestId, reason] of [
      ['telegram:4242:9201', 'failed'],
      ['telegram:4242:9202', 'aborted'],
      ['telegram:4242:9203', 'timeout'],
      ['telegram:4242:9204', 'unknown'],
    ] as const) {
      const partial = makeFixture('2026-08-31T16:00:00.000Z', requestId, '2026-09-01', () => ({ kind: 'unprocessed' }))
      const partialAdmission = await partial.owner.admit({ request: partial.request, window: partial.window as never, signal: signalFor() })
      if (partialAdmission.kind !== 'admitted') throw new Error('partial fixture was not admitted')
      const partialBorrow = await partialAdmission.cursor.borrowCurrent({ signal: signalFor() })
      if (partialBorrow.kind !== 'candidate') throw new Error('partial candidate missing')
      const partialReceipt = await partialBorrow.lease.completeCurrent({ judgment: 'not_qualified' }) as CompletionReceipt
      const result = await partialAdmission.cursor.finalize({ kind: 'incomplete', completed: [partialReceipt], reason })
      expect(result).toMatchObject({ kind: 'incomplete', reason })
      await partialAdmission.cursor.close('partial')
    }
    const partialNone = makeFixture('2026-08-31T16:00:00.000Z', 'telegram:4242:9205', '2026-09-01', () => ({ kind: 'unprocessed' }))
    const partialNoneAdmission = await partialNone.owner.admit({ request: partialNone.request, window: partialNone.window as never, signal: signalFor() })
    if (partialNoneAdmission.kind !== 'admitted') throw new Error('partial-none fixture was not admitted')
    const partialNoneBorrow = await partialNoneAdmission.cursor.borrowCurrent({ signal: signalFor() })
    if (partialNoneBorrow.kind !== 'candidate') throw new Error('partial-none candidate missing')
    const partialNoneReceipt = await partialNoneBorrow.lease.completeCurrent({ judgment: 'not_qualified' }) as CompletionReceipt
    expect(await partialNoneAdmission.cursor.finalize({ kind: 'none', completed: [partialNoneReceipt] }))
      .toMatchObject({ kind: 'incomplete', reason: 'completion_claim_invalid' })
    await partialNoneAdmission.cursor.close('partial-none')

    const reservation = makeFixture('2026-08-31T16:00:00.000Z', 'telegram:4242:9104', '2026-09-01', () => ({ kind: 'unprocessed' }))
    const reservationFirst = await reservation.owner.admit({ request: reservation.request, window: reservation.window as never, signal: signalFor() })
    if (reservationFirst.kind !== 'admitted') throw new Error('reservation owner was not admitted')
    const reservationSecondRequest = requestFor('telegram:4242:9105', '2026-08-31T16:00:00.000Z', '2026-09-01')
    const reservationCounters: CaptureCounters[] = [{ take: 0, close: 0 }, { take: 0, close: 0 }, { take: 0, close: 0 }]
    const reservationSecond = await reservation.owner.admit({ request: reservationSecondRequest, window: threeCandidateWindow(reservationCounters, reservationSecondRequest) as never, signal: signalFor() })
    expect(reservationSecond).toMatchObject({ kind: 'incomplete', reason: 'concurrent_reservation' })
    expect(reservationCounters.every(counter => counter.take === 0)).toBe(true)
    const crashWhileActiveRequest = requestFor('telegram:4242:9115', '2026-08-31T16:00:00.000Z', '2026-09-01')
    const crashWhileActiveCounters: CaptureCounters[] = [{ take: 0, close: 0 }, { take: 0, close: 0 }, { take: 0, close: 0 }]
    const crashWhileActiveOwner = createPersonalFeedV2CandidateLifecycle({ completionLedgerPath: reservation.completionLedgerPath, clock: { now: () => new Date('2026-08-31T16:00:00.000Z') }, processedQuery: () => ({ kind: 'unprocessed' }) as never })
    const crashWhileActive = await crashWhileActiveOwner.admit({ request: crashWhileActiveRequest, window: threeCandidateWindow(crashWhileActiveCounters, crashWhileActiveRequest) as never, signal: signalFor() })
    expect(crashWhileActive.kind).toBe('admitted')
    if (crashWhileActive.kind === 'admitted') {
      expect(await crashWhileActive.cursor.borrowCurrent({ signal: signalFor() })).toMatchObject({ kind: 'candidate', lease: { stableId: 'x-status:101' } })
      await crashWhileActive.cursor.close('new-owner-after-crash')
    }
    await reservationFirst.cursor.close('release')
    const reservationRetryCounters: CaptureCounters[] = [{ take: 0, close: 0 }, { take: 0, close: 0 }, { take: 0, close: 0 }]
    const reservationRetry = await reservation.owner.admit({ request: reservationSecondRequest, window: threeCandidateWindow(reservationRetryCounters, reservationSecondRequest) as never, signal: signalFor() })
    expect(reservationRetry.kind).toBe('admitted')
    if (reservationRetry.kind === 'admitted') await reservationRetry.cursor.close('release')
    const persisted = makeFixture('2026-08-31T16:00:00.000Z', 'telegram:4242:9106', '2026-09-01', () => ({ kind: 'unprocessed' }))
    const persistedAdmission = await persisted.owner.admit({ request: persisted.request, window: persisted.window as never, signal: signalFor() })
    if (persistedAdmission.kind !== 'admitted') throw new Error('persistence fixture was not admitted')
    const persistedBorrow = await persistedAdmission.cursor.borrowCurrent({ signal: signalFor() })
    if (persistedBorrow.kind !== 'candidate') throw new Error('persistence candidate missing')
    const persistedReceipt = await persistedBorrow.lease.completeCurrent({ judgment: 'not_qualified' }) as CompletionReceipt
    await persistedAdmission.cursor.close('crash-before-finalize')
    const restarted = makeFixture('2026-09-01T16:00:00.000Z', 'telegram:4242:9107', '2026-09-02')
    writeFileSync(restarted.completionLedgerPath, canonicalEvent(persistedReceipt), { mode: 0o600 })
    const restartedAdmission = await restarted.owner.admit({ request: restarted.request, window: restarted.window as never, signal: signalFor() })
    expect(restartedAdmission.kind).toBe('admitted')
    if (restartedAdmission.kind === 'admitted') {
      const restartedBorrow = await restartedAdmission.cursor.borrowCurrent({ signal: signalFor() })
      expect(restartedBorrow).toMatchObject({ kind: 'candidate', lease: { stableId: 'x-status:202', position: 0 } })
      expect(restarted.counters[0].take).toBe(0)
      await restartedAdmission.cursor.close('restart')
    }
    const canonicalWithBadTemp = makeFixture('2026-09-01T16:00:00.000Z', 'telegram:4242:9112', '2026-09-02')
    writeFileSync(canonicalWithBadTemp.completionLedgerPath, canonicalEvent(persistedReceipt), { mode: 0o600 })
    writeFileSync(join(canonicalWithBadTemp.directory, 'completion.jsonl.tmp'), 'not canonical\n', { mode: 0o600 })
    const canonicalWithBadTempAdmission = await canonicalWithBadTemp.owner.admit({ request: canonicalWithBadTemp.request, window: canonicalWithBadTemp.window as never, signal: signalFor() })
    expect(canonicalWithBadTempAdmission.kind).toBe('admitted')
    if (canonicalWithBadTempAdmission.kind === 'admitted') {
      expect(await canonicalWithBadTempAdmission.cursor.borrowCurrent({ signal: signalFor() })).toMatchObject({ kind: 'candidate', lease: { stableId: 'x-status:202', position: 0 } })
      expect(canonicalWithBadTemp.counters[0].take).toBe(0)
      await canonicalWithBadTempAdmission.cursor.close('canonical')
    }
    const stale = makeFixture('2026-09-02T16:00:00.000Z', 'telegram:4242:9108', '2026-09-03')
    writeFileSync(join(stale.directory, 'completion.jsonl.tmp'), 'CANARY_STALE_TEMP_BODY_FREE\n', { mode: 0o600 })
    const staleAdmission = await stale.owner.admit({ request: stale.request, window: stale.window as never, signal: signalFor() })
    expect(staleAdmission.kind).toBe('admitted')
    if (staleAdmission.kind === 'admitted') {
      expect(await staleAdmission.cursor.borrowCurrent({ signal: signalFor() })).toMatchObject({ kind: 'candidate' })
      expect(stale.counters[0].take).toBe(1)
      await staleAdmission.cursor.close('stale-temp')
    }

    const prepareClaim = async (requestId: string, secondJudgment: 'qualified' | 'not_qualified' = 'qualified') => {
      const fixture = makeFixture('2026-08-31T16:00:00.000Z', requestId, '2026-09-01', () => ({ kind: 'unprocessed' }))
      const admission = await fixture.owner.admit({ request: fixture.request, window: fixture.window as never, signal: signalFor() })
      if (admission.kind !== 'admitted') throw new Error('claim fixture was not admitted')
      const firstBorrow = await admission.cursor.borrowCurrent({ signal: signalFor() })
      if (firstBorrow.kind !== 'candidate') throw new Error('claim r0 missing')
      const receipt0 = await firstBorrow.lease.completeCurrent({ judgment: 'not_qualified' }) as CompletionReceipt
      const secondBorrow = await admission.cursor.borrowCurrent({ signal: signalFor() })
      if (secondBorrow.kind !== 'candidate') throw new Error('claim r1 missing')
      const receipt1 = await secondBorrow.lease.completeCurrent({ judgment: secondJudgment }) as CompletionReceipt
      return { fixture, cursor: admission.cursor as Cursor, receipt0, receipt1, completed: [receipt0, receipt1] as const }
    }
    const claimCases: readonly { readonly name: string; readonly prepare: () => Promise<{ readonly claim: unknown; readonly cursor: Cursor; readonly fixture: ReturnType<typeof makeFixture>; readonly close: () => unknown }> }[] = [
      {
        name: 'copied receipt',
        prepare: async () => { const p = await prepareClaim('telegram:4242:9109'); return { claim: { kind: 'selected', completed: p.completed.map(receipt => ({ ...receipt })), selected: p.receipt1 }, cursor: p.cursor, fixture: p.fixture, close: () => p.cursor.close('invalid') } },
      },
      {
        name: 'future receipt',
        prepare: async () => { const p = await prepareClaim('telegram:4242:9110'); return { claim: { kind: 'selected', completed: [{ ...p.receipt0, completedAt: '2099-01-01T00:00:00.000Z' }, p.receipt1], selected: p.receipt1 }, cursor: p.cursor, fixture: p.fixture, close: () => p.cursor.close('invalid') } },
      },
      {
        name: 'omitted receipt',
        prepare: async () => { const p = await prepareClaim('telegram:4242:9111'); return { claim: { kind: 'selected', completed: [p.receipt0], selected: p.receipt1 }, cursor: p.cursor, fixture: p.fixture, close: () => p.cursor.close('invalid') } },
      },
      {
        name: 'duplicate receipt',
        prepare: async () => { const p = await prepareClaim('telegram:4242:9112'); return { claim: { kind: 'selected', completed: [p.receipt0, p.receipt0], selected: p.receipt1 }, cursor: p.cursor, fixture: p.fixture, close: () => p.cursor.close('invalid') } },
      },
      {
        name: 'out of order',
        prepare: async () => { const p = await prepareClaim('telegram:4242:9113'); return { claim: { kind: 'selected', completed: [p.receipt1, p.receipt0], selected: p.receipt1 }, cursor: p.cursor, fixture: p.fixture, close: () => p.cursor.close('invalid') } },
      },
      {
        name: 'sparse completed array',
        prepare: async () => { const p = await prepareClaim('telegram:4242:9114'); const completed = [p.receipt0, p.receipt1]; delete completed[1]; return { claim: { kind: 'selected', completed, selected: p.receipt1 }, cursor: p.cursor, fixture: p.fixture, close: () => p.cursor.close('invalid') } },
      },
      {
        name: 'array extra string and symbol',
        prepare: async () => { const p = await prepareClaim('telegram:4242:9115'); const completed = Object.assign([p.receipt0, p.receipt1], { extra: 'CANARY_EXTRA_STRING', [Symbol('extra')]: 'CANARY_EXTRA_SYMBOL' }); return { claim: { kind: 'selected', completed, selected: p.receipt1 }, cursor: p.cursor, fixture: p.fixture, close: () => p.cursor.close('invalid') } },
      },
      {
        name: 'outer extra',
        prepare: async () => { const p = await prepareClaim('telegram:4242:9116'); return { claim: Object.assign({ kind: 'selected', completed: p.completed, selected: p.receipt1 }, { extra: 'CANARY_OUTER_EXTRA' }), cursor: p.cursor, fixture: p.fixture, close: () => p.cursor.close('invalid') } },
      },
      {
        name: 'selected extra',
        prepare: async () => { const p = await prepareClaim('telegram:4242:9117'); return { claim: { kind: 'selected', completed: p.completed, selected: { ...p.receipt1, extra: 'CANARY_SELECTED_EXTRA' } }, cursor: p.cursor, fixture: p.fixture, close: () => p.cursor.close('invalid') } },
      },
      {
        name: 'selected not last',
        prepare: async () => { const p = await prepareClaim('telegram:4242:9118'); return { claim: { kind: 'selected', completed: p.completed, selected: p.receipt0 }, cursor: p.cursor, fixture: p.fixture, close: () => p.cursor.close('invalid') } },
      },
      {
        name: 'qualified after none',
        prepare: async () => { const p = await prepareClaim('telegram:4242:9119'); return { claim: { kind: 'none', completed: p.completed }, cursor: p.cursor, fixture: p.fixture, close: () => p.cursor.close('invalid') } },
      },
      {
        name: 'qualified after incomplete',
        prepare: async () => { const p = await prepareClaim('telegram:4242:9120'); return { claim: { kind: 'incomplete', completed: p.completed, reason: 'failed' }, cursor: p.cursor, fixture: p.fixture, close: () => p.cursor.close('invalid') } },
      },
    ]
    for (const claimCase of claimCases) {
      const prepared = await claimCase.prepare()
      const before = readFileSync(prepared.fixture.completionLedgerPath, 'utf8')
      const result = await prepared.cursor.finalize(prepared.claim)
      expect(result, claimCase.name).toMatchObject({ kind: 'incomplete', reason: 'completion_claim_invalid' })
      expect(readFileSync(prepared.fixture.completionLedgerPath, 'utf8'), claimCase.name).toBe(before)
      await prepared.close()
    }
    const selectedNotQualifiedFixture = makeFixture('2026-08-31T16:00:00.000Z', 'telegram:4242:9121', '2026-09-01', () => ({ kind: 'unprocessed' }))
    const selectedNotQualifiedAdmission = await selectedNotQualifiedFixture.owner.admit({ request: selectedNotQualifiedFixture.request, window: selectedNotQualifiedFixture.window as never, signal: signalFor() })
    if (selectedNotQualifiedAdmission.kind !== 'admitted') throw new Error('selected-not-qualified fixture was not admitted')
    const selectedNotQualifiedReceipts: CompletionReceipt[] = []
    for (const position of [0, 1, 2]) {
      const borrowed = await selectedNotQualifiedAdmission.cursor.borrowCurrent({ signal: signalFor() })
      if (borrowed.kind !== 'candidate') throw new Error('selected-not-qualified candidate missing')
      expect((borrowed.lease as { readonly position: number }).position).toBe(position)
      selectedNotQualifiedReceipts.push(await borrowed.lease.completeCurrent({ judgment: 'not_qualified' }) as CompletionReceipt)
    }
    expect(await selectedNotQualifiedAdmission.cursor.borrowCurrent({ signal: signalFor() })).toMatchObject({ kind: 'done' })
    expect(await selectedNotQualifiedAdmission.cursor.finalize({ kind: 'selected', completed: selectedNotQualifiedReceipts, selected: selectedNotQualifiedReceipts[2] })).toMatchObject({ kind: 'incomplete', reason: 'completion_claim_invalid' })
    await selectedNotQualifiedAdmission.cursor.close('invalid')
    const otherClaim = await prepareClaim('telegram:4242:9122')
    const otherBatch = await prepareClaim('telegram:4242:9123')
    const otherReceipt = otherBatch.receipt0
    const otherResult = await otherClaim.cursor.finalize({ kind: 'selected', completed: [otherReceipt, otherClaim.receipt1], selected: otherClaim.receipt1 })
    expect(otherResult).toMatchObject({ kind: 'incomplete', reason: 'completion_claim_invalid' })
    await otherClaim.cursor.close('invalid')
    await otherBatch.cursor.close('other')
    const validClaim = await prepareClaim('telegram:4242:9124')
    expect(await validClaim.cursor.finalize({ kind: 'selected', completed: validClaim.completed, selected: validClaim.receipt1 })).toMatchObject({ kind: 'selected', selected: { stableId: 'x-status:202', canonicalUrl: 'https://x.com/beta/status/202', position: 1 } })
    await validClaim.cursor.close('terminal')

    const noncanonicalCases = [
      (event: string) => event.replace('schemaVersion', 'event'),
      (event: string) => event.replace(',\"event\":', ',\"extra\":\"x\",\"event\":'),
      (event: string) => `${event}${event}`,
      (event: string) => event.slice(0, -1),
    ]
    for (const mutate of noncanonicalCases) {
      const corrupt = makeFixture('2026-09-03T16:00:00.000Z', 'telegram:4242:9111', '2026-09-04')
      writeFileSync(corrupt.completionLedgerPath, mutate(canonicalEvent(persistedReceipt)), { mode: 0o600 })
      const corruptAdmission = await corrupt.owner.admit({ request: corrupt.request, window: corrupt.window as never, signal: signalFor() })
      expect(corruptAdmission).toMatchObject({ kind: 'incomplete' })
      expect(corrupt.counters.every(counter => counter.take === 0)).toBe(true)
      await Promise.resolve(corruptAdmission)
    }
    for (const directory of temporaryDirectories) {
      const generated = readdirSync(directory).map(file => readFileSync(join(directory, file), 'utf8')).join('\n')
      for (const canary of Object.values(canaries)) expect(generated).not.toContain(canary)
      expect(generated).not.toContain(R4_MARKER)
    }
  })

  it('keeps failed captures retryable and releases every reservation without hiding close failure', async () => {
    const R4_MARKER = 'R4_PRIVATE_MARKER_B2_6e2d9c41'
    const CLOSE_ERROR = 'B2_CAPTURE_CLOSE_CANARY_8d4f1a7c'
    type B2Counter = CaptureCounters & { readonly reasons: string[] }

    const makeCounter = (): B2Counter => ({ take: 0, close: 0, reasons: [] })
    const makeSufficientCapture = (
      body: string,
      counter: B2Counter,
      failuresBeforeResolve: number,
    ): BodyCapture => {
      let failures = failuresBeforeResolve
      return {
        kind: 'sufficient',
        capture: {
          take: () => {
            counter.take += 1
            return body
          },
          close: (...args: unknown[]) => {
            const reason = args[0] as string
            counter.close += 1
            counter.reasons.push(reason)
            if (failures > 0) {
              failures -= 1
              throw new Error(CLOSE_ERROR)
            }
          },
        },
      }
    }
    const makeB2Window = (
      counters: readonly B2Counter[],
      requestValue: ReturnType<typeof request>,
      closeFailures: readonly number[] = [2, 0, 0],
    ) => ({
      requestId: requestValue.requestId,
      cutoff: requestValue.cutoff,
      shanghaiDay: requestValue.shanghaiDay,
      startedAt: requestValue.cutoff,
      completedAt: requestValue.cutoff,
      surfaces: [
        {
          kind: 'complete',
          surface: 'for_you',
          surfaceOrdinal: 0,
          startedAt: requestValue.cutoff,
          completedAt: requestValue.cutoff,
          occurrences: [{
            sourceUrl: 'https://x.com/alpha/status/101',
            body: makeSufficientCapture('CANARY_B2_STATUS_101_37af9e2c', counters[0]!, closeFailures[0]!),
            occurrenceOrdinal: 0,
            capturedAt: requestValue.cutoff,
            authorHandle: 'b2_alpha_101',
            publishedAt: '2026-08-30T12:34:56.000Z',
          }],
        },
        {
          kind: 'complete',
          surface: 'following',
          surfaceOrdinal: 1,
          startedAt: requestValue.cutoff,
          completedAt: requestValue.cutoff,
          occurrences: [{
            sourceUrl: 'https://twitter.com/beta/status/202/photo/1',
            body: makeSufficientCapture('CANARY_B2_STATUS_202_5bc18d40', counters[1]!, closeFailures[1]!),
            occurrenceOrdinal: 0,
            capturedAt: requestValue.cutoff,
            authorHandle: 'b2_beta_202',
            publishedAt: '2026-08-30T12:35:56.000Z',
          }],
        },
        {
          kind: 'complete',
          surface: 'explore',
          surfaceOrdinal: 2,
          startedAt: requestValue.cutoff,
          completedAt: requestValue.cutoff,
          occurrences: [{
            sourceUrl: 'https://x.com/gamma/status/303/video/2',
            body: makeSufficientCapture('CANARY_B2_STATUS_303_6e27a1f9', counters[2]!, closeFailures[2]!),
            occurrenceOrdinal: 0,
            capturedAt: requestValue.cutoff,
            authorHandle: 'b2_gamma_303',
            publishedAt: '2026-08-30T12:36:56.000Z',
          }],
        },
      ] as const,
    } as const)
    const signalFor = () => new AbortController().signal
    const oldRequest = request('telegram:4242:9201', CAPTURE_AT_DAY_ONE_START, SHANGHAI_DAY)
    const newRequest = request('telegram:4242:9202', CAPTURE_AT_DAY_ONE_START, SHANGHAI_DAY)
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-b2-close-retry-'))
    temporaryDirectories.push(directory)
    const completionLedgerPath = join(directory, 'completion.jsonl')
    let now = new Date(CAPTURE_AT_DAY_ONE_START)
    let aProcessed = false
    const owner = createPersonalFeedV2CandidateLifecycle({
      completionLedgerPath,
      clock: { now: () => new Date(now) },
      processedQuery: ({ stableId }) => stableId === 'x-status:101' && aProcessed
        ? { kind: 'processed' }
        : { kind: 'unprocessed' },
    })
    const oldCounters = [makeCounter(), makeCounter(), makeCounter()]
    const oldWindow = makeB2Window(oldCounters, oldRequest)
    const oldAdmission = await owner.admit({ request: oldRequest, window: oldWindow as never, signal: signalFor() })
    expect(oldAdmission).toMatchObject({ kind: 'admitted' })
    if (oldAdmission.kind !== 'admitted') throw new Error('B2 old admission was not admitted')
    const oldBorrow = await oldAdmission.cursor.borrowCurrent({ signal: signalFor() })
    expect(oldBorrow).toMatchObject({ kind: 'candidate', lease: { stableId: 'x-status:101', position: 0 } })
    if (oldBorrow.kind !== 'candidate') throw new Error('B2 A candidate was not borrowable')
    expect(oldCounters.map(counter => counter.take)).toEqual([1, 1, 1])

    now = new Date('2026-08-31T16:00:01.000Z')
    const firstCompletion = await oldBorrow.lease.completeCurrent({ judgment: 'not_qualified' })
    expect(firstCompletion).toEqual({ kind: 'incomplete', reason: 'capture_failed' })
    expect(readFileSync(completionLedgerPath, 'utf8')).toBe(
      `{"completedAt":"2026-08-31T16:00:01.000Z","event":"candidate_judgment_completed","judgment":"not_qualified","position":0,"requestId":"${oldRequest.requestId}","schemaVersion":1,"stableId":"x-status:101"}\n`,
    )
    aProcessed = true
    expect(oldCounters[0]).toEqual({ take: 1, close: 1, reasons: ['not_qualified'] })
    expect(oldCounters[1]).toEqual({ take: 1, close: 1, reasons: ['capture_failed'] })
    expect(oldCounters[2]).toEqual({ take: 1, close: 1, reasons: ['capture_failed'] })
    expect(JSON.stringify(firstCompletion)).not.toContain(CLOSE_ERROR)
    expect(JSON.stringify(firstCompletion)).not.toContain(R4_MARKER)

    const oldRetryBorrow = await oldAdmission.cursor.borrowCurrent({ signal: signalFor() })
    expect(oldRetryBorrow).toEqual({ kind: 'incomplete', reason: 'capture_failed' })

    const newCounters = [makeCounter(), makeCounter(), makeCounter()]
    const newWindow = makeB2Window(newCounters, newRequest, [0, 0, 0])
    const newAdmission = await owner.admit({ request: newRequest, window: newWindow as never, signal: signalFor() })
    expect(newAdmission).toMatchObject({ kind: 'admitted' })
    if (newAdmission.kind !== 'admitted') throw new Error('B2 reservation was not released')
    expect(newCounters[0].take).toBe(0)
    expect(newCounters[0].close).toBe(1)
    const newBorrow = await newAdmission.cursor.borrowCurrent({ signal: signalFor() })
    expect(newBorrow).toMatchObject({ kind: 'candidate', lease: { stableId: 'x-status:202', position: 0, body: 'CANARY_B2_STATUS_202_5bc18d40' } })
    await newAdmission.cursor.close('retry')
    expect(newCounters).toEqual([
      { take: 0, close: 1, reasons: ['processed'] },
      { take: 1, close: 1, reasons: ['cursor_closed'] },
      { take: 1, close: 1, reasons: ['cursor_closed'] },
    ])

    await expect(oldAdmission.cursor.close('cleanup')).rejects.toThrow('personal Feed v2 candidate capture close failed')
    expect(oldCounters[0]).toEqual({ take: 1, close: 2, reasons: ['not_qualified', 'not_qualified'] })
    expect(oldCounters[1]).toEqual({ take: 1, close: 1, reasons: ['capture_failed'] })
    expect(oldCounters[2]).toEqual({ take: 1, close: 1, reasons: ['capture_failed'] })
    await expect(oldAdmission.cursor.close('cleanup')).resolves.toBeUndefined()
    expect(oldCounters[0]).toEqual({ take: 1, close: 3, reasons: ['not_qualified', 'not_qualified', 'not_qualified'] })
    await expect(oldAdmission.cursor.close('cleanup')).resolves.toBeUndefined()
    expect(oldCounters[0]).toEqual({ take: 1, close: 3, reasons: ['not_qualified', 'not_qualified', 'not_qualified'] })
    expect(await oldAdmission.cursor.borrowCurrent({ signal: signalFor() })).toEqual({ kind: 'incomplete', reason: 'capture_failed' })

    const ledger = readFileSync(completionLedgerPath, 'utf8')
    expect(ledger.split('\n').filter(Boolean)).toHaveLength(1)
    expect(ledger).not.toContain('CANARY_B2_STATUS_101_37af9e2c')
    expect(ledger).not.toContain('CANARY_B2_STATUS_202_5bc18d40')
    expect(ledger).not.toContain('CANARY_B2_STATUS_303_6e27a1f9')
    const persisted = readdirSync(directory).map(file => readFileSync(join(directory, file), 'utf8')).join('\n')
    expect(persisted).not.toContain('CANARY_B2_STATUS_101_37af9e2c')
    expect(persisted).not.toContain('CANARY_B2_STATUS_202_5bc18d40')
    expect(persisted).not.toContain('CANARY_B2_STATUS_303_6e27a1f9')
    expect(persisted).not.toContain(R4_MARKER)
  })
})
