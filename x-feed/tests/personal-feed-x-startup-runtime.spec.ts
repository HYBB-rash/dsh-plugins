import { EventEmitter } from 'node:events'
import {
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SELF_TEST_RECEIPT = 'personal-feed-x-startup-self-test/v1'
const EXPECTED_INVALID_INPUT = '{"schemaVersion":1,"kind":"invalid_input"}\n'
const SELF_TEST_HOME = '/nonexistent'
const SELF_TEST_DSH_HOME = '/nonexistent/.dsh'
const SELF_TEST_DATA_DIR = '/nonexistent/x-feed-data'
const FIXED_ERROR_CANARY = 'PERSONAL_FEED_X_STARTUP_CHILD_CANARY'
const TOTAL_BUDGET_MS = 120_000
const CLEANUP_RESERVE_MS = 2_000
const SELF_TEST_TIMEOUT_MS = 2_000
const KILL_GRACE_MS = 500

type RuntimeConfig = Readonly<{
  readonly dataDir: string
  readonly telegramSessionId: string
  readonly feedbackPendingTtlMs: number
  readonly feedbackTurnTimeoutMs: number
  readonly personalFeedDataDir: string
}>

type Startup = Readonly<{
  readonly observe: (input: unknown) => Promise<unknown>
  readonly shutdown: () => Promise<void>
}>

type ChildBehavior = {
  readonly onEnd?: (child: FakeChild) => void
  readonly stdinError?: unknown
  readonly throwOnChildOn?: string
  readonly throwOnStdoutOn?: string
  readonly throwOnStderrOn?: string
  readonly kill?: (child: FakeChild, signal: unknown) => void
}

class FakeWritable extends EventEmitter {
  readonly endCalls: unknown[][] = []
  constructor(private readonly behavior: ChildBehavior, private readonly owner: FakeChild) {
    super()
  }

  override end(...args: unknown[]): void {
    this.endCalls.push(args)
    if (this.behavior.stdinError !== undefined) throw this.behavior.stdinError
    const callback = args.at(-1)
    if (typeof callback === 'function') callback()
    this.behavior.onEnd?.(this.owner)
  }
}

class FakeReadable extends EventEmitter {
  constructor(private readonly throwOnEvent: string | undefined) {
    super()
  }

  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    if (event === this.throwOnEvent) throw new Error(`${FIXED_ERROR_CANARY}:stream-listener`)
    return super.on(event, listener)
  }
}

class FakeChild extends EventEmitter {
  readonly stdin: FakeWritable
  readonly stdout: FakeReadable
  readonly stderr: FakeReadable
  readonly signals: unknown[] = []
  pid: unknown = 7911

  constructor(readonly behavior: ChildBehavior = {}) {
    super()
    this.stdin = new FakeWritable(behavior, this)
    this.stdout = new FakeReadable(behavior.throwOnStdoutOn)
    this.stderr = new FakeReadable(behavior.throwOnStderrOn)
  }

  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    if (event === this.behavior.throwOnChildOn) throw new Error(`${FIXED_ERROR_CANARY}:child-listener`)
    return super.on(event, listener)
  }

  readonly kill = (signal?: unknown): boolean => {
    this.signals.push(signal)
    this.behavior.kill?.(this, signal)
    return true
  }
}

type TimerRecord = {
  readonly callback: () => void
  readonly delayMs: number
  fired: boolean
  cleared: boolean
}

class ManualScheduler {
  readonly records: TimerRecord[] = []
  readonly setTimeout = (callback: () => void, delayMs: number): object => {
    const record: TimerRecord = { callback, delayMs, fired: false, cleared: false }
    this.records.push(record)
    return record
  }

  readonly clearTimeout = (handle: unknown): void => {
    const record = this.records.find(candidate => candidate === handle)
    if (record !== undefined) record.cleared = true
  }

  fireNext(): void {
    const record = this.records.find(candidate => !candidate.fired && !candidate.cleared)
    if (record === undefined) throw new Error('scheduler had no active timer')
    record.fired = true
    record.callback()
  }

  fireDelay(delayMs: number): void {
    const record = this.records.find(candidate => !candidate.fired && !candidate.cleared && candidate.delayMs === delayMs)
    if (record === undefined) throw new Error(`scheduler had no active timer for ${delayMs}ms`)
    record.fired = true
    record.callback()
  }

  fireAll(): void {
    while (this.records.some(record => !record.fired && !record.cleared)) this.fireNext()
  }
}

type NativeSpawn = (...args: unknown[]) => unknown
type Primitives = Readonly<{
  readonly nativeSpawn: NativeSpawn
  readonly homedir: () => string
  readonly resolveDshHome: () => string
  readonly nowEpochMs: () => number
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}>

type StartupModule = Readonly<{
  readonly createPersonalFeedXStartupFromPackageEntry?: unknown
  readonly runPersonalFeedXStartupSelfTestFromPackageEntry?: unknown
}>

type RootModule = Readonly<Record<string, unknown>>

const SOURCE_ENTRY = new URL('../src/index.ts', import.meta.url).href
const LIB_ENTRY = new URL('../lib/index.js', import.meta.url).href
const STARTUP_SOURCE_MODULE_URL = new URL('../src/personal-feed/x-startup.ts', import.meta.url).href
const STARTUP_LIB_MODULE_URL = new URL('../lib/types/personal-feed/x-startup.js', import.meta.url).href
const CONFIG_MODULE_URL = new URL('../src/config.ts', import.meta.url).href

function cliPathForEntry(packageEntryUrl: string): string {
  return fileURLToPath(new URL('../python/x_personal_feed_observer_cli.py', packageEntryUrl))
}

async function loadStartupModule(entry: 'source' | 'lib' = 'source'): Promise<StartupModule> {
  const moduleUrl = entry === 'source' ? STARTUP_SOURCE_MODULE_URL : STARTUP_LIB_MODULE_URL
  try {
    return await import(/* @vite-ignore */ moduleUrl) as StartupModule
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`CAPABILITY_ASSERTION: ${entry} x-startup import failed: ${detail}`)
  }
}

