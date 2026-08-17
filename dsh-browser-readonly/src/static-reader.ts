import { Resolver } from 'node:dns/promises'
import * as http from 'node:http'
import * as https from 'node:https'
import type { IncomingMessage, RequestOptions } from 'node:http'
import { extractDocument } from './html-extract.ts'
import {
  classifyAddress as productionClassifyAddress,
  classifyRedirectUrl,
  isHttpsDowngrade,
  type AddressAllowed,
  type PolicyFailure,
  type ReadFailureCode,
} from './policy.ts'

const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5
const STATIC_BUDGET_MS = 30_000
const HOP_FIRST_BYTE_MS = 10_000

export interface StaticReadSuccess {
  readonly ok: true
  readonly retrieval: 'static_http'
  readonly finalUrl: string
  readonly statusCode: number
  readonly title: string
  readonly visibleText: string
  readonly links: Array<{ title: string; url: string }>
  readonly capturedAt: string
  readonly truncated: boolean
}

export interface StaticReadFailure {
  readonly ok: false
  readonly code: ReadFailureCode
  readonly message: string
  readonly retryable: boolean
}

export type StaticReadResult = StaticReadSuccess | StaticReadFailure

export interface StaticReaderOptions {
  readonly signal?: AbortSignal
  /** Test seam. Production resolves each A/AAAA set with a new Resolver. */
  readonly resolveHost?: (hostname: string, signal: AbortSignal) => Promise<string[]>
  /** Test seam; never surfaced through plugin configuration or a model tool. */
  readonly classifyAddress?: (address: string) => AddressAllowed | PolicyFailure
  readonly now?: () => Date
  readonly totalTimeoutMs?: number
}

function fail(code: ReadFailureCode, message: string, retryable = false): StaticReadFailure {
  return { ok: false, code, message, retryable }
}

function isExpectedNoData(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ENOTIMP'
}

async function resolvePublicHost(hostname: string, signal: AbortSignal): Promise<string[]> {
  const resolver = new Resolver()
  const stop = () => resolver.cancel()
  signal.addEventListener('abort', stop, { once: true })
  try {
    const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)])
    if (signal.aborted) throw abortError()
    const addresses: string[] = []
    for (const result of results) {
      if (result.status === 'fulfilled') addresses.push(...result.value)
      else if (!isExpectedNoData(result.reason)) throw result.reason
    }
    return [...new Set(addresses)]
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function contentType(response: IncomingMessage): { readonly mime: string; readonly charset: string } {
  const raw = Array.isArray(response.headers['content-type']) ? response.headers['content-type'][0] : response.headers['content-type']
  const [mime = '', ...parts] = (raw ?? '').toLowerCase().split(';').map((part: string) => part.trim())
  const charset = parts.find((part: string) => part.startsWith('charset='))?.slice('charset='.length) ?? 'utf-8'
  return { mime, charset: charset.replace(/^"|"$/g, '') }
}

interface OneResponse {
  readonly response: IncomingMessage
  readonly request: http.ClientRequest
  readonly close: (reason?: Error) => Promise<void>
}

function waitForClose(emitter: NodeJS.EventEmitter, maximumMs = 2_000): Promise<void> {
  return new Promise(resolve => {
    let timer: NodeJS.Timeout
    const done = (): void => {
      clearTimeout(timer)
      emitter.removeListener('close', done)
      resolve()
    }
    timer = setTimeout(done, maximumMs)
    emitter.once('close', done)
  })
}

async function closeOwned(request: http.ClientRequest, response: IncomingMessage | undefined, reason = new Error('reader closed response')): Promise<void> {
  const requestClosed = waitForClose(request)
  const responseClosed = response === undefined ? Promise.resolve() : waitForClose(response)
  response?.destroy(reason)
  request.destroy(reason)
  await Promise.all([requestClosed, responseClosed])
}

