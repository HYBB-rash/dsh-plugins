/**
 * dsh-cron manager role: per-root-agent model tools over the durable job log.
 *
 * Mirrors the `schedule` package's per-root registration pattern
 * (`agent/created` + `agent.ctx.effect` + `tools.register(defineTool(...))`),
 * but the durability barrier is `sessions.flush` + an atomic append to
 * `jobs.jsonl` instead of a session event log.
 * @module @deepseek-ai/dsh-cron
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { parseCron, CronParseError } from './cron.ts'
import type { JobStore } from './store.ts'
import type {
  CronCreateOutput,
  CronCreateValue,
  CronDeleteOutput,
  CronJobView,
  CronListOutput,
  CronToolError,
  DeliverChannel,
  Job,
  ScheduleSpec,
} from './types.ts'

/** Validate and normalize a schedule argument, or return a stable error. */
function validateSchedule(value: unknown): { schedule: ScheduleSpec } | CronToolError {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { code: 'invalid_schedule', message: 'schedule must be one of cron, interval, or once.' }
  }
  const record = value as Record<string, unknown>
  const kind = record.kind
  if (kind === 'cron') {
    const expr = record.expr
    if (typeof expr !== 'string' || expr.trim() === '') {
      return { code: 'invalid_schedule', message: 'cron schedule requires a non-empty expr (5-field expression).' }
    }
    try {
      parseCron(expr)
    } catch (error) {
      return {
        code: 'cron_parse_error',
        message: error instanceof CronParseError ? error.message : 'invalid cron expression.',
      }
    }
    return { schedule: { kind: 'cron', expr: expr.trim() } }
  }
  if (kind === 'interval') {
    const minutes = record.minutes
    if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < 1) {
      return { code: 'invalid_schedule', message: 'interval schedule requires minutes as a positive safe integer.' }
    }
    return { schedule: { kind: 'interval', minutes } }
  }
  if (kind === 'once') {
    const runAt = record.runAt
    if (typeof runAt !== 'string' || !Number.isFinite(Date.parse(runAt))) {
      return { code: 'invalid_schedule', message: 'once schedule requires runAt as an RFC 3339 / ISO date-time.' }
    }
    return { schedule: { kind: 'once', runAt } }
  }
  return { code: 'invalid_schedule', message: 'schedule.kind must be "cron", "interval", or "once".' }
}

/** Validate the neutral delivery policy, defaulting to the configured provider. */
function validateDeliver(value: unknown): { deliver: DeliverChannel } | CronToolError {
  if (value === undefined) return { deliver: 'default' }
  if (value === 'default' || value === 'silent') return { deliver: value }
  return { code: 'invalid_deliver', message: 'deliver must be "default" or "silent".' }
}

/** Deterministic model content for every canonical value. */
function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Pure generic pending card. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Stable internal failure. */
function internalError(): CronToolError {
  return { code: 'internal_error', message: 'The cron operation failed.' }
}

/** Persistence uncertainty with the known operation identity. */
function persistenceError(operation: 'create' | 'list' | 'delete', id?: string): CronToolError {
  return {
    code: 'persistence_uncertain',
    message: 'Cron job persistence is uncertain; retry with cron_list before relying on this result.',
    operation,
    ...(id === undefined ? {} : { id }),
  }
}

/** The manager's own validated configuration slice. */
export interface ManagerConfig {
  storeDir: string
}

/** One durable mutation, mirroring the schedule preflight + barrier shape. */
async function commit(
  ctx: Context,
  session: unknown,
  operation: 'create' | 'list' | 'delete',
  mutate: () => string | undefined,
): Promise<CronToolError | undefined> {
  try {
    await ctx.sessions.flush(session as never)
  } catch {
    return persistenceError(operation)
  }
  let id: string | undefined
  try {
    id = mutate()
  } catch {
    return persistenceError(operation)
  }
  // A second flush after the append gives the scheduler a durable barrier too,
  // matching the schedule package's create barrier semantics.
  if (operation !== 'list') {
    try {
      await ctx.sessions.flush(session as never)
    } catch {
      return persistenceError(operation, id)
    }
  }
  return undefined
}

/**
 * Register the three cron tools in one exact root-agent scope.
 * @param rootCtx - global service context (sessions, logger).
 * @param toolCtx - exact agent-scoped context receiving the definitions.
 * @param store - the jobs store (manager is the single writer).
 * @returns disposer for the three registrations.
 */
