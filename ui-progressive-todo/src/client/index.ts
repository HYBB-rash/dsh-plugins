/**
 * Progressive TODO tree plugin, browser half: a display-only
 * `conversation.input.dock` strip (id `progressive-todo`) over the standing
 * policy the node half injects into every task assembly. Durable task state
 * stays in TODO.md or the Skill-defined Notion fallback; the browser owns no
 * competing task-state view.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.dock entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PreTaskChecklist } from './PreTaskChecklist.tsx'
import { en, NS, zh, type ProgressiveTodoKey } from './locales.ts'

export { PreTaskChecklist, type PreTaskChecklistProps } from './PreTaskChecklist.tsx'
export type { ProgressiveTodoKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The pre-task thinking strip's copy. */
    'progressive-todo': ProgressiveTodoKey
  }
}

/** Required services: the slot declarations and locale seat. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the dock strip.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-progressive-todo: dictionaries')

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'progressive-todo',
    // Before the goal strip: the pre-task loop belongs right at the composer.
    order: 5,
    locale: NS,
  }, PreTaskChecklist))
}
