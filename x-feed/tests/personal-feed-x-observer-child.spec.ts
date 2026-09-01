import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

type FakeStreamEnd = (...args: unknown[]) => void

class FakeWritable extends EventEmitter {
  readonly endCalls: unknown[][] = []
  onEnd: FakeStreamEnd | undefined

  end(...args: unknown[]): void {
    this.endCalls.push(args)
    const callback = args.at(-1)
    if (typeof callback === 'function') callback()
    this.onEnd?.(...args)
  }
}

class FakeReadable extends EventEmitter {
  setEncoding(_encoding: string): this {
    return this
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeWritable()
  readonly stdout = new FakeReadable()
  readonly stderr = new FakeReadable()
  readonly kill = vi.fn((_signal?: string) => true)
  readonly pid = 7011
}

type ObserverRequest = {
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
}

type ObserverOptions = {
  readonly pythonFile: string
  readonly observerCliPath: string
  readonly totalBudgetMs: number
  readonly cleanupReserveMs: number
  readonly killGraceMs: number
  readonly nowEpochMs: () => number
  readonly spawn: (...args: unknown[]) => FakeChild
}

type ObserverChild = {
  readonly observe: (input: { readonly request: ObserverRequest; readonly signal: AbortSignal }) => Promise<unknown>
}

type ObserverFactory = (options: unknown) => ObserverChild

const REQUEST: ObserverRequest = Object.freeze({
  requestId: 'telegram:7:11',
  cutoff: '2026-08-31T10:00:00.123Z',
  shanghaiDay: '2026-08-31',
})

const CUTOFF_EPOCH_MS = Date.parse(REQUEST.cutoff)
const DEADLINE_EPOCH_MS = CUTOFF_EPOCH_MS + 8_000
const SHANGHAI_MIDNIGHT_EPOCH_MS = Date.parse('2026-08-31T16:00:00.000Z')

async function loadFactory(): Promise<ObserverFactory> {
  const moduleUrl = new URL('../src/personal-feed/x-observer-child.ts', import.meta.url).href
  const loaded = await import(/* @vite-ignore */ moduleUrl) as {
    readonly createPersonalFeedXObserverChild?: unknown
  }
  if (typeof loaded.createPersonalFeedXObserverChild !== 'function') {
    throw new Error('x-observer-child does not export createPersonalFeedXObserverChild')
  }
  return loaded.createPersonalFeedXObserverChild as ObserverFactory
}

function options(
  spawn: (...args: unknown[]) => FakeChild,
  nowEpochMs: number | (() => number) = CUTOFF_EPOCH_MS + 1_000,
): ObserverOptions {
  return {
    pythonFile: '/usr/bin/python3',
    observerCliPath: '/opt/x-feed/python/x_personal_feed_observer_cli.py',
    totalBudgetMs: 10_000,
    cleanupReserveMs: 2_000,
    killGraceMs: 500,
    nowEpochMs: typeof nowEpochMs === 'function' ? nowEpochMs : () => nowEpochMs,
    spawn,
  }
}

function validChild(spawnEvents: string[]): { readonly child: FakeChild; readonly spawn: ReturnType<typeof vi.fn> } {
  const child = new FakeChild()
  const spawn = vi.fn((...args: unknown[]) => {
    spawnEvents.push('spawn')
    expect(args).toHaveLength(3)
    return child
  })
  child.stdin.onEnd = () => {
    queueMicrotask(() => {
      child.stdout.emit('data', '{"schemaVersion":1,"kind":"observer_failed"}\n')
      child.emit('close', 0, null)
    })
  }
  return { child, spawn }
}

async function expectInvalidWithoutSpawn(
  factory: ObserverFactory,
  suppliedOptions: unknown,
  suppliedInput: unknown,
  spawn: ReturnType<typeof vi.fn>,
): Promise<void> {
  let rejected = false
  let result: unknown
  try {
    const child = factory(suppliedOptions)
    result = await child.observe(suppliedInput as { readonly request: ObserverRequest; readonly signal: AbortSignal })
  } catch {
    rejected = true
  }
  if (!rejected) expect(result).toEqual(Object.freeze({ kind: 'error', code: 'invalid_request' }))
  expect(spawn).not.toHaveBeenCalled()
}

describe('Personal Feed X observer child Group1 contract', () => {
  it('uses one fixed Python spawn and one exact deadline stdin write for a canonical request', async () => {
    const factory = await loadFactory()
    const spawnEvents: string[] = []
    const { child, spawn } = validChild(spawnEvents)
    const now = vi.fn(() => {
      spawnEvents.push('now')
      return CUTOFF_EPOCH_MS + 1_000
    })
    const signal = new AbortController().signal

    const result = await factory(options(spawn, now)).observe({ request: REQUEST, signal })

    expect(result).not.toEqual({ kind: 'error', code: 'invalid_request' })
    expect(result).not.toEqual({ kind: 'error', code: 'insufficient_budget' })
    expect(now).toHaveBeenCalledTimes(1)
    expect(spawnEvents.slice(0, 2)).toEqual(['now', 'spawn'])
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/python3',
      ['/opt/x-feed/python/x_personal_feed_observer_cli.py'],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    expect(child.stdin.endCalls).toHaveLength(1)
    expect(child.stdin.endCalls[0]).toEqual([
      `{"schemaVersion":1,"deadlineEpochMs":${DEADLINE_EPOCH_MS}}`,
      'utf8',
      expect.any(Function),
    ])
    const payload = child.stdin.endCalls[0]?.[0]
    expect(typeof payload).toBe('string')
    if (typeof payload === 'string') {
      expect(payload).not.toContain('\n')
      expect(new TextEncoder().encode(payload).byteLength).toBeLessThanOrEqual(4_096)
    }
  })

  it.each([
    { label: 'pre-aborted', code: 'aborted', preAborted: true, nowEpochMs: CUTOFF_EPOCH_MS + 1_000 },
    { label: 'spawn snapshot before cutoff', code: 'invalid_request', preAborted: false, nowEpochMs: CUTOFF_EPOCH_MS - 1 },
    { label: 'snapshot at cleanup deadline', code: 'insufficient_budget', preAborted: false, nowEpochMs: DEADLINE_EPOCH_MS },
    { label: 'budget clamped before Shanghai midnight', code: 'midnight_clamp', preAborted: false, nowEpochMs: CUTOFF_EPOCH_MS + 1_000 },
  ] as const)('enforces the cutoff-relative deadline gate: $label', async ({ code, preAborted, nowEpochMs }) => {
    const factory = await loadFactory()
    const spawnEvents: string[] = []
    const { child, spawn } = validChild(spawnEvents)
    const now = vi.fn(() => nowEpochMs)
    const controller = new AbortController()
    if (preAborted) controller.abort()

    const suppliedOptions = options(spawn, now)
    if (code === 'midnight_clamp') {
      Object.assign(suppliedOptions, {
        totalBudgetMs: SHANGHAI_MIDNIGHT_EPOCH_MS - CUTOFF_EPOCH_MS + 10_000,
      })
    }
    const result = await factory(suppliedOptions).observe({ request: REQUEST, signal: controller.signal })

    if (code === 'midnight_clamp') {
      expect(result).not.toEqual({ kind: 'error', code: 'invalid_request' })
      expect(result).not.toEqual({ kind: 'error', code: 'insufficient_budget' })
      expect(child.stdin.endCalls[0]?.[0]).toBe(
        `{"schemaVersion":1,"deadlineEpochMs":${SHANGHAI_MIDNIGHT_EPOCH_MS - 1 - 2_000}}`,
      )
      expect(spawn).toHaveBeenCalledTimes(1)
    } else {
      expect(result).toEqual(Object.freeze({ kind: 'error', code }))
      expect(spawn).not.toHaveBeenCalled()
    }
    if (preAborted) expect(now).not.toHaveBeenCalled()
    else expect(now).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['request with extra key', { request: { ...REQUEST, extra: true }, signal: new AbortController().signal }],
    ['request with symbol key', { request: Object.assign({ ...REQUEST }, { [Symbol('extra')]: true }), signal: new AbortController().signal }],
    ['request accessor', {
      request: Object.defineProperty({ ...REQUEST }, 'cutoff', { enumerable: true, get: () => { throw new Error('accessor') } }),
      signal: new AbortController().signal,
    }],
    ['request Proxy', { request: new Proxy({ ...REQUEST }, { ownKeys: () => { throw new Error('proxy') } }), signal: new AbortController().signal }],
    ['malformed request', { request: { requestId: REQUEST.requestId, cutoff: 'not-canonical', shanghaiDay: REQUEST.shanghaiDay }, signal: new AbortController().signal }],
    ['non-AbortSignal input', { request: REQUEST, signal: { aborted: false } }],
    ['forbidden options key', { request: REQUEST, optionKey: 'file' }],
    ['forbidden options key', { request: REQUEST, optionKey: 'argv' }],
    ['forbidden options key', { request: REQUEST, optionKey: 'args' }],
    ['forbidden options key', { request: REQUEST, optionKey: 'pythonArgs' }],
    ['forbidden options key', { request: REQUEST, optionKey: 'extraArgs' }],
    ['forbidden options key', { request: REQUEST, optionKey: 'module' }],
    ['forbidden options key', { request: REQUEST, optionKey: 'cwd' }],
    ['forbidden options key', { request: REQUEST, optionKey: 'env' }],
    ['forbidden options key', { request: REQUEST, optionKey: 'shell' }],
    ['empty pythonFile', { request: REQUEST, optionPatch: { pythonFile: '' } }],
    ['NUL pythonFile', { request: REQUEST, optionPatch: { pythonFile: '/usr/bin\u0000python3' } }],
    ['relative pythonFile', { request: REQUEST, optionPatch: { pythonFile: 'python3' } }],
    ['empty observerCliPath', { request: REQUEST, optionPatch: { observerCliPath: '' } }],
    ['NUL observerCliPath', { request: REQUEST, optionPatch: { observerCliPath: '/opt/x-feed\u0000observer.py' } }],
    ['relative observerCliPath', { request: REQUEST, optionPatch: { observerCliPath: 'observer.py' } }],
    ['zero total budget', { request: REQUEST, optionPatch: { totalBudgetMs: 0 } }],
    ['fractional cleanup reserve', { request: REQUEST, optionPatch: { cleanupReserveMs: 1.5 } }],
    ['cleanup reserve not below total budget', { request: REQUEST, optionPatch: { totalBudgetMs: 2_000, cleanupReserveMs: 2_000 } }],
    ['kill grace not below cleanup reserve', { request: REQUEST, optionPatch: { cleanupReserveMs: 500, killGraceMs: 500 } }],
    ['options symbol key', { request: REQUEST, optionSymbol: true }],
    ['options accessor', { request: REQUEST, optionAccessor: true }],
    ['options Proxy', { request: REQUEST, optionProxy: true }],
  ] as const)('rejects %s without invoking spawn', async (_label, fixture) => {
    const factory = await loadFactory()
    const spawnEvents: string[] = []
    const { spawn } = validChild(spawnEvents)
    const base = options(spawn)
    let suppliedOptions: unknown = base
    if ('optionKey' in fixture) suppliedOptions = { ...base, [fixture.optionKey]: true }
    if ('optionPatch' in fixture) suppliedOptions = { ...base, ...fixture.optionPatch }
    if ('optionSymbol' in fixture) suppliedOptions = Object.assign({ ...base }, { [Symbol('extra')]: true })
    if ('optionAccessor' in fixture) {
      suppliedOptions = Object.defineProperty({ ...base }, 'pythonFile', {
        enumerable: true,
        get: () => { throw new Error('accessor') },
      })
    }
    if ('optionProxy' in fixture) suppliedOptions = new Proxy({ ...base }, { ownKeys: () => { throw new Error('proxy') } })
    await expectInvalidWithoutSpawn(factory, suppliedOptions, {
      request: fixture.request,
      signal: 'signal' in fixture ? fixture.signal : new AbortController().signal,
    }, spawn)
  })
})

type RawObject = Record<string, unknown>

function jsonLine(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('fixture is not JSON serializable')
  return `${encoded}\n`
}

function rawChild(line: string): { readonly child: FakeChild; readonly spawn: ReturnType<typeof vi.fn> } {
  const child = new FakeChild()
  const spawn = vi.fn((...args: unknown[]) => {
    expect(args).toHaveLength(3)
    return child
  })
  child.stdin.onEnd = () => {
    queueMicrotask(() => {
      child.stdout.emit('data', line)
      child.emit('close', 0, null)
    })
  }
  return { child, spawn }
}

function occurrence(
  sourceUrl: string,
  occurrenceOrdinal: number,
  capturedAt: string,
  authorHandle = sourceUrl.split('/')[3],
  publishedAt = '2020-01-02T03:04:05.006Z',
  text = `post ${occurrenceOrdinal}`,
): RawObject {
  return {
    sourceUrl,
    body: { kind: 'sufficient', text },
    occurrenceOrdinal,
    capturedAt,
    authorHandle,
    publishedAt,
  }
}

function insufficientOccurrence(
  sourceUrl: string,
  occurrenceOrdinal: number,
  capturedAt: string,
  reason: string,
  authorHandle = sourceUrl.split('/')[3],
  publishedAt = '2020-01-02T03:04:05.006Z',
): RawObject {
  return {
    sourceUrl,
    body: { kind: 'insufficient', reason },
    occurrenceOrdinal,
    capturedAt,
    authorHandle,
    publishedAt,
  }
}

function completeFace(
  surface: string,
  surfaceOrdinal: number,
  startedAt: string,
  completedAt: string,
  occurrences: RawObject[],
  kind = 'complete',
): RawObject {
  return { kind, surface, surfaceOrdinal, startedAt, completedAt, occurrences }
}

function completeFixture(): RawObject {
  return {
    schemaVersion: 1,
    kind: 'complete',
    startedAt: '2026-08-31T10:00:00.500Z',
    completedAt: '2026-08-31T10:00:06.000Z',
    surfaces: [
      completeFace(
        'for_you',
        0,
        '2026-08-31T10:00:01.000Z',
        '2026-08-31T10:00:02.000Z',
        [
          occurrence('https://x.com/alice/status/101', 0, '2026-08-31T10:00:01.500Z', 'alice'),
          insufficientOccurrence('https://x.com/placeholder/status/102', 1, '2026-08-31T10:00:01.600Z', 'placeholder'),
          insufficientOccurrence('https://x.com/empty/status/103', 2, '2026-08-31T10:00:01.700Z', 'empty'),
          insufficientOccurrence('https://x.com/toolarge/status/104', 3, '2026-08-31T10:00:01.800Z', 'too_large'),
          insufficientOccurrence('https://x.com/showmore/status/105', 4, '2026-08-31T10:00:01.900Z', 'show_more_failed'),
        ],
      ),
      completeFace('following', 1, '2026-08-31T10:00:02.500Z', '2026-08-31T10:00:03.000Z', [], 'natural_zero'),
      completeFace(
        'explore',
        2,
        '2026-08-31T10:00:03.500Z',
        '2026-08-31T10:00:04.000Z',
        [occurrence('https://x.com/bob_2/status/202', 0, '2026-08-31T10:00:03.750Z', 'bob_2')],
      ),
    ],
  }
}

function allNaturalZeroFixture(): RawObject {
  return {
    schemaVersion: 1,
    kind: 'complete',
    startedAt: '2026-08-31T10:00:00.500Z',
    completedAt: '2026-08-31T10:00:04.000Z',
    surfaces: [
      completeFace('for_you', 0, '2026-08-31T10:00:01.000Z', '2026-08-31T10:00:01.500Z', [], 'natural_zero'),
      completeFace('following', 1, '2026-08-31T10:00:02.000Z', '2026-08-31T10:00:02.500Z', [], 'natural_zero'),
      completeFace('explore', 2, '2026-08-31T10:00:03.000Z', '2026-08-31T10:00:03.500Z', [], 'natural_zero'),
    ],
  }
}

function exactBoundaryUrl(surfaceOrdinal: number, occurrenceOrdinal: number): string {
  const handle = 'boundary_user__'
  const statusPrefix = String(100 + surfaceOrdinal * 8 + occurrenceOrdinal)
  const status = `${statusPrefix}${'2'.repeat(475 - statusPrefix.length)}`
  return `https://x.com/${handle}/status/${status}`
}

function boundaryCompleteFixture(): RawObject {
  const surfaces = ['for_you', 'following', 'explore'].map((surface, surfaceOrdinal) => {
    const faceStartSecond = 1 + surfaceOrdinal * 2
    const faceCompletedSecond = faceStartSecond + 2
    const faceStarted = `2026-08-31T10:00:0${faceStartSecond}.000Z`
    const faceCompleted = `2026-08-31T10:00:0${faceCompletedSecond}.000Z`
    const occurrences = Array.from({ length: 8 }, (_unused, occurrenceOrdinal) => {
      const capturedAt = `2026-08-31T10:00:0${faceStartSecond}.${String(100 + occurrenceOrdinal).padStart(3, '0')}Z`
      return occurrence(
        exactBoundaryUrl(surfaceOrdinal, occurrenceOrdinal),
        occurrenceOrdinal,
        capturedAt,
        'boundary_user__',
        '2010-01-01T00:00:00.000Z',
        'x'.repeat(6144),
      )
    })
    return completeFace(surface, surfaceOrdinal, faceStarted, faceCompleted, occurrences)
  })
  return {
    schemaVersion: 1,
    kind: 'complete',
    startedAt: '2026-08-31T10:00:00.500Z',
    completedAt: '2026-08-31T10:00:07.500Z',
    surfaces,
  }
}

function incompleteFixture(
  startedAt: string,
  completedAt: string,
  kinds: readonly [string, string, string] = ['unknown', 'partial', 'failed'],
): RawObject {
  return {
    schemaVersion: 1,
    kind: 'incomplete',
    startedAt,
    completedAt,
    surfaces: [
      { surface: 'for_you', surfaceOrdinal: 0, kind: kinds[0] },
      { surface: 'following', surfaceOrdinal: 1, kind: kinds[1] },
      { surface: 'explore', surfaceOrdinal: 2, kind: kinds[2] },
    ],
  }
}

function expectDeepFrozen(value: unknown): void {
  expect(Object.isFrozen(value)).toBe(true)
  if (Array.isArray(value)) {
    for (const entry of value) expectDeepFrozen(entry)
  } else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) expectDeepFrozen(entry)
  }
}

