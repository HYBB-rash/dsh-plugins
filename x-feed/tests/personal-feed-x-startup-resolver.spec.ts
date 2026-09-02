import {
  accessSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

type SyncFilesystem = Readonly<{
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

type Resolver = (packageEntryUrl: unknown, filesystem?: SyncFilesystem) => StartupIdentity

type StartupModule = Readonly<{
  readonly resolvePersonalFeedXStartupIdentityFromPackageEntry?: unknown
}>

type LoadedResolver =
  | Readonly<{ readonly kind: 'available'; readonly resolve: Resolver }>
  | Readonly<{ readonly kind: 'unavailable'; readonly message: string }>

type FakeStatsOptions = Readonly<{
  readonly symlink?: boolean
  readonly file?: boolean
  readonly directory?: boolean
  readonly mode?: number
}>

type PythonFilesystemOptions = Readonly<{
  readonly systemRoot: string
  readonly pythonRealpath: string
  readonly pythonLstat?: FakeStatsOptions
  readonly pythonStat?: FakeStatsOptions
  readonly pythonAccessError?: Error
  readonly systemRootRealpathError?: Error
  readonly pythonRealpathError?: Error
}>

type FilesystemOperation = 'lstatSync' | 'realpathSync' | 'statSync' | 'readFileSync' | 'accessSync'

type FilesystemFailure = Readonly<{
  readonly operation: FilesystemOperation
  readonly path: string
}>

type Fixture = Readonly<{
  readonly root: string
  readonly entry: string
  readonly manifest: string
  readonly cli: string
}>

const ENTRY_RELATIVE_PATHS = Object.freeze(['src/index.ts', 'lib/index.js'] as const)
const PYTHON_FILE = '/usr/bin/python3'

function fakeStats(options: FakeStatsOptions = {}): object {
  const symlink = options.symlink ?? false
  const file = options.file ?? true
  const directory = options.directory ?? false
  const mode = options.mode ?? 0o100755
  return Object.freeze({
    isSymbolicLink: () => symlink,
    isFile: () => file,
    isDirectory: () => directory,
    mode,
  })
}

function filesystemError(code: string, path: string): Error & { readonly code: string } {
  return Object.assign(new Error(`${code}: ${path}`), { code })
}

async function loadResolver(): Promise<LoadedResolver> {
  const moduleUrl = new URL('../src/personal-feed/x-startup.ts', import.meta.url).href
  try {
    const loaded = await import(/* @vite-ignore */ moduleUrl) as StartupModule
    if (typeof loaded.resolvePersonalFeedXStartupIdentityFromPackageEntry !== 'function') {
      return Object.freeze({
        kind: 'unavailable' as const,
        message: 'CAPABILITY_ASSERTION: x-startup.ts does not export resolvePersonalFeedXStartupIdentityFromPackageEntry',
      })
    }
    return Object.freeze({
      kind: 'available' as const,
      resolve: loaded.resolvePersonalFeedXStartupIdentityFromPackageEntry as Resolver,
    })
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return Object.freeze({
      kind: 'unavailable' as const,
      message: `CAPABILITY_ASSERTION: x-startup.ts could not be imported: ${detail}`,
    })
  }
}

function requireResolver(loaded: LoadedResolver): Resolver | undefined {
  expect(loaded.kind, loaded.kind === 'unavailable' ? loaded.message : undefined).toBe('available')
  return loaded.kind === 'available' ? loaded.resolve : undefined
}

function createFixture(
  directory: string,
  relativeEntryPath: string = 'src/index.ts',
  packageRoot: string = join(directory, 'package'),
): Fixture {
  const root = packageRoot
  const entry = join(root, relativeEntryPath)
  const manifest = join(root, 'package.json')
  const cli = join(root, 'python', 'x_personal_feed_observer_cli.py')
  mkdirSync(dirname(entry), { recursive: true })
  mkdirSync(dirname(cli), { recursive: true })
  writeFileSync(entry, '// entry\n')
  writeFileSync(manifest, JSON.stringify({ name: '@herman/x-feed', main: 'lib/index.js' }))
  writeFileSync(cli, '#!/usr/bin/env python3\n')
  chmodSync(cli, 0o755)
  return Object.freeze({ root, entry, manifest, cli })
}

function packageEntryUrl(path: string): string {
  return pathToFileURL(path).href
}

function makeFilesystem(
  python: PythonFilesystemOptions,
  calls: Array<readonly [string, string]> = [],
  failure?: FilesystemFailure,
): SyncFilesystem {
  const failIfSelected = (operation: FilesystemOperation, path: string): void => {
    if (failure?.operation === operation && failure.path === path) throw filesystemError('EIO', path)
  }
  const systemRootStats = fakeStats({ file: false, directory: true, mode: 0o40755 })
  const pythonLstat = fakeStats(python.pythonLstat ?? { symlink: true, file: false, directory: false, mode: 0o120777 })
  const pythonStat = fakeStats(python.pythonStat ?? { file: true, mode: 0o100755 })
  return Object.freeze({
    lstatSync(path: string): unknown {
      calls.push(['lstatSync', path])
      failIfSelected('lstatSync', path)
      if (path === '/usr/bin' || path === python.systemRoot) return systemRootStats
      if (path === PYTHON_FILE) return pythonLstat
      if (path === python.pythonRealpath) return pythonStat
      return lstatSync(path)
    },
    realpathSync(path: string): string {
      calls.push(['realpathSync', path])
      failIfSelected('realpathSync', path)
      if (path === '/usr/bin') {
        if (python.systemRootRealpathError !== undefined) throw python.systemRootRealpathError
        return python.systemRoot
      }
      if (path === PYTHON_FILE) {
        if (python.pythonRealpathError !== undefined) throw python.pythonRealpathError
        return python.pythonRealpath
      }
      if (path === python.systemRoot || path === python.pythonRealpath) return path
      return realpathSync(path)
    },
    statSync(path: string): unknown {
      calls.push(['statSync', path])
      failIfSelected('statSync', path)
      if (path === '/usr/bin' || path === python.systemRoot) return systemRootStats
      if (path === PYTHON_FILE || path === python.pythonRealpath) return pythonStat
      return statSync(path)
    },
    readFileSync(path: string, encoding: 'utf8'): string {
      calls.push(['readFileSync', path])
      failIfSelected('readFileSync', path)
      return readFileSync(path, encoding)
    },
    accessSync(path: string, mode: number): void {
      calls.push(['accessSync', path])
      failIfSelected('accessSync', path)
      if (path === PYTHON_FILE || path === python.pythonRealpath) {
        if (python.pythonAccessError !== undefined) throw python.pythonAccessError
        return
      }
      accessSync(path, mode)
    },
  })
}

function validPython(directory: string): PythonFilesystemOptions {
  const systemRoot = join(directory, 'canonical-system-root')
  return Object.freeze({
    systemRoot,
    pythonRealpath: join(systemRoot, 'bin', 'python3'),
  })
}

async function expectRejected(resolve: Resolver, input: unknown, filesystem?: SyncFilesystem): Promise<void> {
  await expect(Promise.resolve().then(() => resolve(input, filesystem))).rejects.toBeInstanceOf(Error)
}

function expectExactIdentity(result: StartupIdentity, fixture: Fixture): void {
  expect(Object.isFrozen(result)).toBe(true)
  expect(Reflect.ownKeys(result)).toEqual(['packageRoot', 'pythonFile', 'observerCliPath'])
  expect(result).toEqual({
    packageRoot: fixture.root,
    pythonFile: PYTHON_FILE,
    observerCliPath: fixture.cli,
  })
}

describe('personal-feed X startup identity resolver', () => {
  it('exposes the private resolver as a capability instead of failing during collection', async () => {
    const loaded = await loadResolver()
    expect(loaded.kind, loaded.kind === 'unavailable' ? loaded.message : undefined).toBe('available')
  })

  it('accepts only the exact entry roots, uses the seam for every filesystem gate, and freezes exact output', async () => {
    const loaded = await loadResolver()
    const resolve = requireResolver(loaded)
    if (resolve === undefined) return

    for (const relativeEntryPath of ENTRY_RELATIVE_PATHS) {
      const directory = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-success-'))
      try {
        const fixture = createFixture(directory, relativeEntryPath)
        const calls: Array<readonly [string, string]> = []
        const filesystem = makeFilesystem(validPython(directory), calls)
        const result = resolve(packageEntryUrl(fixture.entry), filesystem)
        expectExactIdentity(result, fixture)
        for (const path of [fixture.entry, fixture.root, fixture.manifest, fixture.cli]) {
          expect(calls).toContainEqual(['lstatSync', path])
          expect(calls).toContainEqual(['realpathSync', path])
          expect(calls).toContainEqual(['statSync', path])
        }
        expect(calls).toContainEqual(['readFileSync', fixture.manifest])
        expect(calls).toContainEqual(['accessSync', fixture.cli])
        expect(calls).toContainEqual(['accessSync', PYTHON_FILE])

        const guardedPaths = [fixture.entry, fixture.root, fixture.manifest, fixture.cli] as const
        const guardedOperations: readonly FilesystemOperation[] = ['lstatSync', 'realpathSync', 'statSync']
        for (const path of guardedPaths) {
          for (const operation of guardedOperations) {
            const failingFilesystem = makeFilesystem(validPython(directory), [], { operation, path })
            await expectRejected(resolve, packageEntryUrl(fixture.entry), failingFilesystem)
          }
        }
        await expectRejected(
          resolve,
          packageEntryUrl(fixture.entry),
          makeFilesystem(validPython(directory), [], { operation: 'readFileSync', path: fixture.manifest }),
        )
        await expectRejected(
          resolve,
          packageEntryUrl(fixture.entry),
          makeFilesystem(validPython(directory), [], { operation: 'accessSync', path: fixture.cli }),
        )
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }

    const defaultDirectory = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-default-'))
    try {
      const fixture = createFixture(defaultDirectory, 'lib/index.js')
      expectExactIdentity(resolve(packageEntryUrl(fixture.entry)), fixture)
    } finally {
      rmSync(defaultDirectory, { recursive: true, force: true })
    }
  })

  it('rejects malformed URLs, non-exact entries, ancestor fallback, and invalid manifests', async () => {
    const loaded = await loadResolver()
    const resolve = requireResolver(loaded)
    if (resolve === undefined) return

    const directory = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-reject-'))
    try {
      const fixture = createFixture(directory)
      const parent = join(directory, 'parent')
      const child = join(parent, 'child')
      const parentFixture = createFixture(directory, 'src/index.ts', parent)
      const childFixture = createFixture(directory, 'src/index.ts', child)

      const validEntryUrl = pathToFileURL(fixture.entry)
      const query = `${validEntryUrl.href}?unexpected=1`
      const fragment = `${validEntryUrl.href}#unexpected`
      const host = new URL(`file://example.invalid${fixture.entry}`)
      const exactEntrySuffix = '/index.ts'
      const encodedUnreserved = new URL(
        `${validEntryUrl.href.slice(0, validEntryUrl.href.length - exactEntrySuffix.length)}/%69ndex.ts`,
      ).href

      const malformedInputs: readonly unknown[] = [
        query,
        fragment,
        host,
        validEntryUrl,
        encodedUnreserved,
        'src/index.ts',
        'https://example.invalid/index.ts',
        packageEntryUrl(join(fixture.root, 'src', 'index.js')),
        packageEntryUrl(join(fixture.root, 'lib', 'index.ts')),
        packageEntryUrl(join(fixture.root, 'src', 'nested', 'index.ts')),
      ]
      for (const input of malformedInputs) await expectRejected(resolve, input)

      expect(resolve(packageEntryUrl(childFixture.entry))).toEqual({
        packageRoot: childFixture.root,
        pythonFile: PYTHON_FILE,
        observerCliPath: childFixture.cli,
      })

      rmSync(childFixture.manifest)
      await expectRejected(resolve, packageEntryUrl(childFixture.entry))

      const missingExactEntry = packageEntryUrl(join(parent, 'missing-child', 'src', 'index.ts'))
      await expectRejected(resolve, missingExactEntry)
      expect(parentFixture.root).toBe(parent)

      const manifestCases: readonly { readonly name: string; readonly mutate: (fixture: Fixture) => void }[] = [
        {
          name: 'malformed JSON',
          mutate: fixture => writeFileSync(fixture.manifest, '{malformed'),
        },
        {
          name: 'wrong package name',
          mutate: fixture => writeFileSync(fixture.manifest, JSON.stringify({ name: '@wrong/name', main: 'lib/index.js' })),
        },
        {
          name: 'wrong package main',
          mutate: fixture => writeFileSync(fixture.manifest, JSON.stringify({ name: '@herman/x-feed', main: 'src/index.ts' })),
        },
        {
          name: 'manifest symlink',
          mutate: fixture => {
            const external = join(dirname(fixture.root), 'external-package.json')
            writeFileSync(external, JSON.stringify({ name: '@herman/x-feed', main: 'lib/index.js' }))
            rmSync(fixture.manifest)
            symlinkSync(external, fixture.manifest)
          },
        },
        {
          name: 'manifest directory',
          mutate: fixture => {
            rmSync(fixture.manifest)
            mkdirSync(fixture.manifest)
          },
        },
      ]
      for (const testCase of manifestCases) {
        const caseDirectory = mkdtempSync(join(tmpdir(), `x-feed-startup-resolver-manifest-${testCase.name.replaceAll(' ', '-')}-`))
        try {
          const caseFixture = createFixture(caseDirectory)
          testCase.mutate(caseFixture)
          await expectRejected(resolve, packageEntryUrl(caseFixture.entry))
        } finally {
          rmSync(caseDirectory, { recursive: true, force: true })
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails closed for entry/root/CLI escapes and every Python lexical-path hazard without invoking proxy traps', async () => {
    const loaded = await loadResolver()
    const resolve = requireResolver(loaded)
    if (resolve === undefined) return

    const directory = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-security-'))
    try {
      const escapedEntryDirectory = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-entry-outside-'))
      try {
        const entryCaseDirectory = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-entry-case-'))
        try {
          const fixture = createFixture(entryCaseDirectory)
          const outsideEntry = join(escapedEntryDirectory, 'index.ts')
          writeFileSync(outsideEntry, '// outside\n')
          rmSync(fixture.entry)
          symlinkSync(outsideEntry, fixture.entry)
          await expectRejected(resolve, packageEntryUrl(fixture.entry))
        } finally {
          rmSync(entryCaseDirectory, { recursive: true, force: true })
        }

        const entryDirectoryCase = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-entry-directory-'))
        try {
          const fixture = createFixture(entryDirectoryCase)
          rmSync(fixture.entry)
          mkdirSync(fixture.entry)
          await expectRejected(resolve, packageEntryUrl(fixture.entry))
        } finally {
          rmSync(entryDirectoryCase, { recursive: true, force: true })
        }

        const entryParentEscapeDirectory = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-entry-parent-outside-'))
        try {
          const entryParentCaseDirectory = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-entry-parent-case-'))
          try {
            const fixture = createFixture(entryParentCaseDirectory)
            const outsideSource = join(entryParentEscapeDirectory, 'src')
            mkdirSync(outsideSource)
            writeFileSync(join(outsideSource, 'index.ts'), '// outside source parent\n')
            rmSync(join(fixture.root, 'src'), { recursive: true, force: true })
            symlinkSync(outsideSource, join(fixture.root, 'src'), 'dir')
            await expectRejected(resolve, packageEntryUrl(fixture.entry))
          } finally {
            rmSync(entryParentCaseDirectory, { recursive: true, force: true })
          }
        } finally {
          rmSync(entryParentEscapeDirectory, { recursive: true, force: true })
        }
      } finally {
        rmSync(escapedEntryDirectory, { recursive: true, force: true })
      }

      const rootLinkDirectory = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-root-target-'))
      try {
        const target = createFixture(rootLinkDirectory)
        const rootCaseDirectory = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-root-case-'))
        try {
          const linkedRoot = join(rootCaseDirectory, 'linked-package')
          symlinkSync(target.root, linkedRoot, 'dir')
          await expectRejected(resolve, packageEntryUrl(join(linkedRoot, 'src/index.ts')))
        } finally {
          rmSync(rootCaseDirectory, { recursive: true, force: true })
        }
      } finally {
        rmSync(rootLinkDirectory, { recursive: true, force: true })
      }

      const escapedCliDirectory = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-cli-outside-'))
      try {
        const cliCaseDirectory = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-cli-escape-case-'))
        try {
          const fixture = createFixture(cliCaseDirectory)
          const outsideCli = join(escapedCliDirectory, 'x_personal_feed_observer_cli.py')
          writeFileSync(outsideCli, '#!/usr/bin/env python3\n')
          chmodSync(outsideCli, 0o755)
          rmSync(fixture.cli)
          symlinkSync(outsideCli, fixture.cli)
          await expectRejected(resolve, packageEntryUrl(fixture.entry))
        } finally {
          rmSync(cliCaseDirectory, { recursive: true, force: true })
        }
      } finally {
        rmSync(escapedCliDirectory, { recursive: true, force: true })
      }

      const cliDirectoryCase = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-cli-directory-'))
      try {
        const fixture = createFixture(cliDirectoryCase)
        rmSync(fixture.cli)
        mkdirSync(fixture.cli)
        await expectRejected(resolve, packageEntryUrl(fixture.entry))
      } finally {
        rmSync(cliDirectoryCase, { recursive: true, force: true })
      }

      const cliMissingCase = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-cli-missing-'))
      try {
        const fixture = createFixture(cliMissingCase)
        writeFileSync(join(fixture.root, 'python', 'other_observer_cli.py'), '#!/usr/bin/env python3\n')
        rmSync(fixture.cli)
        await expectRejected(resolve, packageEntryUrl(fixture.entry))
      } finally {
        rmSync(cliMissingCase, { recursive: true, force: true })
      }

      const pythonCases: readonly {
        readonly name: string
        readonly configure: (directory: string) => PythonFilesystemOptions
      }[] = [
        {
          name: 'system root realpath failure',
          configure: directory => Object.freeze({ ...validPython(directory), systemRootRealpathError: filesystemError('EIO', '/usr/bin') }),
        },
        {
          name: 'python missing',
          configure: directory => Object.freeze({
            ...validPython(directory),
            pythonLstat: { file: false, directory: false },
            pythonRealpathError: filesystemError('ENOENT', PYTHON_FILE),
          }),
        },
        {
          name: 'python final realpath failure',
          configure: directory => Object.freeze({ ...validPython(directory), pythonRealpathError: filesystemError('ELOOP', PYTHON_FILE) }),
        },
        {
          name: 'python escapes canonical system root',
          configure: directory => Object.freeze({ ...validPython(directory), pythonRealpath: join(directory, 'canonical-system-root-escape', 'python3') }),
        },
        {
          name: 'python canonical realpath contains dot segment',
          configure: directory => {
            const valid = validPython(directory)
            return Object.freeze({ ...valid, pythonRealpath: `${valid.systemRoot}/./bin/python3` })
          },
        },
        {
          name: 'python canonical realpath contains parent segment',
          configure: directory => {
            const valid = validPython(directory)
            return Object.freeze({ ...valid, pythonRealpath: `${valid.systemRoot}/bin/../bin/python3` })
          },
        },
        {
          name: 'python is a device',
          configure: directory => Object.freeze({ ...validPython(directory), pythonStat: { file: false, directory: false, mode: 0o20666 } }),
        },
        {
          name: 'python is a directory',
          configure: directory => Object.freeze({ ...validPython(directory), pythonStat: { file: false, directory: true, mode: 0o40755 } }),
        },
        {
          name: 'python is non-executable',
          configure: directory => Object.freeze({
            ...validPython(directory),
            pythonStat: { file: true, mode: 0o100644 },
            pythonAccessError: filesystemError('EACCES', PYTHON_FILE),
          }),
        },
        {
          name: 'python access failure',
          configure: directory => Object.freeze({ ...validPython(directory), pythonAccessError: filesystemError('EACCES', PYTHON_FILE) }),
        },
      ]
      for (const testCase of pythonCases) {
        const caseDirectory = mkdtempSync(join(tmpdir(), `x-feed-startup-resolver-python-${testCase.name.replaceAll(' ', '-')}-`))
        try {
          const fixture = createFixture(caseDirectory)
          await expectRejected(resolve, packageEntryUrl(fixture.entry), makeFilesystem(testCase.configure(caseDirectory)))
        } finally {
          rmSync(caseDirectory, { recursive: true, force: true })
        }
      }

      const proxyDirectory = mkdtempSync(join(tmpdir(), 'x-feed-startup-resolver-proxy-'))
      try {
        const fixture = createFixture(proxyDirectory)
        let inputTrapCount = 0
        let filesystemTrapCount = 0
        const inputProxy = new Proxy(pathToFileURL(fixture.entry), {
          get() {
            inputTrapCount += 1
            throw new Error('input getter/proxy must not execute')
          },
        })
        const filesystemProxy = new Proxy(makeFilesystem(validPython(proxyDirectory)), {
          get() {
            filesystemTrapCount += 1
            throw new Error('filesystem getter/proxy must not execute')
          },
        })
        await expectRejected(resolve, inputProxy, makeFilesystem(validPython(proxyDirectory)))
        await expectRejected(resolve, packageEntryUrl(fixture.entry), filesystemProxy)
        expect(inputTrapCount).toBe(0)
        expect(filesystemTrapCount).toBe(0)
      } finally {
        rmSync(proxyDirectory, { recursive: true, force: true })
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