export function registerCronTools(rootCtx: Context, toolCtx: Context, store: JobStore): () => void {
  const disposers: Array<() => void> = []

  try {
    disposers.push(toolCtx.tools.register(defineTool({
      name: 'cron_create',
      description:
        'Create one unattended cron job that runs a prompt in its own session and delivers '
        + 'the result through the configured delivery provider. Supply a non-empty prompt and exactly one schedule: '
        + 'cron with a 5-field expression (minute hour day-of-month month day-of-week), '
        + 'interval with a positive minutes count, or once with an RFC 3339 runAt. '
        + 'the default delivery policy is "default"; use "silent" to record the run without delivery.',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'The prompt the agent executes when the job fires.',
        },
        schedule: {
          required: true,
          description: 'One schedule kind: cron (5-field expr), interval (minutes), or once (runAt).',
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'cron' },
                expr: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'interval' },
                minutes: { type: 'number', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'once' },
                runAt: { type: 'string', required: true },
              },
            },
          ],
        },
        deliver: {
          type: 'string',
          enum: ['default', 'silent'],
          description: 'Whether to use the default delivery provider. Defaults to default.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the job session. Defaults to the process cwd.',
        },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                prompt: { type: 'string', required: true },
                schedule: { type: 'json', required: true },
                deliver: { type: 'string', required: true },
                createdAt: { type: 'string', required: true },
              },
            },
            { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
          ],
        },
        render: renderValue,
      },
      async execute(args, exec): Promise<CronCreateOutput> {
        if (exec.agent === undefined) return internalError()
        const record = args as Record<string, unknown>
        const prompt = record.prompt
        if (typeof prompt !== 'string' || prompt.trim() === '') {
          return { code: 'invalid_prompt', message: 'prompt must be a non-empty string.' }
        }
        const schedule = validateSchedule(record.schedule)
        if ('code' in schedule) return schedule
        const deliver = validateDeliver(record.deliver)
        if ('code' in deliver) return deliver
        const cwd = record.cwd
        if (cwd !== undefined && typeof cwd !== 'string') {
          return { code: 'invalid_schedule', message: 'cwd must be a string path.' }
        }
        const id = `cron-${randomUUID().slice(0, 8)}`
        const createdAt = new Date().toISOString()
        const uncertain = await commit(rootCtx, exec.agent.session, 'create', () => {
          store.append({
            op: 'create',
            id,
            schedule: schedule.schedule,
            prompt: prompt.trim(),
            deliver: deliver.deliver,
            ...(cwd === undefined ? {} : { cwd }),
            createdAt,
          })
          return id
        })
        if (uncertain !== undefined) return uncertain
        const value: CronCreateValue = {
          id,
          schedule: schedule.schedule,
          prompt: prompt.trim(),
          deliver: deliver.deliver,
          createdAt,
        }
        return value
      },
      presentCall: args => present('Create cron job', 'other', (args as Record<string, unknown>).prompt as string | undefined),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'cron_list',
      description:
        'List every active cron job in creation order with its id, schedule, prompt, '
        + 'delivery channel, and creation time.',
      parameters: {},
      output: {
        schema: {
          oneOf: [
            {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  schedule: { type: 'json', required: true },
                  prompt: { type: 'string', required: true },
                  deliver: { type: 'string', required: true },
                  createdAt: { type: 'string', required: true },
                  cwd: { type: 'string' },
                },
              },
            },
            { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
          ],
        },
        render: renderValue,
      },
      async execute(_args, exec): Promise<CronListOutput> {
        if (exec.agent === undefined) return internalError()
        const uncertain = await commit(rootCtx, exec.agent.session, 'list', () => undefined)
        if (uncertain !== undefined) return uncertain
        const folded = store.fold()
        const views: CronJobView[] = folded.active.filter((job): job is Extract<Job, { readonly kind?: undefined }> => job.kind !== 'command').map(job => ({
          id: job.id,
          schedule: job.schedule,
          prompt: job.prompt,
          deliver: job.deliver,
          createdAt: job.createdAt,
          ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
        }))
        return views
      },
      presentCall: () => present('List cron jobs', 'read'),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'cron_delete',
      description:
        'Delete one cron job by the exact id returned by cron_create or cron_list. '
        + 'Deletion is a durable tombstone; the job stops firing.',
      parameters: {
        id: { type: 'string', required: true, description: 'Exact cron job id.' },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                deleted: { type: 'boolean', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                deleted: { type: 'boolean', required: true, const: false },
                code: { type: 'string', required: true, const: 'job_not_found' },
              },
            },
            { type: 'object', additionalProperties: false, properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } } },
          ],
        },
        render: renderValue,
      },
      async execute(args, exec): Promise<CronDeleteOutput> {
        if (exec.agent === undefined) return internalError()
        const id = (args as Record<string, unknown>).id
        if (typeof id !== 'string' || id.trim() === '' || id.trim() !== id) {
          return { code: 'invalid_schedule', message: 'cron_delete id must be a non-empty string without surrounding whitespace.' }
        }
        const existing = store.fold().active.find(job => job.id === id)
        if (existing === undefined || existing.kind === 'command') {
          return { id, deleted: false, code: 'job_not_found' }
        }
        const uncertain = await commit(rootCtx, exec.agent.session, 'delete', () => {
          store.append({ op: 'delete', id, deletedAt: new Date().toISOString() })
          return id
        })
        if (uncertain !== undefined) return uncertain
        return { id, deleted: true }
      },
      presentCall: args => present('Delete cron job', 'other', (args as Record<string, unknown>).id as string | undefined),
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}
