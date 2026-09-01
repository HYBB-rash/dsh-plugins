import { spawn as nativeSpawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type IdentityClass = 'gone' | 'reused' | 'same-original'
type EventRecord = Readonly<Record<string, unknown>>
type KillRecord = EventRecord & {
  readonly kind: 'product-kill'
  readonly signal: string
  readonly identity: IdentityClass
  readonly calledNative: boolean
}

type ObserverFactory = (options: unknown) => {
  readonly observe: (input: { readonly request: unknown; readonly signal: AbortSignal }) => Promise<unknown>
}

type Case = {
  readonly deadline: number
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
  readonly marker: string
  readonly controller: AbortController
  readonly records: EventRecord[]
  readonly kills: KillRecord[]
  readonly child: ChildProcess
  readonly nativeKill: (signal: NodeJS.Signals) => boolean
  readonly originalStarttime: string | undefined
  readonly promise: Promise<unknown>
}

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/personal-feed-x-observer-child-fixture.mjs', import.meta.url))
const TOTAL_BUDGET_MS = 4_100
const CLEANUP_RESERVE_MS = 700
const KILL_GRACE_MS = 300
const OUTER_WATCHDOG_MS = 10_000
let nextRealRequestOrdinal = 1

function shanghaiDayForEpoch(epochMs: number): string {
  return new Date(epochMs + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10)
}

function deadlineFor(mode: number): number {
  const base = Date.now() + 1_500
  return base + ((mode - (base % 10) + 10) % 10)
}

function readStarttime(pid: number): string | undefined {
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  const closingParen = stat.lastIndexOf(')')
  if (closingParen < 0) throw new Error('cannot parse /proc stat')
  const fields = stat.slice(closingParen + 1).trim().split(/\s+/)
  const starttime = fields[19]
  if (starttime === undefined || !/^\d+$/.test(starttime)) throw new Error('cannot parse /proc starttime')
  return starttime
}

function classifyIdentity(pid: number, originalStarttime: string): IdentityClass {
  const currentStarttime = readStarttime(pid)
  if (currentStarttime === undefined) return 'gone'
  return currentStarttime === originalStarttime ? 'same-original' : 'reused'
}

type TimerDiagnostic = {
  readonly ordinal: number
  readonly delay: number
  fired: boolean
  cleared: boolean
}

type PidDescriptorClassification = 'missing' | 'non-enumerable' | 'accessor' | 'data-valid' | 'data-invalid'

function classifyOwnPidDescriptor(child: ChildProcess, capturedPid: unknown, phase: 'spawn-return' | 'spawn-event'): EventRecord {
  const descriptor = Object.getOwnPropertyDescriptor(child, 'pid')
  if (descriptor === undefined) {
    return { kind: 'pid-descriptor', phase, classification: 'missing', positivePidMatchesCaptured: false }
  }
  if (descriptor.enumerable !== true) {
    return { kind: 'pid-descriptor', phase, classification: 'non-enumerable', positivePidMatchesCaptured: false }
  }
  if (!('value' in descriptor)) {
    return { kind: 'pid-descriptor', phase, classification: 'accessor', positivePidMatchesCaptured: false }
  }
  const value = descriptor.value
  const valid = typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  return {
    kind: 'pid-descriptor',
    phase,
    classification: valid ? 'data-valid' : 'data-invalid',
    positivePidMatchesCaptured: valid && value === capturedPid,
  }
}

function safeDiagnosticRecords(records: readonly EventRecord[]): readonly EventRecord[] {
  const keys = [
    'kind', 'phase', 'ordinal', 'delay', 'fired', 'cleared', 'classification',
    'positivePidMatchesCaptured', 'pid', 'starttime', 'code', 'signal',
    'callbackCalls', 'argumentsLength', 'firstArgClass',
  ] as const
  return records.map((record) => Object.fromEntries(keys.flatMap((key) => key in record ? [[key, record[key]]] : [])))
}

function safeKillDiagnostics(kills: readonly KillRecord[]): readonly EventRecord[] {
  return kills.map((record) => ({
    kind: record.kind,
    signal: record.signal,
    identity: record.identity,
    calledNative: record.calledNative,
  }))
}

function releaseMarker(marker: string): void {
  try {
    writeFileSync(marker, 'release\n', { encoding: 'utf8', flag: 'w' })
  } catch {
    // The holder may already have self-destroyed.
  }
}

async function waitFor<T>(read: () => T | undefined, label: string, timeoutMs = 2_000): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`watchdog waiting for ${label}`)
}

