import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

const REQUEST = Object.freeze({
  requestId: 'telegram:17:23',
  cutoff: '2026-08-31T02:00:00.000Z',
  shanghaiDay: '2026-08-31',
})

type Calls = { take: number; close: number }
type Owner = Readonly<{ evaluate: (input: unknown) => Promise<unknown> }>
type Factory = (options: unknown) => Owner

async function factory(): Promise<Factory> {
  const loaded = await import('../src/v2/candidate-state-owner.ts') as Readonly<Record<string, unknown>>
  if (typeof loaded.createPersonalFeedV2CandidateStateOwner !== 'function') {
    throw new Error('CAPABILITY_ASSERTION: candidate state owner is unavailable')
  }
  return loaded.createPersonalFeedV2CandidateStateOwner as Factory
}

function body(text: string, calls: Calls, expectedSignal?: AbortSignal): Readonly<Record<string, unknown>> {
  const take = (input: unknown): string => {
    calls.take += 1
    if (expectedSignal !== undefined) expect(input).toEqual({ signal: expectedSignal })
    return text
  }
  const close = async (): Promise<void> => { calls.close += 1 }
  return Object.freeze({ kind: 'sufficient', capture: Object.freeze({ take, close }) })
}

function unavailable(calls: Calls, kind = 'insufficient'): Readonly<Record<string, unknown>> {
  const close = async (): Promise<void> => { calls.close += 1 }
  return Object.freeze({ kind, close })
}

function occurrence(
  status: number,
  authorHandle: string,
  capturedAt: string,
  occurrenceOrdinal: number,
  candidateBody: unknown,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    sourceUrl: `https://x.com/${authorHandle}/status/${status}`,
    body: candidateBody,
    occurrenceOrdinal,
    capturedAt,
    authorHandle,
    publishedAt: '2026-08-30T10:00:00.000Z',
  })
}

function surface(
  name: 'for_you' | 'following' | 'explore',
  ordinal: number,
  startedAt: string,
  completedAt: string,
  occurrences: readonly unknown[],
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    kind: occurrences.length === 0 ? 'natural_zero' : 'complete',
    surface: name,
    surfaceOrdinal: ordinal,
    startedAt,
    completedAt,
    occurrences: Object.freeze([...occurrences]),
  })
}

function window(faces: readonly unknown[]): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...REQUEST,
    startedAt: '2026-08-31T02:00:00.100Z',
    completedAt: '2026-08-31T02:00:04.000Z',
    surfaces: Object.freeze([...faces]),
  })
}

function threeFaces(
  forYou: readonly unknown[],
  following: readonly unknown[] = [],
  explore: readonly unknown[] = [],
): Readonly<Record<string, unknown>> {
  return window([
    surface('for_you', 0, '2026-08-31T02:00:00.200Z', '2026-08-31T02:00:01.000Z', forYou),
    surface('following', 1, '2026-08-31T02:00:01.100Z', '2026-08-31T02:00:02.000Z', following),
    surface('explore', 2, '2026-08-31T02:00:02.100Z', '2026-08-31T02:00:03.000Z', explore),
  ])
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function lines(path: string): readonly Readonly<Record<string, unknown>>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Readonly<Record<string, unknown>>)
}

function input(windowValue: unknown, requestSignal: AbortSignal, judgeOne: (candidate: unknown) => unknown): Readonly<Record<string, unknown>> {
  return Object.freeze({ request: REQUEST, window: windowValue, signal: requestSignal, judgeOne })
}

