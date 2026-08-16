/**
 * dsh-cron scheduler role: reload the job log, derive a live timer
 * projection, execute due jobs with unattended agents, deliver results to
 * Telegram, and append every run to the audit log.
 *
 * Timing semantics follow Hermes `cron/jobs.py`:
 * - grace window = half the schedule period, clamped to [120s, 2h];
 * - a due job inside the grace window runs once (catch-up);
 * - a job past the window fast-forwards to the next future occurrence,
 *   skipping accumulated misses, but still executes once now (Hermes
 *   fall-through) so a long-running job never defers indefinitely;
 * - a one-shot past its 120s grace is recorded as expired and never runs.
 *
 * The drive loop mirrors `ScheduleRuntime` (packages/schedule/schedule/
 * src/runtime.ts): a single-flight `requested` bit, MAX_TIMER_DELAY_MS
 * segmented timers, and re-reading the wall clock on every wake.
 * @module @deepseek-ai/dsh-cron
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type AgentHandle,
  type AgentSetup,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  chunkText,
  createTelegramHttp,
  summarizeTurn,
  type TelegramHttp,
  type TurnOutcome,
} from '@deepseek-ai/dsh-telegram-gateway'
import { computeGraceSeconds, nextAfter, nextRunAfter, parseCron } from './cron.ts'
import { JobStore, RunLedger, type FoldedJobRuns } from './store.ts'
import type {
  CronRunFinishedEvent,
  Job,
  RunFinishRecord,
  RunFinishStatus,
} from './types.ts'

/** Largest delay that Node timers represent without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** One-shot grace window, mirroring Hermes ONESHOT_GRACE_SECONDS. */
const ONESHOT_GRACE_MS = 120_000

/** Loose agent surface for driving one turn (same contract as the gateway). */
interface AgentLike {
  session: {
    seq: number
    events: readonly SessionEvent[]
  }
  followup(message: unknown): void
  whenIdle(): Promise<void>
}

/** Resolve a config value or its credential reference (env-inherited first). */
async function resolveSecret(ctx: Context, configured: string | undefined, ref: string): Promise<string | undefined> {
  if (configured !== undefined && configured !== '') return configured
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  const hit = await credentials.resolve(credentialRef(ref))
  return hit?.value
}

/** Wait for an Agent to become idle without holding plugin disposal open. */
async function waitForIdle(agent: AgentLike, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  let onAbort!: () => void
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([agent.whenIdle(), aborted])
    return !signal.aborted
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Drive one turn through the fixed job session and return the outcome. */
async function driveTurn(
  agent: AgentLike,
  text: string,
  sessions: { flush(session: unknown): Promise<void> },
  signal: AbortSignal,
): Promise<TurnOutcome | undefined> {
  if (!await waitForIdle(agent, signal)) return undefined
  const firstSeq = agent.session.seq
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-cron' },
  }))
  if (!await waitForIdle(agent, signal)) return undefined
  await sessions.flush(agent.session)
  if (signal.aborted) return undefined
  return summarizeTurn(agent.session.events, firstSeq)
}

/** Deliver text to Telegram, chunking at the 4096-char cap. */
async function deliverText(
  http: TelegramHttp,
  chatId: number,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const chunk of chunkText(text, 4096)) {
    await http.sendMessage(chatId, chunk, undefined, signal)
  }
}

/** Test seam: drive one agent turn (production default is the module fn). */
export type DriveTurn = (
  agent: AgentLike,
  text: string,
  sessions: { flush(session: unknown): Promise<void> },
  signal: AbortSignal,
) => Promise<TurnOutcome | undefined>

/** Test seam: deliver text (production default is the module fn). */
export type DeliverText = (
  http: TelegramHttp,
  chatId: number,
  text: string,
  signal?: AbortSignal,
) => Promise<void>

/** Optional constructor dependencies used only by tests. */
export interface SchedulerRuntimeDeps {
  driveTurn?: DriveTurn
  deliverText?: DeliverText
}

