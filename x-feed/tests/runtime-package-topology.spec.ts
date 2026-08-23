import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const xFeedDirectory = resolve(import.meta.dirname, '..')
const topologyInstaller = join(xFeedDirectory, 'scripts/materialize-runtime-topology.mjs')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createRelease(options: { includePersonalFeed: boolean }): string {
  const releasePlugins = mkdtempSync(join(tmpdir(), 'x-feed-runtime-topology-'))
  temporaryDirectories.push(releasePlugins)

  const xFeed = join(releasePlugins, 'x-feed')
  mkdirSync(xFeed)
  copyFileSync(join(xFeedDirectory, 'package.json'), join(xFeed, 'package.json'))

  if (options.includePersonalFeed) {
    const personalFeed = join(releasePlugins, 'personal-feed')
    mkdirSync(join(personalFeed, 'lib'), { recursive: true })
    copyFileSync(join(xFeedDirectory, '../personal-feed/package.json'), join(personalFeed, 'package.json'))
    writeFileSync(join(personalFeed, 'lib/index.js'), 'export const independentCore = true\n')
  }

  return releasePlugins
}

function runInstaller(mode: '--check' | '--materialize', releasePlugins: string): string {
  return execFileSync(process.execPath, [topologyInstaller, mode, releasePlugins], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function installerError(mode: '--check' | '--materialize', releasePlugins: string): string {
  try {
    runInstaller(mode, releasePlugins)
  } catch (error) {
    const processError = error as { stderr?: Buffer | string }
    return processError.stderr?.toString() ?? String(error)
  }
  throw new Error(`expected topology installer ${mode} to fail`)
}

describe('x-feed release runtime topology', () => {
  it('rejects a release that omitted the declared independent runtime package', () => {
    const releasePlugins = createRelease({ includePersonalFeed: false })

    expect(installerError('--materialize', releasePlugins)).toContain(
      'missing runtime package @herman/personal-feed',
    )
    expect(existsSync(join(releasePlugins, 'node_modules/@herman/personal-feed'))).toBe(false)
  })

  it('materializes and checks the declared peer in the consumer resolution ancestor', () => {
    const releasePlugins = createRelease({ includePersonalFeed: true })
    const runtimeLink = join(releasePlugins, 'node_modules/@herman/personal-feed')

    expect(installerError('--check', releasePlugins)).toContain('missing runtime link @herman/personal-feed')
    expect(runInstaller('--materialize', releasePlugins)).toContain('materialized 1 runtime link')
    expect(lstatSync(runtimeLink).isSymbolicLink()).toBe(true)
    expect(readlinkSync(runtimeLink)).toBe('../../personal-feed')
    expect(realpathSync(runtimeLink)).toBe(realpathSync(join(releasePlugins, 'personal-feed')))
    expect(runInstaller('--check', releasePlugins)).toContain('checked 1 runtime link')

    const requireFromXFeed = createRequire(join(releasePlugins, 'x-feed/package.json'))
    expect(requireFromXFeed.resolve('@herman/personal-feed')).toBe(
      join(releasePlugins, 'personal-feed/lib/index.js'),
    )
  })

  it('fails closed without replacing a conflicting release path', () => {
    const releasePlugins = createRelease({ includePersonalFeed: true })
    const runtimeLink = join(releasePlugins, 'node_modules/@herman/personal-feed')
    mkdirSync(runtimeLink, { recursive: true })
    const marker = join(runtimeLink, 'owned-by-another-package')
    writeFileSync(marker, 'preserve me\n')

    expect(installerError('--materialize', releasePlugins)).toContain(
      'conflicting runtime path @herman/personal-feed',
    )
    expect(readFileSync(marker, 'utf8')).toBe('preserve me\n')
    expect(dirname(marker)).toBe(runtimeLink)
  })
})
