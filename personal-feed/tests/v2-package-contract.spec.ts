import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDirectory = resolve(import.meta.dirname, '..')
const pythonRuntimeFiles = [
  'python/x_browser_navigation_lock.py',
  'python/x_personal_feed_observer.py',
  'python/x_personal_feed_observer_cli.py',
] as const

function packedPaths(): string[] {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const entries = JSON.parse(output) as Array<{ files?: Array<{ path?: string }> }>
  return entries.flatMap(entry => (entry.files ?? []).flatMap(file =>
    file.path === undefined ? [] : [file.path]))
}

describe('personal-feed unified package contract', () => {
  it('ships one Telegram extension with only the active X observer assets', () => {
    const packageJson = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as {
      name?: string
      main?: string
      types?: string
      exports?: Record<string, unknown>
      files?: string[]
      scripts?: Record<string, string>
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    expect(packageJson.name).toBe('@herman/personal-feed')
    expect(packageJson.main).toBe('lib/index.js')
    expect(packageJson.types).toBe('lib/types/index.d.ts')
    expect(packageJson.exports).toEqual({
      '.': {
        types: './lib/types/index.d.ts',
        default: './lib/index.js',
      },
      './package.json': './package.json',
    })
    expect(packageJson.files).toEqual([
      'lib/*.js',
      'lib/types/**/*.d.ts',
      ...pythonRuntimeFiles,
    ])
    expect(packageJson.scripts?.bundle).toContain('tsdown')
    expect(packageJson.peerDependencies).not.toHaveProperty('@herman/personal-feed')
    expect(packageJson.devDependencies).not.toHaveProperty('@herman/personal-feed')

    const files = packedPaths()
    expect(files).toContain('package.json')
    expect(files).toContain(packageJson.main)
    expect(files).toContain(packageJson.types)
    expect(new Set(files.filter(file => file.startsWith('python/')))).toEqual(new Set(pythonRuntimeFiles))
    expect(files.some(path => /(?:^|\/)(?:tests?|fixtures?|v1)(?:\/|$)/iu.test(path))).toBe(false)

    const mainSource = readFileSync(join(packageDirectory, packageJson.main ?? ''), 'utf8')
    const typeSource = readFileSync(join(packageDirectory, packageJson.types ?? ''), 'utf8')
    expect(mainSource).toContain('installTelegramExtension')
    expect(typeSource).toContain('installTelegramExtension')
    for (const retiredExport of [
      'createXFeedCronEnvironmentProvider',
      'createPersonalFeedV2RequestCoordinator',
      'createPersonalFeedV2CandidateStateOwner',
      'createPersonalContextOwner',
    ]) {
      expect(mainSource).not.toMatch(new RegExp(`export[^\\n]*${retiredExport}`))
      expect(typeSource).not.toMatch(new RegExp(`export[^\\n]*${retiredExport}`))
    }
  })
})
