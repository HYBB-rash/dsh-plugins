import {
  accessSync as nodeAccessSync,
  constants as nodeFsConstants,
  lstatSync as nodeLstatSync,
  readFileSync as nodeReadFileSync,
  realpathSync as nodeRealpathSync,
  statSync as nodeStatSync,
} from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { homedir as nodeHomedir } from 'node:os'
import { types as nodeTypes } from 'node:util'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveDshHome as nodeResolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createPersonalFeedXObserverChildOwner } from './x-observer-child.ts'
import { createPersonalFeedXSurfaceObserver } from './x-surface-observer.ts'

const STARTUP_RESOLUTION_ERROR = 'Unable to resolve personal-feed X startup identity'
const STARTUP_SPAWN_ERROR = 'Unable to create personal-feed X startup spawn'
const STARTUP_RUNTIME_ERROR = 'Unable to create personal-feed X startup'
const STARTUP_SELF_TEST_ERROR = 'Unable to run personal-feed X startup self-test'
const STARTUP_SHUTDOWN_ERROR = 'Unable to shutdown personal-feed X startup'
const STARTUP_SURFACE_SHUTDOWN_ERROR = 'Unable to shutdown personal-feed X startup surface owner'
const STARTUP_CHILD_SHUTDOWN_ERROR = 'Unable to shutdown personal-feed X startup child owner'
const STARTUP_DATE = Date
const STARTUP_DATE_GET_TIME = STARTUP_DATE.prototype.getTime
const SELF_TEST_RECEIPT = 'personal-feed-x-startup-self-test/v1'
const SELF_TEST_OUTPUT = '{"schemaVersion":1,"kind":"invalid_input"}\n'
const SELF_TEST_HOME = '/nonexistent'
const SELF_TEST_DSH_HOME = '/nonexistent/.dsh'
const SELF_TEST_DATA_DIR = '/nonexistent/x-feed-data'
const SELF_TEST_TIMEOUT_MS = 2_000
const SELF_TEST_KILL_GRACE_MS = 500
const SELF_TEST_CONFIG_KEYS = Object.freeze([
  'dataDir',
  'telegramSessionId',
  'feedbackPendingTtlMs',
  'feedbackTurnTimeoutMs',
  'personalFeedDataDir',
] as const)
const STARTUP_PRIMITIVE_KEYS = Object.freeze([
  'nativeSpawn',
  'homedir',
  'resolveDshHome',
  'nowEpochMs',
  'setTimeout',
  'clearTimeout',
] as const)
const PACKAGE_NAME = '@herman/x-feed'
const PACKAGE_MAIN = 'lib/index.js'
const PYTHON_FILE = '/usr/bin/python3'
const SYSTEM_ROOT = '/usr/bin'
const CLI_RELATIVE_PATH = 'python/x_personal_feed_observer_cli.py'

const STARTUP_IDENTITY_KEYS = Object.freeze(['packageRoot', 'pythonFile', 'observerCliPath'] as const)
const STARTUP_DIRECTORY_KEYS = Object.freeze(['home', 'dshHome', 'dataDir'] as const)
const STARTUP_ENV_KEYS = Object.freeze([
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

const FILESYSTEM_KEYS = Object.freeze([
  'lstatSync',
  'realpathSync',
  'statSync',
  'readFileSync',
  'accessSync',
] as const)

type Filesystem = Readonly<{
  readonly lstatSync: (path: string) => unknown
  readonly realpathSync: (path: string) => string
  readonly statSync: (path: string) => unknown
  readonly readFileSync: (path: string, encoding: 'utf8') => string
  readonly accessSync: (path: string, mode: number) => void
}>

type StartupIdentity = Readonly<{
  readonly packageRoot: string
  readonly pythonFile: string
  readonly observerCliPath: string
}>

type StatMethods = Readonly<{
  readonly isSymbolicLink: () => boolean
  readonly isFile: () => boolean
  readonly isDirectory: () => boolean
}>

function fail(): never {
  throw new Error(STARTUP_RESOLUTION_ERROR)
}

function resolveFilesystem(filesystem: unknown): Filesystem {
  if (filesystem === undefined) {
    return {
      lstatSync: nodeLstatSync,
      realpathSync: nodeRealpathSync,
      statSync: nodeStatSync,
      readFileSync: nodeReadFileSync as (path: string, encoding: 'utf8') => string,
      accessSync: nodeAccessSync,
    }
  }

  if (typeof filesystem !== 'object' || filesystem === null || nodeTypes.isProxy(filesystem)) fail()
  if (Object.getPrototypeOf(filesystem) !== Object.prototype) fail()

  const keys = Reflect.ownKeys(filesystem)
  if (keys.length !== FILESYSTEM_KEYS.length || keys.some(key => typeof key !== 'string' || !FILESYSTEM_KEYS.includes(key as typeof FILESYSTEM_KEYS[number]))) {
    fail()
  }

  const descriptors = Object.getOwnPropertyDescriptors(filesystem)
  const values: Partial<Record<typeof FILESYSTEM_KEYS[number], Function>> = {}
  for (const key of FILESYSTEM_KEYS) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
      || descriptor.get !== undefined || descriptor.set !== undefined || typeof descriptor.value !== 'function') {
      fail()
    }
    if (nodeTypes.isProxy(descriptor.value)) fail()
    values[key] = descriptor.value
  }

  return {
    lstatSync: values.lstatSync as Filesystem['lstatSync'],
    realpathSync: values.realpathSync as Filesystem['realpathSync'],
    statSync: values.statSync as Filesystem['statSync'],
    readFileSync: values.readFileSync as Filesystem['readFileSync'],
    accessSync: values.accessSync as Filesystem['accessSync'],
  }
}

