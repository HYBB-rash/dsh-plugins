import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireBrowserLock } from '../src/browser-lock.ts'

describe('shared X browser lock', () => {
  it('serializes helpers and releases after disposal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-browser-lock-'))
    const path = join(directory, '.x_timeline_browser.lock')
    try {
      const first = await acquireBrowserLock({ path })
      const blocked = await acquireBrowserLock({ path, timeoutMs: 80 })
      expect(blocked).toMatchObject({ ok: false, code: 'lock_timeout' })
      await first.dispose()
      const second = await acquireBrowserLock({ path, timeoutMs: 1_000 })
      expect(second.ok).toBe(true)
      if (second.ok) await second.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stops waiting when cancelled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-browser-lock-'))
    const path = join(directory, '.x_timeline_browser.lock')
    const controller = new AbortController()
    try {
      const first = await acquireBrowserLock({ path })
      controller.abort()
      const aborted = await acquireBrowserLock({ path, signal: controller.signal })
      expect(aborted).toMatchObject({ ok: false, code: 'aborted' })
      await first.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('cancels a helper already blocked behind another fcntl holder, then releases cleanly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-browser-lock-'))
    const path = join(directory, '.x_timeline_browser.lock')
    const controller = new AbortController()
    try {
      const first = await acquireBrowserLock({ path })
      const pending = acquireBrowserLock({ path, signal: controller.signal, timeoutMs: 5_000 })
      await new Promise(resolve => setTimeout(resolve, 50))
      controller.abort()
      await expect(pending).resolves.toMatchObject({ ok: false, code: 'aborted' })
      await first.dispose()
      const third = await acquireBrowserLock({ path, timeoutMs: 1_000 })
      expect(third.ok).toBe(true)
      if (third.ok) await third.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 10_000)
})
