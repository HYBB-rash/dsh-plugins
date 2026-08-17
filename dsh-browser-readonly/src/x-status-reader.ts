import { acquireBrowserLock, type BrowserLockResult } from './browser-lock.ts'
import { CdpClient } from './cdp-client.ts'
import { normalizeXStatusUrl, type ReadFailureCode } from './policy.ts'
import type { StaticReadFailure } from './static-reader.ts'

interface TargetClient {
  command(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  onEvent(method: string, listener: (params: unknown) => void): () => void
  close(): Promise<void>
}

interface CdpTarget {
  readonly id?: unknown
  readonly webSocketDebuggerUrl?: unknown
}

interface ExtractedX {
  readonly currentUrl?: unknown
  readonly title?: unknown
  readonly text?: unknown
  readonly thread?: unknown
  readonly threadTruncated?: unknown
  readonly loginWall?: unknown
}

export interface XReadSuccess {
  readonly ok: true
  readonly retrieval: 'x_cdp'
  readonly finalUrl: string
  readonly statusCode: number
  readonly title: string
  readonly visibleText: string
  readonly links: Array<{ title: string; url: string }>
  readonly capturedAt: string
  readonly truncated: boolean
}

export type XReadResult = XReadSuccess | StaticReadFailure

export interface XStatusReaderOptions {
  readonly cdpBaseUrl?: string
  readonly browserLockPath?: string
  readonly signal?: AbortSignal
  readonly acquireLock?: () => Promise<BrowserLockResult>
  readonly httpJson?: (method: 'GET' | 'PUT', path: string, signal?: AbortSignal) => Promise<unknown>
  readonly connect?: (url: string, options: { signal?: AbortSignal; timeoutMs?: number }) => Promise<TargetClient>
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  readonly now?: () => Date
}

const EXTRACT_X_STATUS = `(() => {
  const status = location.pathname.match(/^\\/([^/]+)\\/status\\/(\\d+)\\/?$/);
  const id = status?.[2];
  const articles = [...document.querySelectorAll('article')];
  const pick = article => {
    const anchor = [...article.querySelectorAll('a[href*="/status/"]')]
      .find(a => new URL(a.href).pathname.endsWith('/status/' + id));
    return anchor ? article : undefined;
  };
  const target = articles.map(pick).find(Boolean);
  const threadArticles = target ? articles.filter(a => a !== target) : [];
  const loginWall = /log in|sign in/i.test(document.body?.innerText || '') && !target;
  const item = article => ({
    title: (article.querySelector('[data-testid="User-Name"]')?.innerText || '').trim(),
    text: (article.querySelector('[data-testid="tweetText"]')?.innerText || article.innerText || '').trim(),
    url: [...article.querySelectorAll('a[href*="/status/"]')].map(a => a.href).find(Boolean) || '',
  });
  return { currentUrl: location.href, title: document.title || '', text: target ? item(target).text : '',
    thread: threadArticles.slice(0, 20).map(item), threadTruncated: threadArticles.length > 20, loginWall };
})()`

function failure(code: ReadFailureCode, message: string, retryable: boolean): StaticReadFailure {
  return { ok: false, code, message, retryable }
}

class ExpectedFailure extends Error {
  constructor(readonly value: StaticReadFailure) {
    super(value.message)
  }
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError()
}

function isLoopbackWebSocket(value: string): boolean {
  try {
    const url = new URL(value)
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    return (url.protocol === 'ws:' || url.protocol === 'wss:')
      && url.username === '' && url.password === ''
      && ['127.0.0.1', '::1', 'localhost'].includes(hostname)
  } catch { return false }
}

function cleanupSignal(): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('cleanup timeout')), 2_000)
  return { signal: controller.signal, dispose: () => clearTimeout(timer) }
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw abortError()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
    const abort = (): void => { clearTimeout(timer); reject(abortError()) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function defaultHttpJson(base: string, method: 'GET' | 'PUT', path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(new URL(path, base), { method, ...(signal !== undefined ? { signal } : {}) })
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`)
  return await response.json() as unknown
}

function text(value: unknown, limit: number): { value: string; truncated: boolean } {
  const raw = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
  const points = Array.from(raw)
  return points.length > limit ? { value: points.slice(0, limit).join(''), truncated: true } : { value: raw, truncated: false }
}

function fixedStatusExpressionHasNoSensitiveRead(): boolean {
  return !/cookie|localStorage|sessionStorage|authorization|headers|token/iu.test(EXTRACT_X_STATUS)
}

export { EXTRACT_X_STATUS, fixedStatusExpressionHasNoSensitiveRead }

/**
 * Read one public status via an owned target. This is deliberately not a
 * generic browser API: URL, wait, scroll and expression are package constants.
 */
export async function readXStatus(input: string, options: XStatusReaderOptions = {}): Promise<XReadResult> {
  const canonical = normalizeXStatusUrl(input)
  if (canonical === undefined) return failure('x_path_forbidden', 'X 只允许公开 status 页面', false)
  if (!fixedStatusExpressionHasNoSensitiveRead()) return failure('extraction_failed', '固定抽取器安全检查失败', false)
  const base = options.cdpBaseUrl ?? 'http://127.0.0.1:9222'
  let baseUrl: URL
  try { baseUrl = new URL(base) } catch { return failure('browser_unavailable', 'CDP endpoint 无效', true) }
  const baseHostname = baseUrl.hostname.replace(/^\[|\]$/g, '')
  if (baseUrl.protocol !== 'http:' || baseUrl.username !== '' || baseUrl.password !== '' || !['127.0.0.1', '::1', 'localhost'].includes(baseHostname)) {
    return failure('browser_unavailable', 'CDP endpoint 必须是 loopback HTTP', false)
  }
  const httpJson = options.httpJson ?? ((method, path, signal) => defaultHttpJson(base, method, path, signal))
  const connect = options.connect ?? ((url, connectOptions) => CdpClient.connect(url, connectOptions))
  const wait = options.wait ?? delay
  let lock: BrowserLockResult | undefined
  let client: TargetClient | undefined
  let targetId: string | undefined
  let result: XReadResult = failure('navigation_failed', 'X 页面读取失败', true)
  let cleanupFailed = false
  try {
    lock = await (options.acquireLock ?? (() => acquireBrowserLock({
      path: options.browserLockPath ?? '', timeoutMs: 10_000,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })))()
    if (!lock.ok) return lock
    await httpJson('GET', '/json/version', options.signal)
    const created = await httpJson('PUT', `/json/new?${encodeURIComponent('about:blank')}`, options.signal) as CdpTarget
    if (typeof created.id !== 'string' || typeof created.webSocketDebuggerUrl !== 'string') {
      return failure('browser_unavailable', 'CDP 未返回可用新 target', true)
    }
    targetId = created.id
    if (!isLoopbackWebSocket(created.webSocketDebuggerUrl)) {
      throw new ExpectedFailure(failure('browser_unavailable', 'CDP target WebSocket 必须是 loopback', false))
    }
    client = await connect(created.webSocketDebuggerUrl, { timeoutMs: 10_000, ...(options.signal !== undefined ? { signal: options.signal } : {}) })
    let documentStatus = 0
    const stopResponse = client.onEvent('Network.responseReceived', event => {
      const item = event as { type?: unknown; response?: { status?: unknown; url?: unknown } }
      if (item.type === 'Document' && typeof item.response?.status === 'number' && typeof item.response.url === 'string' && normalizeXStatusUrl(item.response.url) === canonical) {
        documentStatus = item.response.status
      }
    })
    try {
      await client.command('Page.enable', {}, options.signal)
      await client.command('Runtime.enable', {}, options.signal)
      await client.command('Network.enable', {}, options.signal)
      await client.command('Page.navigate', { url: canonical }, options.signal)
      throwIfAborted(options.signal)
      await wait(800, options.signal)
      // Bounded, package-owned scrolls only; no model-provided script/selector.
      await client.command('Runtime.evaluate', { expression: 'window.scrollBy(0, window.innerHeight); undefined', returnByValue: true }, options.signal)
      throwIfAborted(options.signal)
      await wait(800, options.signal)
      await client.command('Runtime.evaluate', { expression: 'window.scrollBy(0, window.innerHeight); undefined', returnByValue: true }, options.signal)
      throwIfAborted(options.signal)
      await wait(800, options.signal)
      if (documentStatus < 200 || documentStatus >= 300) {
        throw new ExpectedFailure(failure('navigation_failed', 'X 主文档未确认成功状态', documentStatus === 0 || documentStatus >= 500))
      }
      const evaluated = await client.command('Runtime.evaluate', { expression: EXTRACT_X_STATUS, returnByValue: true }, options.signal) as { result?: { value?: ExtractedX } }
      const extracted = evaluated.result?.value
      if (extracted === undefined) result = failure('extraction_failed', 'X 页面固定抽取失败', false)
      else if (extracted.loginWall === true) result = failure('not_logged_in', 'X 登录状态不可用', false)
      else if (typeof extracted.currentUrl !== 'string' || normalizeXStatusUrl(extracted.currentUrl) !== canonical) result = failure('navigation_failed', 'X 页面离开目标 status', false)
      else {
        const targetText = text(extracted.text, 24_000)
        if (targetText.value === '') result = failure('extraction_failed', '未找到目标公开 status', false)
        else {
          const title = text(extracted.title, 300)
          const links: Array<{ title: string; url: string }> = [{ title: title.value, url: canonical }]
          const lines = [targetText.value]
          let truncated = title.truncated || targetText.truncated || extracted.threadTruncated === true
          if (Array.isArray(extracted.thread)) {
            for (const raw of extracted.thread.slice(0, 20)) {
              const item = raw as { title?: unknown; text?: unknown; url?: unknown }
              const threadText = text(item.text, 1_000)
              const threadTitle = text(item.title, 200)
              if (threadText.value !== '') lines.push(threadText.value)
              if (typeof item.url === 'string' && normalizeXStatusUrl(item.url) !== undefined && links.length < 40) links.push({ title: threadTitle.value, url: normalizeXStatusUrl(item.url)! })
              truncated ||= threadText.truncated || threadTitle.truncated
            }
          }
          const visible = text(lines.join('\n\n'), 24_000)
          result = {
            ok: true, retrieval: 'x_cdp', finalUrl: canonical, statusCode: documentStatus,
            title: title.value, visibleText: visible.value, links,
            capturedAt: (options.now ?? (() => new Date()))().toISOString(), truncated: truncated || visible.truncated,
          }
        }
      }
    } finally {
      stopResponse()
    }
  } catch (error) {
    if (error instanceof ExpectedFailure) result = error.value
    else if (options.signal?.aborted === true || (error as Error).name === 'AbortError') result = failure('aborted', '读取已取消', true)
    else result = failure('navigation_failed', 'X 页面导航失败', true)
  } finally {
    const cleanup = cleanupSignal()
    if (targetId !== undefined) {
      try { await httpJson('GET', `/json/close/${encodeURIComponent(targetId)}`, cleanup.signal) }
      catch { cleanupFailed = true }
    }
    if (client !== undefined) {
      try { await client.close() } catch { cleanupFailed = true }
    }
    if (lock?.ok) {
      try { await lock.dispose() } catch { cleanupFailed = true }
    }
    cleanup.dispose()
  }
  return cleanupFailed ? failure('cleanup_failed', '未能确认自建 X target 已清理', false) : result
}
