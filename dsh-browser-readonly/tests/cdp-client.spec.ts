import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { CdpClient } from '../src/cdp-client.ts'

describe('bounded CDP client', () => {
  it('correlates a command response without exposing arbitrary model evaluation', async () => {
    const server = createServer()
    const wss = new WebSocketServer({ server })
    wss.on('connection', socket => socket.on('message', raw => {
      const request = JSON.parse(raw.toString()) as { id: number; method: string }
      socket.send(JSON.stringify({ id: request.id, result: { method: request.method } }))
    }))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing test port')
    const client = await CdpClient.connect(`ws://127.0.0.1:${address.port}`, { timeoutMs: 500 })
    try {
      await expect(client.command('Page.enable')).resolves.toEqual({ method: 'Page.enable' })
    } finally {
      await client.close()
      wss.close()
      server.close()
      await once(server, 'close')
    }
  })

  it('settles a pending command when the caller aborts', async () => {
    const server = createServer()
    const wss = new WebSocketServer({ server })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing test port')
    const client = await CdpClient.connect(`ws://127.0.0.1:${address.port}`, { timeoutMs: 500 })
    const controller = new AbortController()
    controller.abort()
    try {
      await expect(client.command('Page.enable', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await client.close()
      wss.close()
      server.close()
      await once(server, 'close')
    }
  })
})