/** In-memory scheduling state for one active job. */
interface JobState {
  readonly job: Job
  /** Next run instant (epoch ms), or undefined once a one-shot is settled. */
  nextRunAt: number | undefined
  /**
   * In-process claim retry cutoff (epoch ms), independent of the schedule
   * time. Set when a claim append fails so a due job backs off instead of
   * spinning at the 1ms minimum timer. The trigger identity (scheduledFor /
   * runId) is untouched — only the retry cadence is throttled.
   */
  claimRetryNotBefore?: number
}

/** Fixed in-process delay before retrying a failed claim append. */
export const CLAIM_RETRY_DELAY_MS = 5_000

/** Bounded concurrency helper. */
class Semaphore {
  private running = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>(resolve => this.queue.push(resolve))
    this.running++
    try {
      return await task()
    } finally {
      this.running--
      const next = this.queue.shift()
      if (next !== undefined) next()
    }
  }
}

/** The scheduler's validated configuration slice. */
export interface SchedulerConfig {
  storeDir: string
  apiBaseUrl: string
  token?: string
  chatId?: string
  tokenRef: string
  chatIdRef: string
  pollIntervalMs: number
  maxConcurrent: number
  deliverOnError: boolean
}

/**
 * One process-local, disposable projection of the durable job log.
 * Rebuildable from jobs.jsonl + runs.jsonl, so re-mount is safe.
 */
export class SchedulerRuntime {
  private readonly stop = Promise.withResolvers<void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private run: Promise<void> | undefined
  private requested = false
  private stopping = false
  private faulted = false
  private disposal: Promise<void> | undefined
  private readonly jobs = new Map<string, JobState>()
  private readonly handles = new Map<string, AgentHandle>()
  private readonly jobStore: JobStore
  private readonly ledger: RunLedger
  private readonly semaphore: Semaphore
  private readonly driveTurn: DriveTurn
  private readonly deliverText: DeliverText

  constructor(
    private readonly ctx: Context,
    config: SchedulerConfig,
    private readonly http: TelegramHttp,
    private readonly chatId: number,
    private readonly signal: AbortSignal,
    deps: SchedulerRuntimeDeps = {},
  ) {
    this.jobStore = new JobStore(config.storeDir)
    this.ledger = new RunLedger(config.storeDir)
    this.semaphore = new Semaphore(config.maxConcurrent)
    this.deliverOnError = config.deliverOnError
    this.driveTurn = deps.driveTurn ?? driveTurn
    this.deliverText = deps.deliverText ?? deliverText
  }

  private readonly deliverOnError: boolean

  /** Begin the first preflight and timer derivation. */
  start(): void {
    this.requestDrive()
  }

  /** Coalesce triggers: one in-flight run drains every pending request. */
  requestDrive(): void {
    if (this.stopping || this.faulted) return
    this.clearTimer()
    this.requested = true
    if (this.run !== undefined) return
    const run = this.runRequested()
    this.run = run
    void run.then(
      () => { this.retire(run) },
      (error: unknown) => {
        this.ctx.logger.warn(`dsh-cron: scheduler run failed: ${error instanceof Error ? error.message : String(error)}`)
        this.faulted = true
        this.retire(run)
      },
    )
  }

  /** Stop future work, cancel timers, dispose agents, await outstanding work. */
  dispose(): Promise<void> {
    return (this.disposal ??= (async () => {
      this.stopping = true
      this.requested = false
      this.clearTimer()
      this.stop.resolve()
      if (this.run !== undefined) await Promise.allSettled([this.run])
      await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
      this.handles.clear()
    })())
  }

