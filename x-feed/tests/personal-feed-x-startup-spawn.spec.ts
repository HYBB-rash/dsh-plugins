import { describe, expect, it } from 'vitest'

const STARTUP_SPAWN_ERROR = 'Unable to create personal-feed X startup spawn'
const ENV_KEYS = Object.freeze([
  'HOME',
  'DSH_HOME',
  'DSH_X_FEED_DATA_DIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'PYTHONDONTWRITEBYTECODE',
  'PYTHONNOUSERSITE',
  'PYTHONIOENCODING',
] as const)
const CANARY_KEYS = Object.freeze([
  'PATH',
  'PYTHONPATH',
  'PYTHONHOME',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'DSH_X_FEED_TOKEN',
  'API_TOKEN',
  'TOKEN',
  'CREDENTIALS',
  'AUTH_TOKEN',
  'CDP_ENDPOINT',
  'DISPLAY',
  'XAUTHORITY',
  'TELEGRAM_BOT_TOKEN',
  'X_FEED_UNKNOWN_CANARY',
] as const)
const FIXED_ENV_VALUES = Object.freeze({
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'Asia/Shanghai',
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONNOUSERSITE: '1',
  PYTHONIOENCODING: 'utf-8',
})
const NATIVE_RETURN = Object.freeze({ kind: 'native-return' })

type StartupIdentity = Readonly<{
  readonly packageRoot: string
  readonly pythonFile: string
  readonly observerCliPath: string
}>

type StartupDirectories = Readonly<{
  readonly home: string
  readonly dshHome: string
  readonly dataDir: string
}>

type SpawnWrapper = (...args: unknown[]) => unknown
type StartupFactory = (
  identity: unknown,
  directories: unknown,
  nativeSpawn: unknown,
) => SpawnWrapper

type StartupModule = Readonly<{
  readonly createPersonalFeedXStartupSpawn?: unknown
}>

type LoadedFactory =
  | Readonly<{ readonly kind: 'available'; readonly create: StartupFactory }>
  | Readonly<{ readonly kind: 'unavailable'; readonly message: string }>

type Fixture = Readonly<{
  readonly style: 'production' | 'self-test'
  readonly identity: StartupIdentity
  readonly directories: StartupDirectories
}>

type NativeCall = readonly [unknown, unknown, unknown]

async function loadFactory(): Promise<LoadedFactory> {
  const moduleUrl = new URL('../src/personal-feed/x-startup.ts', import.meta.url).href
  try {
    const loaded = await import(/* @vite-ignore */ moduleUrl) as StartupModule
    if (typeof loaded.createPersonalFeedXStartupSpawn !== 'function') {
      return Object.freeze({
        kind: 'unavailable' as const,
        message: 'CAPABILITY_ASSERTION: x-startup.ts does not export createPersonalFeedXStartupSpawn',
      })
    }
    return Object.freeze({
      kind: 'available' as const,
      create: loaded.createPersonalFeedXStartupSpawn as StartupFactory,
    })
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return Object.freeze({
      kind: 'unavailable' as const,
      message: `CAPABILITY_ASSERTION: x-startup.ts could not be imported: ${detail}`,
    })
  }
}

function requireFactory(loaded: LoadedFactory): StartupFactory | undefined {
  expect(loaded.kind, loaded.kind === 'unavailable' ? loaded.message : undefined).toBe('available')
  return loaded.kind === 'available' ? loaded.create : undefined
}

function fixture(style: Fixture['style']): Fixture {
  const root = style === 'production'
    ? '/var/lib/dsh/x-feed-production'
    : '/tmp/dsh-x-feed-self-test'
  return Object.freeze({
    style,
    identity: Object.freeze({
      packageRoot: `${root}/package`,
      pythonFile: '/usr/bin/python3',
      observerCliPath: `${root}/package/python/x_personal_feed_observer_cli.py`,
    }),
    directories: Object.freeze({
      home: `${root}/home`,
      dshHome: `${root}/dsh-home`,
      dataDir: `${root}/data`,
    }),
  })
}

