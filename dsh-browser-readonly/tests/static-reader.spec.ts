import { createServer } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { readStaticPage } from '../src/static-reader.ts'

describe('static reader', () => {
  it('uses the approved lookup address, sends no credential headers, and reads one bounded document', async () => {
    let headers: Record<string, string | string[] | undefined> = {}
    const server = createServer((request, response) => {
      headers = request.headers
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<title>Public fixture</title><main>readable fixture</main>')
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing test port')
    try {
      const result = await readStaticPage(`http://fixture.test:${address.port}/`, {
        resolveHost: async () => ['127.0.0.1'],
        classifyAddress: address => ({ ok: true, address, family: 4 }),
      })
      if (!result.ok) throw new Error(JSON.stringify(result))
      expect(result.title).toBe('Public fixture')
      expect(result.visibleText).toContain('readable fixture')
      expect(headers.cookie).toBeUndefined()
      expect(headers.authorization).toBeUndefined()
      expect(headers.referer).toBeUndefined()
    } finally {
      server.close()
      await once(server, 'close')
    }
  })

  it('disables the global agent so every request performs this call’s pinned lookup', async () => {
    let lookups = 0
    const remotePorts = new Set<number>()
    const server = createServer((request, response) => {
      remotePorts.add(request.socket.remotePort ?? 0)
      response.setHeader('connection', 'keep-alive')
      response.setHeader('content-type', 'text/plain; charset=utf-8')
      response.end('fixture')
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing test port')
    try {
      const options = {
        resolveHost: async () => { lookups += 1; return ['127.0.0.1'] },
        classifyAddress: (value: string) => ({ ok: true as const, address: value, family: 4 as const }),
      }
      await expect(readStaticPage(`http://pin.fixture:${address.port}/one`, options)).resolves.toMatchObject({ ok: true })
      await expect(readStaticPage(`http://pin.fixture:${address.port}/two`, options)).resolves.toMatchObject({ ok: true })
      expect(lookups).toBe(2)
      expect(remotePorts.size).toBe(2)
    } finally {
      server.close()
      await once(server, 'close')
    }
  })

  it('blocks a mixed DNS answer before opening a socket', async () => {
    const result = await readStaticPage('http://example.test/', {
      resolveHost: async () => ['8.8.8.8', '127.0.0.1'],
    })
    expect(result).toMatchObject({ ok: false, code: 'blocked_address' })
  })

  it('rejects a redirect from public HTTP to private address before requesting it', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 302
      response.setHeader('location', 'http://127.0.0.1/private')
      response.end()
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing test port')
    try {
      const result = await readStaticPage(`http://public.test:${address.port}/`, {
        resolveHost: async host => host === 'public.test' ? ['127.0.0.1'] : ['127.0.0.1'],
        classifyAddress: address => ({ ok: true, address, family: 4 }),
      })
      expect(result).toMatchObject({ ok: false, code: 'blocked_redirect' })
    } finally {
      server.close()
      await once(server, 'close')
    }
  })

  it('closes unneeded infinite redirect and error bodies instead of draining them', async () => {
    for (const statusCode of [302, 500]) {
      let closed = false
      const server = createServer((request, response) => {
        request.socket.once('close', () => { closed = true })
        response.statusCode = statusCode
        if (statusCode === 302) response.setHeader('location', 'https://example.com/')
        response.setHeader('content-type', 'text/plain; charset=utf-8')
        response.write('never-ending')
      }).listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('missing test port')
      try {
        const result = await readStaticPage(`http://body.fixture:${address.port}/`, {
          resolveHost: async () => ['127.0.0.1'],
          classifyAddress: value => ({ ok: true, address: value, family: 4 }),
          totalTimeoutMs: 500,
        })
        expect(result.ok).toBe(false)
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(closed).toBe(true)
      } finally {
        server.close()
        await once(server, 'close')
      }
    }
  })

  it('closes an in-progress 200 response on abort and on body-size rejection', async () => {
    for (const mode of ['abort', 'oversize'] as const) {
      let closed = false
      const controller = new AbortController()
      const server = createServer((request, response) => {
        request.socket.once('close', () => { closed = true })
        response.setHeader('content-type', 'text/plain; charset=utf-8')
        if (mode === 'abort') {
          response.write('partial')
          setTimeout(() => controller.abort(), 10)
        } else response.write('x'.repeat(2 * 1024 * 1024 + 1))
      }).listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('missing test port')
      try {
        const result = await readStaticPage(`http://body.fixture:${address.port}/`, {
          signal: controller.signal,
          resolveHost: async () => ['127.0.0.1'],
          classifyAddress: value => ({ ok: true, address: value, family: 4 }),
        })
        expect(result).toMatchObject({ ok: false, code: mode === 'abort' ? 'aborted' : 'response_too_large' })
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(closed).toBe(true)
      } finally {
        server.close()
        await once(server, 'close')
      }
    }
  })

  it('waits for its own pre-header request socket to close before reporting abort', async () => {
    let closed = false
    const controller = new AbortController()
    const server = createServer(request => {
      request.socket.once('close', () => { closed = true })
      setTimeout(() => controller.abort(), 10)
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing test port')
    try {
      const result = await readStaticPage(`http://header.fixture:${address.port}/`, {
        signal: controller.signal,
        resolveHost: async () => ['127.0.0.1'],
        classifyAddress: value => ({ ok: true, address: value, family: 4 }),
      })
      expect(result).toMatchObject({ ok: false, code: 'aborted' })
      expect(closed).toBe(true)
    } finally {
      server.close()
      await once(server, 'close')
    }
  })
})
