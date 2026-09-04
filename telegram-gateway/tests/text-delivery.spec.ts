import { describe, expect, it, vi } from 'vitest'
import {
  createDshTextDeliveryV1,
  TelegramApiError,
  type TelegramHttp,
} from '../src/index.ts'

function telegramHttp(sendMessage: TelegramHttp['sendMessage']): TelegramHttp {
  return {
    getMe: async () => ({ id: 1 }),
    getUpdates: async () => [],
    sendMessage,
  }
}

describe('dshTextDeliveryV1', () => {
  it('delivers every chunk and reports one confirmed completion time', async () => {
    const sendMessage = vi.fn(async () => ({ messageId: 1 }))
    const service = createDshTextDeliveryV1(telegramHttp(sendMessage), () => 42, 2)

    await expect(service.deliver({ text: 'abcd', signal: new AbortController().signal }))
      .resolves.toMatchObject({ state: 'delivered', deliveredAt: expect.any(String) })
    expect(sendMessage.mock.calls.map(([chatId, text]) => [chatId, text])).toEqual([
      [42, 'ab'],
      [42, 'cd'],
    ])
  })

  it('fails without an authorized chat and does not touch Telegram', async () => {
    const sendMessage = vi.fn(async () => ({ messageId: 1 }))
    const service = createDshTextDeliveryV1(telegramHttp(sendMessage), () => undefined, 4096)

    await expect(service.deliver({ text: 'hello', signal: new AbortController().signal }))
      .resolves.toEqual({ state: 'failed', error: 'telegram-gateway: no authorized chat' })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('classifies an explicit first-chunk Telegram rejection as failed', async () => {
    const service = createDshTextDeliveryV1(telegramHttp(async () => {
      throw new TelegramApiError('fatal', 'bot was blocked')
    }), () => 42, 4096)

    await expect(service.deliver({ text: 'hello', signal: new AbortController().signal }))
      .resolves.toEqual({ state: 'failed', error: 'bot was blocked' })
  })

  it('classifies an ambiguous first-chunk transport error as uncertain', async () => {
    const service = createDshTextDeliveryV1(telegramHttp(async () => {
      throw new Error('connection reset')
    }), () => 42, 4096)

    await expect(service.deliver({ text: 'hello', signal: new AbortController().signal }))
      .resolves.toEqual({ state: 'uncertain', error: 'connection reset' })
  })

  it('classifies any error after one confirmed chunk as uncertain', async () => {
    let sends = 0
    const service = createDshTextDeliveryV1(telegramHttp(async () => {
      sends += 1
      if (sends === 2) throw new TelegramApiError('fatal', 'second chunk rejected')
      return { messageId: sends }
    }), () => 42, 2)

    await expect(service.deliver({ text: 'abcd', signal: new AbortController().signal }))
      .resolves.toEqual({ state: 'uncertain', error: 'second chunk rejected' })
  })

  it('classifies cancellation before or during sending as uncertain', async () => {
    const before = new AbortController()
    before.abort(new Error('cancelled before send'))
    const sendBefore = vi.fn(async () => ({ messageId: 1 }))
    const beforeService = createDshTextDeliveryV1(telegramHttp(sendBefore), () => 42, 4096)
    await expect(beforeService.deliver({ text: 'hello', signal: before.signal }))
      .resolves.toEqual({ state: 'uncertain', error: 'cancelled before send' })
    expect(sendBefore).not.toHaveBeenCalled()

    const during = new AbortController()
    const duringService = createDshTextDeliveryV1(telegramHttp(async () => {
      during.abort(new Error('cancelled during send'))
      throw during.signal.reason
    }), () => 42, 4096)
    await expect(duringService.deliver({ text: 'hello', signal: during.signal }))
      .resolves.toEqual({ state: 'uncertain', error: 'cancelled during send' })
  })
})