describe('Personal Feed v2 candidate-state owner', () => {
  it('deduplicates by stable identity, preserves first order and provenance, then stops at the first qualified candidate', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-candidate-state-'))
    const statePath = join(directory, 'candidate-state.jsonl')
    const requestSignal = signal()
    const a = { take: 0, close: 0 }
    const aDuplicate = { take: 0, close: 0 }
    const b = { take: 0, close: 0 }
    const c = { take: 0, close: 0 }
    const candidates: Readonly<Record<string, unknown>>[] = []
    try {
      const create = await factory()
      const owner = create({ statePath, clock: { now: () => new Date('2026-08-31T02:00:05.000Z') } })
      const result = await owner.evaluate(input(threeFaces([
        occurrence(101, 'alpha', '2026-08-31T02:00:00.300Z', 0, body('A_BODY_CANARY', a, requestSignal)),
        occurrence(202, 'beta', '2026-08-31T02:00:00.400Z', 1, body('B_BODY_CANARY', b, requestSignal)),
      ], [
        occurrence(101, 'alpha', '2026-08-31T02:00:01.200Z', 0, body('A_DUPLICATE_CANARY', aDuplicate, requestSignal)),
        occurrence(303, 'gamma', '2026-08-31T02:00:01.300Z', 1, body('C_BODY_CANARY', c, requestSignal)),
      ]), requestSignal, candidate => {
        candidates.push(candidate as Readonly<Record<string, unknown>>)
        return candidates.length === 1 ? { kind: 'not_qualified' } : { kind: 'qualified' }
      }))

      expect(result).toEqual({ kind: 'selected', stableId: 'x-status:202', canonicalUrl: 'https://x.com/beta/status/202' })
      expect(candidates.map(candidate => candidate.stableId)).toEqual(['x-status:101', 'x-status:202'])
      expect(candidates[0]).toEqual({
        stableId: 'x-status:101',
        canonicalUrl: 'https://x.com/alpha/status/101',
        body: 'A_BODY_CANARY',
        provenance: [
          { capturedAt: '2026-08-31T02:00:00.300Z', surface: 'for_you', surfaceOrdinal: 0, occurrenceOrdinal: 0, canonicalUrl: 'https://x.com/alpha/status/101', authorHandle: 'alpha', publishedAt: '2026-08-30T10:00:00.000Z' },
          { capturedAt: '2026-08-31T02:00:01.200Z', surface: 'following', surfaceOrdinal: 1, occurrenceOrdinal: 0, canonicalUrl: 'https://x.com/alpha/status/101', authorHandle: 'alpha', publishedAt: '2026-08-30T10:00:00.000Z' },
        ],
      })
      expect([a.take, aDuplicate.take, b.take, c.take]).toEqual([1, 0, 1, 0])
      expect([a.close, aDuplicate.close, b.close, c.close]).toEqual([1, 1, 1, 1])
      expect(lines(statePath)).toEqual([
        { schemaVersion: 1, event: 'candidate_first_captured', stableId: 'x-status:101', firstCapturedAt: '2026-08-31T02:00:00.300Z' },
        { schemaVersion: 1, event: 'candidate_first_captured', stableId: 'x-status:202', firstCapturedAt: '2026-08-31T02:00:00.400Z' },
        { schemaVersion: 1, event: 'candidate_first_captured', stableId: 'x-status:303', firstCapturedAt: '2026-08-31T02:00:01.300Z' },
        { schemaVersion: 1, event: 'candidate_processed', stableId: 'x-status:101', judgment: 'not_qualified', processedAt: '2026-08-31T02:00:05.000Z' },
        { schemaVersion: 1, event: 'candidate_processed', stableId: 'x-status:202', judgment: 'qualified', processedAt: '2026-08-31T02:00:05.000Z' },
      ])
      const persisted = readFileSync(statePath, 'utf8')
      expect(persisted).not.toMatch(/A_BODY_CANARY|A_DUPLICATE_CANARY|B_BODY_CANARY|C_BODY_CANARY/)
      expect(statSync(statePath).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('returns none only after every unprocessed candidate is judged not qualified, including a natural-zero window', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-candidate-state-'))
    try {
      const create = await factory()
      const owner = create({ statePath: join(directory, 'state.jsonl'), clock: { now: () => new Date('2026-08-31T02:00:05.000Z') } })
      const calls = { take: 0, close: 0 }
      await expect(owner.evaluate(input(threeFaces([
        occurrence(101, 'alpha', '2026-08-31T02:00:00.300Z', 0, body('candidate', calls)),
      ]), signal(), () => ({ kind: 'not_qualified' })))).resolves.toEqual({ kind: 'none' })
      expect(calls).toEqual({ take: 1, close: 1 })
      await expect(owner.evaluate(input(threeFaces([]), signal(), () => { throw new Error('must not judge') }))).resolves.toEqual({ kind: 'none' })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('accepts a candidate captured in the same millisecond as its surface completion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-candidate-state-'))
    const calls = { take: 0, close: 0 }
    try {
      const create = await factory()
      const owner = create({ statePath: join(directory, 'state.jsonl'), clock: { now: () => new Date('2026-08-31T02:00:05.000Z') } })
      const currentWindow = threeFaces([], [], [
        occurrence(101, 'alpha', '2026-08-31T02:00:03.000Z', 0, body('candidate', calls)),
      ])

      await expect(owner.evaluate(input(currentWindow, signal(), () => ({ kind: 'qualified' })))).resolves.toEqual({
        kind: 'selected',
        stableId: 'x-status:101',
        canonicalUrl: 'https://x.com/alpha/status/101',
      })
      expect(calls).toEqual({ take: 1, close: 1 })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('queries the single body-free log before taking body and skips an already processed stable identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-candidate-state-'))
    const statePath = join(directory, 'state.jsonl')
    const calls = { take: 0, close: 0 }
    try {
      writeFileSync(statePath, [
        JSON.stringify({ schemaVersion: 1, event: 'candidate_first_captured', stableId: 'x-status:101', firstCapturedAt: '2026-08-30T02:00:00.000Z' }),
        JSON.stringify({ schemaVersion: 1, event: 'candidate_processed', stableId: 'x-status:101', judgment: 'qualified', processedAt: '2026-08-30T02:01:00.000Z' }),
        '',
      ].join('\n'), { mode: 0o600 })
      const create = await factory()
      const owner = create({ statePath, clock: { now: () => new Date('2026-08-31T02:00:05.000Z') } })
      await expect(owner.evaluate(input(threeFaces([
        occurrence(101, 'alpha', '2026-08-31T02:00:00.300Z', 0, body('PROCESSED_BODY_CANARY', calls)),
      ]), signal(), () => { throw new Error('must not judge') }))).resolves.toEqual({ kind: 'none' })
      expect(calls).toEqual({ take: 0, close: 1 })
      expect(readFileSync(statePath, 'utf8')).not.toContain('PROCESSED_BODY_CANARY')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails closed on corrupt or unknown candidate state before any body propagation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-candidate-state-'))
    const statePath = join(directory, 'state.jsonl')
    const calls = { take: 0, close: 0 }
    try {
      writeFileSync(statePath, '{"schemaVersion":1,"event":"unknown"}\n', { mode: 0o600 })
      const create = await factory()
      const owner = create({ statePath, clock: { now: () => new Date('2026-08-31T02:00:05.000Z') } })
      await expect(owner.evaluate(input(threeFaces([
        occurrence(101, 'alpha', '2026-08-31T02:00:00.300Z', 0, body('CORRUPT_STATE_CANARY', calls)),
      ]), signal(), () => ({ kind: 'qualified' })))).resolves.toEqual({ kind: 'incomplete' })
      expect(calls).toEqual({ take: 0, close: 1 })
      expect(readFileSync(statePath, 'utf8')).not.toContain('CORRUPT_STATE_CANARY')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not mark processed when body release or judgement is incomplete, malformed, aborted, or throws', async () => {
    const cases = [
      { name: 'insufficient body', makeBody: (calls: Calls) => unavailable(calls), judge: () => ({ kind: 'qualified' }), abort: false, expectedTake: 0 },
      { name: 'malformed judgement', makeBody: (calls: Calls) => body('BODY_CANARY', calls), judge: () => ({ kind: 'maybe' }), abort: false, expectedTake: 1 },
      { name: 'explicit incomplete', makeBody: (calls: Calls) => body('BODY_CANARY', calls), judge: () => ({ kind: 'incomplete' }), abort: false, expectedTake: 1 },
      { name: 'judgement throws', makeBody: (calls: Calls) => body('BODY_CANARY', calls), judge: () => { throw new Error('BODY_CANARY') }, abort: false, expectedTake: 1 },
      { name: 'aborted', makeBody: (calls: Calls) => body('BODY_CANARY', calls), judge: () => ({ kind: 'qualified' }), abort: true, expectedTake: 0 },
    ]
    const create = await factory()
    for (const testCase of cases) {
      const directory = mkdtempSync(join(tmpdir(), 'personal-feed-candidate-state-'))
      const statePath = join(directory, 'state.jsonl')
      const calls = { take: 0, close: 0 }
      const controller = new AbortController()
      if (testCase.abort) controller.abort()
      try {
        const owner = create({ statePath, clock: { now: () => new Date('2026-08-31T02:00:05.000Z') } })
        const result = await owner.evaluate(input(threeFaces([
          occurrence(101, 'alpha', '2026-08-31T02:00:00.300Z', 0, testCase.makeBody(calls)),
        ]), controller.signal, testCase.judge))
        expect(result, testCase.name).toEqual({ kind: 'incomplete' })
        expect(calls.take, testCase.name).toBe(testCase.expectedTake)
        expect(calls.close, testCase.name).toBe(1)
        expect(lines(statePath).filter(record => record.event === 'candidate_processed'), testCase.name).toEqual([])
        if (existsSync(statePath)) expect(readFileSync(statePath, 'utf8'), testCase.name).not.toContain('BODY_CANARY')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })

  it('enforces the Shanghai Day-8 boundary from the earliest persisted capture without renewal after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-candidate-state-'))
    const statePath = join(directory, 'state.jsonl')
    const calls = { take: 0, close: 0 }
    const original = `${JSON.stringify({ schemaVersion: 1, event: 'candidate_first_captured', stableId: 'x-status:101', firstCapturedAt: '2026-08-24T15:59:59.999Z' })}\n`
    try {
      writeFileSync(statePath, original, { mode: 0o600 })
      const create = await factory()
      const restarted = create({ statePath, clock: { now: () => new Date('2026-08-30T16:00:00.000Z') } })
      await expect(restarted.evaluate(input(threeFaces([
        occurrence(101, 'alpha', '2026-08-31T02:00:00.300Z', 0, body('EXPIRED_BODY_CANARY', calls)),
      ]), signal(), () => ({ kind: 'qualified' })))).resolves.toEqual({ kind: 'incomplete' })
      expect(calls).toEqual({ take: 0, close: 1 })
      expect(readFileSync(statePath, 'utf8')).toBe(original)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('closes every recognized capture and rejects a false three-surface AND without taking body', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-candidate-state-'))
    const calls = { take: 0, close: 0 }
    try {
      const create = await factory()
      const owner = create({ statePath: join(directory, 'state.jsonl'), clock: { now: () => new Date('2026-08-31T02:00:05.000Z') } })
      const badWindow = window([
        surface('following', 0, '2026-08-31T02:00:00.200Z', '2026-08-31T02:00:01.000Z', [
          occurrence(101, 'alpha', '2026-08-31T02:00:00.300Z', 0, body('INVALID_WINDOW_CANARY', calls)),
        ]),
        surface('for_you', 1, '2026-08-31T02:00:01.100Z', '2026-08-31T02:00:02.000Z', []),
        surface('explore', 2, '2026-08-31T02:00:02.100Z', '2026-08-31T02:00:03.000Z', []),
      ])
      await expect(owner.evaluate(input(badWindow, signal(), () => ({ kind: 'qualified' })))).resolves.toEqual({ kind: 'incomplete' })
      expect(calls).toEqual({ take: 0, close: 1 })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('serializes overlapping evaluations through the one owner so a completed identity is not judged twice', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-candidate-state-'))
    const firstCalls = { take: 0, close: 0 }
    const secondCalls = { take: 0, close: 0 }
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    try {
      const create = await factory()
      const owner = create({ statePath: join(directory, 'state.jsonl'), clock: { now: () => new Date('2026-08-31T02:00:05.000Z') } })
      const first = owner.evaluate(input(threeFaces([
        occurrence(101, 'alpha', '2026-08-31T02:00:00.300Z', 0, body('FIRST_BODY_CANARY', firstCalls)),
      ]), signal(), async () => { await gate; return { kind: 'not_qualified' } }))
      const second = owner.evaluate(input(threeFaces([
        occurrence(101, 'alpha', '2026-08-31T02:00:00.300Z', 0, body('SECOND_BODY_CANARY', secondCalls)),
      ]), signal(), () => { throw new Error('must not judge twice') }))
      await Promise.resolve()
      expect(secondCalls.take).toBe(0)
      release()
      await expect(first).resolves.toEqual({ kind: 'none' })
      await expect(second).resolves.toEqual({ kind: 'none' })
      expect(firstCalls).toEqual({ take: 1, close: 1 })
      expect(secondCalls).toEqual({ take: 0, close: 1 })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
