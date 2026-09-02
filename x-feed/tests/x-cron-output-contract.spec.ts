import { describe, expect, it } from 'vitest'
import { validateXFeedRichMarkdown } from '../src/x-cron/output-contract.ts'

const valid = `📦 X 洞察 (8/21 12:00)

⭐ 高优先级
- 一条重要内容 (https://x.com/a/status/1)
- 另一条内容 (https://x.com/b/status/2)

🌊 时间线新发现
- 新内容 (https://x.com/c/status/3)
- 新内容二 (https://x.com/c/status/4)
- 新内容三 (https://x.com/c/status/5)

🔄 换口味/随机发现(触发原因: 随机)
- 漫游内容 (https://x.com/d/status/4)
- 漫游内容二 (https://x.com/d/status/5)
- 漫游内容三 (https://x.com/d/status/6)

🎯 主题聚焦:agentic systems
- 主题内容 (https://x.com/e/status/5)
- 主题内容二 (https://x.com/e/status/6)
- 主题内容三 (https://x.com/e/status/7)

📌 信号源
- 跟踪来源 (https://x.com/f/status/6)
- 跟踪来源二 (https://x.com/f/status/7)
- 跟踪来源三 (https://x.com/f/status/8)`

describe('X rich Markdown output guard', () => {
  it('accepts the mature title, section spacing, list and prepared URL contract', () => {
    const result = validateXFeedRichMarkdown(valid, {
      preparedUrls: valid.match(/https:\/\/[^)]+/g)!,
    })
    expect(result).toMatchObject({ ok: true, urls: expect.any(Array) })
  })

  it('requires a blank line after the title and before each present section', () => {
    expect(validateXFeedRichMarkdown(valid.replace('📦 X 洞察 (8/21 12:00)\n\n', '📦 X 洞察 (8/21 12:00)\n'), {
      preparedUrls: valid.match(/https:\/\/[^)]+/g)!,
    })).toMatchObject({ ok: false, code: 'title-spacing' })
    expect(validateXFeedRichMarkdown(valid.replace('\n\n🌊 时间线新发现', '\n🌊 时间线新发现'), {
      preparedUrls: valid.match(/https:\/\/[^)]+/g)!,
    })).toMatchObject({ ok: false, code: 'section-spacing' })
  })

  it('requires continuous list lines inside every present section', () => {
    const broken = valid.replace('- 一条重要内容', '不是列表\n- 一条重要内容')
    expect(validateXFeedRichMarkdown(broken, {
      preparedUrls: valid.match(/https:\/\/[^)]+/g)!,
      maxNonEmptyLines: 21,
    })).toMatchObject({ ok: false, code: 'section-not-list' })
  })

  it('fails closed for extra, missing, duplicate or malformed URLs', () => {
    expect(validateXFeedRichMarkdown(valid.replace('https://x.com/f/status/6', 'https://x.com/extra/status/9'), {
      preparedUrls: valid.match(/https:\/\/[^)]+/g)!,
    })).toMatchObject({ ok: false, code: 'url-set-mismatch' })
    expect(validateXFeedRichMarkdown(valid.replace(' (https://x.com/f/status/6)', ''), {
      preparedUrls: valid.match(/https:\/\/[^)]+/g)!,
    })).toMatchObject({ ok: false, code: 'item-url-missing' })
    expect(validateXFeedRichMarkdown(valid.replace('https://x.com/f/status/6', 'https://x.com/e/status/5'), {
      preparedUrls: valid.match(/https:\/\/[^)]+/g)!,
    })).toMatchObject({ ok: false, code: 'duplicate-url' })
    expect(validateXFeedRichMarkdown(valid.replace('https://x.com/f/status/6', 'not-a-url'), {
      preparedUrls: valid.match(/https:\/\/[^)]+/g)!,
    })).toMatchObject({ ok: false, code: 'item-url-missing' })
  })

  it('enforces the 20 non-empty-line upper bound and UTF-16 size bound', () => {
    expect(valid.split('\n').filter(line => line.trim()).length).toBe(20)
    const tooLong = `${valid}\n- extra (https://x.com/f/status/9)`
    expect(validateXFeedRichMarkdown(tooLong, {
      preparedUrls: [...valid.match(/https:\/\/[^)]+/g)!, 'https://x.com/f/status/9'],
    })).toMatchObject({ ok: false, code: 'too-many-lines' })
    expect(validateXFeedRichMarkdown(valid, { preparedUrls: valid.match(/https:\/\/[^)]+/g)!, maxUtf16CodeUnits: 20 }))
      .toMatchObject({ ok: false, code: 'too-large' })
  })

  it('requires exactly one prepared URL on every list item', () => {
    const urls = valid.match(/https:\/\/[^)]+/g)!
    expect(validateXFeedRichMarkdown(valid.replace(' (https://x.com/a/status/1)', ''), { preparedUrls: urls }))
      .toMatchObject({ ok: false, code: 'item-url-missing' })
    expect(validateXFeedRichMarkdown(valid.replace(' (https://x.com/a/status/1)', ' (https://x.com/a/status/1) (https://x.com/b/status/2)'), { preparedUrls: urls }))
      .toMatchObject({ ok: false, code: 'item-url-multiple' })
  })

  it('does not allow a blank line at the end of the final list', () => {
    expect(validateXFeedRichMarkdown(`${valid}\n`, { preparedUrls: valid.match(/https:\/\/[^)]+/g)! }))
      .toMatchObject({ ok: false, code: 'trailing-blank' })
  })

  it('rejects internal protocol markers, tools, commands, filenames and local paths', () => {
    const urls = valid.match(/https:\/\/[^)]+/g)!
    const internalFragments = [
      'INTERNAL_PROTOCOL',
      'tool-call: x_feed_prepare_delivery',
      'tool_call x_feed_search_topic',
      'tool result: x_feed_explore_candidate',
      'ToOl-ReSuLt: X_Feed_Custom_Tool',
      'prepare-delivery',
      'confirm-prepared',
      'mark-delivered',
      'PREPARE-DELIVERY',
      '/home/herman/.dsh/x_insight_pipeline.py',
      '/tmp/x_insight_package.json',
      'x_browser_navigation_lock.py',
      'X_INSIGHT_PIPELINE.PY',
      '~/.dsh/storages/dsh-x-feed/feedback.jsonl',
      'file:///tmp/trusted-fact-navigation.json',
      'collection.jsonl',
      'topic-search.jsonl',
      'legacy-x-preferences.md',
    ]

    for (const fragment of internalFragments) {
      const output = valid.replace('- 一条重要内容', `- ${fragment} 一条重要内容`)
      expect(validateXFeedRichMarkdown(output, { preparedUrls: urls }), fragment)
        .toMatchObject({ ok: false, code: 'internal-protocol' })
    }
  })

  it('allows ordinary words and non-internal files that still satisfy the X URL contract', () => {
    const urls = valid.match(/https:\/\/[^)]+/g)!
    const ordinaryFragments = [
      '工具 文件 准备投递 Python JSON',
      '普通脚本 script.py',
      '普通链接 [data.json](data.json)',
      '日志 data.jsonl',
    ]

    for (const fragment of ordinaryFragments) {
      const output = valid.replace('- 一条重要内容', `- ${fragment} 一条重要内容`)
      expect(validateXFeedRichMarkdown(output, { preparedUrls: urls }), fragment)
        .toMatchObject({ ok: true })
    }
  })
})
