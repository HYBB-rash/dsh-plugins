/**
 * Minimal 5-field cron expression parsing and next-occurrence computation.
 *
 * The DSH checkout has no cron library, and Hermes (the alignment target)
 * uses `croniter`. This module implements the standard cron subset those
 * jobs rely on, with croniter-compatible day-of-month / day-of-week OR
 * semantics, plus the Hermes grace-period computation
 * (`_compute_grace_seconds` in `cron/jobs.py`).
 * @module @deepseek-ai/dsh-cron
 */

import type { ScheduleSpec } from './types.ts'

/** 5-field cron expression: minute hour day-of-month month day-of-week. */
export type CronExpression = readonly [Field, Field, Field, Field, Field]

/** One parsed cron field: a sorted set of allowed values. */
export type Field = readonly number[]

const FIELD_MIN = [0, 0, 1, 1, 0] as const
const FIELD_MAX = [59, 23, 31, 12, 7] as const

/** Error from a malformed cron expression. */
export class CronParseError extends Error {
  readonly code = 'cron_parse_error' as const
  constructor(message: string) {
    super(message)
    this.name = 'CronParseError'
  }
}

/** Parse one cron field segment (a single `,`-separated element). */
function parseSegment(segment: string, min: number, max: number, index: number): number[] {
  const trimmed = segment.trim()
  if (trimmed === '') throw new CronParseError(`cron field ${index + 1} is empty`)
  if (trimmed === '*') {
    const out: number[] = []
    for (let v = min; v <= max; v++) out.push(v)
    return out
  }
  const stepMatch = /^(?<base>\*|\d+)(?:-(?<end>\d+))?(?:\/(?<step>\d+))?$/.exec(trimmed)
  if (stepMatch === null) throw new CronParseError(`invalid cron field "${trimmed}" at position ${index + 1}`)
  const { base, end, step } = stepMatch.groups as { base: string; end?: string; step?: string }
  const stepValue = step === undefined ? 1 : Number(step)
  if (!Number.isSafeInteger(stepValue) || stepValue < 1) {
    throw new CronParseError(`invalid step in cron field "${trimmed}" at position ${index + 1}`)
  }
  let from: number
  let to: number
  if (base === '*') {
    from = min
    to = end === undefined ? max : Number(end)
  } else {
    from = Number(base)
    to = end === undefined ? from : Number(end)
  }
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < min || to > max || to < from) {
    throw new CronParseError(`out of range in cron field "${trimmed}" at position ${index + 1}`)
  }
  const out: number[] = []
  for (let v = from; v <= to; v += stepValue) out.push(v)
  return out
}

/** Parse a full 5-field cron expression into sorted fields. */
export function parseCron(expr: string): CronExpression {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new CronParseError(`cron expression must have 5 fields, got ${parts.length}`)
  }
  const fields = parts.map((part, index) => {
    const raw = part.split(',').flatMap(segment => parseSegment(segment, FIELD_MIN[index]!, FIELD_MAX[index]!, index))
    // Normalize day-of-week: 7 is Sunday's alias for 0 (croniter semantics).
    // Keeping it as an extra distinct value would corrupt the "both day
    // fields restricted" test (DOW `*` must span exactly 7 values).
    const normalized = index === 4 ? raw.map(v => (v === 7 ? 0 : v)) : raw
    const unique = [...new Set(normalized)].sort((a, b) => a - b)
    if (unique.length === 0) throw new CronParseError(`cron field ${index + 1} matches nothing`)
    return unique
  })
  return fields as unknown as CronExpression
}

/** Whether day-of-month / day-of-week are both restricted (OR semantics apply). */
function bothDayFieldsRestricted(dom: Field, dow: Field): boolean {
  return dom.length !== 31 && dow.length !== 7
}

/** Normalize day-of-week 0/7 (both Sunday) to 0-6. */
function normalizeDow(value: number): number {
  return value === 7 ? 0 : value
}

/** Whether the candidate date matches the day fields (standard OR rule). */
function dayMatches(dom: Field, dow: Field, date: Date): boolean {
  const domValue = date.getDate()
  const dowValue = normalizeDow(date.getDay())
  if (bothDayFieldsRestricted(dom, dow)) return dom.includes(domValue) || dow.includes(dowValue)
  return dom.includes(domValue) && dow.includes(dowValue)
}

