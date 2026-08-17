import { once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { StaticReadFailure } from './static-reader.ts'

export interface BrowserLock {
  readonly ok: true
  readonly dispose: () => Promise<void>
}

export type BrowserLockResult = BrowserLock | StaticReadFailure

export interface BrowserLockOptions {
  readonly path: string
  readonly pythonBin?: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  /** Tests may override only the shipped helper path. */
  readonly helperPath?: string
}

function failure(code: 'lock_timeout' | 'aborted' | 'browser_unavailable', message: string, retryable: boolean): StaticReadFailure {
  return { ok: false, code, message, retryable }
}

function helperPath(): string {
  return fileURLToPath(new URL('../python/flock_holder.py', import.meta.url))
}

async function waitForExit(child: ChildProcess, deadlineMs = 2_000): Promise<void> {
  if (child.exitCode !== null) return
  await Promise.race([
    once(child, 'exit').then(() => undefined),
    new Promise<void>(resolve => setTimeout(resolve, deadlineMs)),
  ])
  if (child.exitCode === null) {
    child.kill('SIGTERM')
    await once(child, 'exit').catch(() => undefined)
  }
}

/** Acquire the exact Python fcntl lock used by dsh-x-feed before CDP access. */
export async function acquireBrowserLock(options: BrowserLockOptions): Promise<BrowserLockResult> {
  if (options.signal?.aborted === true) return failure('aborted', '读取已取消', true)
  const child = spawn(options.pythonBin ?? 'python3', [options.helperPath ?? helperPath(), '--path', options.path], {
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const timeoutMs = options.timeoutMs ?? 10_000
  let buffer = ''
  let settled = false
  return await new Promise<BrowserLockResult>(resolve => {
    const finish = async (value: BrowserLockResult, close = true): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      child.stdout.removeListener('data', onData)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
      if (close) {
        child.stdin?.end()
        await waitForExit(child)
      }
      resolve(value)
    }
    const abort = (): void => { void finish(failure('aborted', '读取已取消', true)) }
    const onExit = (): void => { void finish(failure('browser_unavailable', '浏览器锁 helper 提前退出', true), false) }
    const onError = (): void => { void finish(failure('browser_unavailable', '浏览器锁 helper 无法启动', true), false) }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      if (buffer.includes('LOCKED\n')) {
        void finish({
          ok: true,
          dispose: async () => {
            child.stdin?.end()
            await waitForExit(child)
          },
        }, false)
      }
    }
    const timer = setTimeout(() => { void finish(failure('lock_timeout', '等待 X 浏览器锁超时', true)) }, timeoutMs)
    child.stdout.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
    options.signal?.addEventListener('abort', abort, { once: true })
  })
}
