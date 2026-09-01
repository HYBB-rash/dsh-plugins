import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDirectory = resolve(import.meta.dirname, '..')

function sourcesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourcesUnder(path)
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('x-feed runtime dependency handoff', () => {
  it('has no Personal Feed package edge before the release topology changes', () => {
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as {
      peerDependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    expect(manifest.peerDependencies?.['@herman/personal-feed']).toBeUndefined()
    expect(manifest.devDependencies?.['@herman/personal-feed']).toBeUndefined()

    const source = sourcesUnder(join(packageDirectory, 'src'))
      .map(path => readFileSync(path, 'utf8'))
      .join('\n')
    expect(source).not.toContain('@herman/personal-feed')
    expect(readFileSync(join(packageDirectory, 'lib/index.js'), 'utf8'))
      .not.toContain('@herman/personal-feed')
  })
})
