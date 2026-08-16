// @vitest-environment jsdom
/**
 * ui-progressive-todo browser half: the checklist strip renders collapsed by
 * default, expands to reveal the core loop rows, and the plugin registers and
 * releases the dock entry for HMR safety. The strip is static — no session
 * data, no projection — so the
 * component spec feeds plain props and the registration spec observes the
 * plugin's slot calls through a minimal local registry seam.
 */
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PreTaskChecklist } from '../src/client/PreTaskChecklist.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en, NS, zh, type ProgressiveTodoKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
})

describe('PreTaskChecklist', () => {
  it('renders collapsed with the title and expands on click to show the loop rows', () => {
    const t = (key: ProgressiveTodoKey) => zh[key]
    const { container } = render(<PreTaskChecklist t={t} />)

    const strip = container.querySelector('[aria-label]') as HTMLElement
    expect(strip).not.toBeNull()
    expect(strip.getAttribute('aria-label')).toBe(zh['checklist.title'])
    expect(within(strip).queryByText(zh['checklist.state'])).toBeNull()

    const header = within(strip).getByRole('button')
    fireEvent.click(header)

    expect(within(strip).getByText(zh['checklist.state'])).not.toBeNull()
    expect(within(strip).getByText(zh['checklist.firstPrinciples'])).not.toBeNull()
    expect(within(strip).getByText(zh['checklist.budget'])).not.toBeNull()
    expect(within(strip).getByText(zh['checklist.route'])).not.toBeNull()
    expect(within(strip).getByText(zh['checklist.archive'])).not.toBeNull()
    expect(within(strip).getByText(zh['checklist.skill'])).not.toBeNull()

    fireEvent.click(header)
    expect(within(strip).queryByText(zh['checklist.state'])).toBeNull()
  })

  it('renders English copy for the en locale', () => {
    const t = (key: ProgressiveTodoKey) => en[key]
    const { container } = render(<PreTaskChecklist t={t} />)
    const strip = container.querySelector('[aria-label]') as HTMLElement
    expect(strip.getAttribute('aria-label')).toBe(en['checklist.title'])
  })
})

describe('ui-progressive-todo browser plugin', () => {
  async function bench() {
    type Entry = {
      options: { name: string; id: string; order: number; locale?: string }
      locale?: string
    }
    const bySlot = new Map<string, Entry[]>()
    const disposers: Array<() => void> = []
    const slots = {
      entries(name: string) {
        return bySlot.get(name) ?? []
      },
      inject(_name: string, mount: () => (() => void) | void) {
        const dispose = mount()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      register(options: Entry['options'], _component: unknown) {
        const entries = bySlot.get(options.name) ?? []
        const entry = { options, locale: options.locale }
        entries.push(entry)
        bySlot.set(options.name, entries)
        return () => {
          const index = entries.indexOf(entry)
          if (index >= 0) entries.splice(index, 1)
        }
      },
    }
    const ctx = {
      effect(mount: () => (() => void) | void) {
        const dispose = mount()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      locale: { register: () => () => {} },
      slots,
    }
    apply(ctx as never)
    const fiber = {
      await: async () => {},
      dispose: async () => {
        for (const dispose of disposers.reverse()) dispose()
      },
    }
    return { ctx, fiber }
  }

  it('registers the dock entry and removes it on teardown', async () => {
    const { ctx, fiber } = await bench()
    await fiber.await()
    expect(ctx.slots.entries('conversation.input.dock').map(entry => entry.options.id)).toContain('progressive-todo')

    await fiber.dispose()
    expect(ctx.slots.entries('conversation.input.dock').map(entry => entry.options.id)).not.toContain('progressive-todo')
  })

  it('does not register a competing task-state overlay', async () => {
    const { ctx, fiber } = await bench()
    await fiber.await()
    expect(ctx.slots.entries('shell.overlay')).toEqual([])

    await fiber.dispose()
  })

  it('declares the slots and locale inject edges', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the entry with the progressive-todo id, order, and locale', async () => {
    const { ctx, fiber } = await bench()
    await fiber.await()
    const entry = ctx.slots.entries('conversation.input.dock').find(item => item.options.id === 'progressive-todo')
    expect(entry?.options).toMatchObject({ id: 'progressive-todo', order: 5 })
    expect(entry?.locale).toBe(NS)

    await fiber.dispose()
  })
})
