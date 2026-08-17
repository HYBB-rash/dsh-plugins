import { describe, expect, it } from 'vitest'
import { EXPLORE_CONTRACT } from '../src/prompt.ts'

describe('exploration prompt contract', () => {
  it('requires evidence-first natural experience and prevents scope expansion', () => {
    for (const phrase of ['先快速查证', '不要先给调查计划', '不要询问是否入池', '普通追问不按轮数', '当前直接用户消息', '写失败、写入不确定或账本 degraded', '不进入 MEMORY', '不创建 dsh-assistant 责任、cron、reminder 或 worker']) expect(EXPLORE_CONTRACT).toContain(phrase)
  })
})
