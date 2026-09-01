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