async function observeRaw(factory: ObserverFactory, line: string): Promise<unknown> {
  const { spawn } = rawChild(line)
  return factory(options(spawn)).observe({
    request: REQUEST,
    signal: new AbortController().signal,
  })
}

async function expectProtocolInvalid(factory: ObserverFactory, line: string, message?: string): Promise<void> {
  const result = await observeRaw(factory, line)
  expect(result, message).toEqual(Object.freeze({ kind: 'error', code: 'protocol_invalid' }))
  expect(Object.isFrozen(result)).toBe(true)
}

describe('Personal Feed X observer child Group2 raw DTO contract', () => {
  it('returns exact mixed and all-natural-zero complete DTOs as recursively frozen raw objects', async () => {
    const factory = await loadFactory()
    for (const raw of [completeFixture(), allNaturalZeroFixture()]) {
      const result = await observeRaw(factory, jsonLine(raw))
      expect(result).toEqual(raw)
      expectDeepFrozen(result)
    }
  })

  it('accepts the 8-per-surface, 24-total, 6144-byte body, 512-byte URL, and old publishedAt boundaries', async () => {
    const raw = boundaryCompleteFixture()
    const surfaces = raw.surfaces as RawObject[]
    const occurrences = surfaces.flatMap((surface) => surface.occurrences as RawObject[])
    expect(occurrences).toHaveLength(24)
    expect((occurrences[0]?.body as RawObject).text).toHaveLength(6144)
    expect(new TextEncoder().encode(String(occurrences[0]?.sourceUrl)).byteLength).toBe(512)
    expect(occurrences[0]?.publishedAt).toBe('2010-01-01T00:00:00.000Z')

    const factory = await loadFactory()
    const result = await observeRaw(factory, jsonLine(raw))
    expect(result).toEqual(raw)
    expectDeepFrozen(result)
  })

  it('accepts incomplete completedAt at D-1, D, D+1, and B-1 while rejecting forbidden times', async () => {
    const factory = await loadFactory()
    const valid = [
      ['D-1', '2026-08-31T10:00:00.123Z', '2026-08-31T10:00:08.122Z'],
      ['D', '2026-08-31T10:00:08.000Z', '2026-08-31T10:00:08.123Z'],
      ['D+1', '2026-08-31T10:00:08.000Z', '2026-08-31T10:00:08.124Z'],
      ['B-1', '2026-08-31T10:00:08.000Z', '2026-08-31T10:00:10.122Z'],
    ] as const
    for (const [label, startedAt, completedAt] of valid) {
      const raw = incompleteFixture(
        startedAt,
        completedAt,
        label === 'D-1' ? ['complete', 'natural_zero', 'unknown'] : ['unknown', 'partial', 'failed'],
      )
      const result = await observeRaw(factory, jsonLine(raw))
      expect(result).toEqual(raw)
      expectDeepFrozen(result)
    }

    const invalid = [
      ['completedAt B', incompleteFixture('2026-08-31T10:00:08.000Z', '2026-08-31T10:00:10.123Z')],
      ['startedAt D', incompleteFixture('2026-08-31T10:00:08.123Z', '2026-08-31T10:00:08.124Z')],
      ['reverse', incompleteFixture('2026-08-31T10:00:08.500Z', '2026-08-31T10:00:08.499Z')],
      ['cross-day', incompleteFixture('2026-08-31T10:00:08.000Z', '2026-09-01T10:00:00.000Z')],
    ] as const
    for (const [_label, raw] of invalid) await expectProtocolInvalid(factory, jsonLine(raw))
  })

  it('rejects malformed complete DTOs with protocol_invalid across the Group2 matrix', async () => {
    const malformed: Array<{ readonly label: string; readonly line: string }> = []
    const add = (label: string, mutate: (raw: RawObject) => void): void => {
      const raw = completeFixture()
      mutate(raw)
      malformed.push({ label, line: jsonLine(raw) })
    }
    add('top extra', (raw) => { raw.extra = true })
    add('top missing', (raw) => { delete raw.surfaces })
    add('top wrong type', (raw) => { raw.schemaVersion = '1' })
    add('surface extra', (raw) => { (raw.surfaces as RawObject[])[0].extra = true })
    add('surface missing', (raw) => { delete (raw.surfaces as RawObject[])[0].surface })
    add('surface wrong type', (raw) => { (raw.surfaces as RawObject[])[0].occurrences = {} })
    add('surface order', (raw) => {
      const surfaces = raw.surfaces as RawObject[]
      raw.surfaces = [surfaces[1], surfaces[0], surfaces[2]]
    })
    add('surface ordinal', (raw) => { (raw.surfaces as RawObject[])[0].surfaceOrdinal = 1 })
    add('occurrence extra', (raw) => {
      const occurrences = (raw.surfaces as RawObject[])[0].occurrences as RawObject[]
      occurrences[0].extra = true
    })
    add('occurrence missing', (raw) => {
      const occurrences = (raw.surfaces as RawObject[])[0].occurrences as RawObject[]
      delete occurrences[0].publishedAt
    })
    add('occurrence wrong type', (raw) => {
      const occurrences = (raw.surfaces as RawObject[])[0].occurrences as RawObject[]
      occurrences[0].authorHandle = 42
    })
    add('occurrence ordinal', (raw) => {
      const occurrences = (raw.surfaces as RawObject[])[0].occurrences as RawObject[]
      occurrences[0].occurrenceOrdinal = 1
    })
    add('body extra', (raw) => {
      const occurrenceValue = ((raw.surfaces as RawObject[])[0].occurrences as RawObject[])[0]
      occurrenceValue.body = { kind: 'sufficient', text: 'post 0', extra: true }
    })
    add('body missing', (raw) => {
      const occurrenceValue = ((raw.surfaces as RawObject[])[0].occurrences as RawObject[])[0]
      occurrenceValue.body = { kind: 'sufficient' }
    })
    add('body wrong type', (raw) => {
      const occurrenceValue = ((raw.surfaces as RawObject[])[0].occurrences as RawObject[])[0]
      occurrenceValue.body = null
    })
    add('insufficient unknown reason', (raw) => {
      const occurrenceValue = ((raw.surfaces as RawObject[])[0].occurrences as RawObject[])[0]
      occurrenceValue.body = { kind: 'insufficient', reason: 'unknown' }
    })
    add('insufficient with text', (raw) => {
      const occurrenceValue = ((raw.surfaces as RawObject[])[0].occurrences as RawObject[])[0]
      occurrenceValue.body = { kind: 'insufficient', reason: 'empty', text: '' }
    })
    add('insufficient with extra', (raw) => {
      const occurrenceValue = ((raw.surfaces as RawObject[])[0].occurrences as RawObject[])[0]
      occurrenceValue.body = { kind: 'insufficient', reason: 'empty', extra: true }
    })
    add('complete empty', (raw) => {
      (raw.surfaces as RawObject[])[0].occurrences = []
    })
    add('natural_zero nonempty', (raw) => {
      const surface = (raw.surfaces as RawObject[])[1]
      surface.occurrences = [occurrence('https://x.com/follow/status/303', 0, '2026-08-31T10:00:02.750Z', 'follow')]
    })
    add('9th occurrence', (raw) => {
      const surface = (raw.surfaces as RawObject[])[0]
      surface.occurrences = Array.from({ length: 9 }, (_unused, ordinal) =>
        occurrence(`https://x.com/alice/status/${101 + ordinal}`, ordinal, `2026-08-31T10:00:01.${String(100 + ordinal).padStart(3, '0')}Z`, 'alice'))
    })
    add('body too large', (raw) => {
      const occurrenceValue = ((raw.surfaces as RawObject[])[0].occurrences as RawObject[])[0]
      occurrenceValue.body = { kind: 'sufficient', text: 'x'.repeat(6145) }
    })
    add('body blank', (raw) => {
      const occurrenceValue = ((raw.surfaces as RawObject[])[0].occurrences as RawObject[])[0]
      occurrenceValue.body = { kind: 'sufficient', text: ' \n\t' }
    })
    add('URL noncanonical', (raw) => {
      const occurrenceValue = ((raw.surfaces as RawObject[])[0].occurrences as RawObject[])[0]
      occurrenceValue.sourceUrl = 'https://x.com/Alice/status/101'
    })
    add('URL 513 bytes', (raw) => {
      const occurrenceValue = ((raw.surfaces as RawObject[])[0].occurrences as RawObject[])[0]
      occurrenceValue.sourceUrl = `${exactBoundaryUrl(0, 0)}1`
    })
    add('URL handle mismatch', (raw) => {
      const occurrenceValue = ((raw.surfaces as RawObject[])[0].occurrences as RawObject[])[0]
      occurrenceValue.authorHandle = 'not_alice'
    })
    add('URL and author 16-character handle', (raw) => {
      const occurrenceValue = ((raw.surfaces as RawObject[])[0].occurrences as RawObject[])[0]
      occurrenceValue.sourceUrl = 'https://x.com/abcdefghijklmnop/status/101'
      occurrenceValue.authorHandle = 'abcdefghijklmnop'
    })
    add('capturedAt outside surface', (raw) => {
      const occurrenceValue = ((raw.surfaces as RawObject[])[0].occurrences as RawObject[])[0]
      occurrenceValue.capturedAt = '2026-08-31T10:00:02.500Z'
    })
    add('first surface starts before top', (raw) => {
      const surface = (raw.surfaces as RawObject[])[0]
      surface.startedAt = '2026-08-31T10:00:00.400Z'
      surface.completedAt = '2026-08-31T10:00:01.900Z'
    })
    add('last surface completes after top', (raw) => {
      const surface = (raw.surfaces as RawObject[])[2]
      surface.completedAt = '2026-08-31T10:00:06.500Z'
    })
    add('surface overlap', (raw) => {
      (raw.surfaces as RawObject[])[1].startedAt = '2026-08-31T10:00:01.500Z'
    })
    add('completeAt D', (raw) => { raw.completedAt = '2026-08-31T10:00:08.123Z' })
    add('invalid timestamp', (raw) => { raw.startedAt = '2026-02-29T10:00:00.500Z' })
    add('unpaired surrogate', (raw) => {
      const occurrenceValue = ((raw.surfaces as RawObject[])[0].occurrences as RawObject[])[0]
      const text = String.fromCharCode(0xd800)
      expect(text).toHaveLength(1)
      expect(text.charCodeAt(0)).toBe(0xd800)
      occurrenceValue.body = { kind: 'sufficient', text }
    })

    const factory = await loadFactory()
    for (const { label, line } of malformed) await expectProtocolInvalid(factory, line, label)
  })

  it('maps exact invalid_input to child_invalid_input and preserves observer_failed', async () => {
    const factory = await loadFactory()
    const cases = [
      ['invalid_input', jsonLine({ schemaVersion: 1, kind: 'invalid_input' }), 'child_invalid_input'],
      ['observer_failed', jsonLine({ schemaVersion: 1, kind: 'observer_failed' }), 'observer_failed'],
      ['invalid_input extra', jsonLine({ schemaVersion: 1, kind: 'invalid_input', extra: true }), 'protocol_invalid'],
      ['invalid_input missing schemaVersion', jsonLine({ kind: 'invalid_input' }), 'protocol_invalid'],
      ['observer_failed extra', jsonLine({ schemaVersion: 1, kind: 'observer_failed', extra: true }), 'protocol_invalid'],
      ['observer_failed missing schemaVersion', jsonLine({ kind: 'observer_failed' }), 'protocol_invalid'],
    ] as const
    for (const [_label, line, code] of cases) {
      const result = await observeRaw(factory, line)
      expect(result).toEqual(Object.freeze({ kind: 'error', code }))
      expect(Object.isFrozen(result)).toBe(true)
    }
  })
})
