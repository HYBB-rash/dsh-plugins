import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type PackageJson = {
  readonly bin?: Record<string, string>
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly exports?: Record<string, unknown>
  readonly files?: readonly string[]
}

function readPackage(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson
}

const assistantPackage = readPackage(fileURLToPath(new URL('../package.json', import.meta.url)))

describe('published package contracts', () => {
  it('does not publish the retired assistant migration binary', () => {
    expect(assistantPackage.bin).toBeUndefined()
  })

  it('declares only host capabilities and its own runtime dependency', () => {
    expect(Object.keys(assistantPackage.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/schemastery',
    ])
    expect(Object.keys(assistantPackage.peerDependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-home-paths',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-subagent',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
    ])
  })

  it('keeps only current assistant exports without migration or source-path exports', () => {
    const exports = assistantPackage.exports ?? {}
    expect(exports).not.toHaveProperty('./migrate')
    expect(exports).not.toHaveProperty('./historical-recovery')
    expect(Object.keys(exports).filter(key => key.startsWith('./src/'))).toEqual([])
  })

  it('ships JavaScript entrypoints and declaration files', () => {
    expect(assistantPackage.files).toEqual(expect.arrayContaining([
      'lib/*.js',
      'lib/types/**/*.d.ts',
    ]))
  })
})
