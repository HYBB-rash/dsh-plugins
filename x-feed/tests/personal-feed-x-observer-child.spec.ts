import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

type FakeStreamEnd = (...args: unknown[]) => void

class FakeWritable extends EventEmitter {
  readonly endCalls: unknown[][] = []
  onEnd: FakeStreamEnd | undefined
  callbackError: unknown = undefined
  endError: unknown = undefined

  end(...args: unknown[]): void {
    this.endCalls.push(args)
    if (this.endError !== undefined) throw this.endError
    const callback = args.at(-1)
    if (typeof callback === 'function') callback(this.callbackError)
    this.onEnd?.(...args)
  }
}

class FakeReadable extends EventEmitter {
  throwOnOn = false

  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    if (this.throwOnOn) throw new Error('STREAM_ON_CANARY')
    return super.on(event, listener)
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeWritable()
  readonly stdout = new FakeReadable()
  readonly stderr = new FakeReadable()
  killResult = true
  killError: unknown = undefined
  emitCloseOnKillOrdinal: number | undefined
  readonly onCalls: string[] = []
  throwOnOnEvent: string | undefined
  readonly kill = vi.fn((signal?: string) => {
    if (this.killError !== undefined) throw this.killError
    if (this.emitCloseOnKillOrdinal === this.kill.mock.calls.length) this.emit('close', 0, null)
    return this.killResult
  })
  readonly pid = 7011

  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    const eventName = typeof event === 'symbol' ? event.toString() : event
    this.onCalls.push(eventName)
    if (eventName === this.throwOnOnEvent) throw new Error(`CHILD_ON_${eventName}_CANARY`)
    return super.on(event, listener)
  }
}

type TimerRecord = {
  readonly handle: object
  readonly callback: () => void
  readonly dueAt: number
  readonly insertOrder: number
  readonly registerMode: 'normal' | 'throwBeforeRegister' | 'invokeSynchronouslyThenThrow'
  fired: boolean
  cleared: boolean
  clearCalls: number
}

class ManualScheduler {
  nowEpochMs: number
  readonly records: TimerRecord[] = []
  readonly registerCalls: Array<{ readonly delayMs: number; readonly mode: TimerRecord['registerMode'] }> = []
  private nextInsertOrder = 0
  readonly registerModes: TimerRecord['registerMode'][] = []
  readonly throwBeforeRegisterDelays = new Set<number>()
  readonly invokeSynchronouslyThenThrowDelays = new Set<number>()
  throwOnClearHandle: object | undefined
  throwOnClearDueAt: number | undefined

  constructor(nowEpochMs = 0) {
    this.nowEpochMs = nowEpochMs
  }

  readonly setTimeout = vi.fn((callback: () => void, delayMs: number): object => {
    const mode = this.registerModes.shift()
      ?? (this.throwBeforeRegisterDelays.has(delayMs)
        ? 'throwBeforeRegister'
        : this.invokeSynchronouslyThenThrowDelays.has(delayMs)
          ? 'invokeSynchronouslyThenThrow'
          : 'normal')
    this.registerCalls.push({ delayMs, mode })
    if (mode === 'throwBeforeRegister') throw new Error('SET_TIMEOUT_CANARY')
    const record: TimerRecord = {
      handle: Object.freeze({}),
      callback,
      dueAt: this.nowEpochMs + delayMs,
      insertOrder: this.nextInsertOrder,
      registerMode: mode,
      fired: false,
      cleared: false,
      clearCalls: 0,
    }
    this.nextInsertOrder += 1
    this.records.push(record)
    if (mode === 'invokeSynchronouslyThenThrow') {
      record.fired = true
      callback()
      throw new Error('SET_TIMEOUT_AFTER_CALLBACK_CANARY')
    }
    return record.handle
  })

  readonly clearTimeout = vi.fn((handle: unknown): void => {
    const record = this.records.find((candidate) => candidate.handle === handle)
    if (record !== undefined) {
      record.clearCalls += 1
      record.cleared = true
      if (record.handle === this.throwOnClearHandle || record.dueAt === this.throwOnClearDueAt) {
        this.throwOnClearHandle = undefined
        this.throwOnClearDueAt = undefined
        throw new Error('CLEAR_TIMEOUT_CANARY')
      }
    }
  })

  advanceTo(epochMs: number): void {
    if (epochMs < this.nowEpochMs) throw new Error('ManualScheduler cannot move backwards')
    this.runReadyBatch(epochMs)
  }

  runReadyBatch(epochMs = this.nowEpochMs): void {
    if (epochMs < this.nowEpochMs) throw new Error('ManualScheduler cannot move backwards')
    const ready = this.records
      .filter((record) => !record.fired && !record.cleared && record.dueAt <= epochMs)
      .sort((left, right) => left.dueAt - right.dueAt || left.insertOrder - right.insertOrder)
    for (const next of ready) {
      if (next.fired || next.cleared) continue
      this.nowEpochMs = next.dueAt
      next.fired = true
      next.callback()
    }
    this.nowEpochMs = epochMs
  }

  advance(deltaMs: number): void {
    this.advanceTo(this.nowEpochMs + deltaMs)
  }

  forceFire(): void {
    for (const record of this.records.filter((candidate) => candidate.cleared && !candidate.fired)) {
      record.fired = true
      record.callback()
    }
  }