async function requestPinned(url: URL, address: AddressAllowed, signal: AbortSignal): Promise<OneResponse> {
  const client = url.protocol === 'https:' ? https : http
  return await new Promise<OneResponse>((resolve, reject) => {
    let settled = false
    let request: http.ClientRequest | undefined
    let firstByteTimer: NodeJS.Timeout | undefined
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      if (firstByteTimer !== undefined) clearTimeout(firstByteTimer)
      signal.removeEventListener('abort', stop)
      action()
    }
    const rejectAfterClose = (error: Error): void => {
      if (settled || request === undefined) return
      settled = true
      if (firstByteTimer !== undefined) clearTimeout(firstByteTimer)
      signal.removeEventListener('abort', stop)
      void closeOwned(request, undefined, error).finally(() => reject(error))
    }
    const stop = (): void => {
      rejectAfterClose(abortError())
    }
    firstByteTimer = setTimeout(() => {
      rejectAfterClose(new Error('first byte timeout'))
    }, HOP_FIRST_BYTE_MS)
    const options: RequestOptions = {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        'Accept-Encoding': 'identity',
        'User-Agent': 'DSH-Browser-Readonly/0.1',
      },
      // Keep URL hostname for HTTP Host and HTTPS SNI/certificate validation;
      // only the TCP destination comes from the previously approved answer.
      lookup: (_hostname, lookupOptions, callback) => {
        // Node 20+ commonly asks lookup() with all:true. Returning the scalar
        // form there makes net discard the address; honour both contracts.
        if (lookupOptions.all === true) {
          callback(null, [{ address: address.address, family: address.family }] as never)
        } else callback(null, address.address, address.family)
      },
      // A pooled global socket could be connected through a previous DNS
      // answer and skip this call's lookup entirely. Every hop owns its socket.
      agent: false,
    }
    request = client.request(url, options, response => {
      if (firstByteTimer !== undefined) clearTimeout(firstByteTimer)
      const ownedRequest = request
      if (ownedRequest === undefined) {
        response.destroy(new Error('request ownership missing'))
        finish(() => reject(new Error('request ownership missing')))
        return
      }
      finish(() => resolve({ response, request: ownedRequest, close: reason => closeOwned(ownedRequest, response, reason) }))
    })
    request.once('error', error => {
      if (firstByteTimer !== undefined) clearTimeout(firstByteTimer)
      rejectAfterClose(error)
    })
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) { stop(); return }
    request.end()
  })
}

async function readBody(owned: OneResponse, signal: AbortSignal): Promise<Buffer> {
  const { response } = owned
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let finished = false
    const settle = (action: () => void): void => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      action()
    }
    const failAfterClose = (error: Error): void => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      void owned.close(error).finally(() => reject(error))
    }
    const abort = (): void => {
      failAfterClose(abortError())
    }
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        failAfterClose(Object.assign(new Error('response too large'), { code: 'RESPONSE_TOO_LARGE' }))
      } else chunks.push(chunk)
    })
    response.once('end', () => settle(() => resolve(Buffer.concat(chunks))))
    response.once('error', error => settle(() => reject(error)))
    response.once('aborted', () => failAfterClose(abortError()))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

function linkedSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const forward = (): void => controller.abort(parent?.reason)
  parent?.addEventListener('abort', forward, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', forward)
    },
  }
}