function statMethods(stat: unknown): StatMethods | undefined {
  if (typeof stat !== 'object' || stat === null || nodeTypes.isProxy(stat)) return undefined
  const methods: Partial<Record<'isSymbolicLink' | 'isFile' | 'isDirectory', () => boolean>> = {}
  let current: object | null = stat
  while (current !== null) {
    if (nodeTypes.isProxy(current)) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(current)
    for (const key of ['isSymbolicLink', 'isFile', 'isDirectory'] as const) {
      if (methods[key] !== undefined) continue
      const descriptor = descriptors[key]
      if (descriptor === undefined) continue
      if (!('value' in descriptor) || typeof descriptor.value !== 'function' || nodeTypes.isProxy(descriptor.value)) return undefined
      methods[key] = descriptor.value as () => boolean
    }
    current = Object.getPrototypeOf(current)
  }
  if (methods.isSymbolicLink === undefined || methods.isFile === undefined || methods.isDirectory === undefined) return undefined
  return methods as StatMethods
}

function statIs(stat: unknown, kind: 'file' | 'directory', rejectSymlink: boolean): boolean {
  const methods = statMethods(stat)
  if (methods === undefined) return false
  if (rejectSymlink && Reflect.apply(methods.isSymbolicLink, stat, []) === true) return false
  if (kind === 'file') return Reflect.apply(methods.isFile, stat, []) === true
  return Reflect.apply(methods.isDirectory, stat, []) === true
}

function hasStrictChild(root: string, child: string): boolean {
  const childRelative = relative(root, child)
  return childRelative !== '' && childRelative !== '..' && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative)
}

function gateDirectory(filesystem: Filesystem, path: string, requireLexicalCanonicalEquality = true): string {
  const lstat = filesystem.lstatSync(path)
  if (!statIs(lstat, 'directory', true)) fail()
  const canonical = filesystem.realpathSync(path)
  if (!isAbsolute(canonical) || normalize(canonical) !== canonical
    || (requireLexicalCanonicalEquality && canonical !== path)) fail()
  const stat = filesystem.statSync(path)
  if (!statIs(stat, 'directory', false)) fail()
  if (!requireLexicalCanonicalEquality) {
    const canonicalStat = filesystem.statSync(canonical)
    if (!statIs(canonicalStat, 'directory', false)) fail()
  }
  return canonical
}

function gateFile(filesystem: Filesystem, path: string, root: string): string {
  const lstat = filesystem.lstatSync(path)
  if (!statIs(lstat, 'file', true)) fail()
  const canonical = filesystem.realpathSync(path)
  if (!isAbsolute(canonical) || canonical !== path || !hasStrictChild(root, canonical)) fail()
  const stat = filesystem.statSync(path)
  if (!statIs(stat, 'file', false)) fail()
  return canonical
}

function parsePackageEntry(packageEntryUrl: unknown): string {
  if (typeof packageEntryUrl !== 'string' || packageEntryUrl.includes('?') || packageEntryUrl.includes('#')
    || /^file:\/\/(?!\/)/i.test(packageEntryUrl)) fail()
  const parsed = new URL(packageEntryUrl)
  if (parsed.href !== packageEntryUrl || parsed.protocol !== 'file:' || parsed.host !== ''
    || parsed.username !== '' || parsed.password !== '') fail()
  const path = fileURLToPath(parsed)
  if (!isAbsolute(path) || normalize(path) !== path || pathToFileURL(path).href !== packageEntryUrl) fail()
  return path
}

function parseManifest(contents: string): void {
  const manifest: unknown = JSON.parse(contents)
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)
    || Object.getPrototypeOf(manifest) !== Object.prototype) fail()
  const record = manifest as { readonly name?: unknown; readonly main?: unknown }
  if (record.name !== PACKAGE_NAME || record.main !== PACKAGE_MAIN) fail()
}

function gatePython(filesystem: Filesystem): void {
  const systemRoot = gateDirectory(filesystem, SYSTEM_ROOT, false)
  const pythonLstat = filesystem.lstatSync(PYTHON_FILE)
  const pythonLstatMethods = statMethods(pythonLstat)
  if (pythonLstatMethods === undefined
    || (Reflect.apply(pythonLstatMethods.isFile, pythonLstat, []) !== true
      && Reflect.apply(pythonLstatMethods.isSymbolicLink, pythonLstat, []) !== true)) fail()
  const pythonCanonical = filesystem.realpathSync(PYTHON_FILE)
  if (!isAbsolute(pythonCanonical) || normalize(pythonCanonical) !== pythonCanonical
    || !hasStrictChild(systemRoot, pythonCanonical)) fail()
  const pythonStat = filesystem.statSync(PYTHON_FILE)
  if (!statIs(pythonStat, 'file', false)) fail()
  filesystem.accessSync(PYTHON_FILE, nodeFsConstants.X_OK)
}