async function loadRootModule(entry: 'source' | 'lib'): Promise<RootModule> {
  const moduleUrl = entry === 'source' ? SOURCE_ENTRY : LIB_ENTRY
  try {
    return await import(/* @vite-ignore */ moduleUrl) as RootModule
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`CAPABILITY_ASSERTION: ${entry} package entry import failed: ${detail}`)
  }
}

async function parseRuntimeConfig(): Promise<RuntimeConfig> {
  const loaded = await import(/* @vite-ignore */ CONFIG_MODULE_URL) as {
    readonly parseXFeedRuntimeConfig?: unknown
  }
  expect(typeof loaded.parseXFeedRuntimeConfig).toBe('function')
  return (loaded.parseXFeedRuntimeConfig as (input: Readonly<Record<string, unknown>>) => RuntimeConfig)({
    dataDir: '/tmp/personal-feed-x-startup-runtime-data',
    telegramSessionId: 'startup-test-session',
    feedbackPendingTtlMs: 601_000,
    feedbackTurnTimeoutMs: 31_000,
    personalFeedDataDir: '/tmp/personal-feed-x-startup-personal-data',
  })
}

function exactFrozenShape(value: unknown, keys: readonly string[]): void {
  expect(value).toBeDefined()
  expect(value).not.toBeNull()
  expect(Object.getPrototypeOf(value as object)).toBe(Object.prototype)
  expect(Object.isFrozen(value)).toBe(true)
  expect(Reflect.ownKeys(value as object)).toEqual(keys)
  const descriptors = Object.getOwnPropertyDescriptors(value as object)
  for (const key of keys) {
    const descriptor = descriptors[key]
    expect(descriptor?.enumerable).toBe(true)
    expect(descriptor?.configurable).toBe(false)
    expect(descriptor?.writable).toBe(false)
    expect(descriptor?.get).toBeUndefined()
    expect(descriptor?.set).toBeUndefined()
  }
}

function validCompleteLine(request: Readonly<{ readonly requestId: string; readonly cutoff: string; readonly shanghaiDay: string }>): Uint8Array {
  const raw = JSON.stringify({
    schemaVersion: 1,
    kind: 'complete',
    ...request,
    startedAt: '2026-09-01T00:00:00.010Z',
    completedAt: '2026-09-01T00:00:00.020Z',
    surfaces: [
      { kind: 'natural_zero', surface: 'for_you', surfaceOrdinal: 0, startedAt: '2026-09-01T00:00:00.011Z', completedAt: '2026-09-01T00:00:00.012Z', occurrences: [] },
      { kind: 'natural_zero', surface: 'following', surfaceOrdinal: 1, startedAt: '2026-09-01T00:00:00.013Z', completedAt: '2026-09-01T00:00:00.014Z', occurrences: [] },
      { kind: 'natural_zero', surface: 'explore', surfaceOrdinal: 2, startedAt: '2026-09-01T00:00:00.015Z', completedAt: '2026-09-01T00:00:00.016Z', occurrences: [] },
    ],
  }) + '\n'
  return new TextEncoder().encode(raw)
}

function validCompleteLineWithForYouCanary(
  request: Readonly<{ readonly requestId: string; readonly cutoff: string; readonly shanghaiDay: string }>,
  body: string,
): Uint8Array {
  const raw = JSON.stringify({
    schemaVersion: 1,
    kind: 'complete',
    ...request,
    startedAt: '2026-09-01T00:00:00.100Z',
    completedAt: '2026-09-01T00:00:00.900Z',
    surfaces: [
      {
        kind: 'complete',
        surface: 'for_you',
        surfaceOrdinal: 0,
        startedAt: '2026-09-01T00:00:00.200Z',
        completedAt: '2026-09-01T00:00:00.300Z',
        occurrences: [{
          sourceUrl: 'https://x.com/startup/status/101',
          body: { kind: 'sufficient', text: body },
          occurrenceOrdinal: 0,
          capturedAt: '2026-09-01T00:00:00.250Z',
          authorHandle: 'startup',
          publishedAt: '2026-09-01T00:00:00.250Z',
        }],
      },
      { kind: 'natural_zero', surface: 'following', surfaceOrdinal: 1, startedAt: '2026-09-01T00:00:00.400Z', completedAt: '2026-09-01T00:00:00.500Z', occurrences: [] },
      { kind: 'natural_zero', surface: 'explore', surfaceOrdinal: 2, startedAt: '2026-09-01T00:00:00.600Z', completedAt: '2026-09-01T00:00:00.700Z', occurrences: [] },
    ],
  }) + '\n'
  return new TextEncoder().encode(raw)
}

function expectFixedShutdownAggregate(error: unknown, forbiddenCanary?: string): void {
  expect(error).toBeInstanceOf(AggregateError)
  const aggregate = error as AggregateError
  expect(aggregate.message).toBe('Unable to shutdown personal-feed X startup')
  expect(aggregate.errors).toHaveLength(1)
  expect(aggregate.errors[0]).toBeInstanceOf(Error)
  expect((aggregate.errors[0] as Error).message).toBe('Unable to shutdown personal-feed X startup child owner')
  const visibleGraph = JSON.stringify({
    message: aggregate.message,
    errors: aggregate.errors.map(value => ({
      name: value instanceof Error ? value.name : typeof value,
      message: value instanceof Error ? value.message : String(value),
    })),
  })
  expect(visibleGraph).not.toContain('body')
  expect(visibleGraph).not.toContain(FIXED_ERROR_CANARY)
  if (forbiddenCanary !== undefined) expect(visibleGraph).not.toContain(forbiddenCanary)
  expect(visibleGraph).not.toContain('/nonexistent')
  expect(visibleGraph).not.toContain('/tmp/startup-test')
  expect(visibleGraph).not.toContain('pid')
}

