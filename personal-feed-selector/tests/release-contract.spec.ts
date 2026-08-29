import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const read = (path: string): string => readFileSync(resolve(repositoryRoot, path), 'utf8')

describe('release integration contract', () => {
  it.each([
    'release/Containerfile',
    'release/scripts/dev-source-build.sh',
    'release/scripts/dev-source-verify.sh',
    'release/scripts/self-test.sh',
    'release/cli.mjs',
  ])('%s enumerates the selector package', path => {
    expect(read(path)).toContain('personal-feed-selector')
  })

  it.each(['web', 'telegram', 'telegram-test'])('%s profile depends on and loads the selector', profile => {
    expect(read(`release/profiles/${profile}/package.json`)).toContain('@herman/personal-feed-selector')
    expect(read(`release/profiles/${profile}/cordis.patch.yml`)).toContain("name: '@herman/personal-feed-selector'")
  })

  it('runtime preparation installs the product Skill', () => {
    expect(read('release/scripts/prepare-runtime.sh')).toContain('personal-feed-selector')
  })

  it('runtime topology declares the selector dependencies', () => {
    expect(read('runtime-package-topology.json')).toContain('@herman/personal-feed-selector')
  })
})