export function resolvePersonalFeedXStartupIdentityFromPackageEntry(
  packageEntryUrl: unknown,
  filesystem?: unknown,
): StartupIdentity {
  try {
    const fs = resolveFilesystem(filesystem)
    const entry = parsePackageEntry(packageEntryUrl)
    const isSourceEntry = entry.endsWith(`${sep}src${sep}index.ts`)
    const isLibraryEntry = entry.endsWith(`${sep}lib${sep}index.js`)
    if (!isSourceEntry && !isLibraryEntry) fail()

    const packageRoot = dirname(dirname(entry))
    const expectedEntry = join(packageRoot, isSourceEntry ? 'src/index.ts' : PACKAGE_MAIN)
    if (expectedEntry !== entry) fail()

    const verifiedRoot = gateDirectory(fs, packageRoot)
    gateFile(fs, entry, verifiedRoot)
    const manifest = join(verifiedRoot, 'package.json')
    if (manifest !== join(packageRoot, 'package.json')) fail()
    gateFile(fs, manifest, verifiedRoot)
    const manifestContents = fs.readFileSync(manifest, 'utf8')
    if (typeof manifestContents !== 'string') fail()
    parseManifest(manifestContents)

    const observerCliPath = join(verifiedRoot, CLI_RELATIVE_PATH)
    if (observerCliPath !== join(packageRoot, CLI_RELATIVE_PATH)) fail()
    gateFile(fs, observerCliPath, verifiedRoot)
    fs.accessSync(observerCliPath, nodeFsConstants.R_OK)
    gatePython(fs)

    return Object.freeze({
      packageRoot: verifiedRoot,
      pythonFile: PYTHON_FILE,
      observerCliPath,
    })
  } catch {
    throw new Error(STARTUP_RESOLUTION_ERROR)
  }
}

type StartupDirectories = Readonly<{
  readonly home: string
  readonly dshHome: string
  readonly dataDir: string
}>

type StringSnapshot = Readonly<Record<string, string>>

function spawnFailure(): never {
  throw new Error(STARTUP_SPAWN_ERROR)
}

function absoluteNormalizedNulFreeString(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) return false
  return isAbsolute(value) && normalize(value) === value
}

function snapshotFrozenStringRecord(value: unknown, keys: readonly string[]): StringSnapshot | undefined {
  try {
    if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value)) return undefined
    if (Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) return undefined

    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== keys.length
      || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return undefined

    const descriptors = Object.getOwnPropertyDescriptors(value)
    const snapshot: Record<string, string> = Object.create(null) as Record<string, string>
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)
        || descriptor.configurable !== false || descriptor.writable !== false
        || !absoluteNormalizedNulFreeString(descriptor.value)) return undefined
      snapshot[key] = descriptor.value
    }
    return Object.freeze(snapshot)
  } catch {
    return undefined
  }
}

function snapshotStartupIdentity(value: unknown): StartupIdentity | undefined {
  const snapshot = snapshotFrozenStringRecord(value, STARTUP_IDENTITY_KEYS)
  if (snapshot === undefined) return undefined
  const packageRoot = snapshot.packageRoot
  const pythonFile = snapshot.pythonFile
  const observerCliPath = snapshot.observerCliPath
  if (typeof packageRoot !== 'string' || typeof pythonFile !== 'string' || typeof observerCliPath !== 'string'
    || pythonFile !== PYTHON_FILE
    || observerCliPath !== join(packageRoot, CLI_RELATIVE_PATH)
    || !hasStrictChild(packageRoot, observerCliPath)) return undefined

  return Object.freeze({
    packageRoot,
    pythonFile,
    observerCliPath,
  })
}

function snapshotStartupDirectories(value: unknown): StartupDirectories | undefined {
  const snapshot = snapshotFrozenStringRecord(value, STARTUP_DIRECTORY_KEYS)
  if (snapshot === undefined) return undefined
  const home = snapshot.home
  const dshHome = snapshot.dshHome
  const dataDir = snapshot.dataDir
  if (typeof home !== 'string' || typeof dshHome !== 'string' || typeof dataDir !== 'string') return undefined

  return Object.freeze({
    home,
    dshHome,
    dataDir,
  })
}

function exactSpawnArray(value: unknown, expectedLength: number): readonly unknown[] | undefined {
  try {
    if (nodeTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return undefined
    }

    const ownKeys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
    if (ownKeys.length !== expectedLength + 1 || lengthDescriptor === undefined
      || lengthDescriptor.enumerable !== false || !('value' in lengthDescriptor)
      || lengthDescriptor.value !== expectedLength) return undefined

    const values: unknown[] = []
    for (const key of ownKeys) {
      if (key === 'length') continue
      if (typeof key !== 'string' || !/^\d+$/.test(key)) return undefined
      const index = Number(key)
      if (!Number.isSafeInteger(index) || index < 0 || index >= expectedLength || String(index) !== key) {
        return undefined
      }
      const descriptor = descriptors[key]
      if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) return undefined
    }
    for (let index = 0; index < expectedLength; index += 1) {
      const descriptor = descriptors[String(index)]
      if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) return undefined
      values[index] = descriptor.value
    }
    return Object.freeze(values)
  } catch {
    return undefined
  }
}