  forceClearedCallbacks(): void {
    this.forceFire()
  }
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
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
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
const BUDGET_END_EPOCH_MS = Math.min(CUTOFF_EPOCH_MS + 10_000, SHANGHAI_MIDNIGHT_EPOCH_MS - 1)
const CLEANUP_DEADLINE_EPOCH_MS = BUDGET_END_EPOCH_MS - 2_000
const KILL_GRACE_EPOCH_MS = CLEANUP_DEADLINE_EPOCH_MS + 500

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
  scheduler = new ManualScheduler(typeof nowEpochMs === 'number' ? nowEpochMs : CUTOFF_EPOCH_MS + 1_000),
): ObserverOptions {
  return {
    pythonFile: '/usr/bin/python3',
    observerCliPath: '/opt/x-feed/python/x_personal_feed_observer_cli.py',
    totalBudgetMs: 10_000,
    cleanupReserveMs: 2_000,
    killGraceMs: 500,
    nowEpochMs: typeof nowEpochMs === 'function' ? nowEpochMs : () => nowEpochMs,
    spawn,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
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
      child.stdout.emit('data', Buffer.from('{"schemaVersion":1,"kind":"observer_failed"}\n'))
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

function utf8Buffer(value: string): Buffer {
  return Buffer.from(value, 'utf8')
}

function rawChild(line: string): { readonly child: FakeChild; readonly spawn: ReturnType<typeof vi.fn> } {
  const child = new FakeChild()
  const spawn = vi.fn((...args: unknown[]) => {
    expect(args).toHaveLength(3)
    return child
  })
  child.stdin.onEnd = () => {
    queueMicrotask(() => {
      child.stdout.emit('data', utf8Buffer(line))
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

function controlledChild(): { readonly child: FakeChild; readonly spawn: ReturnType<typeof vi.fn> } {
  const child = new FakeChild()
  const spawn = vi.fn((...args: unknown[]) => {
    expect(args).toHaveLength(3)
    return child
  })
  return { child, spawn }
}

type AbortTrace = {
  readonly controller: AbortController
  readonly signal: AbortSignal
  readonly adds: unknown[]
  readonly removes: unknown[]
  throwOnAdd: boolean
}

function tracedAbortController(): AbortTrace {
  const controller = new AbortController()
  const signal = controller.signal
  const adds: unknown[] = []
  const removes: unknown[] = []
  const originalAdd = signal.addEventListener.bind(signal)
  const originalRemove = signal.removeEventListener.bind(signal)
  const trace: AbortTrace = { controller, signal, adds, removes, throwOnAdd: false }
  Object.defineProperty(signal, 'addEventListener', {
    configurable: true,
    value: ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      adds.push(listener)
      if (trace.throwOnAdd) throw new Error('ABORT_ADD_CANARY')
      return originalAdd(type, listener, options)
    }) as AbortSignal['addEventListener'],
  })
  Object.defineProperty(signal, 'removeEventListener', {
    configurable: true,
    value: ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      removes.push(listener)
      return originalRemove(type, listener, options)
    }) as AbortSignal['removeEventListener'],
  })
  return trace
}

async function expectStillPending(promise: Promise<unknown>): Promise<void> {
  let settled = false
  void promise.then(
    () => { settled = true },
    () => { settled = true },
  )
  await Promise.resolve()
  expect(settled).toBe(false)
}

function expectTimerCleanup(scheduler: ManualScheduler): void {
  for (const record of scheduler.records) {
    expect(record.clearCalls).toBeLessThanOrEqual(1)
    if (!record.fired) expect(record.clearCalls).toBe(1)
  }
}

function startControlledObservation(
  factory: ObserverFactory,
  child: FakeChild,
  scheduler: ManualScheduler,
  controller = new AbortController(),
  nowEpochMs = CUTOFF_EPOCH_MS + 1_000,
): { readonly promise: Promise<unknown>; readonly spawn: ReturnType<typeof vi.fn>; readonly controller: AbortController } {
  const spawn = vi.fn((...args: unknown[]) => {
    expect(args).toHaveLength(3)
    return child
  })
  const promise = factory(options(spawn, nowEpochMs, scheduler)).observe({ request: REQUEST, signal: controller.signal })
  return { promise, spawn, controller }
}

describe('Personal Feed X observer child Group3 bounded termination contract', () => {
  it('settles only from close and parses wire only for close(0, null)', async () => {
    const factory = await loadFactory()
    const cases: readonly {
      readonly label: string
      readonly line?: string
      readonly closeArgs: readonly unknown[]
      readonly expected: unknown
    }[] = [
      { label: 'valid raw tuple', line: jsonLine(completeFixture()), closeArgs: [0, null], expected: completeFixture() },
      { label: 'envelope-valid semantic-invalid wire', line: '{"schemaVersion":1,"kind":"unknown"}\n', closeArgs: [0, null], expected: { kind: 'error', code: 'protocol_invalid' } },
      { label: 'nonzero exit', closeArgs: [1, null], expected: { kind: 'error', code: 'observer_failed' } },
      { label: 'signal close', closeArgs: [null, 'SIGTERM'], expected: { kind: 'error', code: 'observer_failed' } },
      { label: 'zero plus signal', closeArgs: [0, 'SIGTERM'], expected: { kind: 'error', code: 'observer_failed' } },
      { label: 'missing close tuple', closeArgs: [], expected: { kind: 'error', code: 'observer_failed' } },
    ]

    for (const testCase of cases) {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const { child, spawn } = controlledChild()
      const promise = factory(options(spawn, CUTOFF_EPOCH_MS + 1_000, scheduler)).observe({
        request: REQUEST,
        signal: new AbortController().signal,
      })
      await expectStillPending(promise)
      if (testCase.line !== undefined) child.stdout.emit('data', utf8Buffer(testCase.line))
      child.emit('close', ...testCase.closeArgs)
      const result = await promise
      expect(result, testCase.label).toEqual(Object.freeze(testCase.expected))
      if (result !== null && typeof result === 'object' && 'code' in result) {
        expect(Object.keys(result)).toEqual(['kind', 'code'])
        expect(Object.isFrozen(result)).toBe(true)
      }
      expect(child.kill).not.toHaveBeenCalled()
      expect(scheduler.records.every((record) => record.cleared || record.fired)).toBe(true)
      expect(JSON.stringify(result)).not.toContain('RAW_CANARY')
    }
  })

  it('preserves abort as the first reason across registration and grace races', async () => {
    const factory = await loadFactory()

    {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const { child, spawn } = controlledChild()
      const controller = new AbortController()
      controller.abort()
      const result = await factory(options(spawn, CUTOFF_EPOCH_MS + 1_000, scheduler)).observe({ request: REQUEST, signal: controller.signal })
      expect(result).toEqual(Object.freeze({ kind: 'error', code: 'aborted' }))
      expect(spawn).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
      expect(scheduler.records).toHaveLength(0)
    }

    {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const child = new FakeChild()
      const controller = new AbortController()
      const spawn = vi.fn((...args: unknown[]) => {
        expect(args).toHaveLength(3)
        controller.abort()
        return child
      })
      const promise = factory(options(spawn, CUTOFF_EPOCH_MS + 1_000, scheduler)).observe({ request: REQUEST, signal: controller.signal })
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(child.stdin.endCalls).toHaveLength(1)
      await expectStillPending(promise)
      child.emit('close', 0, null)
      expect(await promise).toEqual(Object.freeze({ kind: 'error', code: 'aborted' }))
    }

    const raceCases: readonly { readonly label: string; readonly advanceToGrace: boolean; readonly closeAt: number }[] = [
      { label: 'close before grace', advanceToGrace: false, closeAt: CUTOFF_EPOCH_MS + 1_000 + 499 },
      { label: 'close after grace', advanceToGrace: true, closeAt: CUTOFF_EPOCH_MS + 1_000 + 501 },
      { label: 'close after B', advanceToGrace: true, closeAt: BUDGET_END_EPOCH_MS + 1 },
    ]
    for (const testCase of raceCases) {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const { child } = controlledChild()
      const { promise, controller } = startControlledObservation(factory, child, scheduler)
      controller.abort()
      expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
      if (testCase.advanceToGrace) scheduler.advanceTo(CUTOFF_EPOCH_MS + 1_000 + 500)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(
        testCase.advanceToGrace ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM'],
      )
      if (testCase.label === 'close after B') scheduler.advanceTo(BUDGET_END_EPOCH_MS)
      else scheduler.advanceTo(testCase.closeAt)
      if (testCase.label === 'close after B') {
        expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
        await expectStillPending(promise)
      }
      child.emit('close', 0, null)
      expect(await promise).toEqual(Object.freeze({ kind: 'error', code: 'aborted' }))
    }
  })

  it('runs the timeout TERM, grace KILL, and B KILL ladder for every kill outcome', async () => {
    const factory = await loadFactory()
    for (const mode of ['true', 'false', 'throw'] as const) {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const { child } = controlledChild()
      if (mode === 'false') child.killResult = false
      if (mode === 'throw') child.killError = new Error('KILL_CANARY')
      const { promise } = startControlledObservation(factory, child, scheduler)

      scheduler.advanceTo(CLEANUP_DEADLINE_EPOCH_MS)
      expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
      await expectStillPending(promise)
      scheduler.advanceTo(KILL_GRACE_EPOCH_MS)
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
      await expectStillPending(promise)
      scheduler.advanceTo(BUDGET_END_EPOCH_MS)
      expect(child.kill).toHaveBeenNthCalledWith(3, 'SIGKILL')
      await expectStillPending(promise)
      child.emit('close', 1, null)
      const result = await promise
      expect(result).toEqual(Object.freeze({ kind: 'error', code: 'timed_out' }))
      expect(child.kill).toHaveBeenCalledTimes(3)
      expect(JSON.stringify(result)).not.toContain('KILL_CANARY')
    }

    for (const closeAt of [CLEANUP_DEADLINE_EPOCH_MS + 499, KILL_GRACE_EPOCH_MS + 1] as const) {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const { child } = controlledChild()
      const { promise } = startControlledObservation(factory, child, scheduler)
      scheduler.advanceTo(CLEANUP_DEADLINE_EPOCH_MS)
      scheduler.advanceTo(closeAt)
      child.emit('close', 1, null)
      expect(await promise).toEqual(Object.freeze({ kind: 'error', code: 'timed_out' }))
      const killsAtClose = closeAt < KILL_GRACE_EPOCH_MS ? 1 : 2
      expect(child.kill).toHaveBeenCalledTimes(killsAtClose)
      scheduler.advanceTo(BUDGET_END_EPOCH_MS + 1)
      expect(child.kill).toHaveBeenCalledTimes(killsAtClose)
    }

    {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const { child } = controlledChild()
      const { promise } = startControlledObservation(factory, child, scheduler)
      scheduler.advanceTo(BUDGET_END_EPOCH_MS)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
      await expectStillPending(promise)
      scheduler.forceFire()
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
      child.emit('close', 1, null)
      expect(await promise).toEqual(Object.freeze({ kind: 'error', code: 'timed_out' }))
    }

    {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      scheduler.throwOnClearDueAt = KILL_GRACE_EPOCH_MS
      const { child } = controlledChild()
      const { promise } = startControlledObservation(factory, child, scheduler)
      scheduler.advanceTo(BUDGET_END_EPOCH_MS)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
      const grace = scheduler.records.find((record) => record.dueAt === KILL_GRACE_EPOCH_MS)
      expect(grace).toBeDefined()
      expect(grace?.clearCalls).toBe(1)
      scheduler.forceFire()
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
      await expectStillPending(promise)
      child.emit('close', 1, null)
      expect(await promise).toEqual(Object.freeze({ kind: 'error', code: 'timed_out' }))
    }

    for (const closeOnGraceKill of [false, true] as const) {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      scheduler.invokeSynchronouslyThenThrowDelays.add(500)
      const { child } = controlledChild()
      if (closeOnGraceKill) child.emitCloseOnKillOrdinal = 2
      const { promise } = startControlledObservation(factory, child, scheduler)
      scheduler.advanceTo(CLEANUP_DEADLINE_EPOCH_MS)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
      if (closeOnGraceKill) {
        expect(await promise).toEqual(Object.freeze({ kind: 'error', code: 'timed_out' }))
        scheduler.advanceTo(BUDGET_END_EPOCH_MS)
        expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
      } else {
        await expectStillPending(promise)
        scheduler.advanceTo(BUDGET_END_EPOCH_MS)
        expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
        child.emit('close', 1, null)
        expect(await promise).toEqual(Object.freeze({ kind: 'error', code: 'timed_out' }))
      }
    }

    {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      scheduler.throwBeforeRegisterDelays.add(BUDGET_END_EPOCH_MS - (CUTOFF_EPOCH_MS + 1_000))
      const { child } = controlledChild()
      const { promise } = startControlledObservation(factory, child, scheduler)
      expect(scheduler.nowEpochMs).toBe(CUTOFF_EPOCH_MS + 1_000)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
      await expectStillPending(promise)
      child.emit('close', 1, null)
      expect(await promise).toEqual(Object.freeze({ kind: 'error', code: 'observer_failed' }))
      scheduler.advanceTo(BUDGET_END_EPOCH_MS + 1)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
    }

    {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      scheduler.invokeSynchronouslyThenThrowDelays.add(BUDGET_END_EPOCH_MS - (CUTOFF_EPOCH_MS + 1_000))
      const { child } = controlledChild()
      const { promise } = startControlledObservation(factory, child, scheduler)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
      await expectStillPending(promise)
      child.emit('close', 0, null)
      expect(await promise).toEqual(Object.freeze({ kind: 'error', code: 'timed_out' }))
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
    }

    {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      scheduler.throwBeforeRegisterDelays.add(CLEANUP_DEADLINE_EPOCH_MS - (CUTOFF_EPOCH_MS + 1_000))
      const { child } = controlledChild()
      const { promise } = startControlledObservation(factory, child, scheduler)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM'])
      await expectStillPending(promise)
      scheduler.advanceTo(CUTOFF_EPOCH_MS + 1_000 + 500)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
      scheduler.advanceTo(BUDGET_END_EPOCH_MS)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
      child.emit('close', 1, null)
      expect(await promise).toEqual(Object.freeze({ kind: 'error', code: 'observer_failed' }))
    }

    {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      scheduler.throwBeforeRegisterDelays.add(500)
      const { child } = controlledChild()
      const { promise } = startControlledObservation(factory, child, scheduler)
      scheduler.advanceTo(CLEANUP_DEADLINE_EPOCH_MS)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
      await expectStillPending(promise)
      scheduler.advanceTo(BUDGET_END_EPOCH_MS)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
      child.emit('close', 1, null)
      expect(await promise).toEqual(Object.freeze({ kind: 'error', code: 'timed_out' }))
    }
  })

  it('keeps the promise pending after final KILL and settles once on synchronous close', async () => {
    const factory = await loadFactory()
    for (const mode of ['true', 'false', 'throw'] as const) {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const { child } = controlledChild()
      if (mode === 'false') child.killResult = false
      if (mode === 'throw') child.killError = new Error('KILL_CANARY')
      const { promise } = startControlledObservation(factory, child, scheduler)
      scheduler.advanceTo(CLEANUP_DEADLINE_EPOCH_MS)
      scheduler.advanceTo(KILL_GRACE_EPOCH_MS)
      scheduler.advanceTo(BUDGET_END_EPOCH_MS)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
      await expectStillPending(promise)
      child.emit('close', 1, 'SIGTERM')
      expect(await promise).toEqual(Object.freeze({ kind: 'error', code: 'timed_out' }))
    }

    const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
    const { child } = controlledChild()
    child.emitCloseOnKillOrdinal = 3
    const { promise } = startControlledObservation(factory, child, scheduler)
    scheduler.advanceTo(CLEANUP_DEADLINE_EPOCH_MS)
    scheduler.advanceTo(KILL_GRACE_EPOCH_MS)
    scheduler.advanceTo(BUDGET_END_EPOCH_MS)
    expect(await promise).toEqual(Object.freeze({ kind: 'error', code: 'timed_out' }))
    expect(child.kill).toHaveBeenCalledTimes(3)
    child.emit('close', 0, null)
    expect(child.kill).toHaveBeenCalledTimes(3)

    const synchronousCloseCases: readonly {
      readonly label: string
      readonly advanceTo: number
      readonly closeOrdinal: number
      readonly expectedKills: readonly string[]
    }[] = [
      { label: 'TERM close', advanceTo: CLEANUP_DEADLINE_EPOCH_MS, closeOrdinal: 1, expectedKills: ['SIGTERM'] },
      { label: 'grace KILL close', advanceTo: KILL_GRACE_EPOCH_MS, closeOrdinal: 2, expectedKills: ['SIGTERM', 'SIGKILL'] },
      { label: 'B KILL close', advanceTo: BUDGET_END_EPOCH_MS, closeOrdinal: 3, expectedKills: ['SIGTERM', 'SIGKILL', 'SIGKILL'] },
    ]
    for (const testCase of synchronousCloseCases) {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const { child } = controlledChild()
      child.emitCloseOnKillOrdinal = testCase.closeOrdinal
      const { promise } = startControlledObservation(factory, child, scheduler)
      scheduler.advanceTo(CLEANUP_DEADLINE_EPOCH_MS)
      if (testCase.closeOrdinal >= 2) scheduler.advanceTo(KILL_GRACE_EPOCH_MS)
      if (testCase.closeOrdinal >= 3) scheduler.advanceTo(testCase.advanceTo)
      expect(await promise, testCase.label).toEqual(Object.freeze({ kind: 'error', code: 'timed_out' }))
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(testCase.expectedKills)
      scheduler.forceFire()
      scheduler.advanceTo(BUDGET_END_EPOCH_MS + 1)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(testCase.expectedKills)
      expectTimerCleanup(scheduler)
    }
  })

  it('applies first-reason priority to stream, abort, timeout, and late event races', async () => {
    const factory = await loadFactory()
    type Scenario = {
      readonly label: string
      readonly setup?: (child: FakeChild, scheduler: ManualScheduler, controller: AbortController) => void
      readonly expected: 'aborted' | 'observer_failed' | 'timed_out'
      readonly closeArgs?: readonly unknown[]
      readonly successfulClose?: boolean
      readonly expectedKills?: readonly string[]
      readonly earlyClose?: boolean
    }
    const scenarios: readonly Scenario[] = [
      { label: 'child error first', setup: (child) => child.emit('error', new Error('EXCEPTION_CANARY')), expected: 'observer_failed' },
      { label: 'stdout error first', setup: (child) => child.stdout.emit('error', new Error('EXCEPTION_CANARY')), expected: 'observer_failed' },
      { label: 'stderr error first', setup: (child) => child.stderr.emit('error', new Error('EXCEPTION_CANARY')), expected: 'observer_failed' },
      { label: 'stdin callback error first', expected: 'observer_failed' },
      { label: 'abort first', setup: (_child, _scheduler, controller) => controller.abort(), expected: 'aborted' },
      { label: 'timeout first', setup: (_child, scheduler) => scheduler.advanceTo(CLEANUP_DEADLINE_EPOCH_MS), expected: 'timed_out' },
      { label: 'abort then child error', setup: (child, _scheduler, controller) => { controller.abort(); child.emit('error', new Error('EXCEPTION_CANARY')) }, expected: 'aborted' },
      { label: 'child error then abort', setup: (child, _scheduler, controller) => { child.emit('error', new Error('EXCEPTION_CANARY')); controller.abort() }, expected: 'observer_failed' },
      { label: 'timeout then legal post-D incomplete', setup: (child, scheduler) => {
        scheduler.advanceTo(CLEANUP_DEADLINE_EPOCH_MS)
        child.stdout.emit('data', utf8Buffer(jsonLine(incompleteFixture('2026-08-31T10:00:08.000Z', '2026-08-31T10:00:08.124Z'))))
      }, expected: 'timed_out' },
      { label: 'semantic-invalid wire plus bad close tuple', setup: (child) => child.stdout.emit('data', utf8Buffer('{"schemaVersion":1,"kind":"unknown"}\n')), expected: 'observer_failed', closeArgs: [1, null], expectedKills: [], earlyClose: true },
      { label: 'abort plus signal close', setup: (_child, _scheduler, controller) => controller.abort(), expected: 'aborted', closeArgs: [0, 'SIGTERM'] },
      { label: 'late events after successful close', successfulClose: true, expected: 'observer_failed' },
    ]

    for (const scenario of scenarios) {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const { child } = controlledChild()
      const controller = new AbortController()
      if (scenario.label === 'stdin callback error first') child.stdin.callbackError = new Error('EXCEPTION_CANARY')
      if (scenario.label === 'child error first') child.killError = new Error('TERM_CANARY')
      const { promise } = startControlledObservation(factory, child, scheduler, controller)
      if (scenario.successfulClose) {
        child.stdout.emit('data', utf8Buffer(jsonLine(completeFixture())))
        child.emit('close', 0, null)
        expect(await promise).toEqual(completeFixture())
        controller.abort()
        child.emit('error', new Error('EXCEPTION_CANARY'))
        child.stdout.emit('data', utf8Buffer('RAW_CANARY\n'))
        child.emit('close', 1, null)
        scheduler.forceClearedCallbacks()
        expect(child.kill).not.toHaveBeenCalled()
        continue
      }
      scenario.setup?.(child, scheduler, controller)
      if (scenario.earlyClose) {
        child.emit('close', ...(scenario.closeArgs ?? [1, null]))
        const result = await promise
        expect(result).toEqual(Object.freeze({ kind: 'error', code: scenario.expected }))
        expect(Object.keys(result)).toEqual(['kind', 'code'])
        expect(Object.isFrozen(result)).toBe(true)
        scheduler.advanceTo(BUDGET_END_EPOCH_MS + 1)
        expect(child.kill).not.toHaveBeenCalled()
        for (const canary of ['RAW_CANARY', 'TERM_CANARY', 'KILL_CANARY', 'EXCEPTION_CANARY']) {
          expect(JSON.stringify(result), scenario.label).not.toContain(canary)
        }
        continue
      }
      scheduler.advanceTo(KILL_GRACE_EPOCH_MS)
      scheduler.advanceTo(BUDGET_END_EPOCH_MS)
      await expectStillPending(promise)
      child.emit('close', ...(scenario.closeArgs ?? [0, null]))
      const result = await promise
      expect(result).toEqual(Object.freeze({ kind: 'error', code: scenario.expected }))
      expect(Object.keys(result)).toEqual(['kind', 'code'])
      expect(Object.isFrozen(result)).toBe(true)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(scenario.expectedKills ?? ['SIGTERM', 'SIGKILL', 'SIGKILL'])
      for (const canary of ['RAW_CANARY', 'TERM_CANARY', 'KILL_CANARY', 'EXCEPTION_CANARY']) {
        expect(JSON.stringify(result), scenario.label).not.toContain(canary)
      }
    }
  })

  it('cleans timers and listeners on every terminal path and enforces exact options shape', async () => {
    const factory = await loadFactory()
    const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
    const { child, spawn } = controlledChild()
    const controller = new AbortController()
    const promise = factory(options(spawn, CUTOFF_EPOCH_MS + 1_000, scheduler)).observe({ request: REQUEST, signal: controller.signal })
    let thenCount = 0
    const observed = promise.then((result) => {
      thenCount += 1
      return result
    })
    child.stdout.emit('data', utf8Buffer(jsonLine(completeFixture())))
    child.emit('close', 0, null)
    expect(await observed).toEqual(completeFixture())
    controller.abort()
    child.emit('error', new Error('EXCEPTION_CANARY'))
    child.stdout.emit('data', utf8Buffer('RAW_CANARY\n'))
    child.emit('close', 1, null)
    scheduler.forceClearedCallbacks()
    expect(thenCount).toBe(1)
    expect(child.kill).not.toHaveBeenCalled()
    expect(scheduler.records.every((record) => record.cleared || record.fired)).toBe(true)

    const preabortScheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
    const preabortSpawn = vi.fn(() => new FakeChild())
    const preabort = new AbortController()
    preabort.abort()
    expect(await factory(options(preabortSpawn, CUTOFF_EPOCH_MS + 1_000, preabortScheduler)).observe({ request: REQUEST, signal: preabort.signal }))
      .toEqual(Object.freeze({ kind: 'error', code: 'aborted' }))
    expect(preabortScheduler.records).toHaveLength(0)

    const throwingScheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
    const throwingSpawn = vi.fn(() => { throw new Error('SPAWN_CANARY') })
    expect(await factory(options(throwingSpawn, CUTOFF_EPOCH_MS + 1_000, throwingScheduler)).observe({
      request: REQUEST,
      signal: new AbortController().signal,
    })).toEqual(Object.freeze({ kind: 'error', code: 'observer_failed' }))
    expect(throwingScheduler.records).toHaveLength(0)

    const listenerCases: readonly {
      readonly label: string
      readonly trigger: (child: FakeChild, scheduler: ManualScheduler, trace: AbortTrace) => void
      readonly expected: 'aborted' | 'observer_failed' | 'timed_out' | 'complete'
      readonly closeArgs?: readonly unknown[]
    }[] = [
      {
        label: 'normal close',
        trigger: (child) => child.stdout.emit('data', utf8Buffer(jsonLine(completeFixture()))),
        expected: 'complete',
      },
      {
        label: 'abort',
        trigger: (_child, _scheduler, trace) => trace.controller.abort(),
        expected: 'aborted',
      },
      {
        label: 'timeout',
        trigger: (_child, scheduler) => scheduler.advanceTo(CLEANUP_DEADLINE_EPOCH_MS),
        expected: 'timed_out',
      },
      {
        label: 'stream error',
        trigger: (child) => child.stdout.emit('error', new Error('EXCEPTION_CANARY')),
        expected: 'observer_failed',
      },
      {
        label: 'bad close tuple',
        trigger: () => undefined,
        expected: 'observer_failed',
        closeArgs: [1, null],
      },
    ]
    for (const testCase of listenerCases) {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const { child } = controlledChild()
      const trace = tracedAbortController()
      const { promise } = startControlledObservation(factory, child, scheduler, trace.controller)
      testCase.trigger(child, scheduler, trace)
      if (testCase.expected !== 'complete' && testCase.label !== 'bad close tuple') {
        scheduler.advanceTo(KILL_GRACE_EPOCH_MS)
        scheduler.advanceTo(BUDGET_END_EPOCH_MS)
      }
      child.emit('close', ...(testCase.closeArgs ?? [0, null]))
      const result = await promise
      if (testCase.expected === 'complete') expect(result).toEqual(completeFixture())
      else expect(result).toEqual(Object.freeze({ kind: 'error', code: testCase.expected }))
      expect(trace.adds).toHaveLength(1)
      expect(trace.removes).toHaveLength(1)
      expect(trace.removes[0]).toBe(trace.adds[0])
      expectTimerCleanup(scheduler)
    }

    const setupErrorCases: readonly {
      readonly label: string
      readonly configure: (child: FakeChild, trace: AbortTrace) => void
      readonly expectedAdds: number
      readonly expectedRemoves: number
    }[] = [
      { label: 'addEventListener throw', configure: (_child, trace) => { trace.throwOnAdd = true }, expectedAdds: 1, expectedRemoves: 1 },
      { label: 'stdout on throw', configure: (child) => { child.stdout.throwOnOn = true }, expectedAdds: 1, expectedRemoves: 1 },
      { label: 'stderr on throw', configure: (child) => { child.stderr.throwOnOn = true }, expectedAdds: 1, expectedRemoves: 1 },
      { label: 'child error on throw', configure: (child) => { child.throwOnOnEvent = 'error' }, expectedAdds: 1, expectedRemoves: 1 },
      { label: 'stdin end throw', configure: (child) => { child.stdin.endError = new Error('STDIN_END_CANARY') }, expectedAdds: 1, expectedRemoves: 1 },
    ]
    for (const testCase of setupErrorCases) {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const { child } = controlledChild()
      const trace = tracedAbortController()
      testCase.configure(child, trace)
      const { promise } = startControlledObservation(factory, child, scheduler, trace.controller)
      expect(child.kill.mock.calls.map(([signal]) => signal), testCase.label).toEqual(['SIGTERM'])
      await expectStillPending(promise)
      child.emit('close', 1, null)
      const result = await promise
      expect(result, testCase.label).toEqual(Object.freeze({ kind: 'error', code: 'observer_failed' }))
      expect(Object.keys(result)).toEqual(['kind', 'code'])
      expect(Object.isFrozen(result)).toBe(true)
      expect(trace.adds).toHaveLength(testCase.expectedAdds)
      expect(trace.removes).toHaveLength(testCase.expectedRemoves)
      if (testCase.expectedRemoves === 1) expect(trace.removes[0]).toBe(trace.adds[0])
      expectTimerCleanup(scheduler)
      expect(JSON.stringify(result)).not.toContain('CANARY')
    }

    {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const { child } = controlledChild()
      const trace = tracedAbortController()
      child.throwOnOnEvent = 'close'
      const { promise } = startControlledObservation(factory, child, scheduler, trace.controller)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
      expect(scheduler.records).toHaveLength(0)
      await expectStillPending(promise)
      scheduler.advanceTo(CUTOFF_EPOCH_MS + 1_000 + 500)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
      scheduler.advanceTo(BUDGET_END_EPOCH_MS)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
      child.emit('close', 1, null)
      await expectStillPending(promise)
    }

    const optionCases: readonly { readonly label: string; readonly mutate: (base: Record<string, unknown>) => unknown }[] = [
      { label: 'missing setTimeout', mutate: (base) => { delete base.setTimeout; return base } },
      { label: 'missing clearTimeout', mutate: (base) => { delete base.clearTimeout; return base } },
      { label: 'non-function setTimeout', mutate: (base) => ({ ...base, setTimeout: 1 }) },
      { label: 'non-function clearTimeout', mutate: (base) => ({ ...base, clearTimeout: 1 }) },
      { label: 'extra scheduler key', mutate: (base) => ({ ...base, timer: true }) },
      { label: 'scheduler accessor', mutate: (base) => Object.defineProperty(base, 'setTimeout', { enumerable: true, get: () => { throw new Error('accessor') } }) },
      { label: 'scheduler proxy', mutate: (base) => new Proxy(base, { ownKeys: () => { throw new Error('proxy') } }) },
    ]
    for (const testCase of optionCases) {
      const optionScheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const optionSpawn = vi.fn(() => new FakeChild())
      const base = { ...options(optionSpawn, CUTOFF_EPOCH_MS + 1_000, optionScheduler) } as Record<string, unknown>
      await expectInvalidWithoutSpawn(factory, testCase.mutate(base), {
        request: REQUEST,
        signal: new AbortController().signal,
      }, optionSpawn)
      expect(optionScheduler.records).toHaveLength(0)
    }
  })
})

const STDOUT_RAW_LIMIT = 1_048_576
const STDERR_RAW_LIMIT = 4_096
const OBSERVER_FAILED_LINE = '{"schemaVersion":1,"kind":"observer_failed"}\n'

function completeWithText(text: string): RawObject {
  const raw = completeFixture()
  const occurrences = (raw.surfaces as RawObject[])[0]?.occurrences as RawObject[]
  const occurrenceValue = occurrences[0]
  if (occurrenceValue === undefined) throw new Error('fixture missing occurrence')
  occurrenceValue.body = { kind: 'sufficient', text }
  return raw
}

function observeChunks(
  factory: ObserverFactory,
  stdoutChunks: readonly unknown[],
  stderrChunks: readonly unknown[] = [],
): { readonly promise: Promise<unknown>; readonly child: FakeChild; readonly scheduler: ManualScheduler } {
  const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
  const { child } = controlledChild()
  const { promise } = startControlledObservation(factory, child, scheduler)
  for (const chunk of stdoutChunks) child.stdout.emit('data', chunk)
  for (const chunk of stderrChunks) child.stderr.emit('data', chunk)
  return { promise, child, scheduler }
}

function crossRealmBytes(bytes: readonly number[]): Uint8Array {
  return runInNewContext(`new Uint8Array([${bytes.join(',')}])`) as Uint8Array
}

function paddedObserverFailedLine(targetBytes: number): string {
  const compact = OBSERVER_FAILED_LINE.slice(0, -1)
  const spaces = targetBytes - Buffer.byteLength(compact) - 1
  if (spaces < 0) throw new Error('target too small')
  return `{${' '.repeat(spaces)}${compact.slice(1)}\n`
}

function paddedUnknownEmojiLine(targetBytes: number): string {
  const prefix = '{"schemaVersion":1,"kind":"unknown","filler":"🙂'
  const suffix = '"}\n'
  const fillerBytes = targetBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)
  if (fillerBytes < 0) throw new Error('target too small')
  return `${prefix}${'x'.repeat(fillerBytes)}${suffix}`
}

function lineWithInvalidUtf8(replacement: readonly number[]): Buffer {
  const source = utf8Buffer(jsonLine(completeWithText('post 0')))
  const needle = utf8Buffer('post 0')
  const start = source.indexOf(needle)
  if (start < 0) throw new Error('fixture needle missing')
  return Buffer.concat([source.subarray(0, start), Buffer.from(replacement), source.subarray(start + 1)])
}

function splitInsideEmoji(bytes: Uint8Array): readonly Uint8Array[] {
  const emoji = utf8Buffer('🙂')
  const start = Buffer.from(bytes).indexOf(emoji)
  if (start < 0) throw new Error('emoji missing')
  return [bytes.subarray(0, start + 1), bytes.subarray(start + 1)]
}

function expectFrozenError(value: unknown, code: string): void {
  expect(value).toEqual(Object.freeze({ kind: 'error', code }))
  expect(Object.keys(value as object)).toEqual(['kind', 'code'])
  expect(Object.isFrozen(value)).toBe(true)
}

describe('Personal Feed X observer child Group4 strict stream contract', () => {
  it('enforces raw byte caps with inclusive exact boundaries and close-only settlement', async () => {
    const factory = await loadFactory()

    {
      const line = paddedObserverFailedLine(STDOUT_RAW_LIMIT)
      expect(Buffer.byteLength(line)).toBe(STDOUT_RAW_LIMIT)
      const { promise, child } = observeChunks(factory, [utf8Buffer(line)])
      expect(child.kill).not.toHaveBeenCalled()
      await expectStillPending(promise)
      child.emit('close', 0, null)
      expectFrozenError(await promise, 'observer_failed')
      expect(child.kill).not.toHaveBeenCalled()
    }

    {
      const line = paddedUnknownEmojiLine(STDOUT_RAW_LIMIT)
      expect(Buffer.byteLength(line)).toBe(STDOUT_RAW_LIMIT)
      expect(line.length).not.toBe(STDOUT_RAW_LIMIT)
      const { promise, child } = observeChunks(factory, [utf8Buffer(line), utf8Buffer('x')])
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      await expectStillPending(promise)
      child.emit('close', 0, null)
      expectFrozenError(await promise, 'protocol_invalid')
      expect(child.kill).toHaveBeenCalledTimes(1)
    }

    {
      const valid = utf8Buffer(jsonLine(completeFixture()))
      const { promise, child } = observeChunks(factory, [valid], [utf8Buffer('s'.repeat(STDERR_RAW_LIMIT))])
      expect(child.kill).not.toHaveBeenCalled()
      child.emit('close', 0, null)
      const result = await promise
      expect(result).toEqual(completeFixture())
      expect(JSON.stringify(result)).not.toContain('s'.repeat(32))
      expect(child.kill).not.toHaveBeenCalled()
    }

    {
      const { promise, child } = observeChunks(factory, [utf8Buffer(jsonLine(completeFixture()))], [utf8Buffer('e'.repeat(STDERR_RAW_LIMIT + 1))])
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      await expectStillPending(promise)
      child.emit('close', 0, null)
      expectFrozenError(await promise, 'observer_failed')
      expect(child.kill).toHaveBeenCalledTimes(1)
    }
  })

  it('accepts only Buffer and real or cross-realm Uint8Array data chunks', async () => {
    const factory = await loadFactory()
    const line = utf8Buffer(jsonLine(completeFixture()))
    const accepted: readonly Uint8Array[] = [
      Buffer.from(line),
      new Uint8Array(line),
      crossRealmBytes(Array.from(line)),
    ]
    for (const chunk of accepted) {
      const { promise, child } = observeChunks(factory, [chunk])
      child.emit('close', 0, null)
      expect(await promise).toEqual(completeFixture())
    }

    const wrongTypeCases: readonly unknown[] = [
      jsonLine(completeFixture()),
      new DataView(new ArrayBuffer(1)),
      new Uint16Array([0x7b, 0x7d]),
      new ArrayBuffer(1),
      { 0: 0x7b, 1: 0x7d, CANARY: 'wrong-type' },
      new Proxy({ 0: 0x7b, 1: 0x7d, CANARY: 'wrong-type' }, {}),
    ]
    for (const chunk of wrongTypeCases) {
      const { promise, child } = observeChunks(factory, [chunk])
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      child.emit('close', 0, null)
      const result = await promise
      expectFrozenError(result, 'observer_failed')
      expect(JSON.stringify(result)).not.toContain('CANARY')
    }
  })

  it('uses independent strict streaming UTF-8 decoders for stdout and stderr', async () => {
    const factory = await loadFactory()
    const raw = completeWithText('冻结中文🙂')
    const stdout = utf8Buffer(jsonLine(raw))
    const stderr = utf8Buffer('stderr canary 中文🙂')
    const chunkings: readonly ((bytes: Uint8Array) => readonly Uint8Array[])[] = [
      (bytes) => [bytes],
      (bytes) => splitInsideEmoji(bytes),
      (bytes) => Array.from(bytes, (byte) => new Uint8Array([byte])),
    ]
    for (const chunking of chunkings) {
      const { promise, child } = observeChunks(factory, chunking(stdout), chunking(stderr))
      child.emit('close', 0, null)
      const result = await promise
      expect(result).toEqual(raw)
      expect(JSON.stringify(result)).not.toContain('stderr canary')
    }
  })

  it.each([
    ['invalid continuation', [0xe2, 0x28, 0xa1]],
    ['overlong sequence', [0xc0, 0x80]],
    ['lone continuation', [0x80]],
  ] as const)('maps stdout %s to protocol_invalid under strict UTF-8', async (_label, invalidBytes) => {
    const factory = await loadFactory()
    const { promise, child } = observeChunks(factory, [lineWithInvalidUtf8(invalidBytes)])
    child.emit('close', 0, null)
    const result = await promise
    expectFrozenError(result, 'protocol_invalid')
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('canary')
  })

  it('maps stderr invalid UTF-8 and dangling prefixes to observer_failed, while stdout maps dangling to protocol_invalid', async () => {
    const factory = await loadFactory()
    const valid = utf8Buffer(jsonLine(completeFixture()))
    const stdoutDangling = Buffer.concat([
      utf8Buffer(OBSERVER_FAILED_LINE.slice(0, -1)),
      Buffer.from([0xe2]),
    ])
    const stdoutCase = observeChunks(factory, [stdoutDangling])
    expect(stdoutCase.child.kill).not.toHaveBeenCalled()
    await expectStillPending(stdoutCase.promise)
    stdoutCase.child.emit('close', 0, null)
    const stdoutResult = await stdoutCase.promise
    expectFrozenError(stdoutResult, 'protocol_invalid')
    expect(stdoutCase.child.kill).not.toHaveBeenCalled()

    for (const stderrBytes of [Buffer.from([0xe2]), Buffer.from([0xc0, 0x80]), Buffer.from([0x80])] as const) {
      const { promise, child } = observeChunks(factory, [valid], [stderrBytes])
      child.emit('close', 0, null)
      expectFrozenError(await promise, 'observer_failed')
    }
  })

  it('rejects BOM and every non-exact single-line framing variant, while accepting internal whitespace and escaped breaks', async () => {
    const factory = await loadFactory()
    const compact = OBSERVER_FAILED_LINE
    const internalWhitespace = '{  "schemaVersion" : 1 , "kind" : "observer_failed"  }\n'
    const escapedBreaks = completeWithText('first\r\nsecond')
    const accepted: readonly { readonly line: string; readonly expected: unknown }[] = [
      { line: compact, expected: { kind: 'error', code: 'observer_failed' } },
      { line: internalWhitespace, expected: { kind: 'error', code: 'observer_failed' } },
      { line: jsonLine(escapedBreaks), expected: escapedBreaks },
    ]
    for (const testCase of accepted) {
      const result = await observeRaw(factory, testCase.line)
      expect(result).toEqual(testCase.expected)
    }

    const invalidLines: readonly [string, string][] = [
      ['empty', ''],
      ['LF-only', '\n'],
      ['missing LF', compact.slice(0, -1)],
      ['extra LF', `${compact}\n`],
      ['CRLF', compact.slice(0, -1) + '\r\n'],
      ['leading space', ` ${compact}`],
      ['leading tab', `\t${compact}`],
      ['leading BOM', `\uFEFF${compact}`],
      ['leading garbage', `garbage${compact}`],
      ['trailing space', compact.slice(0, -1) + ' \n'],
      ['trailing tab', compact.slice(0, -1) + '\t\n'],
      ['trailing garbage', compact.slice(0, -1) + 'garbage\n'],
    ]
    for (const [label, line] of invalidLines) await expectProtocolInvalid(factory, line, label)

    const rawCanary = observeChunks(factory, [utf8Buffer('RAW_CANARY\n')])
    expect(rawCanary.child.kill).toHaveBeenCalledTimes(1)
    expect(rawCanary.child.kill).toHaveBeenCalledWith('SIGTERM')
    await expectStillPending(rawCanary.promise)
    rawCanary.child.emit('close', 0, null)
    expectFrozenError(await rawCanary.promise, 'protocol_invalid')

    const split = observeChunks(factory, [utf8Buffer(compact), utf8Buffer('garbage')])
    expect(split.child.kill).toHaveBeenCalledTimes(1)
    expect(split.child.kill).toHaveBeenCalledWith('SIGTERM')
    await expectStillPending(split.promise)
    split.child.emit('close', 0, null)
    expectFrozenError(await split.promise, 'protocol_invalid')
  })

  it('preserves firstReason across protocol, stderr, abort, timeout, close, and late-event races', async () => {
    const factory = await loadFactory()

    {
      const controller = new AbortController()
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const { child } = controlledChild()
      const { promise } = startControlledObservation(factory, child, scheduler, controller)
      child.stdout.emit('data', utf8Buffer(paddedObserverFailedLine(STDOUT_RAW_LIMIT)))
      child.stdout.emit('data', utf8Buffer('x'))
      expect(child.kill).toHaveBeenCalledTimes(1)
      controller.abort()
      scheduler.advanceTo(KILL_GRACE_EPOCH_MS)
      scheduler.advanceTo(BUDGET_END_EPOCH_MS)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
      await expectStillPending(promise)
      child.emit('close', 0, null)
      expectFrozenError(await promise, 'protocol_invalid')
    }

    {
      const { promise, child, scheduler } = observeChunks(factory, [utf8Buffer(jsonLine(completeFixture()))], [utf8Buffer('e'.repeat(STDERR_RAW_LIMIT + 1))])
      expect(child.kill).toHaveBeenCalledTimes(1)
      scheduler.advanceTo(KILL_GRACE_EPOCH_MS)
      scheduler.advanceTo(BUDGET_END_EPOCH_MS)
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
      await expectStillPending(promise)
      child.emit('close', 0, null)
      expectFrozenError(await promise, 'observer_failed')
    }

    {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const controller = new AbortController()
      const { child } = controlledChild()
      const { promise } = startControlledObservation(factory, child, scheduler, controller)
      controller.abort()
      child.stdout.emit('data', 'wrong type after abort')
      child.stdout.emit('data', utf8Buffer(paddedObserverFailedLine(STDOUT_RAW_LIMIT)))
      child.stdout.emit('data', utf8Buffer('x'))
      scheduler.advanceTo(KILL_GRACE_EPOCH_MS)
      scheduler.advanceTo(BUDGET_END_EPOCH_MS)
      child.emit('close', 0, null)
      expectFrozenError(await promise, 'aborted')
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
    }

    {
      const scheduler = new ManualScheduler(CUTOFF_EPOCH_MS + 1_000)
      const { child } = controlledChild()
      const { promise } = startControlledObservation(factory, child, scheduler)
      scheduler.advanceTo(CLEANUP_DEADLINE_EPOCH_MS)
      child.stdout.emit('data', lineWithInvalidUtf8([0xc0, 0x80]))
      child.stdout.emit('data', 'wrong type after timeout')
      child.emit('close', 0, null)
      expectFrozenError(await promise, 'timed_out')
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM'])
    }

    {
      const { promise, child } = observeChunks(factory, [utf8Buffer(jsonLine(completeFixture()))])
      child.emit('close', 0, null)
      expect(await promise).toEqual(completeFixture())
      child.stdout.emit('data', utf8Buffer('LATE_CANARY'))
      child.stderr.emit('data', utf8Buffer('LATE_CANARY'))
      child.emit('error', new Error('LATE_CANARY'))
      child.emit('close', 1, null)
      expect(child.kill).not.toHaveBeenCalled()
      expect(JSON.stringify(await promise)).not.toContain('LATE_CANARY')
    }
  })

  it('uses intrinsic stdout byte length and rejects a real 1 MiB plus one byte view despite a lying own getter', async () => {
    const factory = await loadFactory()
    const exact = utf8Buffer(paddedObserverFailedLine(STDOUT_RAW_LIMIT))
    const oversized = new Uint8Array(STDOUT_RAW_LIMIT + 1)
    oversized.set(exact, 0)
    oversized[STDOUT_RAW_LIMIT] = 0x78
    let byteLengthReads = 0
    Object.defineProperty(oversized, 'byteLength', {
      configurable: true,
      get: () => {
        byteLengthReads += 1
        return STDOUT_RAW_LIMIT
      },
    })

    const { promise, child } = observeChunks(factory, [oversized])
    expect(byteLengthReads).toBe(0)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await expectStillPending(promise)
    child.emit('close', 0, null)
    const result = await promise
    expectFrozenError(result, 'protocol_invalid')
    expect(byteLengthReads).toBe(0)
  })

  it('uses intrinsic stderr byte length and fail-closes a real 4097-byte view despite a lying own getter', async () => {
    const factory = await loadFactory()
    const valid = utf8Buffer(jsonLine(completeFixture()))
    const oversized = new Uint8Array(STDERR_RAW_LIMIT + 1)
    oversized.fill(0x65)
    let byteLengthReads = 0
    Object.defineProperty(oversized, 'byteLength', {
      configurable: true,
      get: () => {
        byteLengthReads += 1
        return STDERR_RAW_LIMIT
      },
    })

    const { promise, child } = observeChunks(factory, [valid], [oversized])
    expect(byteLengthReads).toBe(0)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await expectStillPending(promise)
    child.emit('close', 0, null)
    const result = await promise
    expectFrozenError(result, 'observer_failed')
    expect(JSON.stringify(result)).not.toContain('business')
    expect(byteLengthReads).toBe(0)
  })

  it('rejects a proxied Uint8Array without touching any Proxy trap', async () => {
    const factory = await loadFactory()
    const valid = utf8Buffer(jsonLine(completeFixture()))
    const target = new Uint8Array(valid)
    let trapCount = 0
    const trap = (..._args: unknown[]): never => {
      trapCount += 1
      throw new Error('PROXY_TRAP_CANARY')
    }
    const proxied = new Proxy(target, {
      get: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
      has: trap,
      set: trap,
      defineProperty: trap,
      deleteProperty: trap,
      isExtensible: trap,
      preventExtensions: trap,
      setPrototypeOf: trap,
    } as ProxyHandler<Uint8Array>)

    const { promise, child } = observeChunks(factory, [proxied])
    expect(trapCount).toBe(0)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await expectStillPending(promise)
    child.emit('close', 0, null)
    const result = await promise
    expectFrozenError(result, 'observer_failed')
    expect(trapCount).toBe(0)
    expect(JSON.stringify(result)).not.toContain('PROXY_TRAP_CANARY')
  })

  it('snapshots stdout bytes before decoder execution and does not read adversarial own accessors', async () => {
    const factory = await loadFactory()
    const expected = completeWithText('snapshot DTO 中文🙂')
    const source = new Uint8Array(utf8Buffer(jsonLine(expected)))
    const sourceLength = source.length
    const accessorReads: Array<{ readonly key: PropertyKey; calls: number }> = []
    const nativeIterator = Uint8Array.prototype[Symbol.iterator]
    const accessorSpecs: readonly [PropertyKey, unknown][] = [
      ['byteLength', sourceLength],
      ['length', sourceLength],
      ['constructor', Uint8Array],
      [Symbol.iterator, nativeIterator],
    ]
    const unavailable: PropertyKey[] = []
    for (const [key, value] of accessorSpecs) {
      const record = { key, calls: 0 }
      try {
        Object.defineProperty(source, key, {
          configurable: true,
          get: () => {
            record.calls += 1
            return value
          },
        })
        accessorReads.push(record)
      } catch {
        unavailable.push(key)
      }
    }
    expect(unavailable, 'source own accessors unavailable').toEqual([])

    const decodeDescriptor = Object.getOwnPropertyDescriptor(TextDecoder.prototype, 'decode')
    const nativeDecode = decodeDescriptor?.value as TextDecoder['decode'] | undefined
    if (typeof nativeDecode !== 'function') throw new Error('TextDecoder.decode is not callable')
    let mutated = false
    const wrappedDecode = function (this: TextDecoder, input?: AllowSharedBufferSource, options?: TextDecoderOptions): string {
      if (input !== undefined && !mutated) {
        mutated = true
        Reflect.apply(Uint8Array.prototype.fill, source, [0x78, 0, sourceLength])
      }
      return nativeDecode.call(this, input, options)
    }
    Object.defineProperty(TextDecoder.prototype, 'decode', {
      configurable: true,
      writable: true,
      value: wrappedDecode,
    })

    try {
      const { promise, child } = observeChunks(factory, [source])
      child.emit('close', 0, null)
      expect(await promise).toEqual(expected)
      expect(mutated).toBe(true)
      for (const record of accessorReads) expect(record.calls, String(record.key)).toBe(0)
    } finally {
      if (decodeDescriptor === undefined) delete (TextDecoder.prototype as { decode?: unknown }).decode
      else Object.defineProperty(TextDecoder.prototype, 'decode', decodeDescriptor)
    }
  })

  it('fail-closes SharedArrayBuffer, Resizable ArrayBuffer, and detached ArrayBuffer views', async () => {
    const factory = await loadFactory()
    const source = utf8Buffer(jsonLine(completeWithText('OWNER_CANARY')))
    const ownerCases: readonly { readonly label: string; readonly make: () => Uint8Array }[] = [
      {
        label: 'SharedArrayBuffer view',
        make: () => {
          const shared = new SharedArrayBuffer(source.length)
          const view = new Uint8Array(shared)
          view.set(source)
          return view
        },
      },
      {
        label: 'Resizable ArrayBuffer view',
        make: () => {
          const resizable = new ArrayBuffer(source.length, { maxByteLength: source.length + 16 })
          const view = new Uint8Array(resizable)
          view.set(source)
          return view
        },
      },
      {
        label: 'detached ArrayBuffer view',
        make: () => {
          const ordinary = new ArrayBuffer(source.length)
          const view = new Uint8Array(ordinary)
          view.set(source)
          structuredClone(ordinary, { transfer: [ordinary] })
          return view
        },
      },
    ]

    for (const testCase of ownerCases) {
      const view = testCase.make()
      const { promise, child } = observeChunks(factory, [view])
      expect(child.kill, testCase.label).toHaveBeenCalledTimes(1)
      expect(child.kill, testCase.label).toHaveBeenCalledWith('SIGTERM')
      await expectStillPending(promise)
      child.emit('close', 0, null)
      const result = await promise
      expectFrozenError(result, 'observer_failed')
      expect(JSON.stringify(result)).not.toContain('OWNER_CANARY')
    }
  })
})
