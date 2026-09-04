import { getEventListeners } from 'node:events'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createPersonalFeedXSurfaceObserver } from '../src/personal-feed/x-surface-observer.ts'

type CommandRequest = Readonly<{
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxBuffer: number
  readonly shell: false
  readonly signal: AbortSignal
}>

type CommandResult = Readonly<{ readonly stdout: string; readonly stderr: string }>

const REQUEST = Object.freeze({
  requestId: 'telegram:17:23',
  cutoff: '2026-08-31T02:00:00.000Z',
  shanghaiDay: '2026-08-31',
})
const NOW = new Date('2026-08-31T02:00:04.000Z')
const SHANGHAI_DAY_DEADLINE = Date.parse('2026-08-31T16:00:00.000Z')
const RAW_BODY_A = 'BODY_CANARY_A_ONLY_DIRECT_TAKE'
const RAW_BODY_B = 'BODY_CANARY_B_ONLY_DIRECT_TAKE'

function occurrence(
  sourceUrl: string,
  authorHandle: string,
  body: unknown,
  occurrenceOrdinal: number,
  capturedAt: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({ sourceUrl, body, occurrenceOrdinal, capturedAt, authorHandle, publishedAt: capturedAt })
}

function surface(
  name: 'for_you' | 'following' | 'explore',
  ordinal: number,
  startedAt: string,
  completedAt: string,
  occurrences: readonly unknown[],
  kind: 'complete' | 'natural_zero' = occurrences.length === 0 ? 'natural_zero' : 'complete',
): Readonly<Record<string, unknown>> {
  return Object.freeze({ kind, surface: name, surfaceOrdinal: ordinal, startedAt, completedAt, occurrences: Object.freeze([...occurrences]) })
}

function completeRaw(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'complete',
    ...REQUEST,
    startedAt: '2026-08-31T02:00:00.100Z',
    completedAt: '2026-08-31T02:00:03.900Z',
    surfaces: Object.freeze([
      surface('for_you', 0, '2026-08-31T02:00:00.200Z', '2026-08-31T02:00:01.000Z', [
        occurrence('https://x.com/alpha/status/101', 'alpha', Object.freeze({ kind: 'sufficient', text: RAW_BODY_A }), 0, '2026-08-31T02:00:00.400Z'),
      ]),
      surface('following', 1, '2026-08-31T02:00:01.100Z', '2026-08-31T02:00:02.000Z', [
        occurrence('https://x.com/alpha/status/101', 'alpha', Object.freeze({ kind: 'sufficient', text: RAW_BODY_B }), 0, '2026-08-31T02:00:01.300Z'),
      ]),
      surface('explore', 2, '2026-08-31T02:00:02.100Z', '2026-08-31T02:00:03.000Z', []),
    ]),
    ...overrides,
  })
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function input(signal = new AbortController().signal): Readonly<{ readonly request: typeof REQUEST; readonly signal: AbortSignal }> {
  return Object.freeze({ request: REQUEST, signal })
}

function createObserver(
  run: (request: CommandRequest) => Promise<CommandResult>,
  clock: Readonly<{ readonly now: () => Date }> = Object.freeze({ now: () => NOW }),
) {
  return createPersonalFeedXSurfaceObserver({
    pythonBin: '/usr/bin/python3',
    observerCliPath: '/opt/dsh/runtime/personal-feed/python/x_personal_feed_observer_cli.py',
    clock,
    run,
  })
}

function captures(window: unknown): Array<{ readonly take?: (input: unknown) => string | undefined; readonly close: () => Promise<void> }> {
  const found: Array<{ readonly take?: (input: unknown) => string | undefined; readonly close: () => Promise<void> }> = []
  for (const face of (window as { readonly surfaces: readonly unknown[] }).surfaces) {
    for (const item of (face as { readonly occurrences: readonly unknown[] }).occurrences) {
      const body = (item as { readonly body: Readonly<Record<string, unknown>> }).body
      const owner = body.kind === 'sufficient' ? body.capture : body
      found.push(owner as { readonly take?: (input: unknown) => string | undefined; readonly close: () => Promise<void> })
    }
  }
  return found
}