function exactCallerOptions(value: unknown): Readonly<{ readonly shell: unknown; readonly stdio: readonly unknown[] }> | undefined {
  try {
    if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value)) return undefined
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined

    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== 2
      || ownKeys.some(key => typeof key !== 'string' || (key !== 'shell' && key !== 'stdio'))) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const shellDescriptor = descriptors.shell
    const stdioDescriptor = descriptors.stdio
    if (shellDescriptor === undefined || shellDescriptor.enumerable !== true || !('value' in shellDescriptor)
      || stdioDescriptor === undefined || stdioDescriptor.enumerable !== true || !('value' in stdioDescriptor)) {
      return undefined
    }
    const stdio = exactSpawnArray(stdioDescriptor.value, 3)
    if (stdio === undefined) return undefined
    return Object.freeze({ shell: shellDescriptor.value, stdio })
  } catch {
    return undefined
  }
}

function startupEnvironment(directories: StartupDirectories): Readonly<Record<string, string>> {
  const environment = Object.create(null) as Record<string, string>
  Object.defineProperty(environment, 'HOME', {
    configurable: false,
    enumerable: true,
    value: directories.home,
    writable: false,
  })
  Object.defineProperty(environment, 'DSH_HOME', {
    configurable: false,
    enumerable: true,
    value: directories.dshHome,
    writable: false,
  })
  Object.defineProperty(environment, 'DSH_X_FEED_DATA_DIR', {
    configurable: false,
    enumerable: true,
    value: directories.dataDir,
    writable: false,
  })
  Object.defineProperty(environment, 'LANG', {
    configurable: false,
    enumerable: true,
    value: 'C.UTF-8',
    writable: false,
  })
  Object.defineProperty(environment, 'LC_ALL', {
    configurable: false,
    enumerable: true,
    value: 'C.UTF-8',
    writable: false,
  })
  Object.defineProperty(environment, 'TZ', {
    configurable: false,
    enumerable: true,
    value: 'Asia/Shanghai',
    writable: false,
  })
  Object.defineProperty(environment, 'PYTHONDONTWRITEBYTECODE', {
    configurable: false,
    enumerable: true,
    value: '1',
    writable: false,
  })
  Object.defineProperty(environment, 'PYTHONNOUSERSITE', {
    configurable: false,
    enumerable: true,
    value: '1',
    writable: false,
  })
  Object.defineProperty(environment, 'PYTHONIOENCODING', {
    configurable: false,
    enumerable: true,
    value: 'utf-8',
    writable: false,
  })
  if (Reflect.ownKeys(environment).length !== STARTUP_ENV_KEYS.length
    || !Reflect.ownKeys(environment).every((key, index) => key === STARTUP_ENV_KEYS[index])) spawnFailure()
  return Object.freeze(environment)
}

export function createPersonalFeedXStartupSpawn(
  identity: unknown,
  directories: unknown,
  nativeSpawn: unknown,
): (...args: unknown[]) => unknown {
  try {
    const identitySnapshot = snapshotStartupIdentity(identity)
    const directoriesSnapshot = snapshotStartupDirectories(directories)
    let nativeIsProxy = false
    try {
      nativeIsProxy = nodeTypes.isProxy(nativeSpawn)
    } catch {
      spawnFailure()
    }
    if (identitySnapshot === undefined || directoriesSnapshot === undefined
      || nativeIsProxy || typeof nativeSpawn !== 'function') spawnFailure()

    return (...args: unknown[]): unknown => {
      try {
        if (args.length !== 3) spawnFailure()
        const [command, argv, options] = args
        if (command !== identitySnapshot.pythonFile) spawnFailure()

        const observedArgv = exactSpawnArray(argv, 1)
        if (observedArgv === undefined || observedArgv[0] !== identitySnapshot.observerCliPath) spawnFailure()

        const observedOptions = exactCallerOptions(options)
        if (observedOptions === undefined || observedOptions.shell !== false
          || observedOptions.stdio.length !== 3 || observedOptions.stdio.some(value => value !== 'pipe')) spawnFailure()

        const freshArgv = [identitySnapshot.observerCliPath]
        const freshStdio = ['pipe', 'pipe', 'pipe']
        const freshOptions = {
          shell: false,
          stdio: freshStdio,
          env: startupEnvironment(directoriesSnapshot),
        }
        return Reflect.apply(nativeSpawn, undefined, [identitySnapshot.pythonFile, freshArgv, freshOptions])
      } catch {
        throw new Error(STARTUP_SPAWN_ERROR)
      }
    }
  } catch {
    throw new Error(STARTUP_SPAWN_ERROR)
  }
}

type StartupRuntimeConfig = Readonly<{
  readonly dataDir: string
  readonly telegramSessionId: string
  readonly feedbackPendingTtlMs: number
  readonly feedbackTurnTimeoutMs: number
  readonly personalFeedDataDir: string
}>

type StartupPrimitives = Readonly<{
  readonly nativeSpawn: (...args: unknown[]) => unknown
  readonly homedir: () => string
  readonly resolveDshHome: () => string
  readonly nowEpochMs: () => number
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}>

type StartupOwner = Readonly<{
  readonly observe: (input: unknown) => Promise<unknown>
  readonly shutdown: () => Promise<void>
}>

