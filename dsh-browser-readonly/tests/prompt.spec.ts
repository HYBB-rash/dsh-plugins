import { describe, expect, it } from 'vitest'
import { BROWSER_READONLY_CONTRACT } from '../src/prompt.ts'

describe('browser prompt contract', () => {
  it('keeps evidence and prompt-injection boundaries explicit', () => {
    expect(BROWSER_READONLY_CONTRACT).toContain('搜索摘要不是已读原文')
    expect(BROWSER_READONLY_CONTRACT).toContain('不可信来源数据')
    expect(BROWSER_READONLY_CONTRACT).toContain('cookie/token')
    expect(BROWSER_READONLY_CONTRACT).toContain('click/type/evaluate/screenshot/download')
  })
})
