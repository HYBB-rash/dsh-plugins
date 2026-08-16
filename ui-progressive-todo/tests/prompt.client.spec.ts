/** Node-half coverage for the standing pre-task thinking policy. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, inject } from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('ui-progressive-todo node plugin', () => {
  it('registers the pre-task thinking section only while mounted', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    const mounted = ctx.plugin({ apply, inject })
    await mounted.await()

    const section = (await ctx.systemPrompt.assemble()).sections
      .find(entry => entry.name === 'progressive-todo:pre-task-thinking')
    expect(section?.text).toContain('办事前思考')
    expect(section?.text).toContain('从第一性原理重建问题')
    expect(section?.text).toContain('压缩预算')
    expect(section?.text).toContain('progressive-todo-tree')

    await mounted.dispose()
    expect((await ctx.systemPrompt.assemble()).sections
      .some(entry => entry.name === 'progressive-todo:pre-task-thinking')).toBe(false)
  })

  it('puts authority-state work before substantive exploration for applicable tasks', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    const mounted = ctx.plugin({ apply, inject })
    await mounted.await()

    const text = (await ctx.systemPrompt.assemble()).sections
      .find(entry => entry.name === 'progressive-todo:pre-task-thinking')?.text ?? ''
    expect(text).toContain('行动顺序是验收条件')
    expect(text).toContain('第一项实质行动必须是定位并读取或建立唯一权威状态')
    expect(text).toContain('不得先读业务源码、搜索仓库、制定实现计划或调用 todo_write')
    expect(text).toContain('简单、便宜、可逆且规格明确的任务直接完成')
  })

  it('resumes from frozen state without reopening the route or widening the search', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    const mounted = ctx.plugin({ apply, inject })
    await mounted.await()

    const text = (await ctx.systemPrompt.assemble()).sections
      .find(entry => entry.name === 'progressive-todo:pre-task-thinking')?.text ?? ''
    expect(text).toContain('把当前节点、已决路线和重审条件当作默认执行边界')
    expect(text).toContain('不得重新论证已冻结路线、扩大到相邻项目或读取与当前节点无关的材料')
    expect(text).toContain('能回答或执行当前最小行动时就停止探索')
  })
})