function expectExactFrozenShape(value: unknown, keys: readonly string[]): void {
  expect(typeof value).toBe('object')
  expect(value).not.toBeNull()
  expect(Object.getPrototypeOf(value as object)).toBe(Object.prototype)
  expect(Object.isFrozen(value)).toBe(true)
  expect(Reflect.ownKeys(value as object)).toEqual(keys)
  const descriptors = Object.getOwnPropertyDescriptors(value as object)
  for (const key of keys) {
    const descriptor = descriptors[key]
    expect(descriptor).toBeDefined()
    expect(descriptor?.enumerable).toBe(true)
    expect(descriptor?.configurable).toBe(false)
    expect(descriptor?.writable).toBe(false)
    expect(descriptor?.get).toBeUndefined()
    expect(descriptor?.set).toBeUndefined()
  }
}

function expectExactCallerOptions(value: unknown): void {
  expect(Object.getPrototypeOf(value as object)).toBe(Object.prototype)
  expect(Reflect.ownKeys(value as object)).toEqual(['shell', 'stdio'])
  const descriptors = Object.getOwnPropertyDescriptors(value as object)
  for (const key of ['shell', 'stdio'] as const) {
    const descriptor = descriptors[key]
    expect(descriptor).toBeDefined()
    expect(descriptor?.enumerable).toBe(true)
    expect(descriptor?.configurable).toBe(true)
    expect(descriptor?.writable).toBe(true)
    expect(descriptor?.get).toBeUndefined()
    expect(descriptor?.set).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(descriptor, 'value')).toBe(true)
  }
  expect(descriptors.shell?.value).toBe(false)
  expect(descriptors.stdio?.value).toEqual(['pipe', 'pipe', 'pipe'])
}

function expectExactOptions(value: unknown, expectedEnv: unknown, expectedStdio: unknown): void {
  expect(typeof value).toBe('object')
  expect(value).not.toBeNull()
  expect(Object.getPrototypeOf(value as object)).toBe(Object.prototype)
  expect(Reflect.ownKeys(value as object)).toEqual(['shell', 'stdio', 'env'])
  const descriptors = Object.getOwnPropertyDescriptors(value as object)
  for (const key of ['shell', 'stdio', 'env'] as const) {
    const descriptor = descriptors[key]
    expect(descriptor).toBeDefined()
    expect(descriptor?.enumerable).toBe(true)
    expect(descriptor?.configurable).toBe(true)
    expect(descriptor?.writable).toBe(true)
    expect(descriptor?.get).toBeUndefined()
    expect(descriptor?.set).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(descriptor, 'value')).toBe(true)
  }
  expect(descriptors.shell?.value).toBe(false)
  const stdio = descriptors.stdio?.value
  expect(Array.isArray(stdio)).toBe(true)
  expect(stdio).toEqual(['pipe', 'pipe', 'pipe'])
  expect(stdio).not.toBe(expectedStdio)
  expect(descriptors.env?.value).toBe(expectedEnv)
}

function expectAbsoluteNonEmptyNulFree(value: unknown): void {
  expect(typeof value).toBe('string')
  expect((value as string).length).toBeGreaterThan(0)
  expect((value as string).startsWith('/')).toBe(true)
  expect((value as string).includes('\u0000')).toBe(false)
}

function expectExactEnvironment(value: unknown, directories: StartupDirectories): void {
  expect(typeof value).toBe('object')
  expect(value).not.toBeNull()
  expect(Object.getPrototypeOf(value)).toBeNull()
  expect(Object.isFrozen(value)).toBe(true)
  expect(Reflect.ownKeys(value as object)).toEqual(ENV_KEYS)

  const expectedValues: Record<string, string> = {
    HOME: directories.home,
    DSH_HOME: directories.dshHome,
    DSH_X_FEED_DATA_DIR: directories.dataDir,
    ...FIXED_ENV_VALUES,
  }
  const descriptors = Object.getOwnPropertyDescriptors(value as object)
  for (const key of ENV_KEYS) {
    const descriptor = descriptors[key]
    expect(descriptor).toBeDefined()
    expect(descriptor?.enumerable).toBe(true)
    expect(descriptor?.configurable).toBe(false)
    expect(descriptor?.writable).toBe(false)
    expect(descriptor?.get).toBeUndefined()
    expect(descriptor?.set).toBeUndefined()
    expect(descriptor?.value).toBe(expectedValues[key])
    expect(typeof descriptor?.value).toBe('string')
  }
}

