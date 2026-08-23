import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryDirectory = resolve(import.meta.dirname, '../..')
const topologyInstaller = join(repositoryDirectory, 'scripts/materialize-runtime-topology.mjs')
const topologyManifest = join(repositoryDirectory, 'runtime-package-topology.json')
const pluginDirectories = [
  'dsh-assistant',
  'dsh-cron',
  'personal-feed',
  'telegram-gateway',
  'ui-context-compactor',
  'x-feed',
] as const
const harnessPackages = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
] as const
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createPackage(directory: string, name: string): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name,
    type: 'module',
    main: 'index.js',
    exports: { '.': './index.js' },
  }))
  writeFileSync(join(directory, 'index.js'), `export const packageName = ${JSON.stringify(name)}\n`)
}

function createCleanRelease(): string {
  const release = mkdtempSync(join(tmpdir(), 'dsh-runtime-topology-'))
  temporaryDirectories.push(release)
  const releasePlugins = join(release, 'plugins')
  const harnessNodeModules = join(release, 'harness/node_modules/.pnpm/node_modules')
  mkdirSync(releasePlugins, { recursive: true })

  for (const directory of pluginDirectories) {
    const source = join(repositoryDirectory, directory)
    const target = join(releasePlugins, directory)
    mkdirSync(target)
    copyFileSync(join(source, 'package.json'), join(target, 'package.json'))
    cpSync(join(source, 'lib'), join(target, 'lib'), { recursive: true })
  }
  for (const packageName of harnessPackages) createPackage(join(harnessNodeModules, packageName), packageName)
  return release
}

function runInstaller(
  mode: '--check' | '--materialize',
  release: string,
  installer = topologyInstaller,
): string {
  return execFileSync(process.execPath, [installer, mode, release], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function installerError(
  mode: '--check' | '--materialize',
  release: string,
  installer = topologyInstaller,
): string {
  try {
    runInstaller(mode, release, installer)
  } catch (error) {
    const processError = error as { stderr?: Buffer | string }
    return processError.stderr?.toString() ?? String(error)
  }
  throw new Error(`expected topology installer ${mode} to fail`)
}

function resolveFromPlugin(release: string, pluginDirectory: string, packageName: string): string {
  const requireFromPlugin = createRequire(join(release, 'plugins', pluginDirectory, 'package.json'))
  return requireFromPlugin.resolve(packageName)
}

describe('release runtime package topology', () => {
  it('scans the final plugin libraries and materializes every declared runtime target', () => {
    const release = createCleanRelease()

    expect(() => resolveFromPlugin(release, 'dsh-cron', '@deepseek-ai/dsh-home-paths')).toThrow(
      expect.objectContaining({ code: 'MODULE_NOT_FOUND' }),
    )
    expect(installerError('--check', release)).toContain('missing runtime link @deepseek-ai/dsh-home-paths')

    expect(runInstaller('--materialize', release)).toMatch(/materialized \d+ runtime links; checked \d+ imports/u)
    expect(runInstaller('--check', release)).toMatch(/checked \d+ runtime links; checked \d+ imports/u)
    expect(resolveFromPlugin(release, 'dsh-cron', '@deepseek-ai/dsh-home-paths')).toBe(
      join(release, 'harness/node_modules/.pnpm/node_modules/@deepseek-ai/dsh-home-paths/index.js'),
    )
    expect(resolveFromPlugin(release, 'x-feed', '@herman/personal-feed')).toBe(
      join(release, 'plugins/personal-feed/lib/index.js'),
    )
    expect(resolveFromPlugin(release, 'x-feed', '@deepseek-ai/dsh-telegram-gateway')).toBe(
      join(release, 'plugins/telegram-gateway/lib/index.js'),
    )
    expect(resolveFromPlugin(release, 'dsh-assistant', '@deepseek-ai/dsh-cron')).toBe(
      join(release, 'plugins/dsh-cron/lib/index.js'),
    )
  })

  it('rejects an undeclared final-library import before materializing any link', () => {
    const release = createCleanRelease()
    writeFileSync(
      join(release, 'plugins/personal-feed/lib/undeclared-runtime.js'),
      "import '@example/undeclared-runtime'\n",
    )

    expect(installerError('--materialize', release)).toContain(
      'undeclared runtime import @example/undeclared-runtime from @herman/personal-feed',
    )
    expect(existsSync(join(release, 'plugins/node_modules'))).toBe(false)
  })

  it('fails closed without replacing a conflicting release path', () => {
    const release = createCleanRelease()
    const conflict = join(release, 'plugins/node_modules/@deepseek-ai/dsh-home-paths')
    mkdirSync(conflict, { recursive: true })
    const marker = join(conflict, 'owned-by-another-package')
    writeFileSync(marker, 'preserve me\n')

    expect(installerError('--materialize', release)).toContain(
      'conflicting runtime path @deepseek-ai/dsh-home-paths',
    )
    expect(readFileSync(marker, 'utf8')).toBe('preserve me\n')
    expect(existsSync(join(release, 'plugins/node_modules/@herman/personal-feed'))).toBe(false)
  })

  it('rejects a topology target that escapes the release', () => {
    const release = createCleanRelease()
    const copiedTooling = join(release, 'malicious-tooling')
    const copiedInstaller = join(copiedTooling, 'scripts/materialize-runtime-topology.mjs')
    const copiedManifest = join(copiedTooling, 'runtime-package-topology.json')
    mkdirSync(join(copiedTooling, 'scripts'), { recursive: true })
    copyFileSync(topologyInstaller, copiedInstaller)
    const topology = JSON.parse(readFileSync(topologyManifest, 'utf8')) as {
      targets: Array<{ kind: string; releaseDirectory?: string }>
    }
    const releaseTarget = topology.targets.find(target => target.kind === 'release')
    if (releaseTarget === undefined) throw new Error('fixture topology has no release target')
    releaseTarget.releaseDirectory = '../outside'
    writeFileSync(copiedManifest, `${JSON.stringify(topology, null, 2)}\n`)

    expect(installerError('--materialize', release, copiedInstaller)).toContain(
      'releaseDirectory must be one safe release directory segment',
    )
    expect(existsSync(join(release, 'plugins/node_modules'))).toBe(false)
  })
})
