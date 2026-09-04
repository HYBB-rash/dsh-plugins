import { expect, test } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { apply as maintainedApply } from '../presets/liangshen/tool-bootstrap.mjs'

// Optional read-only comparison against an installed historical release.
const apply = process.env.DSH_LIANGSHEN_BASELINE
  ? (await import(process.env.DSH_LIANGSHEN_BASELINE)).apply
  : maintainedApply

test('current Harness fresh and restored Sessions enter the first request with the bootstrap tools', async () => {
  const handlers = new Map<string, (...args: any[]) => any>()
  apply({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) }, {
    shellTools: ['bash'], commonTools: ['str_replace_editor'], bootstrapMaxTokens: 1024,
  })
  const fresh = Session.create(SessionId('liangshen-fresh'))
  fresh.append('turn/start', { turn: 1 })
  const restored = Session.create(fresh.id, fresh.snapshotEvents(), fresh.header)
  for (const session of [fresh, restored]) {
    const agent = { session }
    const decision = await handlers.get('agent/pre-step')!({ agent }, async () => ({
      kind: 'enter', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }],
    }))
    expect(decision.messages).toHaveLength(1)
    const assembled = await handlers.get('system-prompt/assemble')!(undefined, { agent }, async () => ({
      tools: [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }],
      contexts: [], sections: [{ name: 'deployment:persona', text: 'persona' }],
    }))
    expect(assembled.tools.map((tool: any) => tool.name)).toEqual(['bash', 'str_replace_editor'])
    const request = await handlers.get('agent/request')!({ agent }, async () => ({}))
    expect(request.maxTokens).toBe(1024)
  }
})