type StartupClock = Readonly<{
  readonly now: () => Date
}>

function runtimeFailure(): never {
  throw new Error(STARTUP_RUNTIME_ERROR)
}

function selfTestFailure(): never {
  throw new Error(STARTUP_SELF_TEST_ERROR)
}

function isNonProxyFunction(value: unknown): value is (...args: any[]) => any {
  if (typeof value !== 'function') return false
  try {
    return !nodeTypes.isProxy(value)
  } catch {
    return false
  }
}

function resolveStartupClock(value: unknown): StartupClock {
  try {
    if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value)
      || !Object.isFrozen(value)) runtimeFailure()
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) runtimeFailure()
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== 1 || ownKeys[0] !== 'now') runtimeFailure()
    const descriptor = Object.getOwnPropertyDescriptor(value, 'now')
    if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)
      || descriptor.configurable !== false || descriptor.writable !== false
      || !isNonProxyFunction(descriptor.value)) runtimeFailure()
    return value as StartupClock
  } catch {
    throw new Error(STARTUP_RUNTIME_ERROR)
  }
}

function snapshotRuntimeConfig(value: unknown): StartupRuntimeConfig | undefined {
  try {
    if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) return undefined
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== SELF_TEST_CONFIG_KEYS.length
      || ownKeys.some(key => typeof key !== 'string' || !SELF_TEST_CONFIG_KEYS.includes(key as typeof SELF_TEST_CONFIG_KEYS[number]))) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of SELF_TEST_CONFIG_KEYS) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)
        || descriptor.configurable !== false || descriptor.writable !== false) return undefined
      values[key] = descriptor.value
    }
    if (!absoluteNormalizedNulFreeString(values.dataDir)
      || typeof values.telegramSessionId !== 'string'
      || !Number.isSafeInteger(values.feedbackPendingTtlMs)
      || (values.feedbackPendingTtlMs as number) < 1
      || (values.feedbackPendingTtlMs as number) > 86_400_000
      || !Number.isSafeInteger(values.feedbackTurnTimeoutMs)
      || (values.feedbackTurnTimeoutMs as number) < 1
      || (values.feedbackTurnTimeoutMs as number) > 120_000
      || !absoluteNormalizedNulFreeString(values.personalFeedDataDir)) return undefined
    return Object.freeze({
      dataDir: values.dataDir,
      telegramSessionId: values.telegramSessionId,
      feedbackPendingTtlMs: values.feedbackPendingTtlMs,
      feedbackTurnTimeoutMs: values.feedbackTurnTimeoutMs,
      personalFeedDataDir: values.personalFeedDataDir,
    } as StartupRuntimeConfig)
  } catch {
    return undefined
  }
}

function resolveStartupPrimitives(value: unknown): StartupPrimitives {
  if (value === undefined) {
    return Object.freeze({
      nativeSpawn: nodeSpawn as unknown as (...args: unknown[]) => unknown,
      homedir: nodeHomedir,
      resolveDshHome: nodeResolveDshHome,
      nowEpochMs: () => Date.now(),
      setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
      clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    })
  }

  try {
    if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) runtimeFailure()
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== STARTUP_PRIMITIVE_KEYS.length
      || ownKeys.some(key => typeof key !== 'string' || !STARTUP_PRIMITIVE_KEYS.includes(key as typeof STARTUP_PRIMITIVE_KEYS[number]))) runtimeFailure()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of STARTUP_PRIMITIVE_KEYS) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)
        || descriptor.configurable !== false || descriptor.writable !== false
        || !isNonProxyFunction(descriptor.value)) runtimeFailure()
      values[key] = descriptor.value
    }
    return Object.freeze({
      nativeSpawn: values.nativeSpawn as StartupPrimitives['nativeSpawn'],
      homedir: values.homedir as StartupPrimitives['homedir'],
      resolveDshHome: values.resolveDshHome as StartupPrimitives['resolveDshHome'],
      nowEpochMs: values.nowEpochMs as StartupPrimitives['nowEpochMs'],
      setTimeout: values.setTimeout as StartupPrimitives['setTimeout'],
      clearTimeout: values.clearTimeout as StartupPrimitives['clearTimeout'],
    })
  } catch {
    throw new Error(STARTUP_RUNTIME_ERROR)
  }
}

function startupDirectories(primitives: StartupPrimitives, dataDir: string): StartupDirectories {
  const home = primitives.homedir()
  const dshHome = primitives.resolveDshHome()
  if (!absoluteNormalizedNulFreeString(home) || !absoluteNormalizedNulFreeString(dshHome)) runtimeFailure()
  return Object.freeze({ home, dshHome, dataDir })
}

