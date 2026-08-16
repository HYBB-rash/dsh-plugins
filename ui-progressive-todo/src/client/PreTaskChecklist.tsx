/**
 * PreTaskChecklist: the composer-dock strip rendering the standing
 * progressive-todo-tree pre-task loop. Collapsed by default (a 36px row
 * mirroring the GoalBar/TodoPanel posture); expanding reveals the checklist
 * rows inside the same attached panel (QueueDock posture). Pure
 * presentation — no data, no projection: the policy itself lives in the
 * node-half prompt section, and this surface only reminds the human (and
 * the model, through the assembled prompt) of the loop before acting.
 */

import { useId, useState } from 'react'
import { IconChevronDownOutline14, IconChevronUpOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProgressiveTodoKey } from './locales.ts'
import css from './PreTaskChecklist.module.css'

/** Full props of a dock entry: InputZone owner share + the locale seat. */
export type PreTaskChecklistProps = PropsLocale<'progressive-todo'>

/** The checklist rows in stable order; keys are the dictionary keys. */
const CHECKLIST_KEYS: readonly ProgressiveTodoKey[] = [
  'checklist.state',
  'checklist.firstPrinciples',
  'checklist.budget',
  'checklist.route',
  'checklist.archive',
  'checklist.skill',
]

/** Dock adapter: static strip, no session data needed. */
export function PreTaskChecklist({ t }: PreTaskChecklistProps) {
  const [expanded, setExpanded] = useState(false)
  const listId = useId()

  return (
    <section className={css.dock} aria-label={t('checklist.title')}>
      <div className={css.panel}>
        <button
          type="button"
          className={css.header}
          aria-controls={expanded ? listId : undefined}
          aria-expanded={expanded}
          onClick={() => { setExpanded(v => !v) }}
        >
          <span className={css.title}>{t('checklist.title')}</span>
          <span className={css.chevron} aria-hidden>
            {expanded ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
          </span>
        </button>
        {expanded && (
          <div className={css.body} id={listId}>
            <p className={css.leadLine}>{t('checklist.lead')}</p>
            <ul className={css.list}>
              {CHECKLIST_KEYS.map(key => (
                <li key={key} className={css.item}>
                  <span className={css.bullet} aria-hidden />
                  <span>{t(key)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
