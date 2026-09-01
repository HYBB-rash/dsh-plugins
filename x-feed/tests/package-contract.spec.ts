import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDirectory = resolve(import.meta.dirname, '..')
const pythonRuntimeFiles = [
  'python/browser_start.py',
  'python/insight_engine.py',
  'python/x_browser.py',
  'python/x_explorer.py',
  'python/x_insight_pipeline.py',
  'python/x_neighborhood.py',
  'python/x_paths.py',
  'python/x_timeline_collector.py',
  'python/x_timeline_dedup.py',
  'python/x_timeline_migrate_explore.py',
  'python/x_timeline_store.py',
  'python/x_topic_search.py',
] as const

function packedPaths(): string[] {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const entries = JSON.parse(output) as Array<{ files?: Array<{ path?: string }> }>
  return entries.flatMap((entry) => (entry.files ?? []).flatMap((file) =>
    file.path === undefined ? [] : [file.path]))
}

describe('x-feed business package contract', () => {
  it('ships runtime assets without private state or test material', () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8')) as {
      name?: string
      main?: string
      types?: string
    }
    const files = packedPaths()

    expect(files).toContain('package.json')
    expect(packageJson.name).toBe('@herman/x-feed')
    expect(files).toContain(packageJson.main)
    expect(files).toContain(packageJson.types)
    expect(files.some((file) => /^lib\/[^/]+\.js$/.test(file))).toBe(true)
    expect(files.some((file) => /^lib\/types\/.*\.d\.ts$/.test(file))).toBe(true)

    const mainSource = readFileSync(resolve(packageDirectory, packageJson.main ?? ''), 'utf8')
    const typeSource = readFileSync(resolve(packageDirectory, packageJson.types ?? ''), 'utf8')
    expect(mainSource).toContain('createTrustedFactNavigation')
    expect(mainSource).toContain('TrustedFactNavigationProjector')
    expect(mainSource).toContain('createFactProjectionPreflight')
    expect(typeSource).toContain('createTrustedFactNavigation')
    expect(typeSource).toContain('NavigationItem')
    expect(typeSource).toContain('createFactProjectionPreflight')
    expect(typeSource).toContain('CandidateFactAssessmentDecision')
    expect(typeSource).toContain('ReadyFactProjectionSession')
    for (const privateExport of [
      'createReadyFactProjectionAccessRegistry',
      'ReadyFactProjectionAccess',
      'ExactLookupGrant',
      'ExactFactLookup',
      'ExactFactLookupBuilder',
      'FactProjectionAccessRegistry',
    ]) {
      expect(mainSource).not.toMatch(new RegExp(`export[^\\n]*${privateExport}`))
      expect(typeSource).not.toMatch(new RegExp(`export[^\\n]*${privateExport}`))
    }

    const rootSource = readFileSync(resolve(packageDirectory, 'src/index.ts'), 'utf8')
    expect(rootSource).not.toContain('createCronEnvironmentExtension')
    const businessSources = readdirSync(resolve(packageDirectory, 'src'))
      .flatMap(file => file.endsWith('.ts') ? [readFileSync(resolve(packageDirectory, 'src', file), 'utf8')] : [])
      .join('\n')
    expect(businessSources).toContain('@herman/personal-feed')
    expect(businessSources).not.toMatch(/@herman\/personal-feed\/(?:src|lib|dist)/u)
    expect(rootSource).toContain('installTelegramExtension')
    expect(rootSource).not.toContain('export async function apply')
    expect(rootSource).not.toContain("export const name = 'dsh-x-feed'")
    expect(rootSource).not.toContain('export const inject')

    const projectionSource = readdirSync(resolve(packageDirectory, 'src/fact-projection'))
      .filter(file => file.endsWith('.ts'))
      .map(file => readFileSync(resolve(packageDirectory, 'src/fact-projection', file), 'utf8'))
      .join('\n')
    for (const forbiddenImport of [
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-cron',
      'prompt',
      'tools',
      '.py',
    ]) expect(projectionSource).not.toContain(forbiddenImport)

    for (const runtimeFile of pythonRuntimeFiles) expect(files).toContain(runtimeFile)
    expect(files.some((file) => /(^|\/)(?:data|storage|storages)(?:\/|$)/.test(file))).toBe(false)
    expect(files.some((file) => /(?:feedback\.jsonl|shown\.jsonl|x_insight_package\.json|\.dsh)/.test(file))).toBe(false)
    expect(files.some((file) => /(?:__pycache__|\.pyc$|(?:^|\/)(?:cache|tests?|fixtures?)(?:\/|$)|(?:^|\/)test_[^/]+$)/.test(file))).toBe(false)
    expect(files.filter((file) => /^python\/test_[^/]+\.py$/.test(file))).toEqual([])
  })
})
