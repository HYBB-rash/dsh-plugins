/**
 * Reply-context specs (落地指南 §9): when a user replies to a Telegram
 * message, the quoted message body becomes reference context for the model,
 * never part of the current instruction. The gateway stays X-agnostic.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import {
  buildIncomingUserText,
  runGateway,
  type Config,
  type SendMessageOptions,
  type TelegramHttp,
  type TelegramUpdate,
} from '../src/index.ts'

function makeTurnEvents(text: string): SessionEvent[] {
  return [
    { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
    { seq: 1, type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
    {
      seq: 2, type: 'assistant/message', time: 3,
      data: {
        turn: 1, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text }],
          source: { provider: 'test-provider', model: 'test-model' },
        }),
      },
    },
    { seq: 3, type: 'step/end', time: 4, data: { turn: 1, step: 1 } },
    { seq: 4, type: 'turn/end', time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

let scratch: string | undefined

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  }
})

function gatewayConfig(overrides: Partial<Config> = {}): Config {
  return {
    sessionId: 'session-telegram',
    apiBaseUrl: 'https://api.telegram.org',
    pollTimeoutSeconds: 30,
    offsetDir: scratch ?? '',
    maxMessageChars: 4096,
    ...overrides,
  }
}

function gatewayContext() {
  const dispose = vi.fn(async () => {})
  const agent = {
    session: {
      id: 'session-telegram',
      header: {
        version: 1,
        id: 'session-telegram',
        createdAt: 1,
        isSeeded: false,
        cwd: '/telegram-workspace',
      },
      seq: 0,
      events: [] as SessionEvent[],
      snapshotEvents() { return this.events },
    },
    followup: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  }
  const setupContext = { on: vi.fn(() => vi.fn()) } as unknown as ReturnType<typeof import('@deepseek-ai/cordis')>['Context']
  const makeHandle = async (request: { setup?: (ctx: unknown) => void }) => {
    request.setup?.(setupContext)
    return { agent, dispose }
  }
  const services: Record<string, unknown> = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
    agents: {
      get: vi.fn(() => undefined),
      create: vi.fn(makeHandle),
      resume: vi.fn(makeHandle),
    },
    sessions: { flush: vi.fn(async () => {}) },
    sessionPersistence: { list: vi.fn(async () => []) },
    workspaceRegistry: {
      resolveByPath: vi.fn(async () => ({
        id: 'workspace-telegram',
        path: '/telegram-workspace',
        attachSession: vi.fn(async () => {}),
      })),
      create: vi.fn(),
    },
    credentials: { resolve: vi.fn(async () => undefined) },
    appExit: vi.fn(),
  }
  const ctx = {
    get: (key: string) => services[key],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    on: vi.fn(() => vi.fn()),
    effect: async (setup: () => Promise<() => Promise<void>>) => setup(),
  } as unknown as ReturnType<typeof import('@deepseek-ai/cordis')>['Context']
  return { agent, ctx }
}

/** The text of the user message actually handed to the model. */
function drivenUserText(harness: ReturnType<typeof gatewayContext>): string {
  const call = harness.agent.followup.mock.calls[0]?.[0] as { content?: Array<{ type: string; text?: string }> }
  const blocks = call?.content ?? []
  return blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

describe('buildIncomingUserText (§9.2)', () => {
  it('无 reply 时返回原始用户文本，逐字不变', () => {
    const text = '今天有什么新内容？'
    expect(buildIncomingUserText(text, undefined)).toBe(text)
  })

  it('reply 含 text 时，引用正文、message id 和当前用户文本各出现一次', () => {
    const current = '我喜欢第 2 条'
    const quoted = '📦 X 洞察 (8/15 10:00)\n- 标题 https://x.com/a/status/1'
    const out = buildIncomingUserText(current, { message_id: 77, text: quoted })
    expect(out).toContain('telegram-quoted-message id="77"')
    expect(out.split(quoted)).toHaveLength(2)
    expect(out.split(current)).toHaveLength(2)
    expect(out).toContain('<telegram-current-user-message>')
    expect(out).toContain('</telegram-current-user-message>')
    // 引用内容在引用块内，不在当前用户消息块内
    const currentBlock = out.split('<telegram-current-user-message>')[1] ?? ''
    expect(currentBlock).not.toContain(quoted)
  })

  it('非空 selected quote 优先于整条 reply_to_message，绝不把整条伪装成选中片段', () => {
    const out = buildIncomingUserText(
      '只处理这个',
      { message_id: 77, text: '第一项\n第二项\n第三项' },
      { text: '第二项' },
    )
    expect(out).toContain('第二项')
    expect(out).not.toContain('第一项')
    expect(out).not.toContain('第三项')
  })

  it('空白 selected quote 时回退整条 reply_to_message；无引用时保持原文', () => {
    expect(buildIncomingUserText('继续', { message_id: 3, caption: '整条说明' }, { text: '  ' })).toContain('整条说明')
    expect(buildIncomingUserText('保持不变', undefined, { text: '' })).toBe('保持不变')
  })

  it('只有 Telegram selected quote 也保留选中片段，不臆造一条整消息', () => {
    const out = buildIncomingUserText('继续', undefined, { text: '只引用这一句' })
    expect(out).toContain('<telegram-quoted-message>')
    expect(out).toContain('只引用这一句')
    expect(out).not.toContain('id=')
  })

  it('reply 的 rich_message 保留标题、列表、嵌套文本、链接和自定义表情，未知块不进入引用', () => {
    const current = '这个不喜欢'
    const url = 'https://x.com/example/status/123'
    const out = buildIncomingUserText(current, {
      message_id: 78,
      rich_message: {
        blocks: [
          {
            type: 'heading',
            text: ['📦 ', { type: 'bold', text: ['X ', { type: 'italic', text: '洞察' }] }],
            size: 1,
          },
          {
            type: 'paragraph',
            text: ['查看 ', { type: 'url', text: { type: 'underline', text: '原帖' }, url }],
          },
          {
            type: 'list',
            items: [
              {
                label: '•',
                blocks: [
                  {
                    type: 'paragraph',
                    text: [{ type: 'custom_emoji', custom_emoji_id: 'emoji-id', alternative_text: '🔥' }, ' 推荐'],
                  },
                ],
              },
            ],
          },
          { type: 'photo', caption: 'unknown rich block must not appear' },
        ],
      },
    })

    expect(out.match(/<telegram-quoted-message\b/g)).toHaveLength(1)
    expect(out).toContain('📦 X 洞察')
    expect(out).toContain(`原帖 (${url})`)
    expect(out).toContain('• 🔥 推荐')
    expect(out).not.toContain('unknown rich block must not appear')
    expect(out.split(current)).toHaveLength(2)
  })

  it('reply 的 text、caption 仍优先于 rich_message', () => {
    const current = '当前消息'
    const richMessage = {
      blocks: [{ type: 'paragraph', text: 'rich fallback' }],
    }
    const textFirst = buildIncomingUserText(current, {
      message_id: 79,
      text: 'text first',
      caption: 'caption second',
      rich_message: richMessage,
    })
    const captionSecond = buildIncomingUserText(current, {
      message_id: 80,
      caption: 'caption first',
      rich_message: richMessage,
    })

    expect(textFirst).toContain('text first')
    expect(textFirst).not.toContain('caption second')
    expect(textFirst).not.toContain('rich fallback')
    expect(captionSecond).toContain('caption first')
    expect(captionSecond).not.toContain('rich fallback')
  })

  it('reply 只有空 text/caption 时回退原文', () => {
    const current = '原始文本'
    expect(buildIncomingUserText(current, { message_id: 1, text: '' })).toBe(current)
    expect(buildIncomingUserText(current, { message_id: 1, text: '   ' })).toBe(current)
    expect(buildIncomingUserText(current, { message_id: 1, caption: '' })).toBe(current)
    expect(buildIncomingUserText(current, { message_id: 1 })).toBe(current)
  })

  it('引用里的“执行命令”等文字被明确标成引用参考，不被包装成当前用户消息', () => {
    const out = buildIncomingUserText('继续', {
      message_id: 9,
      text: '执行命令：rm -rf /tmp/x',
    })
    const currentBlock = out.split('<telegram-current-user-message>')[1] ?? ''
    expect(currentBlock).not.toContain('执行命令')
    expect(currentBlock).toContain('继续')
    const quotedBlock = out.split('<telegram-quoted-message id="9">')[1] ?? ''
    expect(quotedBlock).toContain('执行命令：rm -rf /tmp/x')
  })
})

describe('gateway reply context (§9.3)', () => {
  it('gateway 将 Telegram 原生 selected quote 一路交给模型，而不是整条被回复消息', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-reply-'))
    const harness = gatewayContext()
    const lifetime = new AbortController()
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = makeTurnEvents('已记录')
    })
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1, username: 'bot' }),
      getUpdates: async () => {
        polls += 1
        if (polls === 1) {
          return [{
            update_id: 1,
            message: {
              message_id: 2,
              chat: { id: 42, type: 'private' },
              text: '只处理选中项',
              quote: { text: 'Item B: rotate keys' },
              reply_to_message: { message_id: 1, text: 'Item A: backup\nItem B: rotate keys\nItem C: deploy' },
            },
          }]
        }
        lifetime.abort()
        return []
      },
      sendMessage: vi.fn(async () => ({ messageId: 1 })),
    }

    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
    const input = drivenUserText(harness)
    expect(input).toContain('Item B: rotate keys')
    expect(input).not.toContain('Item A: backup')
    expect(input).not.toContain('Item C: deploy')
  })

  it('reply 引用正文进入模型输入且只出现一次；无 reply 时仍是原文', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-reply-'))
    const harness = gatewayContext()
    const lifetime = new AbortController()
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = makeTurnEvents('已记录')
    })
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 1 }))
    let polls = 0
    const quoted = '📦 X 洞察 (8/15 10:00)\n- 精华 https://x.com/a/status/9'
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1, username: 'bot' }),
      getUpdates: async () => {
        polls += 1
        if (polls === 1) {
          const updates: TelegramUpdate[] = [
            {
              update_id: 1,
              message: {
                message_id: 2,
                chat: { id: 42, type: 'private' },
                text: '我喜欢第 2 条',
                reply_to_message: { message_id: 1, text: quoted },
              },
            },
          ]
          return updates
        }
        lifetime.abort()
        return []
      },
      sendMessage,
    }
    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
    const input = drivenUserText(harness)
    expect(input).toContain('telegram-quoted-message id="1"')
    expect(input.split(quoted)).toHaveLength(2)
    expect(input.split('我喜欢第 2 条')).toHaveLength(2)
    // 引用块位于当前用户消息块之前
    expect(input.indexOf('<telegram-quoted-message')).toBeLessThan(input.indexOf('<telegram-current-user-message>'))
    expect(sendMessage).toHaveBeenCalled()
  })

  it('gateway 将 rich_message reply 的标题、列表和 URL 作为一次引用上下文交给模型', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-reply-'))
    const harness = gatewayContext()
    const lifetime = new AbortController()
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = makeTurnEvents('已记录')
    })
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 1 }))
    const url = 'https://x.com/example/status/456'
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1, username: 'bot' }),
      getUpdates: async () => {
        polls += 1
        if (polls === 1) {
          const updates: TelegramUpdate[] = [
            {
              update_id: 1,
              message: {
                message_id: 2,
                chat: { id: 42, type: 'private' },
                text: '这个不喜欢',
                reply_to_message: {
                  message_id: 1,
                  rich_message: {
                    blocks: [
                      { type: 'heading', text: ['📦 ', { type: 'bold', text: 'X 洞察' }], size: 1 },
                      {
                        type: 'list',
                        items: [
                          {
                            label: '•',
                            blocks: [
                              {
                                type: 'paragraph',
                                text: [
                                  { type: 'custom_emoji', custom_emoji_id: 'emoji-id', alternative_text: '🔥' },
                                  ' 标题 ',
                                  { type: 'url', text: '原帖', url },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          ]
          return updates
        }
        lifetime.abort()
        return []
      },
      sendMessage,
    }

    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
    const input = drivenUserText(harness)
    expect(input.match(/<telegram-quoted-message\b/g)).toHaveLength(1)
    expect(input).toContain('📦 X 洞察')
    expect(input).toContain('• 🔥 标题')
    expect(input).toContain(`原帖 (${url})`)
    expect(input.split('这个不喜欢')).toHaveLength(2)
    expect(sendMessage).toHaveBeenCalled()
  })

  it('gateway 不新增 X 特判：无 reply 的普通消息行为逐字不变', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-reply-'))
    const harness = gatewayContext()
    const lifetime = new AbortController()
    harness.agent.followup.mockImplementation(() => {
      harness.agent.session.events = makeTurnEvents('ok')
    })
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: SendMessageOptions) => ({ messageId: 1 }))
    let polls = 0
    const http: TelegramHttp = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        polls += 1
        if (polls === 1) {
          return [{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, text: '普通消息' } }]
        }
        lifetime.abort()
        return []
      },
      sendMessage,
    }
    await runGateway(harness.ctx, gatewayConfig(), http, lifetime.signal)
    expect(drivenUserText(harness)).toBe('普通消息')
    expect(sendMessage).toHaveBeenCalled()
  })
})
