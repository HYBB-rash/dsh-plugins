import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type PackageJson = {
  readonly bin?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly exports?: Record<string, unknown>
  readonly files?: readonly string[]
}

function readPackage(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson
}

const assistantPackage = readPackage(fileURLToPath(new URL('../package.json', import.meta.url)))
const cronPackage = readPackage(fileURLToPath(new URL('../../dsh-cron/package.json', import.meta.url)))

describe('published package contracts', () => {
  it('exposes the v4 assistant migration binary from lib', () => {
    expect(assistantPackage.bin).toMatchObject({
      'dsh-assistant-migrate-to-v4': 'lib/migrate-cli.js',
    })
  })

  it('declares dsh-cron in assistant peer and development dependencies', () => {
    expect(assistantPackage.peerDependencies?.['@deepseek-ai/dsh-cron']).toBeDefined()
    expect(assistantPackage.devDependencies?.['@deepseek-ai/dsh-cron']).toBeDefined()
  })

  it('keeps assistant public migration exports without source-path exports', () => {
    const exports = assistantPackage.exports ?? {}
    expect(exports).toHaveProperty('./migrate')
    expect(exports).toHaveProperty('./historical-recovery')
    expect(Object.keys(exports).filter(key => key.startsWith('./src/'))).toEqual([])
  })

  it('keeps cron root and package metadata exports without source-path exports', () => {
    const exports = cronPackage.exports ?? {}
    expect(exports).toHaveProperty('.')
    expect(exports).toHaveProperty('./package.json')
    expect(Object.keys(exports).filter(key => key.startsWith('./src/'))).toEqual([])
  })

  it('ships JavaScript entrypoints and declaration files for both packages', () => {
    for (const packageJson of [assistantPackage, cronPackage]) {
      expect(packageJson.files).toEqual(expect.arrayContaining([
        'lib/*.js',
        'lib/types/**/*.d.ts',
      ]))
    }
  })
})