/** Static, direct, GET-only reader. It never evaluates page scripts or loads subresources. */
export async function readStaticPage(input: string, options: StaticReaderOptions = {}): Promise<StaticReadResult> {
  let current: URL
  try { current = new URL(input) } catch { return fail('invalid_url', 'URL 无效') }
  const deadline = linkedSignal(options.signal, options.totalTimeoutMs ?? STATIC_BUDGET_MS)
  const resolveHost = options.resolveHost ?? resolvePublicHost
  const classify = options.classifyAddress ?? productionClassifyAddress
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      if (deadline.signal.aborted) return fail(options.signal?.aborted === true ? 'aborted' : 'timeout', '读取已取消或超时', true)
      const rawAddresses = await resolveHost(current.hostname, deadline.signal)
      if (rawAddresses.length === 0) return fail('navigation_failed', 'DNS 未返回可用地址', true)
      const approved = rawAddresses.map(classify)
      if (approved.some(value => !value.ok)) return fail('blocked_address', '目标 DNS 结果包含非公网地址')
      const address = approved[0]
      if (address === undefined || !address.ok) return fail('blocked_address', '目标地址不允许访问')
      let fetched: OneResponse
      try { fetched = await requestPinned(current, address, deadline.signal) }
      catch (error) {
        if (deadline.signal.aborted || (error as Error).name === 'AbortError') return fail(options.signal?.aborted === true ? 'aborted' : 'timeout', '读取已取消或超时', true)
        return fail('navigation_failed', '公开网页请求失败', true)
      }
      const response = fetched.response
      const statusCode = response.statusCode ?? 0
      if (statusCode >= 300 && statusCode < 400) {
        const location = response.headers.location
        await fetched.close()
        if (typeof location !== 'string') return fail('blocked_redirect', '重定向缺少有效目标')
        let next: URL
        try { next = new URL(location, current) } catch { return fail('blocked_redirect', '重定向目标无效') }
        if (isHttpsDowngrade(current, next)) return fail('blocked_redirect', '禁止 HTTPS 降级重定向')
        const allowed = classifyRedirectUrl(next.toString())
        if (!allowed.ok || allowed.kind !== 'static_http') return fail('blocked_redirect', '重定向目标不允许访问')
        if (redirects === MAX_REDIRECTS) return fail('blocked_redirect', '重定向次数超限')
        current = allowed.url
        continue
      }
      if (statusCode < 200 || statusCode >= 300) {
        await fetched.close()
        return fail('navigation_failed', `网页返回 HTTP ${statusCode}`, statusCode >= 500)
      }
      const disposition = response.headers['content-disposition']
      if (typeof disposition === 'string' && /attachment/iu.test(disposition)) {
        await fetched.close()
        return fail('unsupported_content', '拒绝下载附件')
      }
      const declaredLength = Number(response.headers['content-length'])
      if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        await fetched.close()
        return fail('response_too_large', '网页响应过大')
      }
      const type = contentType(response)
      if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(type.mime) || !['utf-8', 'utf8', 'us-ascii', 'ascii'].includes(type.charset)) {
        await fetched.close()
        return fail('unsupported_content', '只支持 UTF-8 或 ASCII 文本页面')
      }
      const encoding = response.headers['content-encoding']
      if (encoding !== undefined && encoding !== '' && encoding !== 'identity') {
        await fetched.close()
        return fail('unsupported_content', '不支持压缩网页响应')
      }
      let body: Buffer
      try { body = await readBody(fetched, deadline.signal) }
      catch (error) {
        if ((error as { code?: string }).code === 'RESPONSE_TOO_LARGE') return fail('response_too_large', '网页响应过大')
        return fail(deadline.signal.aborted ? (options.signal?.aborted === true ? 'aborted' : 'timeout') : 'navigation_failed', '网页正文读取失败', deadline.signal.aborted)
      }
      if (type.mime === 'text/plain') {
        const value = body.toString('utf8')
        const chars = Array.from(value)
        const truncated = chars.length > 24_000
        return {
          ok: true, retrieval: 'static_http', finalUrl: current.toString(), statusCode,
          title: '', visibleText: truncated ? chars.slice(0, 24_000).join('') : value,
          links: [], capturedAt: (options.now ?? (() => new Date()))().toISOString(), truncated,
        }
      }
      const document = extractDocument(body.toString('utf8'), current)
      return {
        ok: true, retrieval: 'static_http', finalUrl: current.toString(), statusCode,
        title: document.title, visibleText: document.visibleText, links: document.links,
        capturedAt: (options.now ?? (() => new Date()))().toISOString(), truncated: document.truncated,
      }
    }
    return fail('blocked_redirect', '重定向次数超限')
  } catch (error) {
    if (deadline.signal.aborted || (error as Error).name === 'AbortError') return fail(options.signal?.aborted === true ? 'aborted' : 'timeout', '读取已取消或超时', true)
    return fail('navigation_failed', '公开网页读取失败', true)
  } finally {
    deadline.dispose()
  }
}
