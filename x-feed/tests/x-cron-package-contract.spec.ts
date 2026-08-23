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
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const packageDirectory = resolve(import.meta.dirname, '..')
const workspaceDirectory = resolve(packageDirectory, '..')
const personalFeedDirectory = join(workspaceDirectory, 'personal-feed')
const temporaryDirectories: string[] = []
const harnessDirectory = process.env.DSH_HARNESS_ROOT!
const harnessDependencies = join(harnessDirectory, 'node_modules/.pnpm/node_modules')
const typeScript = join(harnessDirectory, 'node_modules/typescript/bin/tsc')

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function allTypeScriptSources(directory: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...allTypeScriptSources(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(path)
  }
  return result
}

function pack(packagePath: string, destination: string): string {
  const before = new Set(readdirSync(destination))
  execFileSync('npm', ['pack', '--silent', '--pack-destination', destination], {
    cwd: packagePath,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tarball = readdirSync(destination).find(entry => entry.endsWith('.tgz') && !before.has(entry))
  if (tarball === undefined) throw new Error(`npm pack did not produce a tarball for ${packagePath}`)
  return join(destination, tarball)
}

function unpack(tarball: string, packageDirectory: string): void {
  mkdirSync(packageDirectory, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', packageDirectory, '--strip-components=1'])
}

function linkExistingDependencies(consumerNodeModules: string): void {
  const sourceScope = join(harnessDependencies, '@deepseek-ai')
  const targetScope = join(consumerNodeModules, '@deepseek-ai')
  mkdirSync(targetScope, { recursive: true })
  for (const entry of readdirSync(sourceScope)) {
    if (entry === 'dsh-cron') continue
    symlinkSync(join(sourceScope, entry), join(targetScope, entry), 'dir')
  }
  const standardSchema = join(harnessDependencies, '@standard-schema')
  if (existsSync(standardSchema)) symlinkSync(standardSchema, join(consumerNodeModules, '@standard-schema'), 'dir')
}

describe('x-feed cron environment package root contract', () => {
  it('imports dsh-cron only through its public root and exposes the provider from the X root', () => {
    const providerSource = readFileSync(join(packageDirectory, 'src/x-cron/provider.ts'), 'utf8')
    expect(providerSource).toContain("from '@deepseek-ai/dsh-cron'")
    expect(providerSource).not.toMatch(/@deepseek-ai\/dsh-cron\/(?:src|lib|dist)/u)

    const allSources = allTypeScriptSources(join(packageDirectory, 'src'))
      .map(path => readFileSync(path, 'utf8'))
      .join('\n')
    expect(allSources).not.toMatch(/@deepseek-ai\/dsh-cron\/(?:src|lib|dist)/u)

    const xPackage = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>
    }
    const cronPackage = JSON.parse(readFileSync(join(workspaceDirectory, 'dsh-cron/package.json'), 'utf8')) as {
      exports?: Record<string, unknown>
    }
    expect(xPackage.exports?.['.']).toBeDefined()
    expect(cronPackage.exports?.['.']).toBeDefined()
    expect(readFileSync(join(packageDirectory, 'src/index.ts'), 'utf8')).toContain('createXFeedCronEnvironmentProvider')
  })

  it('type-checks root imports from all packed runtime dependencies with NodeNext resolution', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'dsh-x-feed-package-consumer-'))
    temporaryDirectories.push(temporary)
    const tarballs = join(temporary, 'tarballs')
    const consumer = join(temporary, 'consumer')
    mkdirSync(tarballs)
    mkdirSync(join(consumer, 'node_modules'), { recursive: true })
    const cronTarball = pack(join(workspaceDirectory, 'dsh-cron'), tarballs)
    const personalFeedTarball = pack(personalFeedDirectory, tarballs)
    const xFeedTarball = pack(packageDirectory, tarballs)
    unpack(cronTarball, join(consumer, 'node_modules/@deepseek-ai/dsh-cron'))
    unpack(personalFeedTarball, join(consumer, 'node_modules/@herman/personal-feed'))
    unpack(xFeedTarball, join(consumer, 'node_modules/@herman/x-feed'))
    linkExistingDependencies(join(consumer, 'node_modules'))

    writeFileSync(join(consumer, 'consumer.ts'), `
import {
  createCronAgentEnvironmentRegistry,
  type CronAgentEnvironmentProvider,
} from '@deepseek-ai/dsh-cron'
import {
  createXFeedCronEnvironmentProvider,
  X_CRON_AGENT_ENVIRONMENT_MARKER,
} from '@herman/x-feed'

const provider: CronAgentEnvironmentProvider = createXFeedCronEnvironmentProvider({
  ctx: {} as never,
  cronJobId: 'cron-x',
  dataDir: '/tmp/x-feed-consumer',
  pythonBin: 'python3',
  pipelinePath: '/pkg/python/x_insight_pipeline.py',
})
const registry = createCronAgentEnvironmentRegistry()
registry.register(provider)
if (X_CRON_AGENT_ENVIRONMENT_MARKER !== provider.marker) throw new Error('marker mismatch')
`)
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
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
  }, 15_000)
})
