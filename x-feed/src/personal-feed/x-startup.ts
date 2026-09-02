import {
  accessSync as nodeAccessSync,
  constants as nodeFsConstants,
  lstatSync as nodeLstatSync,
  readFileSync as nodeReadFileSync,
  realpathSync as nodeRealpathSync,
  statSync as nodeStatSync,
} from 'node:fs'
import { types as nodeTypes } from 'node:util'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const STARTUP_RESOLUTION_ERROR = 'Unable to resolve personal-feed X startup identity'
const STARTUP_SPAWN_ERROR = 'Unable to create personal-feed X startup spawn'
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
