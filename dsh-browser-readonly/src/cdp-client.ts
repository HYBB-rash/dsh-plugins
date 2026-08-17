import WebSocket from 'ws'

interface CdpEnvelope {
  readonly id?: number
  readonly result?: unknown
  readonly error?: { readonly message?: string }
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
  readonly signal?: AbortSignal
  readonly abort?: () => void
}

export interface CdpConnectOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** A per-target CDP connection. It owns exactly one WebSocket and no browser-wide state. */
export class CdpClient {
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>()
  private nextId = 1
  private closed = false

  private constructor(private readonly socket: WebSocket, private readonly timeoutMs: number) {
    socket.on('message', raw => this.onMessage(raw.toString()))
    socket.on('error', error => this.failAll(error))
    socket.on('close', () => this.failAll(new Error('CDP WebSocket closed')))
  }

  static async connect(url: string, options: CdpConnectOptions = {}): Promise<CdpClient> {
    if (options.signal?.aborted === true) throw abortError()
    const socket = new WebSocket(url, { handshakeTimeout: options.timeoutMs ?? 10_000 })
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        socket.terminate()
        reject(abortError())
      }
      const cleanup = (): void => {
        options.signal?.removeEventListener('abort', abort)
        socket.removeListener('open', onOpen)
        socket.removeListener('error', onError)
      }
      const onOpen = (): void => { cleanup(); resolve() }
      const onError = (error: Error): void => { cleanup(); reject(error) }
      socket.once('open', onOpen)
      socket.once('error', onError)
      options.signal?.addEventListener('abort', abort, { once: true })
    })
    return new CdpClient(socket, options.timeoutMs ?? 10_000)
  }

  async command(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error('CDP client is closed')
    if (signal?.aborted === true) throw abortError()
    const id = this.nextId++
    return await new Promise<unknown>((resolve, reject) => {
      const abort = (): void => {
        this.removePending(id)
        reject(abortError())
      }
      const timer = setTimeout(() => {
        this.removePending(id)
        reject(new Error(`CDP command timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer, ...(signal !== undefined ? { signal, abort } : {}) })
      signal?.addEventListener('abort', abort, { once: true })
      try { this.socket.send(JSON.stringify({ id, method, params })) }
      catch (error) {
        this.removePending(id)
        reject(error instanceof Error ? error : new Error('CDP send failed'))
      }
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.failAll(new Error('CDP client closed'))
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.socket.terminate()
        resolve()
      }, 2_000)
      this.socket.once('close', () => { clearTimeout(timer); resolve() })
      this.socket.close()
    })
  }

  /** Subscribe to one target-local event; callers must dispose before close. */
  onEvent(method: string, listener: (params: unknown) => void): () => void {
    const listeners = this.listeners.get(method) ?? new Set<(params: unknown) => void>()
    listeners.add(listener)
    this.listeners.set(method, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(method)
    }
  }

  private onMessage(raw: string): void {
    let envelope: CdpEnvelope
    try { envelope = JSON.parse(raw) as CdpEnvelope } catch { return }
    if (typeof envelope.id !== 'number') {
      const event = envelope as CdpEnvelope & { method?: string; params?: unknown }
      if (typeof event.method === 'string') {
        for (const listener of this.listeners.get(event.method) ?? []) {
          try { listener(event.params) } catch { /* event observers cannot break CDP cleanup */ }
        }
      }
      return
    }
    const pending = this.pending.get(envelope.id)
    if (pending === undefined) return
    this.removePending(envelope.id)
    if (envelope.error !== undefined) pending.reject(new Error(envelope.error.message ?? 'CDP command failed'))
    else pending.resolve(envelope.result)
  }

  private removePending(id: number): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (pending.abort !== undefined && pending.signal !== undefined) pending.signal.removeEventListener('abort', pending.abort)
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.removePending(id)
      pending.reject(error)
    }
  }
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}
