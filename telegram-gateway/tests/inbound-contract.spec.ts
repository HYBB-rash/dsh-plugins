import { describe, expect, it } from 'vitest'
import type { Events } from '@deepseek-ai/cordis'
import {
  isTelegramInboundEnvelope,
  type TelegramInboundEnvelope,
  type TelegramInboundHandled,
  type TelegramInboundReadyEvent,
  type TelegramInboundResult,
  type TelegramInboundRootDelivered,
  type TelegramInboundWaterfallEvent,
} from '../src/inbound-contract.ts'

const signal = new AbortController().signal

function envelope(): TelegramInboundEnvelope {
  return {
    chat: { id: 7, type: 'private' },
    message: { id: 11 },
    currentText: '当前消息',
    reference: { messageId: 10, selectedText: '被引用选段', messageText: '被引用完整消息' },
    signal,
  }
}

describe('telegram inbound contract', () => {
  it('keeps the envelope limited to transport context', () => {
    const value = envelope()

    expect(Object.keys(value).sort()).toEqual(['chat', 'currentText', 'message', 'reference', 'signal'])
    expect(isTelegramInboundEnvelope(value)).toBe(true)
    expect(isTelegramInboundEnvelope({ ...value, operation: 'save' })).toBe(false)
    expect(isTelegramInboundEnvelope({ ...value, reference: { messageText: '完整消息' } })).toBe(true)
  })

  it('uses terminal outcomes that distinguish interception, failure, and root delivery', () => {
    const handled: TelegramInboundHandled = { kind: 'handled', finalText: '已处理完成' }
    const failed: TelegramInboundResult = { kind: 'failed', visibleError: '处理失败' }
    const delivered: TelegramInboundRootDelivered = { kind: 'root-delivered' }

    expect([handled.kind, failed.kind, delivered.kind]).toEqual([
      'handled', 'failed', 'root-delivered',
    ])
  })

  it('uses the real Cordis ready and waterfall event signatures', () => {
    const ready: TelegramInboundReadyEvent = (value) => {
      expect(value.currentText).toBe('当前消息')
      return true
    }
    const waterfall: TelegramInboundWaterfallEvent = (value, next) => {
      expect(value.message.id).toBe(11)
      return next()
    }

    const events: Pick<Events, 'telegram/inbound/ready' | 'telegram/inbound'> = {
      'telegram/inbound/ready': ready,
      'telegram/inbound': waterfall,
    }
    expect(events['telegram/inbound/ready']).toBe(ready)
    expect(events['telegram/inbound']).toBe(waterfall)
  })
})
