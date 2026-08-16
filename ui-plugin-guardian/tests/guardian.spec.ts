/** ui-plugin-guardian: watched-set resolution, fiber matching, audit log, and repair logic. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apply, appendAudit, DEFAULT_WATCHED, DOWN_STATES, inject, isWatched, resolveWatched,
} from '../src/index.ts'

let scratch: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  }
})

/** Build a fake fiber with the given runtime name and state. */
function fakeFiber(name: string | undefined, state: string): { runtime: { name?: string }; state: string } {
  return { runtime: name === undefined ? undefined : { name }, state }
}

describe('resolveWatched', () => {
  it('defaults to our own plugin names', () => {
    expect(resolveWatched({ watched: [], repairCooldownMs: 0, auditDir: '' })).toEqual(DEFAULT_WATCHED)
  })

  it('uses the configured watch list when provided', () => {
    expect(resolveWatched({ watched: ['custom-a'], repairCooldownMs: 0, auditDir: '' })).toEqual(['custom-a'])
  })
})

describe('isWatched', () => {
  it('matches fibers whose runtime name is watched', () => {
    expect(isWatched(fakeFiber('ui-context-compactor', 'ACTIVE') as never, DEFAULT_WATCHED)).toBe(true)
    expect(isWatched(fakeFiber('some-other', 'ACTIVE') as never, DEFAULT_WATCHED)).toBe(false)
    expect(isWatched(fakeFiber(undefined, 'ACTIVE') as never, DEFAULT_WATCHED)).toBe(false)
  })
})

describe('DOWN_STATES', () => {
  it('covers the failure states the guardian repairs', () => {
    expect(DOWN_STATES).toEqual([3, 4]) // FiberState.FAILED=3, DISPOSED=4
  })
})

describe('appendAudit', () => {
  it('appends JSONL records and creates the directory', () => {
    scratch = mkdtempSync(join(tmpdir(), 'guardian-'))
    appendAudit(scratch, {
      time: 't1', plugin: 'ui-context-compactor', event: 'detected-down', oldState: 'ACTIVE',
    })
    appendAudit(scratch, {
      time: 't2', plugin: 'ui-context-compactor', event: 'repair-ok', oldState: 'FAILED',
    })
    const lines = readFileSync(join(scratch, 'audit.jsonl'), 'utf8').trim().split('\n')
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'detected-down', plugin: 'ui-context-compactor' })
    expect(JSON.parse(lines[1])).toMatchObject({ event: 'repair-ok' })
  })

  it('never throws on an unwritable directory', () => {
    expect(() => appendAudit('/nonexistent-root/deep', {
      time: 't', plugin: 'p', event: 'repair-failed', oldState: 'FAILED',
    })).not.toThrow()
  })
})

describe('apply', () => {
  it('subscribes and repairs a watched plugin that fails', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'guardian-apply-'))
    ctx = new Context()
    const fiber = ctx.plugin({ inject, apply }, {
      watched: ['ui-context-compactor'], repairCooldownMs: 0, auditDir: scratch,
    })
    await fiber.await()

    // A failed watched fiber triggers a repair attempt (audited; re-mount of
    // a stub runtime without a real callback is expected to fail, but the
    // detection + attempt path is what this pins).
    const failed = {
      runtime: { name: 'ui-context-compactor', callback: undefined },
      inject: {},
      config: {},
      state: 3, // FiberState.FAILED
    }
    ctx.emit('internal/status' as never, failed, 2 as never) // ACTIVE -> FAILED
    await new Promise(resolve => setTimeout(resolve, 20))

    const audit = readFileSync(join(scratch, 'audit.jsonl'), 'utf8').trim().split('\n')
    expect(audit.some(line => line.includes('detected-down'))).toBe(true)
    expect(audit.some(line => line.includes('repair-failed'))).toBe(true)

    await fiber.dispose()
  })

  it('ignores non-watched plugin failures', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'guardian-apply-'))
    ctx = new Context()
    const fiber = ctx.plugin({ inject, apply }, {
      watched: ['ui-context-compactor'], repairCooldownMs: 0, auditDir: scratch,
    })
    await fiber.await()

    const other = { runtime: { name: 'some-other', callback: undefined }, state: 3 }
    ctx.emit('internal/status' as never, other, 2 as never)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(() => readFileSync(join(scratch, 'audit.jsonl'), 'utf8')).toThrow()

    await fiber.dispose()
  })
})