async function settleWithWatchdog<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('10s outer watchdog')), OUTER_WATCHDOG_MS)
  })
  try {
    return await Promise.race([promise, watchdog])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function assertBodyFreeFrozenObserverError(result: unknown, code: string): void {
  expect(result).toEqual(Object.freeze({ kind: 'error', code }))
  expect(result && typeof result === 'object' ? Object.isFrozen(result) : false).toBe(true)
  expect(JSON.stringify(result)).not.toContain('body')
  expect(JSON.stringify(result)).not.toContain('CANARY')
}

function expectedComplete(
  deadline: number,
  identity: { readonly requestId: string; readonly cutoff: string; readonly shanghaiDay: string },
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'complete',
    requestId: identity.requestId,
    cutoff: identity.cutoff,
    shanghaiDay: identity.shanghaiDay,
    startedAt: new Date(deadline - 90).toISOString(),
    completedAt: new Date(deadline - 10).toISOString(),
    surfaces: [
      { kind: 'natural_zero', surface: 'for_you', surfaceOrdinal: 0, startedAt: new Date(deadline - 80).toISOString(), completedAt: new Date(deadline - 70).toISOString(), occurrences: [] },
      { kind: 'natural_zero', surface: 'following', surfaceOrdinal: 1, startedAt: new Date(deadline - 60).toISOString(), completedAt: new Date(deadline - 50).toISOString(), occurrences: [] },
      { kind: 'natural_zero', surface: 'explore', surfaceOrdinal: 2, startedAt: new Date(deadline - 40).toISOString(), completedAt: new Date(deadline - 30).toISOString(), occurrences: [] },
    ],
  }
}

async function loadFactory(): Promise<ObserverFactory> {
  const moduleUrl = new URL('../src/personal-feed/x-observer-child.ts', import.meta.url).href
  const loaded = await import(/* @vite-ignore */ moduleUrl) as { readonly createPersonalFeedXObserverChild?: unknown }
  if (typeof loaded.createPersonalFeedXObserverChild !== 'function') throw new Error('missing observer factory')
  return loaded.createPersonalFeedXObserverChild as ObserverFactory
}