function expectFixedError(action: () => unknown): void {
  let thrown: unknown
  try {
    action()
  } catch (error: unknown) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error | undefined)?.message).toBe(STARTUP_SPAWN_ERROR)
  expect((thrown as Error | undefined)?.message).not.toContain('CANARY')
  expect((thrown as Error | undefined)?.message).not.toContain('/var/lib')
  expect((thrown as Error | undefined)?.message).not.toContain('/tmp/')
}

function withEnvironmentCanaries<T>(suffix: string, action: () => T): T {
  const previous = new Map<string, string | undefined>()
  for (const key of CANARY_KEYS) previous.set(key, process.env[key])
  try {
    for (const key of CANARY_KEYS) process.env[key] = `X_FEED_SPAWN_CANARY_${suffix}`
    return action()
  } finally {
    for (const key of CANARY_KEYS) {
      const oldValue = previous.get(key)
      if (oldValue === undefined) delete process.env[key]
      else process.env[key] = oldValue
    }
  }
}

function exactCallerOptions(stdio: unknown[] = ['pipe', 'pipe', 'pipe']): Record<string, unknown> {
  return { shell: false, stdio }
}

function validNativeRecorder(calls: NativeCall[]): (...args: unknown[]) => unknown {
  return (...args: unknown[]): unknown => {
    expect(args).toHaveLength(3)
    calls.push(args as NativeCall)
    return NATIVE_RETURN
  }
}

function accessorObject<T extends object>(value: T, onGet: () => void): T {
  const result = {} as T
  for (const key of Reflect.ownKeys(value)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      get: () => {
        onGet()
        return (value as Record<PropertyKey, unknown>)[key]
      },
    })
  }
  return result
}

