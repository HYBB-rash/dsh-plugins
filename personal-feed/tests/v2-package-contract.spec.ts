import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDirectory = resolve(import.meta.dirname, '..')
const forbiddenV1Exports = [
  'createPersonalFeedScopeService',
  'createCrossSourceEditor',
  'createPeriodBusinessFinalizer',
  'createSourceCandidateReportReader',
  'createDeliveryAndReceipt',
  'createCurrentContextProjection',
  'createMechanicalAdmission',
  'createCandidateMaterialProjection',
] as const
const forbiddenV1PackedModules = [
  'candidate-period',
  'cross-source-editor',
  'current-context-input-store',
  'delivery-and-receipt',
  'editing-input-store',
  'period-business',
  'source-candidate-report',
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

function filesUnder(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

describe('personal-feed v2 package carrier contract', () => {
  it('ships one v2-only public package root and no v1 source or test material', () => {
    const packageJson = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as {
      name?: string
      main?: string
      types?: string
      exports?: Record<string, unknown>
      files?: string[]
      scripts?: Record<string, string>
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
    expect(packageJson.files).toEqual(expect.arrayContaining(['lib/*.js', 'lib/types/**/*.d.ts']))
    expect(packageJson.scripts?.bundle).toContain('tsdown')

    const sourceFiles = filesUnder(join(packageDirectory, 'src'))
    const allowedRootSources = new Set([
      '/src/index.ts',
      '/src/canonical-json.ts',
      '/src/durable-jsonl-store.ts',
      '/src/errors.ts',
    ])
    expect(sourceFiles.every(path => path.includes('/src/v2/')
      || [...allowedRootSources].some(suffix => path.endsWith(suffix)))).toBe(true)
    const sourceText = sourceFiles.map(path => readFileSync(path, 'utf8')).join('\n')
    for (const forbiddenExport of forbiddenV1Exports) {
      expect(sourceText).not.toContain(forbiddenExport)
    }

    const files = packedPaths()
    expect(files).toContain('package.json')
    expect(files).toContain(packageJson.main)
    expect(files).toContain(packageJson.types)
    expect(files.some(path => /(?:^|\/)(?:tests?|fixtures?|v1)(?:\/|$)/iu.test(path))).toBe(false)
    expect(files.some(path => /(?:^|\/)v1[-_]/iu.test(path))).toBe(false)
    for (const moduleSegment of forbiddenV1PackedModules) {
      expect(files.some(path => path.includes(moduleSegment))).toBe(false)
    }

    const mainSource = readFileSync(join(packageDirectory, packageJson.main ?? ''), 'utf8')
    const typeSource = readFileSync(join(packageDirectory, packageJson.types ?? ''), 'utf8')
    for (const v2Export of [
      'createPersonalFeedV2RequestCoordinator',
      'createPersonalFeedV2CandidateLifecycle',
      'createPersonalContextOwner',
      'createSessionUserHistoryAdapter',
    ]) {
      expect(mainSource).toContain(v2Export)
      expect(typeSource).toContain(v2Export)
    }
    for (const forbiddenExport of forbiddenV1Exports) {
      expect(mainSource).not.toMatch(new RegExp(`export[^\\n]*${forbiddenExport}`))
      expect(typeSource).not.toMatch(new RegExp(`export[^\\n]*${forbiddenExport}`))
    }
  })
})