async function startCase(factory: ObserverFactory, mode: number, pythonFile = process.execPath): Promise<Case> {
  const deadline = deadlineFor(mode)
  const cutoffEpochMs = deadline - (TOTAL_BUDGET_MS - CLEANUP_RESERVE_MS)
  const cutoff = new Date(cutoffEpochMs).toISOString()
  const requestId = `telegram:1:${nextRealRequestOrdinal++}`
  const shanghaiDay = shanghaiDayForEpoch(cutoffEpochMs)
  const controller = new AbortController()
  const records: EventRecord[] = []
  const kills: KillRecord[] = []
  let nextTimerOrdinal = 1
  const timers = new Map<unknown, TimerDiagnostic>()
  let child: ChildProcess | undefined
  let nativeKill: ((signal: NodeJS.Signals) => boolean) | undefined
  let originalStarttime: string | undefined

  const spawn = (...args: unknown[]): ChildProcess => {
    expect(args).toHaveLength(3)
    expect(args[0]).toBe(pythonFile)
    expect(args[1]).toEqual([FIXTURE_PATH])
    expect(args[2]).toEqual({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    child = nativeSpawn(args[0] as string, args[1] as string[], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    const pidDescriptor = Object.getOwnPropertyDescriptor(child, 'pid')
    const capturedPid = pidDescriptor !== undefined && 'value' in pidDescriptor ? pidDescriptor.value : undefined
    child.on('spawn', () => {
      records.push({ kind: 'spawn' })
      records.push(classifyOwnPidDescriptor(child as ChildProcess, capturedPid, 'spawn-event'))
    })
    records.push(classifyOwnPidDescriptor(child, capturedPid, 'spawn-return'))
    const stdin = child.stdin as unknown as { end: (...input: unknown[]) => unknown }
    const boundStdinEnd = stdin.end.bind(child.stdin)
    let stdinEndCallbackCalls = 0
    stdin.end = function (this: unknown, ...input: unknown[]): unknown {
      const callback = input.at(-1)
      if (typeof callback !== 'function') return boundStdinEnd(...input)
      const wrappedCallback = function (this: unknown, ...callbackArgs: unknown[]): unknown {
        stdinEndCallbackCalls += 1
        const firstArg = callbackArgs[0]
        const firstArgClass = firstArg === null ? 'null' : firstArg === undefined ? 'undefined' : 'other'
        records.push({
          kind: 'stdin-end-callback',
          callbackCalls: stdinEndCallbackCalls,
          argumentsLength: callbackArgs.length,
          firstArgClass,
        })
        return Reflect.apply(callback, this, callbackArgs)
      }
      const wrappedInput = input.slice()
      wrappedInput[wrappedInput.length - 1] = wrappedCallback
      return boundStdinEnd(...wrappedInput)
    }
    records.push({ kind: 'pid', pid: child.pid })
    if (child.pid !== undefined) {
      originalStarttime = readStarttime(child.pid)
      if (originalStarttime === undefined) throw new Error('child disappeared before identity capture')
      records.push({ kind: 'starttime', starttime: originalStarttime })
    }
    const boundNativeKill = child.kill.bind(child)
    nativeKill = boundNativeKill
    child.stdout.on('data', (data) => records.push({ kind: 'stdout-data', bytes: Buffer.byteLength(data) }))
    child.stdout.on('end', () => records.push({ kind: 'stdout-end' }))
    child.stderr.on('data', (data) => records.push({ kind: 'stderr-data', text: String(data) }))
    child.stderr.on('end', () => records.push({ kind: 'stderr-end' }))
    child.on('error', (error: unknown) => records.push({ kind: 'error', code: error && typeof error === 'object' && 'code' in error ? error.code : undefined }))
    child.on('exit', (code, signal) => records.push({ kind: 'exit', code, signal }))
    child.on('close', (code, signal) => records.push({ kind: 'close', code, signal }))
    child.kill = ((signal?: NodeJS.Signals): boolean => {
      const pid = child?.pid
      const identity = typeof pid === 'number' && originalStarttime !== undefined
        ? classifyIdentity(pid, originalStarttime)
        : 'gone'
      const sameOriginal = identity === 'same-original'
      const record = { kind: 'product-kill', signal: String(signal), identity, calledNative: sameOriginal } as KillRecord
      kills.push(record)
      if (!sameOriginal) return false
      return boundNativeKill(signal)
    }) as ChildProcess['kill']
    return child
  }

  const options = {
    pythonFile,
    observerCliPath: FIXTURE_PATH,
    totalBudgetMs: TOTAL_BUDGET_MS,
    cleanupReserveMs: CLEANUP_RESERVE_MS,
    killGraceMs: KILL_GRACE_MS,
    nowEpochMs: () => deadline - 399,
    spawn,
    setTimeout: (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
      const ordinal = nextTimerOrdinal++
      const timer: TimerDiagnostic = { ordinal, delay, fired: false, cleared: false }
      const handle = globalThis.setTimeout(() => {
        timer.fired = true
        records.push({ kind: 'timer-fired', ordinal })
        callback()
      }, delay)
      timers.set(handle, timer)
      records.push({ kind: 'timer-registered', ordinal, delay })
      return handle
    },
    clearTimeout: (handle: unknown): void => {
      const timer = timers.get(handle)
      if (timer !== undefined && !timer.cleared) {
        timer.cleared = true
        records.push({ kind: 'timer-cleared', ordinal: timer.ordinal })
      }
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
  }
  const promise = factory(options).observe({
    request: { requestId, cutoff, shanghaiDay },
    signal: controller.signal,
  })
  const spawned = await waitFor(() => child, 'spawn')
  if (nativeKill === undefined) throw new Error('missing native kill binding')
  return {
    deadline,
    requestId,
    cutoff,
    shanghaiDay,
    marker: `${tmpdir()}/personal-feed-x-observer-child-holder-${deadline}.release`,
    controller,
    records,
    kills,
    child: spawned,
    nativeKill,
    originalStarttime,
    promise,
  }
}

async function cleanupCase(testCase: Case): Promise<void> {
  releaseMarker(testCase.marker)
  if (testCase.child.pid !== undefined && testCase.originalStarttime !== undefined
    && classifyIdentity(testCase.child.pid, testCase.originalStarttime) === 'same-original') {
    testCase.nativeKill('SIGKILL')
  }
  await waitFor(() => testCase.records.some((record) => record.kind === 'close') ? true : undefined, 'close/reap', 3_000).catch(() => undefined)
  try { unlinkSync(testCase.marker) } catch { /* marker already released */ }
}

function eventIndex(records: readonly EventRecord[], kind: string): number {
  return records.findIndex((record) => record.kind === kind)
}

function expectNativeEventOrder(records: readonly EventRecord[]): void {
  const spawnIndex = eventIndex(records, 'spawn')
  const firstData = records.findIndex((record) => record.kind === 'stdout-data' || record.kind === 'stderr-data')
  const exitIndex = eventIndex(records, 'exit')
  const closeIndex = eventIndex(records, 'close')
  const errorIndex = eventIndex(records, 'error')
  if (spawnIndex < 0) {
    expect(spawnIndex).toBe(-1)
    expect(exitIndex).toBe(-1)
    expect(errorIndex).toBeGreaterThanOrEqual(0)
    expect(errorIndex).toBeLessThan(closeIndex)
    return
  }
  expect(spawnIndex).toBeGreaterThanOrEqual(0)
  if (firstData >= 0) expect(spawnIndex).toBeLessThan(firstData)
  expect(exitIndex).toBeGreaterThanOrEqual(0)
  expect(closeIndex).toBeGreaterThan(exitIndex)
  const streamEndIndexes = records
    .map((record, index) => record.kind === 'stdout-end' || record.kind === 'stderr-end' ? index : -1)
    .filter((index) => index >= 0)
  for (const endIndex of streamEndIndexes) expect(endIndex).toBeLessThan(closeIndex)
}

describe('Personal Feed X observer child real-process lifecycle contract', () => {
  it('real Linux/Node24 child lifecycle matrix never signals a failed or reaped child', async () => {
    const factory = await loadFactory()
    const ownStarttime = readStarttime(process.pid)
    if (ownStarttime === undefined) throw new Error('cannot read current process identity')
    expect(classifyIdentity(process.pid, ownStarttime)).toBe('same-original')
    expect(classifyIdentity(process.pid, `${ownStarttime}0`)).toBe('reused')
    expect(classifyIdentity(4_000_000, '0')).toBe('gone')

    const run = async (mode: number, action: (testCase: Case) => Promise<void>, expected: (testCase: Case, result: unknown) => void, pythonFile = process.execPath): Promise<void> => {
      const testCase = await startCase(factory, mode, pythonFile)
      try {
        await action(testCase)
        const result = await settleWithWatchdog(testCase.promise)
        expected(testCase, result)
        const repeated = await settleWithWatchdog(testCase.promise)
        expect(repeated).toEqual(result)
        expect(testCase.records.filter((record) => record.kind === 'close')).toHaveLength(1)
        expectNativeEventOrder(testCase.records)
        if (testCase.child.pid !== undefined && testCase.originalStarttime !== undefined) {
          const afterExit = await waitFor(() => {
            const identity = classifyIdentity(testCase.child.pid as number, testCase.originalStarttime)
            return identity === 'gone' || identity === 'reused' ? identity : undefined
          }, 'original identity gone')
          expect(['gone', 'reused']).toContain(afterExit)
        }
      } finally {
        await cleanupCase(testCase)
      }
    }

    await run(0, async () => {}, (testCase, result) => {
      expect(result, JSON.stringify({
        result,
        events: testCase.records.map((record) => ({
          kind: record.kind,
          code: record.code,
          signal: record.signal,
          pid: record.pid,
          starttime: record.starttime,
          callbackCalls: record.callbackCalls,
          argumentsLength: record.argumentsLength,
          firstArgClass: record.firstArgClass,
        })),
        productKills: testCase.kills.map((record) => ({
          signal: record.signal,
          identity: record.identity,
          calledNative: record.calledNative,
        })),
      })).toEqual(expectedComplete(testCase.deadline, testCase))
      expect(testCase.records).toContainEqual({
        kind: 'stdin-end-callback',
        callbackCalls: 1,
        argumentsLength: 1,
        firstArgClass: 'null',
      })
      expect(testCase.kills).toEqual([])
    })

    await run(1, async (testCase) => {
      await waitFor(() => testCase.records.some((record) => record.kind === 'stderr-data' && String(record.text).includes('READY')) ? true : undefined, 'READY before timeout')
      try {
        await waitFor(() => testCase.kills.length > 0 ? true : undefined, 'deadline TERM')
      } catch {
        throw new Error(JSON.stringify({
          events: safeDiagnosticRecords(testCase.records),
          productKills: safeKillDiagnostics(testCase.kills),
        }))
      }
    }, (testCase, result) => {
      assertBodyFreeFrozenObserverError(result, 'timed_out')
      expect(testCase.kills.map((record) => record.signal)).toEqual(['SIGTERM'])
      expect(testCase.kills.every((record) => record.identity === 'same-original' && record.calledNative)).toBe(true)
    })

    await run(1, async (testCase) => {
      await waitFor(() => testCase.records.some((record) => record.kind === 'stderr-data' && String(record.text).includes('READY')) ? true : undefined, 'READY before abort')
      testCase.controller.abort()
    }, (testCase, result) => {
      assertBodyFreeFrozenObserverError(result, 'aborted')
      expect(testCase.kills.map((record) => record.signal)).toEqual(['SIGTERM'])
    })

    await run(2, async (testCase) => {
      await waitFor(() => testCase.records.some((record) => record.kind === 'stderr-data' && String(record.text).includes('READY')) ? true : undefined, 'READY before abort')
      testCase.controller.abort()
    }, (testCase, result) => {
      assertBodyFreeFrozenObserverError(result, 'aborted')
      expect(testCase.kills.map((record) => record.signal)).toEqual(['SIGTERM', 'SIGKILL'])
      expect(testCase.kills.every((record) => record.identity === 'same-original' && record.calledNative)).toBe(true)
    })

    await run(0, async () => {}, (testCase, result) => {
      expect(testCase.records).toContainEqual({ kind: 'error', code: 'ENOENT' })
      expect(testCase.records.some((record) => record.kind === 'spawn')).toBe(false)
      expect(testCase.records.some((record) => record.kind === 'exit')).toBe(false)
      expect(eventIndex(testCase.records, 'error')).toBeLessThan(eventIndex(testCase.records, 'close'))
      expect(testCase.kills).toEqual([])
      assertBodyFreeFrozenObserverError(result, 'observer_failed')
    }, '/definitely/not/a/real/python-file-for-enoent')

    await run(0, async (testCase) => {
      await waitFor(() => testCase.records.some((record) => record.kind === 'close') ? true : undefined, 'fast-race close')
      testCase.controller.abort()
    }, (testCase, result) => {
      expect(result).toEqual(expectedComplete(testCase.deadline, testCase))
      expect(testCase.kills).toEqual([])
    })

    const holderActions: readonly { readonly action: (testCase: Case) => Promise<void>; readonly expected: 'aborted' | 'timed_out' }[] = [
      { action: async (testCase: Case) => {
        await waitFor(() => testCase.records.some((record) => record.kind === 'exit') ? true : undefined, 'holder exit before abort')
        await waitFor(() => testCase.records.some((record) => record.kind === 'close') ? true : undefined, 'holder close remains pending', 120).catch(() => undefined)
        expect(testCase.records.some((record) => record.kind === 'close')).toBe(false)
        testCase.controller.abort()
        expect(testCase.kills).toEqual([])
        releaseMarker(testCase.marker)
      }, expected: 'aborted' },
      { action: async (testCase: Case) => {
        await waitFor(() => testCase.records.some((record) => record.kind === 'exit') ? true : undefined, 'holder exit before deadline')
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, testCase.deadline + CLEANUP_RESERVE_MS + 100 - Date.now())))
        expect(testCase.records.some((record) => record.kind === 'close')).toBe(false)
        expect(testCase.kills).toEqual([])
        releaseMarker(testCase.marker)
      }, expected: 'timed_out' },
    ]
    for (const holderCase of holderActions) {
      await run(3, holderCase.action, (testCase, result) => {
        if (holderCase.expected === 'aborted') assertBodyFreeFrozenObserverError(result, 'aborted')
        else assertBodyFreeFrozenObserverError(result, 'timed_out')
        expect(testCase.kills).toEqual([])
      })
    }
  })

  it('exit is the signal terminal while close remains the settlement terminal', async () => {
    const factory = await loadFactory()
    for (const reason of ['aborted', 'timed_out'] as const) {
      const scheduler = {
        now: 0,
        timers: [] as Array<{ readonly callback: () => void; readonly due: number; readonly delay: number; cleared: boolean }>,
        setTimeout(callback: () => void, delay: number) {
          const timer = { callback, due: this.now + delay, delay, cleared: false }
          this.timers.push(timer)
          return timer
        },
        clearTimeout(timer: unknown) {
          if (timer && typeof timer === 'object' && 'cleared' in timer) timer.cleared = true
        },
        advance(to: number) {
          this.now = to
          for (const timer of this.timers) if (!timer.cleared && timer.due <= to) { timer.cleared = true; timer.callback() }
        },
      }
      const child = new EventEmitter() as any
      child.stdin = { end: () => {} }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.pid = 7011
      let killCount = 0
      child.kill = () => { killCount += 1; return true }
      const spawn = () => child
      const controller = new AbortController()
      const promise = factory({
        pythonFile: '/usr/bin/python3', observerCliPath: '/opt/observer.py', totalBudgetMs: 4_100,
        cleanupReserveMs: 700, killGraceMs: 300, nowEpochMs: () => 601,
        spawn, setTimeout: scheduler.setTimeout.bind(scheduler), clearTimeout: scheduler.clearTimeout.bind(scheduler),
      }).observe({ request: { requestId: `telegram:2:${reason === 'aborted' ? 1 : 2}`, cutoff: '1970-01-01T00:00:00.000Z', shanghaiDay: shanghaiDayForEpoch(0) }, signal: controller.signal })
      child.emit('exit', 0, null)
      expect(killCount).toBe(0)
      await Promise.resolve()
      if (reason === 'aborted') controller.abort()
      else scheduler.advance(5_000)
      expect(killCount).toBe(0)
      let settled = false
      void promise.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      child.emit('close', 0, null)
      assertBodyFreeFrozenObserverError(await promise, reason)
      child.emit('exit', 1, 'SIGTERM')
      child.emit('close', 1, 'SIGTERM')
      assertBodyFreeFrozenError(await promise, reason)
    }
  })

  it('a synchronous exit from TERM cancels escalation and an undefined-pid spawn failure is never signaled', async () => {
    const factory = await loadFactory()
    const makeFake = (pid: unknown, emitExitOnTerm: boolean) => {
      const child = new EventEmitter() as any
      child.stdin = { end: () => {} }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.pid = pid
      child.killCalls = [] as string[]
      child.kill = (signal: string) => { child.killCalls.push(signal); if (emitExitOnTerm && signal === 'SIGTERM') child.emit('exit', 0, null); return true }
      return child
    }
    const syncChild = makeFake(7011, true)
    const scheduler = { now: 601, timers: [] as Array<{ callback: () => void; due: number; delay: number; cleared: boolean }>, setTimeout(callback: () => void, delay: number) { const timer = { callback, due: this.now + delay, delay, cleared: false }; this.timers.push(timer); return timer }, clearTimeout(timer: any) { timer.cleared = true }, advance(to: number) { this.now = to; for (const timer of this.timers) if (!timer.cleared && timer.due <= to) { timer.cleared = true; timer.callback() } } }
    const controller = new AbortController()
    const promise = factory({ pythonFile: '/usr/bin/python3', observerCliPath: '/opt/observer.py', totalBudgetMs: 4_100, cleanupReserveMs: 700, killGraceMs: 300, nowEpochMs: () => 601, spawn: () => syncChild, setTimeout: scheduler.setTimeout.bind(scheduler), clearTimeout: scheduler.clearTimeout.bind(scheduler) }).observe({ request: { requestId: 'telegram:3:1', cutoff: '1970-01-01T00:00:00.000Z', shanghaiDay: shanghaiDayForEpoch(0) }, signal: controller.signal })
    controller.abort()
    expect(syncChild.killCalls).toEqual(['SIGTERM'])
    expect(scheduler.timers.filter((timer) => timer.delay === KILL_GRACE_MS)).toHaveLength(0)
    scheduler.advance(4_000)
    expect(syncChild.killCalls).toEqual(['SIGTERM'])
    expect(syncChild.killCalls).toHaveLength(1)
    syncChild.emit('close', 0, null)
    assertBodyFreeFrozenObserverError(await promise, 'aborted')

    let callbackCaseOrdinal = 1
    const makeCallbackCase = () => {
      const callbackScheduler = {
        now: 601,
        timers: [] as Array<{ readonly callback: () => void; readonly due: number; readonly delay: number; cleared: boolean }>,
        setTimeout(callback: () => void, delay: number) {
          const timer = { callback, due: this.now + delay, delay, cleared: false }
          this.timers.push(timer)
          return timer
        },
        clearTimeout(timer: unknown) {
          if (timer && typeof timer === 'object' && 'cleared' in timer) timer.cleared = true
        },
        advance(to: number) {
          this.now = to
          for (const timer of this.timers) if (!timer.cleared && timer.due <= to) {
            timer.cleared = true
            timer.callback()
          }
        },
      }
      const callbackChild = makeFake(7011, false)
      const request = {
        requestId: `telegram:5:${callbackCaseOrdinal++}`,
        cutoff: '1970-01-01T00:00:00.000Z',
        shanghaiDay: shanghaiDayForEpoch(0),
      }
      let savedCallback: ((...args: unknown[]) => unknown) | undefined
      let endArgs: unknown[] = []
      callbackChild.stdin = {
        end: (...args: unknown[]) => {
          endArgs = args
          const candidate = args.at(-1)
          if (typeof candidate === 'function') savedCallback = candidate as (...args: unknown[]) => unknown
        },
      }
      const controller = new AbortController()
      const callbackPromise = factory({
        pythonFile: '/usr/bin/python3', observerCliPath: '/opt/observer.py', totalBudgetMs: 4_100,
        cleanupReserveMs: 700, killGraceMs: 300, nowEpochMs: () => 601,
        spawn: () => callbackChild, setTimeout: callbackScheduler.setTimeout.bind(callbackScheduler), clearTimeout: callbackScheduler.clearTimeout.bind(callbackScheduler),
      }).observe({
        request,
        signal: controller.signal,
      })
      return {
        child: callbackChild,
        request,
        scheduler: callbackScheduler,
        controller,
        promise: callbackPromise,
        getEndArgs: () => endArgs,
        invokeCallback: (...args: unknown[]) => savedCallback?.(...args),
      }
    }
    const legalStdout = (request: { readonly requestId: string; readonly cutoff: string; readonly shanghaiDay: string }): Buffer => Buffer.from(`${JSON.stringify(expectedComplete(3_400, request))}\n`, 'utf8')
    const assertLegalStdinWire = (endArgs: readonly unknown[], request: { readonly requestId: string; readonly cutoff: string; readonly shanghaiDay: string }): void => {
      expect(endArgs).toHaveLength(3)
      expect(endArgs[0]).toBe(`{"schemaVersion":1,"requestId":"${request.requestId}","cutoff":"${request.cutoff}","shanghaiDay":"${request.shanghaiDay}","deadlineEpochMs":3400}`)
      expect(endArgs[1]).toBe('utf8')
      expect(endArgs[2]).toEqual(expect.any(Function))
    }
    for (const callbackValue of [undefined, null] as const) {
      const callbackCase = makeCallbackCase()
      assertLegalStdinWire(callbackCase.getEndArgs(), callbackCase.request)
      callbackCase.child.stdout.emit('data', legalStdout(callbackCase.request))
      callbackCase.invokeCallback(callbackValue)
      callbackCase.child.emit('close', 0, null)
      expect(await callbackCase.promise).toEqual(expectedComplete(3_400, callbackCase.request))
      expect(callbackCase.child.killCalls).toEqual([])
    }
    const callbackErrorValues: readonly unknown[] = [false, 0, '', Object.freeze({ canary: 'CALLBACK_CANARY' }), new Error('CALLBACK_ERROR_MESSAGE')]
    for (const callbackValue of callbackErrorValues) {
      const callbackCase = makeCallbackCase()
      assertLegalStdinWire(callbackCase.getEndArgs(), callbackCase.request)
      callbackCase.invokeCallback(callbackValue)
      let settled = false
      void callbackCase.promise.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      callbackCase.child.emit('close', 0, null)
      const result = await callbackCase.promise
      assertBodyFreeFrozenObserverError(result, 'observer_failed')
      expect(JSON.stringify(result)).not.toContain('CALLBACK_CANARY')
      expect(JSON.stringify(result)).not.toContain('CALLBACK_ERROR_MESSAGE')
    }
    for (const callbackValues of [[null, undefined], [null, new Error('CALLBACK_ERROR_MESSAGE')], [new Error('CALLBACK_ERROR_MESSAGE'), null]] as const) {
      const callbackCase = makeCallbackCase()
      assertLegalStdinWire(callbackCase.getEndArgs(), callbackCase.request)
      if (callbackValues[0] === null && callbackValues[1] === undefined) callbackCase.child.stdout.emit('data', legalStdout(callbackCase.request))
      callbackCase.invokeCallback(...callbackValues)
      let settled = false
      void callbackCase.promise.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      callbackCase.child.emit('close', 0, null)
      const result = await callbackCase.promise
      if (callbackValues[1] === undefined) expect(result).toEqual(expectedComplete(3_400, callbackCase.request))
      else assertBodyFreeFrozenObserverError(result, 'observer_failed')
      expect(JSON.stringify(result)).not.toContain('CALLBACK_ERROR_MESSAGE')
    }
    for (const terminal of ['aborted', 'timed_out'] as const) {
      const callbackCase = makeCallbackCase()
      assertLegalStdinWire(callbackCase.getEndArgs(), callbackCase.request)
      if (terminal === 'aborted') callbackCase.controller.abort()
      else callbackCase.scheduler.advance(3_400)
      const killCallsBeforeCallback = [...callbackCase.child.killCalls]
      callbackCase.invokeCallback(new Error('CALLBACK_ERROR_MESSAGE'))
      callbackCase.child.emit('close', 0, null)
      assertBodyFreeFrozenObserverError(await callbackCase.promise, terminal)
      expect(callbackCase.child.killCalls).toEqual(killCallsBeforeCallback)
      expect(JSON.stringify(await callbackCase.promise)).not.toContain('CALLBACK_ERROR_MESSAGE')
    }
    {
      const callbackCase = makeCallbackCase()
      assertLegalStdinWire(callbackCase.getEndArgs(), callbackCase.request)
      callbackCase.child.stdout.emit('data', legalStdout(callbackCase.request))
      callbackCase.invokeCallback(undefined)
      callbackCase.child.emit('close', 0, null)
      const settledResult = await callbackCase.promise
      const killCallsAfterClose = [...callbackCase.child.killCalls]
      const timersAfterClose = callbackCase.scheduler.timers.map((timer) => ({ delay: timer.delay, cleared: timer.cleared }))
      callbackCase.invokeCallback(null)
      callbackCase.invokeCallback(new Error('CALLBACK_ERROR_MESSAGE'))
      expect(await callbackCase.promise).toEqual(settledResult)
      expect(callbackCase.child.killCalls).toEqual(killCallsAfterClose)
      expect(callbackCase.scheduler.timers.map((timer) => ({ delay: timer.delay, cleared: timer.cleared }))).toEqual(timersAfterClose)
      expect(JSON.stringify(settledResult)).not.toContain('CALLBACK_ERROR_MESSAGE')
    }

    const accessorReads = { value: 0 }
    const invalidPids: readonly { readonly label: string; readonly configure: (child: object) => void }[] = [
      { label: 'missing', configure: (child) => { delete (child as { pid?: unknown }).pid } },
      { label: 'inherited', configure: (child) => { delete (child as { pid?: unknown }).pid; Object.setPrototypeOf(child, Object.create(Object.getPrototypeOf(child), { pid: { enumerable: true, value: 7011 } })) } },
      { label: 'non-enumerable', configure: (child) => Object.defineProperty(child, 'pid', { enumerable: false, value: 7011 }) },
      { label: 'accessor returned 7011', configure: (child) => Object.defineProperty(child, 'pid', { enumerable: true, get: () => 7011 }) },
      { label: 'accessor throws', configure: (child) => Object.defineProperty(child, 'pid', { enumerable: true, get: () => { accessorReads.value += 1; throw new Error('PID_ACCESSOR_CANARY') } }) },
      { label: 'undefined', configure: (child) => Object.defineProperty(child, 'pid', { enumerable: true, value: undefined }) },
      { label: 'zero', configure: (child) => Object.defineProperty(child, 'pid', { enumerable: true, value: 0 }) },
      { label: 'negative', configure: (child) => Object.defineProperty(child, 'pid', { enumerable: true, value: -1 }) },
      { label: 'fractional', configure: (child) => Object.defineProperty(child, 'pid', { enumerable: true, value: 1.5 }) },
      { label: 'above MAX_SAFE_INTEGER', configure: (child) => Object.defineProperty(child, 'pid', { enumerable: true, value: Number.MAX_SAFE_INTEGER + 1 }) },
      { label: 'string', configure: (child) => Object.defineProperty(child, 'pid', { enumerable: true, value: '7011' }) },
    ]
    for (const [invalidIndex, pidCase] of invalidPids.entries()) {
      const fake = makeFake(undefined, false)
      pidCase.configure(fake)
      const invalidPromise = factory({ pythonFile: '/usr/bin/python3', observerCliPath: '/opt/observer.py', totalBudgetMs: 4_100, cleanupReserveMs: 700, killGraceMs: 300, nowEpochMs: () => 601, spawn: () => fake, setTimeout: scheduler.setTimeout.bind(scheduler), clearTimeout: scheduler.clearTimeout.bind(scheduler) }).observe({ request: { requestId: `telegram:4:${invalidIndex + 1}`, cutoff: '1970-01-01T00:00:00.000Z', shanghaiDay: shanghaiDayForEpoch(0) }, signal: new AbortController().signal })
      fake.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      fake.emit('close', 1, null)
      fake.emit('spawn')
      expect(fake.killCalls).toEqual([])
      if (pidCase.label === 'accessor throws') expect(accessorReads.value).toBe(0)
      assertBodyFreeFrozenObserverError(await invalidPromise, 'observer_failed')
    }
  })
})

function assertBodyFreeFrozenError(result: unknown, code: string): void {
  expect(result).toEqual(Object.freeze({ kind: 'error', code }))
  expect(result && typeof result === 'object' ? Object.isFrozen(result) : false).toBe(true)
  expect(JSON.stringify(result)).not.toContain('body')
}
