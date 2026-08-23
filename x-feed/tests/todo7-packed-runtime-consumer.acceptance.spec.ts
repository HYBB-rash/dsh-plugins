import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const xFeedDirectory = resolve(import.meta.dirname, '..')
const workspaceDirectory = resolve(xFeedDirectory, '..')
const cronDirectory = join(workspaceDirectory, 'dsh-cron')
const personalFeedDirectory = join(workspaceDirectory, 'personal-feed')
const harnessDirectory = process.env.DSH_HARNESS_ROOT!
const harnessDependencies = join(harnessDirectory, 'node_modules/.pnpm/node_modules')
const typeScript = join(harnessDirectory, 'node_modules/typescript/bin/tsc')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function pack(packageDirectory: string, destination: string): string {
  const before = new Set(readdirSync(destination))
  execFileSync('npm', ['pack', '--silent', '--pack-destination', destination], {
    cwd: packageDirectory,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tarball = readdirSync(destination).find(entry => entry.endsWith('.tgz') && !before.has(entry))
  if (tarball === undefined) throw new Error(`npm pack produced no tarball for ${packageDirectory}`)
  return join(destination, tarball)
}

function unpack(tarball: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', destination, '--strip-components=1'])
}

function linkWorkspaceDependencies(nodeModules: string): void {
  const sourceScope = join(harnessDependencies, '@deepseek-ai')
  const targetScope = join(nodeModules, '@deepseek-ai')
  mkdirSync(targetScope, { recursive: true })
  for (const entry of readdirSync(sourceScope)) {
    if (entry === 'dsh-cron') continue
    symlinkSync(join(sourceScope, entry), join(targetScope, entry), 'dir')
  }
  const standardSchema = join(harnessDependencies, '@standard-schema')
  if (existsSync(standardSchema)) symlinkSync(standardSchema, join(nodeModules, '@standard-schema'), 'dir')
}

function filesUnder(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function assertNoCrossPackageSubpathImports(directory: string, packageName: string): void {
  const pattern = new RegExp(`${packageName.replace('/', '\\/')}\\/(?:src|lib|dist)(?:\\/|$)`)
  for (const path of filesUnder(directory)) {
    const text = readFileSync(path, 'utf8')
    expect(text, `forbidden cross-package import in ${relative(directory, path)}`).not.toMatch(pattern)
  }
}

describe('TODO7 packed NodeNext public-root consumer', () => {
  it('packs all runtime packages and executes a consumer against only their public roots', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'dsh-x-feed-todo7-packed-consumer-'))
    temporaryDirectories.push(temporary)
    const tarballs = join(temporary, 'tarballs')
    const consumer = join(temporary, 'consumer')
    const consumerNodeModules = join(consumer, 'node_modules')
    const cronPackage = join(consumerNodeModules, '@deepseek-ai/dsh-cron')
    const xFeedPackage = join(consumerNodeModules, '@herman/x-feed')
    const personalFeedPackage = join(consumerNodeModules, '@herman/personal-feed')
    mkdirSync(tarballs)
    mkdirSync(consumerNodeModules, { recursive: true })

    const cronTarball = pack(cronDirectory, tarballs)
    const personalFeedTarball = pack(personalFeedDirectory, tarballs)
    const xFeedTarball = pack(xFeedDirectory, tarballs)
    unpack(cronTarball, cronPackage)
    unpack(personalFeedTarball, personalFeedPackage)
    unpack(xFeedTarball, xFeedPackage)
    linkWorkspaceDependencies(consumerNodeModules)

    for (const path of [
      cronTarball,
      personalFeedTarball,
      xFeedTarball,
      cronPackage,
      personalFeedPackage,
      xFeedPackage,
      consumer,
    ]) {
      expect(path.startsWith(`${temporary}/`), `path escaped temporary root: ${path}`).toBe(true)
    }

    const cronManifest = JSON.parse(readFileSync(join(cronPackage, 'package.json'), 'utf8')) as {
      name: string
      version: string
      main: string
      types: string
      exports: Record<string, unknown>
    }
    const xFeedManifest = JSON.parse(readFileSync(join(xFeedPackage, 'package.json'), 'utf8')) as {
      name: string
      version: string
      main: string
      types: string
      exports: Record<string, unknown>
    }
    const personalFeedManifest = JSON.parse(readFileSync(join(personalFeedPackage, 'package.json'), 'utf8')) as {
      name: string
      version: string
      main: string
      types: string
      exports: Record<string, unknown>
    }
    expect(cronManifest.name).toBe('@deepseek-ai/dsh-cron')
    expect(personalFeedManifest.name).toBe('@herman/personal-feed')
    expect(xFeedManifest.name).toBe('@herman/x-feed')
    expect(cronManifest.version).toBe(JSON.parse(readFileSync(join(cronDirectory, 'package.json'), 'utf8')).version)
    expect(xFeedManifest.version).toBe(JSON.parse(readFileSync(join(xFeedDirectory, 'package.json'), 'utf8')).version)
    expect(personalFeedManifest.version).toBe(
      JSON.parse(readFileSync(join(personalFeedDirectory, 'package.json'), 'utf8')).version,
    )
    for (const [directory, manifest] of [
      [cronPackage, cronManifest],
      [personalFeedPackage, personalFeedManifest],
      [xFeedPackage, xFeedManifest],
    ] as const) {
      expect(manifest.exports['.']).toBeDefined()
      expect(existsSync(join(directory, manifest.main))).toBe(true)
      expect(existsSync(join(directory, manifest.types))).toBe(true)
    }

    const packedFiles = filesUnder(xFeedPackage).map(path => relative(xFeedPackage, path))
    for (const asset of [
      'runtime-package-topology.json', 'scripts/materialize-runtime-topology.mjs',
      'python/browser_start.py', 'python/insight_engine.py', 'python/x_browser.py',
      'python/x_explorer.py', 'python/x_insight_pipeline.py', 'python/x_neighborhood.py',
      'python/x_paths.py', 'python/x_timeline_collector.py', 'python/x_timeline_dedup.py',
      'python/x_timeline_migrate_explore.py', 'python/x_timeline_store.py', 'python/x_topic_search.py',
    ]) expect(packedFiles).toContain(asset)
    expect(packedFiles.some(path => /(?:test|fixture|\.dsh|jobs\.jsonl|runs\.jsonl)/iu.test(path))).toBe(false)
    expect(packedFiles.some(path => path.startsWith('lib/'))).toBe(true)
    expect(packedFiles.some(path => path.endsWith('.d.ts'))).toBe(true)

    assertNoCrossPackageSubpathImports(consumer, '@deepseek-ai/dsh-cron')
    assertNoCrossPackageSubpathImports(consumer, '@herman/personal-feed')
    assertNoCrossPackageSubpathImports(consumer, '@herman/x-feed')

    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(join(consumer, 'consumer.ts'), `
import {
  createCronAgentEnvironmentRegistry,
  type CronAgentEnvironmentProvider,
} from '@deepseek-ai/dsh-cron'
import {
  createXFeedCronEnvironmentProvider,
  X_CRON_AGENT_ENVIRONMENT_MARKER,
  X_CRON_ENVIRONMENT_REQUIREMENTS,
} from '@herman/x-feed'

const provider: CronAgentEnvironmentProvider = createXFeedCronEnvironmentProvider({
  ctx: {} as never,
  cronJobId: 'todo7-consumer-job',
  dataDir: ${JSON.stringify(join(consumer, 'runtime-data'))},
  pythonBin: 'python3',
  pipelinePath: ${JSON.stringify(join(xFeedPackage, 'python/x_insight_pipeline.py'))},
})
const registry = createCronAgentEnvironmentRegistry()
const dispose = registry.register(provider)
const resolved = registry.resolve(X_CRON_AGENT_ENVIRONMENT_MARKER)
if (!resolved.ok) throw new Error('provider did not resolve')
if (resolved.provider.marker !== X_CRON_AGENT_ENVIRONMENT_MARKER) throw new Error('marker mismatch')
if (JSON.stringify(resolved.provider.requirements) !== JSON.stringify(X_CRON_ENVIRONMENT_REQUIREMENTS)) throw new Error('requirements mismatch')
dispose()
const missing = registry.resolve(X_CRON_AGENT_ENVIRONMENT_MARKER)
if (missing.ok || missing.error.code !== 'missing_provider') throw new Error('provider was not disposed')
console.log('TODO7_PACKED_RUNTIME_CONSUMER_OK')
`)
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext',
        strict: true, skipLibCheck: false, outDir: 'dist', rootDir: '.',
      },
      files: ['consumer.ts'],
    }, null, 2))

    try {
      execFileSync(typeScript, ['--project', join(consumer, 'tsconfig.json'), '--pretty', 'false'], {
        cwd: consumer,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const processError = error as { stdout?: Buffer; stderr?: Buffer }
      const output = [processError.stdout, processError.stderr]
        .flatMap(value => value === undefined ? [] : [value.toString('utf8')])
        .join('\n')
      throw new Error(`packed consumer type-check failed:\n${output || String(error)}`, { cause: error })
    }
    const output = execFileSync('node', [join(consumer, 'dist/consumer.js')], {
      cwd: consumer,
      encoding: 'utf8',
    }).trim()
    expect(output).toBe('TODO7_PACKED_RUNTIME_CONSUMER_OK')
  }, 15_000)
})
