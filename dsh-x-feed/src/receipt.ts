/**
 * dsh-x-feed delivery receipt (§11): maps a `dsh-cron/run-finished` terminal
 * event to `x_insight_pipeline.py confirm-prepared` so that shown URLs are
 * written ONLY after Telegram truly delivered (and never on failure).
 *
 * Mapping (§11.2):
 * - `status === success` with `deliveredAt` → `confirm-prepared --status delivered`;
 * - `error | silent | expired | interrupted`, or success without deliveredAt
 *   → `confirm-prepared --status not-delivered`.
 *
 * confirm is idempotent upstream. A single failure is retried with a short
 * backoff, at most 3 attempts; exhaustion throws so `ctx.parallel` records a
 * bounded error — Telegram is never re-delivered and shown is never touched.
 * Calls use `execFile` argument arrays (no shell), a 15s timeout and a 64 KiB
 * output cap.
 * @module @deepseek-ai/dsh-x-feed
 */

import { execFile as nodeExecFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CronRunFinishedEvent } from '@deepseek-ai/dsh-cron'

const execFileAsync = promisify(nodeExecFile)

/** Executable seam matching node:child_process `execFile` semantics. */
export interface ExecFileFn {
  (
    file: string,
    args: readonly string[],
    options: { env: Record<string, string | undefined>; timeout: number; maxBuffer: number },
  ): Promise<{ stdout: string; stderr: string }>
}

/** Constructor dependencies (logger + test seams). */
export interface ReceiptDeps {
  /** Bound cron job id; empty means the receipt stays unbound. */
  readonly cronJobId: string
  /** Harness X data directory (passed to Python via DSH_X_FEED_DATA_DIR). */
  readonly dataDir: string
  /** Python interpreter. Defaults to /usr/bin/python3. */
  readonly pythonBin: string
  /** Path to the shipped `python/x_insight_pipeline.py`. */
  readonly pipelinePath: string
  readonly logger: { warn(message: string): void; error(message: string): void }
  readonly execFile?: ExecFileFn
  readonly sleep?: (ms: number) => Promise<void>
}

/** Result of handling one terminal event. */
export type ReceiptResult =
  | { readonly ok: true; readonly skipped?: true; readonly confirmStatus?: 'delivered' | 'not-delivered' }
  | { readonly ok: false; readonly error: string }

/** The delivery receipt adapter. */
export class DeliveryReceipt {
  static readonly MAX_ATTEMPTS = 3
  static readonly BACKOFF_MS = 500
  static readonly TIMEOUT_MS = 15_000
  static readonly MAX_OUTPUT_BYTES = 64 * 1024

  private readonly execFile: ExecFileFn
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: ReceiptDeps) {
    this.execFile = deps.execFile ?? execFileAsync as unknown as ExecFileFn
    this.sleep = deps.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /** Map one terminal event. Non-target jobs are a no-op. */
  async handle(event: CronRunFinishedEvent): Promise<ReceiptResult> {
    if (this.deps.cronJobId === '') {
      this.deps.logger.warn('dsh-x-feed: receipt 未绑定 cronJobId，忽略终态事件')
      return { ok: false, error: 'receipt_unbound' }
    }
    if (event.jobId !== this.deps.cronJobId) {
      return { ok: true, skipped: true }
    }
    const status = event.status === 'success' && event.deliveredAt !== undefined
      ? 'delivered'
      : 'not-delivered'
    return this.confirm(status)
  }

  /**
   * Run confirm-prepared with bounded retries. Exhaustion throws so the
   * caller's event dispatch records a bounded error; shown is never modified
   * here (only the Python confirm on a real delivered receipt writes shown).
   */
  async confirm(status: 'delivered' | 'not-delivered'): Promise<ReceiptResult> {
    let lastError = 'unknown error'
    for (let attempt = 1; attempt <= DeliveryReceipt.MAX_ATTEMPTS; attempt++) {
      try {
        await this.runConfirm(status)
        return { ok: true, confirmStatus: status }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        this.deps.logger.warn(`dsh-x-feed: confirm-prepared ${status} attempt ${attempt} failed: ${lastError}`)
        if (attempt < DeliveryReceipt.MAX_ATTEMPTS) {
          await this.sleep(DeliveryReceipt.BACKOFF_MS * attempt)
        }
      }
    }
    throw new Error(
      `dsh-x-feed: confirm-prepared ${status} failed after ${DeliveryReceipt.MAX_ATTEMPTS} attempts: ${lastError}`,
    )
  }

  private async runConfirm(status: 'delivered' | 'not-delivered'): Promise<void> {
    const packagePath = join(this.deps.dataDir, 'x_insight_package.json')
    const shownPath = join(this.deps.dataDir, 'x_shown.json')
    const args = [
      this.deps.pipelinePath,
      'confirm-prepared',
      '--status',
      status,
      '--package',
      packagePath,
      '--shown',
      shownPath,
    ]
    const env = { ...process.env, DSH_X_FEED_DATA_DIR: this.deps.dataDir }
    await this.execFile(this.deps.pythonBin, args, {
      env,
      timeout: DeliveryReceipt.TIMEOUT_MS,
      maxBuffer: DeliveryReceipt.MAX_OUTPUT_BYTES,
    })
  }
}
