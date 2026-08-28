import { describe, expect, it } from 'vitest'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const P01_SESSION_ID = 'session-2ad8a3dd-1e0b-4126-aca8-4f129ad02b54'
const EDITABLE_PROFILES_ROOT = '/workspace/dsh-plugins/release/profiles'

async function profilesRoot(): Promise<string> {
  try {
    await access(EDITABLE_PROFILES_ROOT)
    return EDITABLE_PROFILES_ROOT
  } catch {
    // A formal release build supplies the Harness root and archives release
    // tooling into its one canonical sibling; do not search arbitrary paths.
  }

  const harnessRoot = process.env['DSH_HARNESS_ROOT']
  if (harnessRoot === undefined || harnessRoot.trim().length === 0) {
    throw new Error('missing editable profiles and DSH_HARNESS_ROOT for archived profiles')
  }
  const archivedProfilesRoot = resolve(harnessRoot, '..', 'release-system', 'profiles')
  try {
    await access(archivedProfilesRoot)
    return archivedProfilesRoot
  } catch (error: unknown) {
    throw new Error(`missing official archived profiles at ${archivedProfilesRoot}`, { cause: error })
  }
}

function pluginBlock(profile: string, id: string): string {
  const lines = profile.split('\n')
  const start = lines.findIndex(line => line === `    - id: ${id}`)
  if (start < 0) throw new Error(`missing profile plugin ${id}`)
  const endOffset = lines.slice(start + 1).findIndex(line => line.startsWith('    - id: '))
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset
  return lines.slice(start, end).join('\n')
}

function p01ConfigBlock(plugin: string): string {
  const lines = plugin.split('\n')
  const start = lines.findIndex(line => line.trim() === 'p01UserWordsView:')
  if (start < 0) throw new Error('missing p01UserWordsView config')
  const indent = lines[start]!.search(/\S/u)
  const endOffset = lines.slice(start + 1).findIndex((line) => {
    const nextIndent = line.search(/\S/u)
    return nextIndent >= 0 && nextIndent <= indent
  })
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset
  return lines.slice(start, end).map(line => line.slice(indent)).join('\n').trim()
}

describe('P01 production profile contract', () => {
  it('keeps one identical exact allowlist in the Web runtime and invariant, and none in Telegram', async () => {
    const root = await profilesRoot()
    const [web, telegram] = await Promise.all([
      readFile(resolve(root, 'web/cordis.patch.yml'), 'utf8'),
      readFile(resolve(root, 'telegram/cordis.patch.yml'), 'utf8'),
    ])
    const runtime = p01ConfigBlock(pluginBlock(web, 'ui-context-compactor'))
    const invariant = p01ConfigBlock(pluginBlock(web, 'ui-context-compactor-invariant'))

    expect(runtime).toBe(invariant)
    expect(runtime).toContain('mode: enforce')
    expect(runtime.match(new RegExp(P01_SESSION_ID, 'gu'))).toHaveLength(1)
    expect(runtime).not.toMatch(/maxChars|observe|fallback|\*/u)
    expect(web.match(new RegExp(P01_SESSION_ID, 'gu'))).toHaveLength(2)
    expect(telegram).not.toContain('p01UserWordsView')
    expect(telegram).not.toContain(P01_SESSION_ID)
  })
})