function validPrimitives(nativeSpawn: NativeSpawn, scheduler = new ManualScheduler()): Primitives {
  return Object.freeze({
    nativeSpawn,
    homedir: () => '/tmp/startup-test-home',
    resolveDshHome: () => '/tmp/startup-test-dsh-home',
    nowEpochMs: () => Date.parse('2026-09-01T00:00:01.000Z'),
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
  })
}

function expectNoSensitiveDetails(error: unknown, knownMessage?: string): string {
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).not.toContain(FIXED_ERROR_CANARY)
  expect(message).not.toContain('/nonexistent')
  expect(message).not.toContain('/tmp/startup-test')
  if (knownMessage !== undefined) expect(message).toBe(knownMessage)
  return message
}

async function settleWithWatchdog<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined
  const watchdog = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`${FIXED_ERROR_CANARY}:watchdog`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, watchdog])
  } finally {
    if (handle !== undefined) clearTimeout(handle)
  }
}

function treeSnapshot(root: string): string[] {
  const output: string[] = []
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      output.push(relative)
      if (entry.isDirectory()) visit(join(directory, entry.name), relative)
    }
  }
  visit(root, '')
  return output.sort()
}

describe('Personal Feed X startup Group4/G3 runtime composition contract', () => {
  it('exposes only the frozen public startup APIs with exact arity while retaining existing root exports', async () => {
    const expectedExisting = [
      'parseXFeedRuntimeConfig', 'resolveDataDir', 'resolvePipelinePath',
      'createTrustedFactNavigation', 'installTelegramExtension', 'X_FEED_CONTRACT',
      'createXFeedCronEnvironmentProvider', 'X_CRON_AGENT_ENVIRONMENT_MARKER',
      'X_CRON_ENVIRONMENT_REQUIREMENTS',
    ]
    for (const entry of ['source', 'lib'] as const) {
      const root = await loadRootModule(entry)
      for (const key of expectedExisting) expect(typeof root[key], `${entry}:${key}`).not.toBe('undefined')
      expect(typeof root.createPersonalFeedXStartup, `${entry}:createPersonalFeedXStartup`).toBe('function')
      expect(typeof root.runPersonalFeedXStartupSelfTest, `${entry}:runPersonalFeedXStartupSelfTest`).toBe('function')
      expect((root.createPersonalFeedXStartup as Function).length).toBe(1)
      expect((root.runPersonalFeedXStartupSelfTest as Function).length).toBe(0)
      for (const forbidden of [
        'resolvePersonalFeedXStartupIdentityFromPackageEntry',
        'createPersonalFeedXStartupSpawn',
        'createPersonalFeedXStartupFromPackageEntry',
        'runPersonalFeedXStartupSelfTestFromPackageEntry',
        'createPersonalFeedXObserverChild',
        'createPersonalFeedXSurfaceObserver',
      ]) expect(Object.prototype.hasOwnProperty.call(root, forbidden), `${entry}:${forbidden}`).toBe(false)
    }

    const source = await loadRootModule('source')
    const runtimeConfig = await parseRuntimeConfig()
    const publicFactory = source.createPersonalFeedXStartup as Function
    expect(() => Reflect.apply(publicFactory, undefined, [])).toThrow()
    expect(() => Reflect.apply(publicFactory, undefined, [runtimeConfig, 'extra'])).toThrow()
    const owner = Reflect.apply(publicFactory, undefined, [runtimeConfig]) as Startup
    exactFrozenShape(owner, ['observe', 'shutdown'])
    await owner.shutdown()

    const publicSelfTest = source.runPersonalFeedXStartupSelfTest as Function
    let invalidArgsResult: unknown
    try {
      invalidArgsResult = Reflect.apply(publicSelfTest, undefined, ['extra'])
    } catch (error: unknown) {
      invalidArgsResult = Promise.reject(error)
    }
    await expect(settleWithWatchdog(Promise.resolve(invalidArgsResult))).rejects.toBeInstanceOf(Error)
  })

  it('composes source and bundled entries with exact budget, directories, child ownership, and fixed output shape', async () => {
    const loaded = await loadStartupModule()
    expect(typeof loaded.createPersonalFeedXStartupFromPackageEntry).toBe('function')
    const create = loaded.createPersonalFeedXStartupFromPackageEntry as (
      packageEntryUrl: unknown,
      runtimeConfig: unknown,
      primitives?: unknown,
    ) => Startup
    const runtimeConfig = await parseRuntimeConfig()
    exactFrozenShape(runtimeConfig, ['dataDir', 'telegramSessionId', 'feedbackPendingTtlMs', 'feedbackTurnTimeoutMs', 'personalFeedDataDir'])
    for (const entry of [SOURCE_ENTRY, LIB_ENTRY]) {
      const calls: unknown[][] = []
      const scheduler = new ManualScheduler()
      let child: FakeChild | undefined
      const spawn: NativeSpawn = (...args: unknown[]): unknown => {
        calls.push(args)
        child = new FakeChild({
          onEnd: current => queueMicrotask(() => {
            current.stdout.emit('data', validCompleteLine({ requestId: 'telegram:7:11', cutoff: '2026-09-01T00:00:00.000Z', shanghaiDay: '2026-09-01' }))
            current.emit('exit', 0, null)
            current.emit('close', 0, null)
          }),
        })
        return child
      }
      const startup = create(entry, runtimeConfig, validPrimitives(spawn, scheduler))
      try {
        exactFrozenShape(startup, ['observe', 'shutdown'])
        expect(typeof startup.observe).toBe('function')
        expect(typeof startup.shutdown).toBe('function')
        const signal = new AbortController().signal
        const observed = await settleWithWatchdog(startup.observe({
          request: Object.freeze({ requestId: 'telegram:7:11', cutoff: '2026-09-01T00:00:00.000Z', shanghaiDay: '2026-09-01' }),
          signal,
        })) as { readonly kind?: unknown; readonly window?: unknown; readonly close?: unknown }
        expect(observed.kind).toBe('complete')
        expect(typeof observed.close).toBe('function')
        expect(calls).toHaveLength(1)
        const [command, argv, options] = calls[0] ?? []
        expect(command).toBe('/usr/bin/python3')
        expect(argv).toEqual([cliPathForEntry(entry)])
        expect(options).toEqual(expect.objectContaining({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] }))
        const optionRecord = options as { readonly env?: Record<string, unknown> }
        expect(optionRecord.env).toEqual({
          HOME: '/tmp/startup-test-home',
          DSH_HOME: '/tmp/startup-test-dsh-home',
          DSH_X_FEED_DATA_DIR: runtimeConfig.dataDir,
          LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'Asia/Shanghai',
          PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8',
        })
        expect(child).toBeDefined()
        const delays = scheduler.records.map(record => record.delayMs).sort((left, right) => left - right)
        expect(delays).toEqual([TOTAL_BUDGET_MS - CLEANUP_RESERVE_MS - 1_000, TOTAL_BUDGET_MS - 1_000])
        expect((delays[1] ?? 0) - (delays[0] ?? 0)).toBe(CLEANUP_RESERVE_MS)
        await (observed.close as () => Promise<void>)()
      } finally {
        await startup.shutdown()
      }
    }
  })

  it('runs the current CLI with empty stdin in an arbitrary isolated cwd without changing its file tree', async () => {
    const root = await loadRootModule('source')
    expect(typeof root.runPersonalFeedXStartupSelfTest).toBe('function')
    const isolated = mkdtempSync(join(tmpdir(), 'personal-feed-x-startup-cwd-'))
    const previousCwd = process.cwd()
    const before = treeSnapshot(isolated)
    try {
      process.chdir(isolated)
      await expect(settleWithWatchdog((root.runPersonalFeedXStartupSelfTest as () => Promise<unknown>)(), 10_000)).resolves.toBe(SELF_TEST_RECEIPT)
      expect(treeSnapshot(isolated)).toEqual(before)
    } finally {
      process.chdir(previousCwd)
      rmSync(isolated, { recursive: true, force: true })
    }
  })

  it('settles fake-child success only on close, including exit-before-close holder behavior', async () => {
    const loaded = await loadStartupModule()
    expect(typeof loaded.runPersonalFeedXStartupSelfTestFromPackageEntry).toBe('function')
    const run = loaded.runPersonalFeedXStartupSelfTestFromPackageEntry as (packageEntryUrl: unknown, primitives?: unknown) => Promise<unknown>

    const successCalls: unknown[][] = []
    let successChild: FakeChild | undefined
    const successSpawn: NativeSpawn = (...args: unknown[]): unknown => {
      successCalls.push(args)
      successChild = new FakeChild({
        onEnd: current => queueMicrotask(() => {
          current.stdout.emit('data', new TextEncoder().encode(EXPECTED_INVALID_INPUT))
          current.emit('exit', 0, null)
          current.emit('close', 0, null)
        }),
      })
      return successChild
    }
    await expect(settleWithWatchdog(run(SOURCE_ENTRY, validPrimitives(successSpawn)))).resolves.toBe(SELF_TEST_RECEIPT)
    expect(successCalls).toHaveLength(1)
    expect(successCalls[0]?.[0]).toBe('/usr/bin/python3')
    expect(successCalls[0]?.[1]).toEqual([cliPathForEntry(SOURCE_ENTRY)])
    expect(successCalls[0]?.[2]).toEqual(expect.objectContaining({
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        HOME: SELF_TEST_HOME,
        DSH_HOME: SELF_TEST_DSH_HOME,
        DSH_X_FEED_DATA_DIR: SELF_TEST_DATA_DIR,
        LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'Asia/Shanghai',
        PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8',
      },
    }))
    expect(successChild?.stdin.endCalls[0]?.slice(0, 2)).toEqual(['', 'utf8'])
    expect(successChild?.signals).toEqual([])

    const holderCalls: unknown[][] = []
    const holder = new FakeChild()
    const holderScheduler = new ManualScheduler()
    const holderPromise = run(SOURCE_ENTRY, validPrimitives((...args: unknown[]) => {
      holderCalls.push(args)
      return holder
    }, holderScheduler))
    let settled = false
    void holderPromise.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    holder.emit('exit', 0, null)
    await Promise.resolve()
    expect(settled).toBe(false)
    holder.stdout.emit('data', new TextEncoder().encode(EXPECTED_INVALID_INPUT))
    holder.emit('close', 0, null)
    await expect(settleWithWatchdog(holderPromise)).resolves.toBe(SELF_TEST_RECEIPT)
    expect(holder.signals).toEqual([])
    expect(holderCalls).toHaveLength(1)
  })

  it('maps output, protocol, stdio, exit, spawn, and listener failures to one fixed body-free rejection', async () => {
    const loaded = await loadStartupModule()
    expect(typeof loaded.runPersonalFeedXStartupSelfTestFromPackageEntry).toBe('function')
    const run = loaded.runPersonalFeedXStartupSelfTestFromPackageEntry as (packageEntryUrl: unknown, primitives?: unknown) => Promise<unknown>
    const scenarios: Array<Readonly<{ readonly label: string; readonly spawn: (calls: unknown[][], scheduler: ManualScheduler) => NativeSpawn }>> = [
      { label: 'spawn throw', spawn: () => () => { throw new Error(FIXED_ERROR_CANARY) } },
      { label: 'spawn undefined', spawn: () => () => undefined },
      { label: 'stdin failure', spawn: (calls) => (...args) => { calls.push(args); return new FakeChild({ stdinError: new Error(FIXED_ERROR_CANARY) }) } },
      { label: 'stdout wrong', spawn: (calls) => (...args) => { calls.push(args); return new FakeChild({ onEnd: child => queueMicrotask(() => { child.stdout.emit('data', new TextEncoder().encode('wrong\n')); child.emit('close', 0, null) }) }) } },
      { label: 'stdout extra', spawn: (calls) => (...args) => { calls.push(args); return new FakeChild({ onEnd: child => queueMicrotask(() => { child.stdout.emit('data', new TextEncoder().encode(`${EXPECTED_INVALID_INPUT}x`)); child.emit('close', 0, null) }) }) } },
      { label: 'stdout overflow', spawn: (calls) => (...args) => { calls.push(args); return new FakeChild({ onEnd: child => queueMicrotask(() => { const bytes = new Uint8Array(new TextEncoder().encode(EXPECTED_INVALID_INPUT).length + 1); bytes.set(new TextEncoder().encode(EXPECTED_INVALID_INPUT)); child.stdout.emit('data', bytes); child.emit('close', 0, null) }) }) } },
      { label: 'stdout non-byte', spawn: (calls) => (...args) => { calls.push(args); return new FakeChild({ onEnd: child => queueMicrotask(() => { child.stdout.emit('data', new DataView(new ArrayBuffer(1))); child.emit('close', 0, null) }) }) } },
      { label: 'stderr byte', spawn: (calls) => (...args) => { calls.push(args); return new FakeChild({ onEnd: child => queueMicrotask(() => { child.stderr.emit('data', new Uint8Array([1])); child.emit('close', 0, null) }) }) } },
      { label: 'stream error', spawn: (calls) => (...args) => { calls.push(args); return new FakeChild({ onEnd: child => queueMicrotask(() => { child.stdout.emit('error', new Error(FIXED_ERROR_CANARY)); child.emit('close', 0, null) }) }) } },
      { label: 'child error', spawn: (calls) => (...args) => { calls.push(args); return new FakeChild({ onEnd: child => queueMicrotask(() => { child.emit('error', new Error(FIXED_ERROR_CANARY)); child.emit('close', 0, null) }) }) } },
      { label: 'stderr stream error', spawn: (calls) => (...args) => { calls.push(args); return new FakeChild({ onEnd: child => queueMicrotask(() => { child.stderr.emit('error', new Error(FIXED_ERROR_CANARY)); child.emit('close', 0, null) }) }) } },
      { label: 'nonzero close', spawn: (calls) => (...args) => { calls.push(args); return new FakeChild({ onEnd: child => queueMicrotask(() => child.emit('close', 1, null)) }) } },
      { label: 'signal close', spawn: (calls) => (...args) => { calls.push(args); return new FakeChild({ onEnd: child => queueMicrotask(() => child.emit('close', null, 'SIGTERM')) }) } },
      { label: 'tuple conflict', spawn: (calls) => (...args) => { calls.push(args); return new FakeChild({ onEnd: child => queueMicrotask(() => child.emit('close', 0, 'SIGTERM')) }) } },
      { label: 'malformed close', spawn: (calls) => (...args) => { calls.push(args); return new FakeChild({ onEnd: child => queueMicrotask(() => child.emit('close', '0', null)) }) } },
      { label: 'child listener failure', spawn: (calls) => (...args) => { calls.push(args); return new FakeChild({ throwOnChildOn: 'close', onEnd: child => queueMicrotask(() => child.emit('close', 1, null)) }) } },
      { label: 'stdout listener failure', spawn: (calls) => (...args) => { calls.push(args); return new FakeChild({ throwOnStdoutOn: 'data', kill: child => queueMicrotask(() => child.emit('close', 1, null)) }) } },
    ]
    let fixedMessage: string | undefined
    for (const scenario of scenarios) {
      const calls: unknown[][] = []
      const scheduler = new ManualScheduler()
      let thrown: unknown
      let child: FakeChild | undefined
      try {
        const scenarioSpawn = scenario.spawn(calls, scheduler)
        const spawn: NativeSpawn = (...args: unknown[]): unknown => {
          const result = scenarioSpawn(...args)
          if (result instanceof FakeChild) child = result
          return result
        }
        const promise = run(SOURCE_ENTRY, validPrimitives(spawn, scheduler))
        if (child !== undefined && scenario.label === 'stdin failure') {
          queueMicrotask(() => child?.emit('close', 1, null))
        }
        await settleWithWatchdog(promise)
      } catch (error: unknown) {
        thrown = error
      }
      const message = expectNoSensitiveDetails(thrown, fixedMessage)
      fixedMessage ??= message
      expect(calls.length, scenario.label).toBeLessThanOrEqual(1)
    }
    expect(fixedMessage).toBeTypeOf('string')

    const timerCalls: unknown[][] = []
    const timerChild = new FakeChild()
    const timerSpawn = (...args: unknown[]): unknown => {
      timerCalls.push(args)
      return timerChild
    }
    const timerPrimitives = validPrimitives(timerSpawn)
    const throwingTimerPrimitives = Object.freeze({
      ...timerPrimitives,
      setTimeout: () => { throw new Error(FIXED_ERROR_CANARY) },
    })
    let timerThrown: unknown
    try {
      const timerPromise = run(SOURCE_ENTRY, throwingTimerPrimitives)
      queueMicrotask(() => timerChild.emit('close', 1, null))
      await settleWithWatchdog(timerPromise)
    } catch (error: unknown) {
      timerThrown = error
    }
    expectNoSensitiveDetails(timerThrown, fixedMessage)
    expect(timerCalls).toHaveLength(1)
  })

  it('enforces timeout TERM/KILL, synchronous-exit no-KILL, invalid-pid no-signal, and one late-event settlement', async () => {
    const loaded = await loadStartupModule()
    expect(typeof loaded.runPersonalFeedXStartupSelfTestFromPackageEntry).toBe('function')
    const run = loaded.runPersonalFeedXStartupSelfTestFromPackageEntry as (packageEntryUrl: unknown, primitives?: unknown) => Promise<unknown>

    const timeoutScheduler = new ManualScheduler()
    const timeoutChild = new FakeChild()
    const timeoutPromise = run(SOURCE_ENTRY, validPrimitives((..._args: unknown[]) => timeoutChild, timeoutScheduler))
    expect(timeoutScheduler.records.map(record => record.delayMs)).toEqual([SELF_TEST_TIMEOUT_MS])
    timeoutScheduler.fireNext()
    expect(timeoutChild.signals).toEqual(['SIGTERM'])
    expect(timeoutScheduler.records.map(record => record.delayMs)).toEqual([SELF_TEST_TIMEOUT_MS, KILL_GRACE_MS])
    timeoutScheduler.fireNext()
    expect(timeoutChild.signals).toEqual(['SIGTERM', 'SIGKILL'])
    timeoutChild.emit('close', 1, null)
    await expect(timeoutPromise).rejects.toThrow()

    const syncScheduler = new ManualScheduler()
    const syncChild = new FakeChild({ kill: child => child.emit('exit', null, 'SIGTERM') })
    const syncPromise = run(SOURCE_ENTRY, validPrimitives((..._args: unknown[]) => syncChild, syncScheduler))
    syncScheduler.fireNext()
    expect(syncChild.signals).toEqual(['SIGTERM'])
    syncScheduler.fireAll()
    expect(syncChild.signals).toEqual(['SIGTERM'])
    syncChild.emit('close', null, 'SIGTERM')
    await expect(syncPromise).rejects.toThrow()

    for (const pid of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Symbol('pid')] as unknown[]) {
      const invalidChild = new FakeChild()
      Object.defineProperty(invalidChild, 'pid', { configurable: true, enumerable: true, value: pid, writable: true })
      const invalidPromise = run(SOURCE_ENTRY, validPrimitives((..._args: unknown[]) => invalidChild))
      invalidChild.emit('close', 1, null)
      await expect(settleWithWatchdog(invalidPromise)).rejects.toThrow()
      expect(invalidChild.signals).toEqual([])
    }

    const lateChild = new FakeChild({ onEnd: child => queueMicrotask(() => {
      child.stdout.emit('data', new TextEncoder().encode(EXPECTED_INVALID_INPUT))
      child.emit('close', 0, null)
      child.emit('error', new Error(FIXED_ERROR_CANARY))
      child.stdout.emit('data', new TextEncoder().encode('late'))
      child.emit('close', 1, null)
    }) })
    const latePromise = run(SOURCE_ENTRY, validPrimitives((..._args: unknown[]) => lateChild))
    await expect(settleWithWatchdog(latePromise)).resolves.toBe(SELF_TEST_RECEIPT)
    expect(lateChild.signals).toEqual([])
  })

  it('keeps private FromPackageEntry seams private and rejects malicious runtimeConfig and primitive shapes without spawning', async () => {
    const loaded = await loadStartupModule()
    expect(typeof loaded.createPersonalFeedXStartupFromPackageEntry).toBe('function')
    expect(typeof loaded.runPersonalFeedXStartupSelfTestFromPackageEntry).toBe('function')
    const create = loaded.createPersonalFeedXStartupFromPackageEntry as (entry: unknown, config: unknown, primitives?: unknown) => unknown
    const run = loaded.runPersonalFeedXStartupSelfTestFromPackageEntry as (entry: unknown, primitives?: unknown) => Promise<unknown>
    const validConfig = await parseRuntimeConfig()
    const calls: unknown[][] = []
    const primitives = validPrimitives((...args: unknown[]) => { calls.push(args); return new FakeChild() })
    const configCases: Array<Readonly<{ readonly label: string; readonly value: unknown; readonly reads?: () => number }>> = [
      { label: 'extra', value: Object.freeze({ ...validConfig, extra: 'x' }) },
      { label: 'mutable', value: { ...validConfig } },
      { label: 'symbol', value: Object.freeze({ ...validConfig, [Symbol('canary')]: 'x' }) },
      { label: 'proxy', value: new Proxy(validConfig, { ownKeys: () => { throw new Error(FIXED_ERROR_CANARY) } }) },
      { label: 'dataDir relative', value: Object.freeze({ ...validConfig, dataDir: 'relative/data' }) },
      { label: 'dataDir NUL', value: Object.freeze({ ...validConfig, dataDir: '/tmp/data\u0000canary' }) },
    ]
    let getterReads = 0
    const getterConfig = { ...validConfig }
    Object.defineProperty(getterConfig, 'dataDir', { configurable: true, enumerable: true, get: () => { getterReads += 1; return validConfig.dataDir } })
    configCases.push({ label: 'getter', value: getterConfig, reads: () => getterReads })
    for (const current of configCases) {
      expect(() => create(SOURCE_ENTRY, current.value, primitives), current.label).toThrow()
      expect(current.reads?.() ?? 0, current.label).toBe(0)
      expect(calls, current.label).toHaveLength(0)
    }

    const personalFeedDataDirCases = [
      { label: 'personalFeedDataDir empty', value: '' },
      { label: 'personalFeedDataDir relative', value: 'personal-data' },
      { label: 'personalFeedDataDir dot segment', value: '/tmp/./personal-data' },
      { label: 'personalFeedDataDir parent segment', value: '/tmp/a/../personal-data' },
      { label: 'personalFeedDataDir duplicate separator', value: '/tmp//personal-data' },
      { label: 'personalFeedDataDir NUL', value: '/tmp/personal-data\u0000canary' },
    ] as const
    for (const current of personalFeedDataDirCases) {
      const config = Object.freeze({ ...validConfig, personalFeedDataDir: current.value })
      exactFrozenShape(config, ['dataDir', 'telegramSessionId', 'feedbackPendingTtlMs', 'feedbackTurnTimeoutMs', 'personalFeedDataDir'])
      let thrown: unknown
      try {
        create(SOURCE_ENTRY, config, primitives)
      } catch (error: unknown) {
        thrown = error
      }
      expect(thrown, current.label).toBeInstanceOf(Error)
      expect((thrown as Error | undefined)?.message, current.label).toBe('Unable to create personal-feed X startup')
      expect(calls, current.label).toHaveLength(0)
    }

    for (const personalFeedDataDir of ['/tmp/personal-data', '/tmp/personal-data/'] as const) {
      const normalizedConfig = Object.freeze({ ...validConfig, personalFeedDataDir })
      exactFrozenShape(normalizedConfig, ['dataDir', 'telegramSessionId', 'feedbackPendingTtlMs', 'feedbackTurnTimeoutMs', 'personalFeedDataDir'])
      expect(() => create(SOURCE_ENTRY, normalizedConfig, primitives)).not.toThrow()
      expect(calls).toHaveLength(0)
    }

    const primitiveCases: unknown[] = [
      { ...primitives, extra: true },
      { ...primitives },
      Object.freeze({ ...primitives, [Symbol('primitive-canary')]: true }),
      new Proxy(primitives, { ownKeys: () => { throw new Error(FIXED_ERROR_CANARY) } }),
    ]
    let primitiveGetterReads = 0
    const primitiveGetter = { ...primitives }
    Object.defineProperty(primitiveGetter, 'nativeSpawn', { configurable: true, enumerable: true, get: () => { primitiveGetterReads += 1; return primitives.nativeSpawn } })
    primitiveCases.push(primitiveGetter)
    for (const malicious of primitiveCases) {
      expect(() => create(SOURCE_ENTRY, validConfig, malicious), 'primitive shape').toThrow()
      expect(calls).toHaveLength(0)
    }
    expect(primitiveGetterReads).toBe(0)

    const invalidSelfTestPrimitives = Object.freeze({ ...primitives, nativeSpawn: undefined })
    let thrown: unknown
    try {
      await run(SOURCE_ENTRY, invalidSelfTestPrimitives)
    } catch (error: unknown) {
      thrown = error
    }
    expectNoSensitiveDetails(thrown)
    expect(calls).toHaveLength(0)
  })

  it('package shutdown joins child ownership after surface drain', async () => {
    const runtimeConfig = await parseRuntimeConfig()
    const request = Object.freeze({ requestId: 'telegram:7:11', cutoff: '2026-09-01T00:00:00.000Z', shanghaiDay: '2026-09-01' })
    for (const entry of ['source', 'lib'] as const) {
      const loaded = await loadStartupModule(entry)
      expect(typeof loaded.createPersonalFeedXStartupFromPackageEntry).toBe('function')
      const create = loaded.createPersonalFeedXStartupFromPackageEntry as (
        packageEntryUrl: unknown,
        config: unknown,
        primitives?: unknown,
      ) => Startup

      let startup: Startup | undefined
      let child: FakeChild | undefined
      let shutdownPromise: Promise<void> | undefined
      try {
        const calls: unknown[][] = []
        const scheduler = new ManualScheduler()
        const spawn: NativeSpawn = (...args: unknown[]): unknown => {
          calls.push(args)
          child = new FakeChild({
            onEnd: current => queueMicrotask(() => {
              current.stdout.emit('data', validCompleteLine(request))
              current.emit('exit', 0, null)
              current.emit('close', 0, null)
            }),
          })
          return child
        }
        startup = create(entry === 'source' ? SOURCE_ENTRY : LIB_ENTRY, runtimeConfig, validPrimitives(spawn, scheduler))
        const observed = await settleWithWatchdog(startup.observe({ request, signal: new AbortController().signal })) as {
          readonly kind?: unknown
          readonly close?: () => Promise<void>
        }
        expect(observed.kind).toBe('complete')
        expect(typeof observed.close).toBe('function')
        await observed.close?.()
        shutdownPromise = startup.shutdown()
        expect(startup.shutdown()).toBe(shutdownPromise)
        await settleWithWatchdog(shutdownPromise)
        expect(child?.signals).toEqual([])
        const afterShutdown = await settleWithWatchdog(startup.observe({ request, signal: new AbortController().signal }))
        expect(afterShutdown).toEqual(Object.freeze({ kind: 'incomplete' }))
        expect(Reflect.ownKeys(afterShutdown as object)).toEqual(['kind'])
        expect(calls).toHaveLength(1)
      } finally {
        child?.emit('exit', 0, null)
        if (child !== undefined && child.listenerCount('error') > 0) child.emit('error', new Error(FIXED_ERROR_CANARY))
        child?.emit('close', 0, null)
        if (shutdownPromise !== undefined) await shutdownPromise.catch(() => undefined)
        else if (startup !== undefined) await startup.shutdown().catch(() => undefined)
      }

      const hardCalls: unknown[][] = []
      const hardScheduler = new ManualScheduler()
      const hardChild = new FakeChild()
      const hardSpawn: NativeSpawn = (...args: unknown[]): unknown => {
        hardCalls.push(args)
        return hardChild
      }
      const hardStartup = create(entry === 'source' ? SOURCE_ENTRY : LIB_ENTRY, runtimeConfig, validPrimitives(hardSpawn, hardScheduler))
      let hardShutdown: Promise<void> | undefined
      try {
        const hardObserve = hardStartup.observe({ request, signal: new AbortController().signal })
        await Promise.resolve()
        expect(hardCalls).toHaveLength(1)
        hardScheduler.fireDelay(TOTAL_BUDGET_MS - CLEANUP_RESERVE_MS - 1_000)
        expect(hardChild.signals).toEqual(['SIGTERM'])
        hardScheduler.fireDelay(KILL_GRACE_MS)
        expect(hardChild.signals).toEqual(['SIGTERM', 'SIGKILL'])
        hardScheduler.fireDelay(TOTAL_BUDGET_MS - 1_000)
        expect(hardChild.signals).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
        const hardResult = await settleWithWatchdog(hardObserve)
        expect(hardResult).toEqual(Object.freeze({ kind: 'incomplete' }))
        expect(Reflect.ownKeys(hardResult as object)).toEqual(['kind'])

        hardShutdown = hardStartup.shutdown()
        expect(hardStartup.shutdown()).toBe(hardShutdown)
        let shutdownError: unknown
        try {
          await settleWithWatchdog(hardShutdown)
        } catch (error: unknown) {
          shutdownError = error
        }
        expectFixedShutdownAggregate(shutdownError)

        hardChild.emit('exit', 0, null)
        hardChild.emit('error', new Error(FIXED_ERROR_CANARY))
        hardChild.emit('close', 0, null)
        expect(hardStartup.shutdown()).toBe(hardShutdown)
        let lateShutdownError: unknown
        try {
          await settleWithWatchdog(hardShutdown)
        } catch (error: unknown) {
          lateShutdownError = error
        }
        expectFixedShutdownAggregate(lateShutdownError)
        const afterShutdown = await settleWithWatchdog(hardStartup.observe({ request, signal: new AbortController().signal }))
        expect(afterShutdown).toEqual(Object.freeze({ kind: 'incomplete' }))
        expect(Reflect.ownKeys(afterShutdown as object)).toEqual(['kind'])
        expect(hardCalls).toHaveLength(1)
      } finally {
        hardChild.emit('exit', 0, null)
        if (hardChild.listenerCount('error') > 0) hardChild.emit('error', new Error(FIXED_ERROR_CANARY))
        hardChild.emit('close', 0, null)
        if (hardShutdown !== undefined) await hardShutdown.catch(() => undefined)
        else await hardStartup.shutdown().catch(() => undefined)
      }
    }
  })

  it('shutdown synchronously seals captures, then joins the still-active child', async () => {
    const runtimeConfig = await parseRuntimeConfig()
    const request = Object.freeze({ requestId: 'telegram:7:11', cutoff: '2026-09-01T00:00:00.000Z', shanghaiDay: '2026-09-01' })
    const canary = 'PERSONAL_FEED_X_STARTUP_CAPTURE_CANARY'
    for (const entry of ['source', 'lib'] as const) {
      const loaded = await loadStartupModule(entry)
      expect(typeof loaded.createPersonalFeedXStartupFromPackageEntry).toBe('function')
      const create = loaded.createPersonalFeedXStartupFromPackageEntry as (
        packageEntryUrl: unknown,
        config: unknown,
        primitives?: unknown,
      ) => Startup
      const calls: unknown[][] = []
      const scheduler = new ManualScheduler()
      const children: FakeChild[] = []
      const spawn: NativeSpawn = (...args: unknown[]): unknown => {
        calls.push(args)
        const child = children.length === 0
          ? new FakeChild({
            onEnd: current => queueMicrotask(() => {
              current.stdout.emit('data', validCompleteLineWithForYouCanary(request, canary))
              current.emit('exit', 0, null)
              current.emit('close', 0, null)
            }),
          })
          : new FakeChild()
        children.push(child)
        return child
      }
      const startup = create(entry === 'source' ? SOURCE_ENTRY : LIB_ENTRY, runtimeConfig, validPrimitives(spawn, scheduler))
      let capture: { readonly take: (input: unknown) => unknown; readonly close: () => Promise<void> } | undefined
      let shutdownPromise: Promise<void> | undefined
      try {
        const firstController = new AbortController()
        const first = await settleWithWatchdog(startup.observe({ request, signal: firstController.signal })) as {
          readonly kind?: unknown
          readonly window?: unknown
        }
        expect(first.kind).toBe('complete')
        const firstWindow = first.window as { readonly surfaces: readonly unknown[] }
        const firstSurface = firstWindow.surfaces[0] as { readonly occurrences: readonly unknown[] }
        const firstOccurrence = firstSurface.occurrences[0] as { readonly body: { readonly kind?: unknown; readonly capture?: unknown } }
        expect(firstOccurrence.body.kind).toBe('sufficient')
        capture = firstOccurrence.body.capture as typeof capture
        expect(typeof capture?.take).toBe('function')
        expect(typeof capture?.close).toBe('function')

        const secondObserve = startup.observe({ request, signal: new AbortController().signal })
        await Promise.resolve()
        expect(calls).toHaveLength(2)
        shutdownPromise = startup.shutdown()
        expect(startup.shutdown()).toBe(shutdownPromise)
        expect(await capture!.take({ signal: firstController.signal })).toBeUndefined()
        const third = await settleWithWatchdog(startup.observe({ request, signal: new AbortController().signal }))
        expect(third).toEqual(Object.freeze({ kind: 'incomplete' }))
        expect(Reflect.ownKeys(third as object)).toEqual(['kind'])
        expect(calls).toHaveLength(2)
        let shutdownSettled = false
        void shutdownPromise.then(() => { shutdownSettled = true }, () => { shutdownSettled = true })
        await Promise.resolve()
        expect(shutdownSettled).toBe(false)

        expect(children[1]).toBeDefined()
        scheduler.fireDelay(TOTAL_BUDGET_MS - CLEANUP_RESERVE_MS - 1_000)
        expect(children[1]?.signals).toEqual(['SIGTERM'])
        scheduler.fireDelay(KILL_GRACE_MS)
        expect(children[1]?.signals).toEqual(['SIGTERM', 'SIGKILL'])
        scheduler.fireDelay(TOTAL_BUDGET_MS - 1_000)
        expect(children[1]?.signals).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
        const second = await settleWithWatchdog(secondObserve)
        expect(second).toEqual(Object.freeze({ kind: 'incomplete' }))
        expect(Reflect.ownKeys(second as object)).toEqual(['kind'])

        let shutdownError: unknown
        try {
          await settleWithWatchdog(shutdownPromise)
        } catch (error: unknown) {
          shutdownError = error
        }
        expectFixedShutdownAggregate(shutdownError, canary)
        children[1]?.emit('exit', 0, null)
        children[1]?.emit('error', new Error(FIXED_ERROR_CANARY))
        children[1]?.emit('close', 0, null)
        expect(startup.shutdown()).toBe(shutdownPromise)
        let lateShutdownError: unknown
        try {
          await settleWithWatchdog(shutdownPromise)
        } catch (error: unknown) {
          lateShutdownError = error
        }
        expectFixedShutdownAggregate(lateShutdownError, canary)
      } finally {
        if (capture !== undefined) await capture.close().catch(() => undefined)
        for (const child of children) {
          child.emit('exit', 0, null)
          if (child.listenerCount('error') > 0) child.emit('error', new Error(FIXED_ERROR_CANARY))
          child.emit('close', 0, null)
        }
        if (shutdownPromise !== undefined) await shutdownPromise.catch(() => undefined)
        else await startup.shutdown().catch(() => undefined)
      }
    }
  })
})