/** Next matching minute strictly greater than the candidate, or undefined when the hour has none. */
function nextMinute(field: Field, candidate: number): number | undefined {
  return field.find(v => v > candidate)
}

/** Next matching hour strictly greater than the candidate, or undefined. */
function nextHour(field: Field, candidate: number): number | undefined {
  return field.find(v => v > candidate)
}

/** Next matching month (1-12) strictly greater than the candidate, or undefined. */
function nextMonth(field: Field, candidate: number): number | undefined {
  return field.find(v => v > candidate)
}

/**
 * Compute the first occurrence strictly after `fromMs`.
 * Iterates by jumping whole units (month/day/hour/minute), so even a
 * yearly expression converges in a few hundred steps.
 */
export function nextAfter(expr: CronExpression, fromMs: number): number {
  const [minuteField, hourField, domField, monthField, dowField] = expr
  // Start at the next minute boundary strictly after fromMs.
  const start = new Date(fromMs)
  start.setSeconds(0, 0)
  start.setMilliseconds(0)
  start.setMinutes(start.getMinutes() + 1)

  const candidate = start
  // Safety bound: about 8 years of minutes (a yearly 2/29 expression needs
  // ~8 iterations through February to reach the next leap day).
  for (let guard = 0; guard < 4_000_000; guard++) {
    const month = candidate.getMonth() + 1
    if (!monthField.includes(month)) {
      const next = nextMonth(monthField, month)
      if (next === undefined) {
        candidate.setFullYear(candidate.getFullYear() + 1, 0, 1)
      } else {
        candidate.setMonth(next - 1, 1)
      }
      candidate.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(domField, dowField, candidate)) {
      candidate.setDate(candidate.getDate() + 1)
      candidate.setHours(0, 0, 0, 0)
      continue
    }
    const hour = candidate.getHours()
    if (!hourField.includes(hour)) {
      const next = nextHour(hourField, hour)
      if (next === undefined) {
        candidate.setDate(candidate.getDate() + 1)
        candidate.setHours(0, 0, 0, 0)
      } else {
        candidate.setHours(next, 0, 0, 0)
      }
      continue
    }
    const minute = candidate.getMinutes()
    if (!minuteField.includes(minute)) {
      const next = nextMinute(minuteField, minute)
      if (next === undefined) {
        candidate.setHours(hour + 1, 0, 0, 0)
      } else {
        candidate.setMinutes(next, 0, 0)
      }
      continue
    }
    return candidate.getTime()
  }
  throw new CronParseError('cron expression has no occurrence within the search horizon')
}

/**
 * Hermes grace window: half the schedule period, clamped to [120s, 2h].
 * For `once` schedules the fixed one-shot grace applies (120s).
 * @param schedule - the job schedule.
 * @param now - wall clock used to measure the cron period.
 */
export function computeGraceSeconds(schedule: ScheduleSpec, now: number = Date.now()): number {
  const MIN_GRACE = 120
  const MAX_GRACE = 7200
  if (schedule.kind === 'once') return 120
  if (schedule.kind === 'interval') {
    const period = schedule.minutes * 60
    return Math.max(MIN_GRACE, Math.min(period / 2, MAX_GRACE))
  }
  // cron: period = distance between two adjacent future occurrences.
  const expr = parseCron(schedule.expr)
  const first = nextAfter(expr, now)
  const second = nextAfter(expr, first)
  const period = (second - first) / 1000
  return Math.max(MIN_GRACE, Math.min(period / 2, MAX_GRACE))
}

/**
 * Compute the next run instant for a fresh job (created now), or advance an
 * existing job's next run to the following occurrence after `after`.
 * @param schedule - the job schedule.
 * @param after - exclusive lower bound for the next occurrence.
 * @returns epoch milliseconds of the next run.
 */
export function nextRunAfter(schedule: ScheduleSpec, after: number): number {
  if (schedule.kind === 'once') return Date.parse(schedule.runAt)
  if (schedule.kind === 'interval') return after + schedule.minutes * 60_000
  return nextAfter(parseCron(schedule.expr), after)
}

/**
 * Whether a missed `once` job is still within its catch-up window.
 * @param schedule - the one-shot schedule.
 * @param now - wall clock.
 */
export function isOneShotCatchable(schedule: ScheduleSpec, now: number): boolean {
  if (schedule.kind !== 'once') return false
  const runAt = Date.parse(schedule.runAt)
  return runAt <= now && now - runAt <= 120_000
}
