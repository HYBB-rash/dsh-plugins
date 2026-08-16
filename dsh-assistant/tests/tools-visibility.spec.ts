/**
 * Real-composition visibility test (验收返工 §4.1, §5A): with the plugin
 * mounted on a real ToolRuntime + SystemPrompt, assistant tools are
 * root-local — a fresh child scope (what a continuable child gets) must NOT
 * see any `assistant_*` tool. This is the mechanism proof that dropping the
 * child toolFilter.deny cannot leak the assistant surface into workers.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { installReportTool } from '@deepseek-ai/dsh-tool-subagent-report'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.ts'

// This suite proves scoped tool composition, not Telegram connectivity. Using
// the real gateway made `mountReal('telegram')` perform a live getMe request,
// so an unrelated network stall could consume the whole 10-second test budget.
vi.mock('@deepseek-ai/dsh-telegram-gateway', () => ({
  createTelegramHttp: () => ({
    getMe: vi.fn(async () => ({ id: 1, username: 'test' })),
  }),
}))

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-vis-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function mountReal(mode: 'web' | 'telegram' = 'telegram') {
  const ctx = new Context()
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SystemPrompt)
  let rootScope!: ReturnType<typeof createScope>
  // Scopes resolve services through the minting plugin's dependency chain.
  await ctx.plugin(Object.assign((inner: Context) => { rootScope = createScope(inner, { name: 'session-telegram' }) },
    { inject: ['tools', 'systemPrompt'] }))
  const root = {
    id: SessionId('session-telegram'),
    session: { id: SessionId('session-telegram') },
    ctx: rootScope.ctx,
  }
  ctx.provide('agents', {
    roots: () => [root],
    get: () => undefined,
  } as never)
  ctx.provide('subagents', {
    startContinuable: vi.fn(async () => ({ childId: SessionId('child-1'), messageId: 'm1' })),
    interrupt: vi.fn(),
    followup: vi.fn(async () => 'm2'),
  } as never)
  ctx.provide('credentials', { resolve: async () => ({ value: 't' }) } as never)
  const mounted = await ctx.plugin(plugin, {
    mode,
    storePath: join(tempDir(), 'state.sqlite'),
    pollIntervalMs: 1000,
    ...mode === 'telegram' ? {
      token: 't',
      chatId: '1',
      telegramParentSessionId: 'session-telegram',
    } : {},
  } as never)
  return { ctx, rootScope, mounted }
}

describe('child visibility', () => {
  it('the root scope sees assistant tools; a fresh child scope sees none', async () => {
    const { ctx, rootScope, mounted } = await mountReal('telegram')
    const rootNames = ctx.tools.schemas(scopeOf(rootScope.ctx)).map(s => s.name)
    expect(rootNames.some(name => name.startsWith('assistant_'))).toBe(true)
    // A continuable child is materialized in its own fresh scope; it must not
    // inherit the root-local assistant tools.
    let childScope!: ReturnType<typeof createScope>
    await ctx.plugin(Object.assign((inner: Context) => { childScope = createScope(inner, { name: 'child' }) },
      { inject: ['tools', 'systemPrompt'] }))
    const childNames = ctx.tools.schemas(scopeOf(childScope.ctx)).map(s => s.name)
    expect(childNames.some(name => name.startsWith('assistant_'))).toBe(false)
    await mounted.dispose()
  }, 10_000)

  it('web mode roots get assistant tools; a fresh child scope still sees none', async () => {
    const { ctx, rootScope, mounted } = await mountReal('web')
    const rootNames = ctx.tools.schemas(scopeOf(rootScope.ctx)).map(s => s.name)
    expect(rootNames.some(name => name.startsWith('assistant_'))).toBe(true)
    let childScope!: ReturnType<typeof createScope>
    await ctx.plugin(Object.assign((inner: Context) => { childScope = createScope(inner, { name: 'web-child' }) },
      { inject: ['tools', 'systemPrompt'] }))
    const childNames = ctx.tools.schemas(scopeOf(childScope.ctx)).map(s => s.name)
    expect(childNames.some(name => name.startsWith('assistant_'))).toBe(false)
    await mounted.dispose()
  }, 10_000)

  it('an actual continuable-child composition receives the official report tool but no assistant controls', async () => {
    const { ctx, mounted } = await mountReal('telegram')
    let childScope!: ReturnType<typeof createScope>
    await ctx.plugin(Object.assign((inner: Context) => { childScope = createScope(inner, { name: 'continuable-child' }) },
      { inject: ['tools', 'systemPrompt'] }))
    const disposeReport = installReportTool(childScope.ctx, ctx, 'wakeup')
    const childNames = ctx.tools.schemas(scopeOf(childScope.ctx)).map(schema => schema.name)
    expect(childNames).toContain('report')
    expect(childNames.some(name => name.startsWith('assistant_'))).toBe(false)
    disposeReport()
    await mounted.dispose()
  }, 10_000)
})
