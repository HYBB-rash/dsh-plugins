import { describe, expect, it } from 'vitest'
import { EXTRACT_X_STATUS, fixedStatusExpressionHasNoSensitiveRead, readXStatus } from '../src/x-status-reader.ts'

describe('X status reader', () => {
  it('keeps the packaged extractor free of storage, credentials, and caller input', () => {
    expect(fixedStatusExpressionHasNoSensitiveRead()).toBe(true)
    expect(EXTRACT_X_STATUS).not.toMatch(/cookie|localStorage|sessionStorage|authorization|headers|token/iu)
  })

  it('rejects non-status routes before touching lock or CDP', async () => {
    let touched = false
    const result = await readXStatus('https://x.com/messages/compose', {
      acquireLock: async () => { touched = true; throw new Error('must not run') },
    })
    expect(result).toMatchObject({ ok: false, code: 'x_path_forbidden' })
    expect(touched).toBe(false)
  })

  it('rejects a non-default-port X status before touching lock or CDP', async () => {
    let touched = false
    const result = await readXStatus('https://x.com:444/user/status/123', {
      acquireLock: async () => { touched = true; throw new Error('must not run') },
    })
    expect(result).toMatchObject({ ok: false, code: 'x_path_forbidden' })
    expect(touched).toBe(false)
  })

  it('rejects credential-bearing CDP endpoints before lock or CDP access', async () => {
    let touched = false
    const result = await readXStatus('https://x.com/user/status/123', {
      cdpBaseUrl: 'http://user:pass@127.0.0.1:9222',
      acquireLock: async () => { touched = true; throw new Error('must not run') },
    })
    expect(result).toMatchObject({ ok: false, code: 'browser_unavailable' })
    expect(touched).toBe(false)
  })

  it('creates and closes only its exact target after fixed extraction', async () => {
    const calls: string[] = []
    const client = {
      command: async (method: string) => {
        calls.push(method)
        if (method === 'Runtime.evaluate') return { result: { value: {
          currentUrl: 'https://x.com/user/status/123', title: 'A post', text: 'target post', thread: [{ title: '@reply', url: 'https://x.com/r/status/2', text: 'reply' }], loginWall: false,
        } } }
        return {}
      },
      onEvent: (_method: string, listener: (event: unknown) => void) => {
        listener({ type: 'Document', response: { status: 200, url: 'https://x.com/user/status/123' } })
        return () => {}
      },
      close: async () => { calls.push('ws.close') },
    }
    const result = await readXStatus('https://twitter.com/user/status/123?x=1', {
      acquireLock: async () => ({ ok: true, dispose: async () => { calls.push('lock.release') } }),
      httpJson: async (_method, path) => {
        calls.push(path)
        if (path === '/json/version') return {}
        if (path.startsWith('/json/new?')) return { id: 'only-target', webSocketDebuggerUrl: 'ws://127.0.0.1/only-target' }
        if (path === '/json/close/only-target') return {}
        throw new Error(`unexpected ${path}`)
      },
      connect: async () => client,
      wait: async () => undefined,
    })
    expect(result).toMatchObject({ ok: true, retrieval: 'x_cdp', finalUrl: 'https://x.com/user/status/123' })
    if (result.ok) expect(result.visibleText).toContain('target post')
    expect(calls).toContain('/json/close/only-target')
    expect(calls).toContain('ws.close')
    expect(calls).toContain('lock.release')
    expect(calls).not.toContain('/json/close')
  })

  it('does not claim success when exact-target cleanup fails', async () => {
    const client = {
      command: async (method: string) => method === 'Runtime.evaluate' ? { result: { value: { currentUrl: 'https://x.com/user/status/123', title: '', text: 'post', thread: [], loginWall: false } } } : {},
      onEvent: (_method: string, listener: (event: unknown) => void) => {
        listener({ type: 'Document', response: { status: 200, url: 'https://x.com/user/status/123' } })
        return () => {}
      }, close: async () => undefined,
    }
    const result = await readXStatus('https://x.com/user/status/123', {
      acquireLock: async () => ({ ok: true, dispose: async () => undefined }),
      httpJson: async (_method, path) => {
        if (path === '/json/version') return {}
        if (path.startsWith('/json/new?')) return { id: 'target', webSocketDebuggerUrl: 'ws://127.0.0.1/target' }
        throw new Error('close failed')
      },
      connect: async () => client,
      wait: async () => undefined,
    })
    expect(result).toMatchObject({ ok: false, code: 'cleanup_failed' })
  })

  it('fails if the fixed extractor reports another status id', async () => {
    const client = {
      command: async (method: string) => method === 'Runtime.evaluate' ? { result: { value: { currentUrl: 'https://x.com/user/status/999', title: '', text: 'wrong post', thread: [], loginWall: false } } } : {},
      onEvent: (_method: string, listener: (event: unknown) => void) => { listener({ type: 'Document', response: { status: 200, url: 'https://x.com/user/status/123' } }); return () => {} },
      close: async () => undefined,
    }
    const result = await readXStatus('https://x.com/user/status/123', {
      acquireLock: async () => ({ ok: true, dispose: async () => undefined }),
      httpJson: async (_method, path) => path === '/json/version' ? {} : path.startsWith('/json/new?') ? { id: 'target', webSocketDebuggerUrl: 'ws://127.0.0.1/target' } : {},
      connect: async () => client, wait: async () => undefined,
    })
    expect(result).toMatchObject({ ok: false, code: 'navigation_failed' })
  })

  it('marks result truncated when the fixed extractor found more than 20 thread articles', async () => {
    expect(EXTRACT_X_STATUS).toContain('threadTruncated')
    const client = {
      command: async (method: string) => method === 'Runtime.evaluate' ? { result: { value: { currentUrl: 'https://x.com/user/status/123', title: '', text: 'target', thread: [], threadTruncated: true, loginWall: false } } } : {},
      onEvent: (_method: string, listener: (event: unknown) => void) => { listener({ type: 'Document', response: { status: 200, url: 'https://x.com/user/status/123' } }); return () => {} },
      close: async () => undefined,
    }
    const result = await readXStatus('https://x.com/user/status/123', {
      acquireLock: async () => ({ ok: true, dispose: async () => undefined }),
      httpJson: async (_method, path) => path === '/json/version' ? {} : path.startsWith('/json/new?') ? { id: 'target', webSocketDebuggerUrl: 'ws://127.0.0.1/target' } : {},
      connect: async () => client, wait: async () => undefined,
    })
    expect(result).toMatchObject({ ok: true, truncated: true })
  })

  it('uses an independent cleanup signal after navigation abort and still closes exact target', async () => {
    const controller = new AbortController()
    const calls: Array<{ path: string; aborted: boolean | undefined }> = []
    let released = false
    let wsClosed = false
    const client = {
      command: async (method: string) => { if (method === 'Page.navigate') controller.abort(); return {} },
      onEvent: () => () => {}, close: async () => { wsClosed = true },
    }
    const result = await readXStatus('https://x.com/user/status/123', {
      signal: controller.signal,
      acquireLock: async () => ({ ok: true, dispose: async () => { released = true } }),
      httpJson: async (_method, path, signal) => { calls.push({ path, aborted: signal?.aborted }); return path === '/json/version' ? {} : path.startsWith('/json/new?') ? { id: 'owned-target', webSocketDebuggerUrl: 'ws://127.0.0.1/owned-target' } : {} },
      connect: async () => client, wait: async () => undefined,
    })
    expect(result).toMatchObject({ ok: false, code: 'aborted' })
    expect(calls.find(call => call.path === '/json/close/owned-target')).toMatchObject({ aborted: false })
    expect(wsClosed).toBe(true)
    expect(released).toBe(true)
  })

  it('rejects a non-loopback target WebSocket but still closes its exact target', async () => {
    const calls: string[] = []
    const result = await readXStatus('https://x.com/user/status/123', {
      acquireLock: async () => ({ ok: true, dispose: async () => undefined }),
      httpJson: async (_method, path) => { calls.push(path); return path === '/json/version' ? {} : path.startsWith('/json/new?') ? { id: 'owned-target', webSocketDebuggerUrl: 'ws://evil.example/target' } : {} },
      connect: async () => { throw new Error('must not connect') }, wait: async () => undefined,
    })
    expect(result).toMatchObject({ ok: false, code: 'browser_unavailable' })
    expect(calls).toContain('/json/close/owned-target')
  })
})