  /** Drain coalesced triggers serially. */
  private async runRequested(): Promise<void> {
    while (this.requested && !this.stopping && !this.faulted) {
      this.requested = false
      try {
        await this.driveOnce()
      } catch (error: unknown) {
        this.ctx.logger.warn(`dsh-cron: drive iteration failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Retire one exact run and honor a trigger that landed during its final microtask. */
  private retire(run: Promise<void>): void {
    if (this.run !== run) return
    this.run = undefined
    if (this.requested && !this.stopping && !this.faulted) this.requestDrive()
  }

  /** Whether this runtime may continue scheduler work. */
  private isRunnable(): boolean {
    return !this.stopping && !this.faulted && !this.signal.aborted
  }

  /** Cancel the currently armed timer, if any. */
  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Arm one bounded timer segment; every wake rechecks the wall clock. */
  private arm(target: number, now: number): void {
    const delay = Math.min(Math.max(target - now, 1), MAX_TIMER_DELAY_MS)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.requestDrive()
    }, delay)
  }

  /** Rebuild the next-run instant from the ledger projection + schedule. */
  private rebuildNextRun(job: Job, folded: FoldedJobRuns): number | undefined {
    if (job.schedule.kind === 'once') {
      // A claim OR any terminal record settles a one-shot forever.
      if (folded.anyRecord) return undefined
      return Date.parse(job.schedule.runAt)
    }
    // A V2 claim/finish carries the authoritative recovery anchor.
    if (folded.nextRunAt !== undefined) return Date.parse(folded.nextRunAt)
    // V1 fallback: anchor off the last finished run, else creation time.
    const base = folded.legacyFinishedAt !== undefined
      ? Date.parse(folded.legacyFinishedAt)
      : Date.parse(job.createdAt)
    if (job.schedule.kind === 'interval') return base + job.schedule.minutes * 60_000
    return nextAfter(parseCron(job.schedule.expr), base)
  }

  /** Synchronize the in-memory projection with the durable job log. */
  private reload(): void {
    const folded = this.jobStore.fold()
    const activeIds = new Set(folded.active.map(job => job.id))
    for (const job of folded.active) {
      const existing = this.jobs.get(job.id)
      if (existing !== undefined) continue
      this.jobs.set(job.id, { job, nextRunAt: this.rebuildNextRun(job, this.ledger.foldJob(job.id)) })
    }
    // Crash orphans: claims without a finish are marked interrupted (audit
    // only — they are settled and must never be re-executed).
    for (const job of folded.active) {
      const runs = this.ledger.foldJob(job.id)
      for (const orphan of runs.interrupted) {
        this.ctx.logger.error(
          `dsh-cron: run ${orphan.runId} was interrupted before finishing; marking interrupted (never re-run)`,
        )
        this.appendFinish(
          job,
          orphan.runId,
          Date.parse(orphan.scheduledFor),
          'interrupted',
          Date.parse(orphan.claimedAt),
          Date.now(),
          orphan.nextRunAt === undefined ? {} : { nextRunAt: Date.parse(orphan.nextRunAt) },
        )
      }
    }
    for (const id of [...this.jobs.keys()]) {
      if (activeIds.has(id)) continue
      this.jobs.delete(id)
      const handle = this.handles.get(id)
      if (handle !== undefined) {
        this.handles.delete(id)
        void handle.dispose()
      }
    }
  }

  /** Stable run id for one trigger point (jobId + consumed schedule time). */
  private static runIdOf(jobId: string, scheduledFor: number): string {
    return `${jobId}@${new Date(scheduledFor).toISOString()}`
  }

  /**
   * Append one V2 finish event atomically. Returns the record only when it
   * truly persisted; undefined when the append failed (the claim stays
   * durable and no forged terminal event may be emitted).
   */
  private appendFinish(
    job: Job,
    runId: string,
    scheduledFor: number,
    status: RunFinishStatus,
    startedAt: number,
    finishedAt: number,
    extra: { nextRunAt?: number; deliveredAt?: string; error?: string; outputPreview?: string } = {},
  ): RunFinishRecord | undefined {
    const record: RunFinishRecord = {
      schemaVersion: 2,
      event: 'finish',
      runId,
      jobId: job.id,
      sessionId: `session-cron-${job.id}`,
      scheduledFor: new Date(scheduledFor).toISOString(),
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      status,
      ...(extra.nextRunAt === undefined ? {} : { nextRunAt: new Date(extra.nextRunAt).toISOString() }),
      ...(extra.deliveredAt === undefined ? {} : { deliveredAt: extra.deliveredAt }),
      ...(extra.error === undefined ? {} : { error: extra.error }),
      ...(extra.outputPreview === undefined ? {} : { outputPreview: extra.outputPreview }),
    }
    try {
      this.ledger.finish(record)
    } catch (error) {
      // The claim stays durable; a lost finish must not enable a replay,
      // but the operator needs a loud, explicit trail.
      this.ctx.logger.error(
        `dsh-cron: finish append failed for ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
    return record
  }

  /**
   * Emit the generic terminal-outcome event (§8). Only called after the
   * finish append truly persisted. Observer failures are bounded: they never
   * rewrite the persisted finish, never re-execute, and never re-deliver.
   */
  private async emitRunFinished(record: RunFinishRecord): Promise<void> {
    const event: CronRunFinishedEvent = {
      jobId: record.jobId,
      runId: record.runId,
      sessionId: record.sessionId,
      scheduledFor: record.scheduledFor,
      status: record.status,
      ...(record.deliveredAt === undefined ? {} : { deliveredAt: record.deliveredAt }),
      ...(record.error === undefined ? {} : { error: record.error }),
    }
    try {
      await this.ctx.parallel('dsh-cron/run-finished', event)
    } catch (error) {
      this.ctx.logger.warn(
        `dsh-cron: run-finished observer failed for ${record.runId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** One full drive: reload, decide due jobs, execute, re-arm. */
  private async driveOnce(): Promise<void> {
    this.clearTimer()
    if (!this.isRunnable()) return
    const now = Date.now()
    this.reload()

    const due: Array<{ state: JobState; scheduledFor: number }> = []
    for (const state of this.jobs.values()) {
      if (state.nextRunAt === undefined || state.nextRunAt > now) continue
      // A failed claim append backs off in-process without moving nextRunAt;
      // the original scheduledFor and runId stay stable for the retry.
      if (state.claimRetryNotBefore !== undefined && now < state.claimRetryNotBefore) continue
      const scheduledFor = state.nextRunAt
      if (state.job.schedule.kind === 'once') {
        if (now - scheduledFor > ONESHOT_GRACE_MS) {
          // Expired one-shots have no external side effect: a finish is
          // enough, no claim is required and none may be re-run.
          const finished = this.appendFinish(
            state.job,
            SchedulerRuntime.runIdOf(state.job.id, scheduledFor),
            scheduledFor,
            'expired',
            scheduledFor,
            now,
          )
          state.nextRunAt = undefined
          if (finished !== undefined) await this.emitRunFinished(finished)
          continue
        }
        due.push({ state, scheduledFor })
        continue
      }
      const graceMs = computeGraceSeconds(state.job.schedule, now) * 1000
      if (now - scheduledFor > graceMs) {
        // Past the catch-up window: fast-forward to the next future
        // occurrence (skip accumulated misses) but still execute once now.
        const forwarded = nextRunAfter(state.job.schedule, now)
        this.ctx.logger.info(
          `dsh-cron: job ${state.job.id} missed its run (${Math.round((now - scheduledFor) / 1000)}s late, grace ${graceMs / 1000}s); fast-forwarding to ${new Date(forwarded).toISOString()} and running once`,
        )
        state.nextRunAt = forwarded
      }
      due.push({ state, scheduledFor })
    }

    if (due.length > 0) {
      await Promise.all(due.map(entry => this.semaphore.run(() => this.executeJob(entry.state, entry.scheduledFor))))
    }

    // Re-arm to the nearest future run, honoring claim backoff so a job with
    // a failing claim wakes at its retry cutoff instead of immediately.
    let target: number | undefined
    for (const state of this.jobs.values()) {
      if (state.nextRunAt === undefined) continue
      if (state.nextRunAt <= Date.now()) {
        if (state.claimRetryNotBefore !== undefined && state.claimRetryNotBefore > Date.now()) {
          if (target === undefined || state.claimRetryNotBefore < target) target = state.claimRetryNotBefore
          continue
        }
        target = Date.now()
        break
      }
      if (target === undefined || state.nextRunAt < target) target = state.nextRunAt
    }
    if (target !== undefined) this.arm(target, Date.now())
  }

  /** Acquire (or create/resume) the fixed session agent for one job. */
  private async acquireAgent(job: Job): Promise<AgentLike> {
    const sessionId = SessionId(`session-cron-${job.id}`)
    const agents = this.ctx.get('agents')
    const defaultModel = this.ctx.get('agentDefaultModel')
    const persistence = this.ctx.get('sessionPersistence')
    if (agents === undefined || defaultModel === undefined || persistence === undefined) {
      throw new Error('dsh-cron: core services unavailable for job execution')
    }
    const live = agents.get(sessionId)
    if (live !== undefined) return live as unknown as AgentLike
    const selection = defaultModel.currentSelection()
    const setup: AgentSetup = (agentCtx) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    }
    const persisted = (await persistence.list(this.signal)).some(header => header.id === sessionId)
    const handle = persisted
      ? await agents.resume({
          resumeSessionId: sessionId,
          agentOptions: { provider: selection.provider, model: selection.model },
          setup,
        })
      : await agents.create({
          sessionId,
          meta: { cwd: job.cwd ?? process.cwd() },
          agentOptions: { provider: selection.provider, model: selection.model },
          setup,
        })
    this.handles.set(job.id, handle)
    return handle.agent as unknown as AgentLike
  }

  /**
   * Execute one due trigger. Order is fixed by the V1.1 contract:
   *   1. derive the stable runId and the crash-recovery nextRunAt;
   *   2. persist the claim — BEFORE any Agent, tool, or Telegram side effect;
   *   3. a failed claim aborts the whole run; an already-claimed trigger is
   *      skipped and the ledger's recovery anchor is adopted;
   *   4. only then acquire the agent, drive the turn, deliver, and finish.
   */
  private async executeJob(state: JobState, scheduledFor: number): Promise<void> {
    const { job } = state
    const runId = SchedulerRuntime.runIdOf(job.id, scheduledFor)
    const crashFallback = job.schedule.kind === 'once'
      ? undefined
      : nextRunAfter(job.schedule, Date.now())

    let claimed: boolean
    try {
      claimed = this.ledger.claim({
        schemaVersion: 2,
        event: 'claim',
        runId,
        jobId: job.id,
        sessionId: `session-cron-${job.id}`,
        scheduledFor: new Date(scheduledFor).toISOString(),
        claimedAt: new Date().toISOString(),
        ...(crashFallback === undefined ? {} : { nextRunAt: new Date(crashFallback).toISOString() }),
      }) === 'claimed'
    } catch (error) {
      // Claim write failed: fail closed — no Agent/tool/Telegram side effect.
      // Back off in-process (schedule time and trigger identity untouched) so
      // driveOnce does not re-wake this due job at the 1ms minimum timer.
      state.claimRetryNotBefore = Date.now() + CLAIM_RETRY_DELAY_MS
      this.ctx.logger.error(
        `dsh-cron: claim failed for ${runId}, run skipped: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    if (!claimed) {
      this.ctx.logger.warn(`dsh-cron: ${runId} already claimed; skipping this trigger`)
      const folded = this.ledger.foldJob(job.id)
      state.nextRunAt = folded.nextRunAt === undefined ? undefined : Date.parse(folded.nextRunAt)
      return
    }
    // The claim landed: clear any backoff and adopt the crash-recovery anchor.
    delete state.claimRetryNotBefore
    if (job.schedule.kind === 'once') {
      state.nextRunAt = undefined
    } else if (crashFallback !== undefined) {
      state.nextRunAt = crashFallback
    }

    const startedAt = Date.now()
    let finishedAt = startedAt
    let outcome: TurnOutcome | undefined
    let executionError: string | undefined
    try {
      const agent = await this.acquireAgent(job)
      const sessions = this.ctx.get('sessions')
      if (sessions === undefined) throw new Error('dsh-cron: sessions service unavailable')
      outcome = await this.driveTurn(agent, job.prompt, sessions as never, this.signal)
      if (this.signal.aborted) return
    } catch (error: unknown) {
      executionError = error instanceof Error ? error.message : String(error)
    }
    finishedAt = Date.now()

    // Re-anchor the next run off the actual finish time (Hermes mark_job_run).
    const finishedNextRunAt = job.schedule.kind === 'once'
      ? undefined
      : nextRunAfter(job.schedule, finishedAt)
    if (finishedNextRunAt !== undefined) state.nextRunAt = finishedNextRunAt

    const errorText = executionError ?? outcome?.error
    if (errorText !== undefined) {
      const finished = this.appendFinish(job, runId, scheduledFor, 'error', startedAt, finishedAt, {
        error: errorText,
        ...(finishedNextRunAt === undefined ? {} : { nextRunAt: finishedNextRunAt }),
      })
      if (finished !== undefined) await this.emitRunFinished(finished)
      if (this.deliverOnError && job.deliver === 'telegram') {
        try {
          await this.deliverText(this.http, this.chatId, `⚠️ cron job ${job.id} 出错：${errorText}`, this.signal)
        } catch (deliveryError: unknown) {
          this.ctx.logger.warn(`dsh-cron: error delivery failed for ${job.id}: ${deliveryError instanceof Error ? deliveryError.message : String(deliveryError)}`)
        }
      }
      return
    }

    const text = outcome?.text ?? ''
    if (job.deliver === 'silent' || text.trim() === '') {
      // Hermes empty-stdout semantics: silence, no delivery.
      const finished = this.appendFinish(job, runId, scheduledFor, 'silent', startedAt, finishedAt, {
        ...(finishedNextRunAt === undefined ? {} : { nextRunAt: finishedNextRunAt }),
      })
      if (finished !== undefined) await this.emitRunFinished(finished)
      return
    }

    try {
      await this.deliverText(this.http, this.chatId, text, this.signal)
      const deliveredAt = new Date().toISOString()
      const finished = this.appendFinish(job, runId, scheduledFor, 'success', startedAt, finishedAt, {
        deliveredAt,
        ...(finishedNextRunAt === undefined ? {} : { nextRunAt: finishedNextRunAt }),
        outputPreview: text.length > 200 ? `${text.slice(0, 200)}…` : text,
      })
      if (finished !== undefined) await this.emitRunFinished(finished)
    } catch (deliveryError: unknown) {
      const message = deliveryError instanceof Error ? deliveryError.message : String(deliveryError)
      const finished = this.appendFinish(job, runId, scheduledFor, 'error', startedAt, finishedAt, {
        error: `delivery failed: ${message}`,
        ...(finishedNextRunAt === undefined ? {} : { nextRunAt: finishedNextRunAt }),
      })
      if (finished !== undefined) await this.emitRunFinished(finished)
      this.ctx.logger.warn(`dsh-cron: delivery failed for ${job.id}: ${message}`)
    }
  }
}

/**
 * Mount the scheduler lifecycle. Resolves credentials first (fails fast on a
 * missing token), validates the token with getMe, then starts the runtime.
 * @param ctx - plugin context carrying core services.
 * @param config - validated scheduler configuration.
 */
export async function applyScheduler(ctx: Context, config: SchedulerConfig): Promise<void> {
  await ctx.effect(async () => {
    const token = await resolveSecret(ctx, config.token, config.tokenRef)
    if (token === undefined || token === '') {
      throw new Error('dsh-cron: TELEGRAM_BOT_TOKEN is required (config token or credential reference)')
    }
    const chatIdRaw = await resolveSecret(ctx, config.chatId, config.chatIdRef)
    const chatId = chatIdRaw !== undefined && chatIdRaw !== '' ? Number(chatIdRaw) : Number.NaN
    if (!Number.isFinite(chatId)) {
      throw new Error(`dsh-cron: invalid allowed chat id "${chatIdRaw ?? ''}" (config chatId or ${config.chatIdRef} credential)`)
    }
    const http = createTelegramHttp(config.apiBaseUrl, token)
    try {
      const me = await http.getMe()
      ctx.logger.info(`dsh-cron: scheduler connected as @${me.username ?? String(me.id)}`)
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-cron: getMe transient failure: ${error instanceof Error ? error.message : String(error)}`)
    }

    const lifetime = new AbortController()
    const runtime = new SchedulerRuntime(ctx, config, http, chatId, lifetime.signal)
    runtime.start()
    const pollTimer = setInterval(() => runtime.requestDrive(), config.pollIntervalMs)
    ctx.logger.info(`dsh-cron: scheduler started (poll ${config.pollIntervalMs}ms, maxConcurrent ${config.maxConcurrent})`)

    return async () => {
      clearInterval(pollTimer)
      lifetime.abort(new Error('dsh-cron scheduler disposed'))
      await runtime.dispose()
    }
  }, 'dsh-cron.scheduler()')
}