function startupObserverChild(
  identity: StartupIdentity,
  directories: StartupDirectories,
  primitives: StartupPrimitives,
): StartupOwner {
  const spawn = createPersonalFeedXStartupSpawn(identity, directories, primitives.nativeSpawn)
  const childOwner = createPersonalFeedXObserverChildOwner({
    pythonFile: identity.pythonFile,
    observerCliPath: identity.observerCliPath,
    totalBudgetMs: 120_000,
    cleanupReserveMs: 2_000,
    killGraceMs: 500,
    nowEpochMs: primitives.nowEpochMs,
    spawn,
    setTimeout: primitives.setTimeout,
    clearTimeout: primitives.clearTimeout,
  })
  const child = Object.freeze({ observe: childOwner.observe })
  const surfaceOwner = createPersonalFeedXSurfaceObserver({ child }) as StartupOwner
  let finalShutdownPromise: Promise<void> | undefined

  const shutdown = (): Promise<void> => {
    if (finalShutdownPromise !== undefined) return finalShutdownPromise

    let resolveFinal!: () => void
    let rejectFinal!: (reason: unknown) => void
    finalShutdownPromise = new Promise<void>((resolve, reject) => {
      resolveFinal = resolve
      rejectFinal = reject
    })
    void finalShutdownPromise.catch(() => undefined)

    let surfaceShutdown: Promise<void> | undefined
    let surfaceFailed = false
    try {
      surfaceShutdown = surfaceOwner.shutdown()
    } catch {
      surfaceFailed = true
    }

    const finishShutdown = async (): Promise<void> => {
      if (!surfaceFailed) {
        try {
          await surfaceShutdown
        } catch {
          surfaceFailed = true
        }
      }

      let childFailed = false
      try {
        await childOwner.shutdown()
      } catch {
        childFailed = true
      }

      if (surfaceFailed || childFailed) {
        const errors: Error[] = []
        if (surfaceFailed) errors.push(new Error(STARTUP_SURFACE_SHUTDOWN_ERROR))
        if (childFailed) errors.push(new Error(STARTUP_CHILD_SHUTDOWN_ERROR))
        rejectFinal(new AggregateError(errors, STARTUP_SHUTDOWN_ERROR))
      } else {
        resolveFinal()
      }
    }
    void finishShutdown().catch(() => {
      rejectFinal(new AggregateError([
        new Error(STARTUP_SURFACE_SHUTDOWN_ERROR),
        new Error(STARTUP_CHILD_SHUTDOWN_ERROR),
      ], STARTUP_SHUTDOWN_ERROR))
    })
    return finalShutdownPromise
  }

  Object.freeze(surfaceOwner.observe)
  Object.freeze(shutdown)
  return Object.freeze({ observe: surfaceOwner.observe, shutdown })
}

/** Internal composition seam. It is intentionally not re-exported by the package root. */
export function createPersonalFeedXStartupFromPackageEntry(
  packageEntryUrl: unknown,
  runtimeConfig: unknown,
  primitives?: unknown,
): StartupOwner {
  try {
    if (arguments.length < 2 || arguments.length > 3) runtimeFailure()
    const config = snapshotRuntimeConfig(runtimeConfig)
    if (config === undefined) runtimeFailure()
    const resolvedPrimitives = resolveStartupPrimitives(primitives)
    const identity = resolvePersonalFeedXStartupIdentityFromPackageEntry(packageEntryUrl)
    const directories = startupDirectories(resolvedPrimitives, config.dataDir)
    return startupObserverChild(identity, directories, resolvedPrimitives)
  } catch {
    throw new Error(STARTUP_RUNTIME_ERROR)
  }
}

/** Bind a validated install clock while retaining startup creation as a lazy factory. */
export function bindPersonalFeedXStartupFromPackageEntry(
  packageEntryUrl: unknown,
  clock: unknown,
  primitives?: unknown,
): (runtimeConfig: unknown) => StartupOwner {
  try {
    if (arguments.length < 2 || arguments.length > 3) runtimeFailure()
    const resolvedClock = resolveStartupClock(clock)
    const resolvedPrimitives = resolveStartupPrimitives(primitives)
    const nowEpochMs = (): number => {
      try {
        const date = resolvedClock.now()
        if (!(date instanceof STARTUP_DATE)) runtimeFailure()
        const epochMs = Reflect.apply(STARTUP_DATE_GET_TIME, date, [])
        if (!Number.isFinite(epochMs)) runtimeFailure()
        return epochMs
      } catch {
        throw new Error(STARTUP_RUNTIME_ERROR)
      }
    }
    const boundPrimitives = Object.freeze({
      nativeSpawn: resolvedPrimitives.nativeSpawn,
      homedir: resolvedPrimitives.homedir,
      resolveDshHome: resolvedPrimitives.resolveDshHome,
      nowEpochMs,
      setTimeout: resolvedPrimitives.setTimeout,
      clearTimeout: resolvedPrimitives.clearTimeout,
    })
    const factory = (runtimeConfig: unknown): StartupOwner => createPersonalFeedXStartupFromPackageEntry(
      packageEntryUrl,
      runtimeConfig,
      boundPrimitives,
    )
    return Object.freeze(factory)
  } catch {
    throw new Error(STARTUP_RUNTIME_ERROR)
  }
}

type SelfTestChild = object

function safeChildPid(value: unknown): number | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined
  try {
    if (nodeTypes.isProxy(value)) return undefined
    const descriptor = Reflect.getOwnPropertyDescriptor(value, 'pid')
    if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)
      || !Number.isSafeInteger(descriptor.value) || (descriptor.value as number) <= 0) return undefined
    return descriptor.value as number
  } catch {
    return undefined
  }
}

function safeCallable(value: unknown): ((...args: unknown[]) => unknown) | undefined {
  return isNonProxyFunction(value) ? value : undefined
}

