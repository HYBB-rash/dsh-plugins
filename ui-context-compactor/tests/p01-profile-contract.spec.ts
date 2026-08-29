import { describe, expect, it } from 'vitest'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

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

function topLevelBlock(profile: string, id: string): string {
  const lines = profile.split('\n')
  const start = lines.findIndex(line => line === `- id: ${id}`)
  if (start < 0) throw new Error(`missing profile plugin ${id}`)
  const endOffset = lines.slice(start + 1).findIndex(line => line.startsWith('- id: ') || line === '- insert:')
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset
  return lines.slice(start, end).join('\n')
}

describe('native context production profile contract', () => {
  it('uses Harness compaction and session query without the custom context runtime', async () => {
    const root = await profilesRoot()
    const profiles = await Promise.all(['web', 'telegram'].map(async (name) => ({
      name,
      patch: await readFile(resolve(root, name, 'cordis.patch.yml'), 'utf8'),
      manifest: JSON.parse(await readFile(resolve(root, name, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      },
    })))

    for (const { name, patch, manifest } of profiles) {
      const compaction = topLevelBlock(patch, 'compaction-basic')
      expect(compaction, `${name} native compaction`).toContain('disabled: false')
      expect(compaction, `${name} automatic compaction`).toContain('auto: true')
      expect(topLevelBlock(patch, 'command-compact'), `${name} manual compaction`).toContain('disabled: false')
      expect(topLevelBlock(patch, 'session-query-sqlite'), `${name} native session query`).toContain('openAt: first-search')
      expect(patch, `${name} model query tools`).toContain("name: '@deepseek-ai/dsh-tool-session-query'")

      expect(patch, `${name} custom context runtime`).not.toContain('ui-context-compactor')
      expect(patch, `${name} custom context invariant`).not.toContain("name: '@deepseek-ai/dsh-invariants'")
      expect(manifest.dependencies, `${name} native query dependency`)
        .toHaveProperty('@deepseek-ai/dsh-tool-session-query', 'workspace:*')
      expect(manifest.dependencies, `${name} custom context dependency`)
        .not.toHaveProperty('@deepseek-ai/dsh-client-ui-context-compactor')
    }
  })
})