describe('Personal Feed X startup spawn Group4/G2b contract', () => {
  it('exposes the private spawn factory as a capability instead of failing during collection', async () => {
    const loaded = await loadFactory()
    expect(loaded.kind, loaded.kind === 'unavailable' ? loaded.message : undefined).toBe('available')
  })

  it('reconstructs one exact production-style and self-test-style spawn with a minimal frozen environment', async () => {
    const loaded = await loadFactory()
    const create = requireFactory(loaded)
    if (create === undefined) return

    const production = fixture('production')
    const selfTest = fixture('self-test')
    for (const key of ['home', 'dshHome', 'dataDir'] as const) {
      expect(production.directories[key]).not.toBe(selfTest.directories[key])
    }

    for (const current of [production, selfTest] as const) {
      const calls: NativeCall[] = []
      const nativeSpawn = validNativeRecorder(calls)
      const wrapper = create(current.identity, current.directories, nativeSpawn)
      expect(typeof wrapper).toBe('function')

      const suppliedCommand = current.identity.pythonFile
      const suppliedArgv = [current.identity.observerCliPath]
      const suppliedStdio = ['pipe', 'pipe', 'pipe']
      const suppliedOptions = exactCallerOptions(suppliedStdio)
      expectExactCallerOptions(suppliedOptions)
      const result = withEnvironmentCanaries(current.style, () => {
        const callResult = wrapper(suppliedCommand, suppliedArgv, suppliedOptions)
        for (const key of CANARY_KEYS) {
          expect(process.env[key]).toBe(`X_FEED_SPAWN_CANARY_${current.style}`)
        }
        return callResult
      })

      expect(result).toBe(NATIVE_RETURN)
      expect(calls).toHaveLength(1)
      const [command, argv, options] = calls[0] ?? []
      expect(command).toBe(current.identity.pythonFile)
      expect(argv).toEqual([current.identity.observerCliPath])
      expect(argv).not.toBe(suppliedArgv)
      expect(options).not.toBe(suppliedOptions)
      expect(suppliedArgv).toEqual([current.identity.observerCliPath])
      expect(suppliedOptions).toEqual({ shell: false, stdio: suppliedStdio })

      const optionDescriptors = Object.getOwnPropertyDescriptors(options as object)
      const nativeStdio = optionDescriptors.stdio?.value
      expect(nativeStdio).not.toBe(suppliedStdio)
      expectExactOptions(options, optionDescriptors.env?.value, suppliedStdio)
      expectExactEnvironment(optionDescriptors.env?.value, current.directories)
      expectExactFrozenShape(current.identity, ['packageRoot', 'pythonFile', 'observerCliPath'])
      expectExactFrozenShape(current.directories, ['home', 'dshHome', 'dataDir'])
      for (const value of [
        current.identity.packageRoot,
        current.identity.pythonFile,
        current.identity.observerCliPath,
        current.directories.home,
        current.directories.dshHome,
        current.directories.dataDir,
      ]) expectAbsoluteNonEmptyNulFree(value)
      for (const key of CANARY_KEYS) {
        expect(Reflect.ownKeys(optionDescriptors.env?.value as object)).not.toContain(key)
      }
    }
  })

  it('rejects every non-exact low-level call without reading accessors, proxy traps, or invoking native spawn', async () => {
    const loaded = await loadFactory()
    const create = requireFactory(loaded)
    if (create === undefined) return

    const current = fixture('production')
    const calls: NativeCall[] = []
    const nativeSpawn = validNativeRecorder(calls)
    const wrapper = create(current.identity, current.directories, nativeSpawn)
    const cases: Array<Readonly<{ readonly label: string; readonly args: readonly unknown[]; readonly reads: () => number }>> = []

    const addExactCase = (label: string, command: unknown, argv: unknown, options: unknown): void => {
      cases.push({ label, args: [command, argv, options], reads: () => 0 })
    }
    addExactCase('wrong command', '/usr/bin/python', [current.identity.observerCliPath], exactCallerOptions())
    addExactCase('wrong CLI', current.identity.pythonFile, ['/opt/other-observer.py'], exactCallerOptions())
    addExactCase('extra argv', current.identity.pythonFile, [current.identity.observerCliPath, '--extra'], exactCallerOptions())
    addExactCase('shell changed', current.identity.pythonFile, [current.identity.observerCliPath], { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
    addExactCase('stdio changed', current.identity.pythonFile, [current.identity.observerCliPath], { shell: false, stdio: ['pipe', 'pipe'] })
    addExactCase('extra option', current.identity.pythonFile, [current.identity.observerCliPath], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], cwd: '/tmp' })
    addExactCase('symbol command', Symbol('command'), [current.identity.observerCliPath], exactCallerOptions())
    cases.push({ label: 'extra call argument', args: [current.identity.pythonFile, [current.identity.observerCliPath], exactCallerOptions(), 'extra'], reads: () => 0 })

    let getterReads = 0
    const accessorOptions = accessorObject(exactCallerOptions(), () => { getterReads += 1 })
    cases.push({ label: 'accessor options', args: [current.identity.pythonFile, [current.identity.observerCliPath], accessorOptions], reads: () => getterReads })

    let proxyTraps = 0
    const proxyOptions = new Proxy(exactCallerOptions(), {
      get: () => { proxyTraps += 1; return undefined },
      ownKeys: () => { proxyTraps += 1; return [] },
      getOwnPropertyDescriptor: () => { proxyTraps += 1; return undefined },
    })
    cases.push({ label: 'proxy options', args: [current.identity.pythonFile, [current.identity.observerCliPath], proxyOptions], reads: () => proxyTraps })

    for (const currentCase of cases) {
      expectFixedError(() => wrapper(...currentCase.args))
      expect(currentCase.reads(), currentCase.label).toBe(0)
      expect(calls, currentCase.label).toHaveLength(0)
    }
  })

  it('rejects malformed setup values, accessors, proxies, symbols, and unsafe directory strings with one fixed error', async () => {
    const loaded = await loadFactory()
    const create = requireFactory(loaded)
    if (create === undefined) return

    const current = fixture('self-test')
    const calls: NativeCall[] = []
    const nativeSpawn = validNativeRecorder(calls)
    const cases: Array<Readonly<{ readonly label: string; readonly identity: unknown; readonly directories: unknown; readonly nativeSpawn: unknown; readonly reads: () => number }>> = []
    const validDirectories = current.directories
    const validIdentity = current.identity

    const add = (label: string, identity: unknown, directories: unknown, spawn: unknown, reads: () => number = () => 0): void => {
      cases.push({ label, identity, directories, nativeSpawn: spawn, reads })
    }
    add('identity undefined', undefined, validDirectories, nativeSpawn)
    add('identity symbol', Symbol('identity'), validDirectories, nativeSpawn)
    add('identity null', null, validDirectories, nativeSpawn)
    add('identity extra key', { ...validIdentity, extra: 'x' }, validDirectories, nativeSpawn)
    add('identity mutable', { ...validIdentity }, validDirectories, nativeSpawn)
    add('directories undefined', validIdentity, undefined, nativeSpawn)
    add('directories symbol', validIdentity, Symbol('directories'), nativeSpawn)
    add('directories null', validIdentity, null, nativeSpawn)
    add('directories extra key', validIdentity, { ...validDirectories, extra: 'x' }, nativeSpawn)
    add('directories mutable', validIdentity, { ...validDirectories }, nativeSpawn)
    add('native spawn undefined', validIdentity, validDirectories, undefined)
    add('native spawn symbol', validIdentity, validDirectories, Symbol('native-spawn'))
    add('native spawn object', validIdentity, validDirectories, {})

    let identityGetterReads = 0
    add('identity accessor', accessorObject(validIdentity, () => { identityGetterReads += 1 }), validDirectories, nativeSpawn, () => identityGetterReads)
    let directoryGetterReads = 0
    add('directories accessor', validIdentity, accessorObject(validDirectories, () => { directoryGetterReads += 1 }), nativeSpawn, () => directoryGetterReads)
    let spawnGetterReads = 0
    const spawnAccessor = accessorObject({ value: nativeSpawn }, () => { spawnGetterReads += 1 })
    add('native spawn accessor', validIdentity, validDirectories, spawnAccessor, () => spawnGetterReads)

    let identityProxyTraps = 0
    const identityProxy = new Proxy(validIdentity, {
      get: () => { identityProxyTraps += 1; return undefined },
      ownKeys: () => { identityProxyTraps += 1; return [] },
      getOwnPropertyDescriptor: () => { identityProxyTraps += 1; return undefined },
    })
    add('identity proxy', identityProxy, validDirectories, nativeSpawn, () => identityProxyTraps)
    let directoryProxyTraps = 0
    const directoryProxy = new Proxy(validDirectories, {
      get: () => { directoryProxyTraps += 1; return undefined },
      ownKeys: () => { directoryProxyTraps += 1; return [] },
      getOwnPropertyDescriptor: () => { directoryProxyTraps += 1; return undefined },
    })
    add('directories proxy', validIdentity, directoryProxy, nativeSpawn, () => directoryProxyTraps)
    let spawnProxyTraps = 0
    const spawnProxy = new Proxy(nativeSpawn, {
      apply: () => { spawnProxyTraps += 1; return undefined },
      get: () => { spawnProxyTraps += 1; return undefined },
    })
    add('native spawn proxy', validIdentity, validDirectories, spawnProxy, () => spawnProxyTraps)

    for (const key of ['packageRoot', 'pythonFile', 'observerCliPath'] as const) {
      const malformed = Object.freeze({ ...validIdentity, [key]: key === 'pythonFile' ? '/usr/bin/python3\u0000canary' : '' })
      add(`identity unsafe ${key}`, malformed, validDirectories, nativeSpawn)
    }
    for (const key of ['home', 'dshHome', 'dataDir'] as const) {
      add(`directory empty ${key}`, validIdentity, Object.freeze({ ...validDirectories, [key]: '' }), nativeSpawn)
      add(`directory relative ${key}`, validIdentity, Object.freeze({ ...validDirectories, [key]: 'relative/path' }), nativeSpawn)
      add(`directory NUL ${key}`, validIdentity, Object.freeze({ ...validDirectories, [key]: `/absolute/\u0000${key}` }), nativeSpawn)
    }

    for (const currentCase of cases) {
      expectFixedError(() => create(currentCase.identity, currentCase.directories, currentCase.nativeSpawn))
      expect(currentCase.reads(), currentCase.label).toBe(0)
      expect(calls, currentCase.label).toHaveLength(0)
    }
  })
})