const SELF_TEST_BYTE_INTRINSICS = (() => {
  try {
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
    const arrayBufferPrototype = ArrayBuffer.prototype
    return Object.freeze({
      apply: Reflect.apply,
      byteLength: Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get,
      buffer: Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get,
      arrayByteLength: Object.getOwnPropertyDescriptor(arrayBufferPrototype, 'byteLength')?.get,
      resizable: Object.getOwnPropertyDescriptor(arrayBufferPrototype, 'resizable')?.get,
      detached: Object.getOwnPropertyDescriptor(arrayBufferPrototype, 'detached')?.get,
    })
  } catch {
    return Object.freeze({
      apply: undefined,
      byteLength: undefined,
      buffer: undefined,
      arrayByteLength: undefined,
      resizable: undefined,
      detached: undefined,
    })
  }
})()

function strictSelfTestBytes(value: unknown, maxLength: number): Uint8Array | undefined {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null
      || nodeTypes.isProxy(value) || !nodeTypes.isUint8Array(value)) return undefined
    const ownByteLength = Reflect.getOwnPropertyDescriptor(value, 'byteLength')
    if (ownByteLength !== undefined) return undefined
    const intrinsics = SELF_TEST_BYTE_INTRINSICS
    if (intrinsics.apply === undefined || intrinsics.byteLength === undefined || intrinsics.buffer === undefined
      || intrinsics.arrayByteLength === undefined || intrinsics.resizable === undefined || intrinsics.detached === undefined) return undefined
    const byteLength = intrinsics.apply(intrinsics.byteLength, value, [])
    const owner = intrinsics.apply(intrinsics.buffer, value, [])
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maxLength
      || !nodeTypes.isArrayBuffer(owner)) return undefined
    const ownerByteLength = intrinsics.apply(intrinsics.arrayByteLength, owner, [])
    const ownerResizable = intrinsics.apply(intrinsics.resizable, owner, [])
    const ownerDetached = intrinsics.apply(intrinsics.detached, owner, [])
    if (!Number.isSafeInteger(ownerByteLength) || ownerByteLength < 0
      || ownerResizable !== false || ownerDetached !== false || byteLength > ownerByteLength) return undefined
    const copy = new Uint8Array(byteLength)
    for (let index = 0; index < byteLength; index += 1) {
      const byte = (value as Uint8Array)[index]
      if (byte === undefined || !Number.isInteger(byte) || byte < 0 || byte > 0xff) return undefined
      copy[index] = byte
    }
    return copy
  } catch {
    return undefined
  }
}

