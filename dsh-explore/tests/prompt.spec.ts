import { describe, expect, it } from 'vitest'
import { EXPLORE_CONTRACT } from '../src/prompt.ts'

describe('exploration prompt contract', () => {
  it('requires evidence-first natural experience and prevents scope expansion', () => {
    for (const phrase of ['先快速查证', '不要先给调查计划', '不要询问是否入池', '普通追问不按轮数', '当前直接用户消息', '写失败、写入不确定或账本 degraded', '不进入 MEMORY', '不创建 dsh-assistant 责任、cron、reminder 或 worker']) expect(EXPLORE_CONTRACT).toContain(phrase)
  })

  it('makes explicit X interest enter the one exploration pool instead of legacy parallel storage', () => {
    for (const phrase of [
      '很感兴趣',
      '保存下来继续看',
      '必须调用 exploration_record',
      'x_feed 的 save 不能替代 exploration_record',
      '不得另建 research Markdown',
      'Bash、curl、Python、OpenClaw 脚本或原始 CDP',
    ]) expect(EXPLORE_CONTRACT).toContain(phrase)
  })
})
