import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { CONTROL_PROTOCOL_VERSION } from '../src/control-contract.ts'
import { foldJobLog, JobStore } from '../src/store.ts'
import type { Config } from '../src/index.ts'

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('cron sibling decoupling', () => {
  it('keeps sibling packages out of the package manifest', () => {
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as Record<string, Record<string, string>>
    const forbiddenPackages = [
      ['@deepseek-ai/dsh', 'telegram-gateway'].join('-'),
      ['@deepseek-ai/dsh', 'credentials'].join('-'),
    ]
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const packageName of forbiddenPackages) expect(manifest[field] ?? {}).not.toHaveProperty(packageName)
    }
  })

  it('exposes only the neutral scheduler configuration', () => {
    const config: Config = {
      mode: 'scheduler',
      pollIntervalMs: 1_000,
      maxConcurrent: 1,
      deliverOnError: true,
    }
    expect(config).not.toHaveProperty('apiBaseUrl')
    expect(config).not.toHaveProperty('token')
    expect(config).not.toHaveProperty('chatId')
  })

  it('uses only control protocol v2', () => {
    expect(CONTROL_PROTOCOL_VERSION).toBe(2)
  })

  it('normalizes a legacy telegram row at the private read boundary', () => {
    const legacy = JSON.stringify({
      op: 'create',
      id: 'legacy',
      schedule: { kind: 'interval', minutes: 5 },
      prompt: 'legacy',
      deliver: 'telegram',
      createdAt: '2026-09-05T00:00:00.000Z',
    })
    expect(foldJobLog([legacy]).active).toMatchObject([{ id: 'legacy', deliver: 'default' }])
  })

  it('does not rewrite a legacy row while normalizing it for readers', () => {
    const storeDirectory = mkdtempSync(join(tmpdir(), 'dsh-cron-legacy-'))
    const jobsFile = join(storeDirectory, 'jobs.jsonl')
    const legacy = `${JSON.stringify({
      op: 'create',
      id: 'legacy',
      schedule: { kind: 'interval', minutes: 5 },
      prompt: 'legacy',
      deliver: 'telegram',
      createdAt: '2026-09-05T00:00:00.000Z',
    })}\n`
    try {
      writeFileSync(jobsFile, legacy, 'utf8')

      expect(new JobStore(storeDirectory).fold().active).toMatchObject([{ id: 'legacy', deliver: 'default' }])
      expect(readFileSync(jobsFile, 'utf8')).toBe(legacy)
    } finally {
      rmSync(storeDirectory, { recursive: true, force: true })
    }
  })
})