describe('Personal Feed X surface observer', () => {
  it('executes one fixed command for the request and exposes an exact three-face capture window', async () => {
    const calls: CommandRequest[] = []
    const run = vi.fn(async (request: CommandRequest) => {
      calls.push(request)
      return { stdout: line(completeRaw()), stderr: '' }
    })
    const controller = new AbortController()
    const observer = createObserver(run)

    const result = await observer.observe(input(controller.signal)) as {
      readonly kind: string
      readonly window: Readonly<Record<string, unknown>>
      readonly close: () => Promise<void>
    }

    expect(Object.keys(observer)).toEqual(['observe'])
    expect(Object.isFrozen(observer)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      file: '/usr/bin/python3',
      args: ['/opt/dsh/runtime/personal-feed/python/x_personal_feed_observer_cli.py', expect.any(String)],
      cwd: '/opt/dsh/runtime/personal-feed/python',
      timeoutMs: SHANGHAI_DAY_DEADLINE - NOW.getTime(),
      maxBuffer: 1_048_576,
      shell: false,
      signal: controller.signal,
    })
    expect(JSON.parse(calls[0]!.args[1]!)).toEqual({
      schemaVersion: 1,
      ...REQUEST,
      deadlineEpochMs: SHANGHAI_DAY_DEADLINE,
    })
    expect(result.kind).toBe('complete')
    expect(Reflect.ownKeys(result)).toEqual(['kind', 'window', 'close'])
    expect(Reflect.ownKeys(result.window)).toEqual(['requestId', 'cutoff', 'shanghaiDay', 'startedAt', 'completedAt', 'surfaces'])
    expect((result.window.surfaces as readonly Readonly<Record<string, unknown>>[]).map(face => face.surface)).toEqual(['for_you', 'following', 'explore'])
    expect(JSON.stringify(result)).not.toContain(RAW_BODY_A)
    expect(JSON.stringify(result)).not.toContain(RAW_BODY_B)

    const owners = captures(result.window)
    expect(owners).toHaveLength(2)
    expect(owners[0]!.take?.({ signal: controller.signal })).toBe(RAW_BODY_A)
    expect(owners[1]!.take?.({ signal: controller.signal })).toBe(RAW_BODY_B)
    expect(owners[0]!.take?.({ signal: controller.signal })).toBeUndefined()
    await result.close()
  })

  it('keeps cross-face occurrences but rejects any incomplete or structurally false AND result', async () => {
    const wrongOrder = completeRaw({
      surfaces: Object.freeze([
        surface('following', 0, '2026-08-31T02:00:00.200Z', '2026-08-31T02:00:01.000Z', []),
        surface('for_you', 1, '2026-08-31T02:00:01.100Z', '2026-08-31T02:00:02.000Z', []),
        surface('explore', 2, '2026-08-31T02:00:02.100Z', '2026-08-31T02:00:03.000Z', []),
      ]),
    })
    const falseZero = completeRaw({
      surfaces: Object.freeze([
        surface('for_you', 0, '2026-08-31T02:00:00.200Z', '2026-08-31T02:00:01.000Z', [
          occurrence('https://x.com/alpha/status/101', 'alpha', Object.freeze({ kind: 'sufficient', text: RAW_BODY_A }), 0, '2026-08-31T02:00:00.400Z'),
        ], 'natural_zero'),
        surface('following', 1, '2026-08-31T02:00:01.100Z', '2026-08-31T02:00:02.000Z', []),
        surface('explore', 2, '2026-08-31T02:00:02.100Z', '2026-08-31T02:00:03.000Z', []),
      ]),
    })
    const incomplete = Object.freeze({
      schemaVersion: 1,
      kind: 'incomplete',
      ...REQUEST,
      startedAt: '2026-08-31T02:00:00.100Z',
      completedAt: '2026-08-31T02:00:01.000Z',
      surfaces: Object.freeze([
        Object.freeze({ surface: 'for_you', surfaceOrdinal: 0, kind: 'partial' }),
        Object.freeze({ surface: 'following', surfaceOrdinal: 1, kind: 'unknown' }),
        Object.freeze({ surface: 'explore', surfaceOrdinal: 2, kind: 'unknown' }),
      ]),
    })
    for (const raw of [wrongOrder, falseZero, incomplete, { ...completeRaw(), requestId: 'telegram:17:24' }]) {
      const observer = createObserver(async () => ({ stdout: line(raw), stderr: '' }))
      expect(await observer.observe(input())).toEqual({ kind: 'incomplete' })
    }

    const observer = createObserver(async () => ({ stdout: line(completeRaw()), stderr: '' }))
    const result = await observer.observe(input()) as { readonly kind: string; readonly window: Readonly<Record<string, unknown>>; readonly close: () => Promise<void> }
    expect(result.kind).toBe('complete')
    const faces = result.window.surfaces as readonly Readonly<Record<string, unknown>>[]
    expect((faces[0]!.occurrences as readonly unknown[])).toHaveLength(1)
    expect((faces[1]!.occurrences as readonly unknown[])).toHaveLength(1)
    await result.close()
  })

  it('accepts a capture stamped in the same millisecond as its surface completion', async () => {
    const raw = completeRaw({
      surfaces: Object.freeze([
        surface('for_you', 0, '2026-08-31T02:00:00.200Z', '2026-08-31T02:00:01.000Z', []),
        surface('following', 1, '2026-08-31T02:00:01.100Z', '2026-08-31T02:00:02.000Z', []),
        surface('explore', 2, '2026-08-31T02:00:02.100Z', '2026-08-31T02:00:03.000Z', [
          occurrence('https://x.com/alpha/status/101', 'alpha', Object.freeze({ kind: 'sufficient', text: RAW_BODY_A }), 0, '2026-08-31T02:00:03.000Z'),
        ]),
      ]),
    })
    const observer = createObserver(async () => ({ stdout: line(raw), stderr: '' }))

    const result = await observer.observe(input()) as { readonly kind: string; readonly close?: () => Promise<void> }

    expect(result.kind).toBe('complete')
    await result.close?.()
  })

  it('binds one-shot body access to the original signal and closes the whole batch on abort or explicit close', async () => {
    const controller = new AbortController()
    const other = new AbortController()
    const baseline = getEventListeners(controller.signal, 'abort').length
    const observer = createObserver(async () => ({ stdout: line(completeRaw()), stderr: '' }))
    const result = await observer.observe(input(controller.signal)) as { readonly window: unknown; readonly close: () => Promise<void> }
    const owners = captures(result.window)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(baseline + 1)
    expect(owners[0]!.take?.({ signal: other.signal })).toBeUndefined()
    controller.abort()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(baseline)
    expect(owners[0]!.take?.({ signal: controller.signal })).toBeUndefined()
    expect(owners[1]!.take?.({ signal: controller.signal })).toBeUndefined()
    await result.close()
    await result.close()
  })

  it('fails closed before execution, during execution, and after a late result', async () => {
    const preAborted = new AbortController()
    preAborted.abort()
    const preRun = vi.fn(async () => ({ stdout: line(completeRaw()), stderr: '' }))
    expect(await createObserver(preRun).observe(input(preAborted.signal))).toEqual({ kind: 'incomplete' })
    expect(preRun).not.toHaveBeenCalled()

    let release!: (value: CommandResult) => void
    const deferred = new Promise<CommandResult>(resolve => { release = resolve })
    const active = new AbortController()
    const pending = createObserver(async () => await deferred).observe(input(active.signal))
    active.abort()
    release({ stdout: line(completeRaw()), stderr: '' })
    expect(await pending).toEqual({ kind: 'incomplete' })

    const failed = createObserver(async () => { throw new Error(RAW_BODY_A) })
    expect(await failed.observe(input())).toEqual({ kind: 'incomplete' })
    const noisy = createObserver(async () => ({ stdout: line(completeRaw()), stderr: RAW_BODY_B }))
    expect(await noisy.observe(input())).toEqual({ kind: 'incomplete' })
    const extraLine = createObserver(async () => ({ stdout: `${line(completeRaw())}${line({ extra: true })}`, stderr: '' }))
    expect(await extraLine.observe(input())).toEqual({ kind: 'incomplete' })
  })

  it('uses the Shanghai-day deadline and rejects results completed or returned at that boundary', async () => {
    const completedAtDeadline = completeRaw({ completedAt: '2026-08-31T16:00:00.000Z' })
    expect(await createObserver(async () => ({ stdout: line(completedAtDeadline), stderr: '' })).observe(input())).toEqual({ kind: 'incomplete' })

    const times = [NOW, new Date(SHANGHAI_DAY_DEADLINE)]
    const lateClock = Object.freeze({ now: () => times.shift() ?? new Date(SHANGHAI_DAY_DEADLINE) })
    expect(await createObserver(async () => ({ stdout: line(completeRaw()), stderr: '' }), lateClock).observe(input())).toEqual({ kind: 'incomplete' })

    const expiredClock = Object.freeze({ now: () => new Date(SHANGHAI_DAY_DEADLINE) })
    const run = vi.fn(async () => ({ stdout: line(completeRaw()), stderr: '' }))
    expect(await createObserver(run, expiredClock).observe(input())).toEqual({ kind: 'incomplete' })
    expect(run).not.toHaveBeenCalled()
  })

  it('has no Personal Feed persistence, session, recovery, browser-start, or logging sink', () => {
    const source = readFileSync(new URL('../src/personal-feed/x-surface-observer.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from\s+['"]node:fs(?:\/promises)?['"]|require\(\s*['"]node:fs/)
    expect(source).not.toMatch(/\b(?:timeline|history|shown|current_collection|recovery|session)\b\s*\./)
    expect(source).not.toMatch(/\b(?:console|logger|log)\s*\./)
    expect(source).not.toMatch(/ensure_cdp|ensure_x_tab|new_tab|run_browser_start/)
  })
})
