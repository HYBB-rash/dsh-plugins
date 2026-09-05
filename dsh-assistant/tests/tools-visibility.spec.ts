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
import { SubagentRunId, type SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.ts'
import { AssistantStore } from '../src/store.ts'
import { WorkerController } from '../src/worker.ts'

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
  const mounted = await ctx.plugin(plugin, {
    mode,
    storePath: join(tempDir(), 'state.sqlite'),
    pollIntervalMs: 1000,
    ...mode === 'telegram' ? { telegramParentSessionId: 'session-telegram' } : {},
  } as never)
  return { ctx, root, rootScope, mounted }
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

  it('published lifecycle completion reaches the outbox while a child has no assistant controls', async () => {
    const { ctx, root, rootScope, mounted } = await mountReal('telegram')
    let childScope!: ReturnType<typeof createScope>
    await ctx.plugin(Object.assign((inner: Context) => { childScope = createScope(inner, { name: 'continuable-child' }) },
      { inject: ['tools', 'systemPrompt'] }))
    const childNames = ctx.tools.schemas(scopeOf(childScope.ctx)).map(schema => schema.name)
    expect(childNames.some(name => name.startsWith('assistant_'))).toBe(false)
    // The published SDK completes through subagent/end; it no longer publishes
    // the old report-tool package. Exercise our listener using real Cordis dispatch.
    const store = new AssistantStore(join(tempDir(), 'completion.sqlite'))
    const identity = { id: SessionId('published-child'), runId: SubagentRunId('published-run'), provider: 'spawn', local: true }
    const worker = new WorkerController({ store, mode: 'telegram', telegramParentSessionId: root.session.id,
      subagents: { interrupt() {}, async startContinuable() {
        rootScope.ctx.emit('subagent/start', identity)
        return { childId: identity.id, messageId: MessageId('published-message') }
      } },
    })
    const delegated = await worker.delegate(root as Agent, { title: 'published SDK', prompt: 'one task' }, new AbortController().signal)
    expect(delegated.ok).toBe(true)
    const completion: SubagentRunEndInfo = { ...identity, stopReason: 'completed', lastAssistantMessage: [
      { type: 'text', text: 'Finished through the published lifecycle.\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"finished"}' },
    ] }
    rootScope.ctx.emit('subagent/end', completion)
    rootScope.ctx.emit('subagent/end', completion)
    expect(store.getByWorkerSessionId(identity.id)).toMatchObject({ status: 'completed', result: 'Finished through the published lifecycle.' })
    expect(store.listPendingOutbox()).toHaveLength(1)
    await mounted.dispose()
    store.close()
  }, 10_000)
})