function runSelfTestChild(
  childValue: unknown,
  primitives: StartupPrimitives,
): Promise<string> {
  const expectedBytes = new TextEncoder().encode(SELF_TEST_OUTPUT)
  const rejectFixed = (): Promise<never> => Promise.reject(new Error(STARTUP_SELF_TEST_ERROR))
  if ((typeof childValue !== 'object' && typeof childValue !== 'function') || childValue === null) return rejectFixed()
  try {
    if (nodeTypes.isProxy(childValue)) return rejectFixed()
  } catch {
    return rejectFixed()
  }

  const child: SelfTestChild = childValue as SelfTestChild
  let childOn: ((...args: unknown[]) => unknown) | undefined
  let childKill: ((...args: unknown[]) => unknown) | undefined
  let stdinEnd: ((...args: unknown[]) => unknown) | undefined
  let stdoutOn: ((...args: unknown[]) => unknown) | undefined
  let stderrOn: ((...args: unknown[]) => unknown) | undefined
  let stdinValue: unknown
  let stdoutValue: unknown
  let stderrValue: unknown
  try {
    childOn = safeCallable((child as { readonly on?: unknown }).on)
    childKill = safeCallable((child as { readonly kill?: unknown }).kill)
    stdinValue = (child as { readonly stdin?: unknown }).stdin
    stdoutValue = (child as { readonly stdout?: unknown }).stdout
    stderrValue = (child as { readonly stderr?: unknown }).stderr
    stdinEnd = safeCallable((stdinValue as { readonly end?: unknown } | undefined)?.end)
    stdoutOn = safeCallable((stdoutValue as { readonly on?: unknown } | undefined)?.on)
    stderrOn = safeCallable((stderrValue as { readonly on?: unknown } | undefined)?.on)
  } catch {
    return rejectFixed()
  }
  if (childOn === undefined || stdinEnd === undefined || stdoutOn === undefined || stderrOn === undefined) return rejectFixed()
  const pid = safeChildPid(child)

  return new Promise<string>((resolve, reject) => {
    let settled = false
    let closed = false
    let processExited = false
    let failure = false
    let termAttempted = false
    let killAttempted = false
    let timeoutHandle: unknown
    let graceHandle: unknown
    let timeoutArmed = false
    let graceArmed = false
    const stdoutBytes: number[] = []
    let stderrByteCount = 0

    const clearSlot = (kind: 'timeout' | 'grace'): void => {
      const active = kind === 'timeout' ? timeoutArmed : graceArmed
      const handle = kind === 'timeout' ? timeoutHandle : graceHandle
      if (!active) return
      if (kind === 'timeout') timeoutArmed = false
      else graceArmed = false
      try { primitives.clearTimeout(handle) } catch { /* logical cancellation is sufficient */ }
    }

    const canSignal = (): boolean => !settled && !closed && !processExited && pid !== undefined && childKill !== undefined

    const sendKill = (): void => {
      if (killAttempted || !canSignal()) return
      killAttempted = true
      try { Reflect.apply(childKill!, child, ['SIGKILL']) } catch { /* close remains authoritative */ }
    }

    const armGrace = (): void => {
      if (graceArmed || killAttempted || !canSignal()) return
      graceArmed = true
      try {
        graceHandle = primitives.setTimeout(() => {
          graceArmed = false
          if (!settled && !closed && !processExited) sendKill()
        }, SELF_TEST_KILL_GRACE_MS)
      } catch {
        graceArmed = false
        sendKill()
      }
    }

    const sendTerm = (): void => {
      if (termAttempted || !canSignal()) return
      termAttempted = true
      try { Reflect.apply(childKill!, child, ['SIGTERM']) } catch { /* close remains authoritative */ }
      armGrace()
    }

    const fail = (): void => {
      if (settled || closed) return
      failure = true
      sendTerm()
    }

    const settleClose = (code: unknown, signal: unknown): void => {
      if (settled || closed) return
      closed = true
      settled = true
      clearSlot('timeout')
      clearSlot('grace')
      let outputOkay = false
      if (!failure && code === 0 && signal === null && stderrByteCount === 0 && stdoutBytes.length === expectedBytes.length) {
        try {
          const bytes = Uint8Array.from(stdoutBytes)
          const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
          outputOkay = decoded === SELF_TEST_OUTPUT && bytes.every((byte, index) => byte === expectedBytes[index])
        } catch {
          outputOkay = false
        }
      }
      if (failure || !outputOkay) reject(new Error(STARTUP_SELF_TEST_ERROR))
      else resolve(SELF_TEST_RECEIPT)
    }

    const onExit = (): void => {
      if (settled || closed || processExited) return
      processExited = true
      clearSlot('grace')
    }
    const onChildError = (): void => fail()
    const onStdoutData = (chunk: unknown): void => {
      if (settled || closed || failure) return
      const bytes = strictSelfTestBytes(chunk, expectedBytes.length - stdoutBytes.length)
      if (bytes === undefined) { fail(); return }
      for (const byte of bytes) stdoutBytes.push(byte)
    }
    const onStderrData = (chunk: unknown): void => {
      if (settled || closed || failure) return
      const bytes = strictSelfTestBytes(chunk, 1)
      if (bytes === undefined || bytes.length !== 0) { stderrByteCount += bytes?.length ?? 1; fail() }
    }
    const onStreamError = (): void => fail()

    let closeInstalled = false
    try {
      Reflect.apply(childOn!, child, ['close', settleClose])
      closeInstalled = true
    } catch {
      // Without close there is no bounded authoritative settlement point.
    }
    if (!closeInstalled) {
      sendTerm()
      clearSlot('grace')
      settled = true
      reject(new Error(STARTUP_SELF_TEST_ERROR))
      return
    }
    if (settled) return

    const install = (method: (...args: unknown[]) => unknown, owner: unknown, event: string, listener: (...args: unknown[]) => void): void => {
      if (settled || closed) return
      try { Reflect.apply(method, owner, [event, listener]) } catch { fail() }
    }
    install(childOn!, child, 'exit', onExit)
    install(childOn!, child, 'error', onChildError)
    install(stdoutOn!, stdoutValue, 'data', onStdoutData)
    install(stderrOn!, stderrValue, 'data', onStderrData)
    install(stdoutOn!, stdoutValue, 'error', onStreamError)
    install(stderrOn!, stderrValue, 'error', onStreamError)

    if (!settled && !closed) {
      try {
        timeoutArmed = true
        timeoutHandle = primitives.setTimeout(() => {
          timeoutArmed = false
          if (!settled && !closed && !processExited) {
            failure = true
            sendTerm()
          }
        }, SELF_TEST_TIMEOUT_MS)
      } catch {
        timeoutArmed = false
        fail()
      }
    }

    try {
      if (!settled && !closed) {
        Reflect.apply(stdinEnd!, stdinValue, ['', 'utf8', (...values: unknown[]) => {
          if (values.some(value => value !== undefined && value !== null)) fail()
        }])
      }
    } catch {
      fail()
    }
  })
}

/** Internal self-test seam. It is intentionally not re-exported by the package root. */
export async function runPersonalFeedXStartupSelfTestFromPackageEntry(
  packageEntryUrl: unknown,
  primitives?: unknown,
): Promise<string> {
  try {
    if (arguments.length < 1 || arguments.length > 2) selfTestFailure()
    const resolvedPrimitives = resolveStartupPrimitives(primitives)
    const identity = resolvePersonalFeedXStartupIdentityFromPackageEntry(packageEntryUrl)
    const directories = Object.freeze({
      home: SELF_TEST_HOME,
      dshHome: SELF_TEST_DSH_HOME,
      dataDir: SELF_TEST_DATA_DIR,
    })
    const spawn = createPersonalFeedXStartupSpawn(identity, directories, resolvedPrimitives.nativeSpawn)
    const child = spawn(identity.pythonFile, [identity.observerCliPath], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return await runSelfTestChild(child, resolvedPrimitives)
  } catch {
    throw new Error(STARTUP_SELF_TEST_ERROR)
  }
}
