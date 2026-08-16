/**
 * Characterization tests for the cron expression engine (src/cron.ts).
 *
 * These lock the CURRENT V1 semantics: 5-field parsing, ranges/steps/lists,
 * day-of-week normalization, day-of-month/day-of-week OR rule, nextAfter,
 * Hermes grace computation, nextRunAfter, and the one-shot catch-up window.
 * They are written against the unmodified implementation.
 */

import { describe, expect, it } from 'vitest'
import {
  computeGraceSeconds,
  isOneShotCatchable,
  nextAfter,
  nextRunAfter,
  parseCron,
  CronParseError,
} from '../src/cron.ts'

const MIN_GRACE = 120
const MAX_GRACE = 7200

describe('parseCron', () => {
  it('parses the every-minute wildcard into full fields', () => {
    const fields = parseCron('* * * * *')
    expect(fields.map(field => field.length)).toEqual([60, 24, 31, 12, 7])
    expect(fields[0]).toEqual([...Array(60).keys()])
    expect(fields[4]).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('parses a step', () => {
    const fields = parseCron('*/15 * * * *')
    expect(fields[0]).toEqual([0, 15, 30, 45])
  })

  it('parses a list and a range', () => {
    expect(parseCron('1,15,30 * * * *')[0]).toEqual([1, 15, 30])
    expect(parseCron('1-5 * * * *')[0]).toEqual([1, 2, 3, 4, 5])
  })

  it('normalizes day-of-week 7 to 0 (Sunday alias)', () => {
    expect(parseCron('* * * * 7')[4]).toEqual([0])
    expect(parseCron('* * * * 0-7')[4]).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('parses a concrete daily expression', () => {
    const fields = parseCron('30 8 * * 1-5')
    expect(fields[0]).toEqual([30])
    expect(fields[1]).toEqual([8])
    expect(fields[4]).toEqual([1, 2, 3, 4, 5])
  })

  it('rejects wrong field counts', () => {
    for (const expr of ['* * * *', '* * * * * *', '']) {
      expect(() => parseCron(expr)).toThrow(CronParseError)
    }
  })

  it('rejects out-of-range and malformed fields', () => {
    for (const expr of ['60 * * * *', '* 24 * * *', '* * 32 * *', '* * * 13 *', '* * * * 8', 'a * * * *', '*/0 * * * *', '1- * * * *']) {
      expect(() => parseCron(expr)).toThrow(CronParseError)
    }
  })
})

describe('nextAfter', () => {
  it('returns the next minute boundary for * * * * *', () => {
    const base = new Date(2026, 7, 14, 10, 0, 30).getTime()
    const next = nextAfter(parseCron('* * * * *'), base)
    expect(new Date(next).toISOString()).toBe(new Date(2026, 7, 14, 10, 1, 0).toISOString())
  })

  it('skips to the following day when the minute has passed', () => {
    const base = new Date(2026, 7, 14, 8, 30, 0).getTime()
    const next = nextAfter(parseCron('30 8 * * *'), base)
    expect(new Date(next).toISOString()).toBe(new Date(2026, 7, 15, 8, 30, 0).toISOString())
  })

  it('jumps to the next matching month/year', () => {
    const base = new Date(2026, 7, 14, 12, 0, 0).getTime()
    const next = nextAfter(parseCron('0 0 1 1 *'), base)
    expect(new Date(next).toISOString()).toBe(new Date(2027, 0, 1, 0, 0, 0).toISOString())
  })

  it('applies day-of-week OR semantics when both day fields are restricted', () => {
    // 2026-08-13 is a Thursday; 2026-08-14 is a Friday. DOM 13 does not match
    // the 14th, but DOW 5 (Friday) does, so the OR rule fires on Friday.
    const base = new Date(2026, 7, 13, 0, 0, 0).getTime()
    const next = nextAfter(parseCron('0 0 13 * 5'), base)
    expect(new Date(next).toISOString()).toBe(new Date(2026, 7, 14, 0, 0, 0).toISOString())
  })

  it('applies day-of-week AND semantics when only DOW is restricted', () => {
    // 2026-08-13 is a Thursday; the next Monday is 2026-08-17.
    const base = new Date(2026, 7, 13, 0, 0, 0).getTime()
    const next = nextAfter(parseCron('0 0 * * 1'), base)
    expect(new Date(next).toISOString()).toBe(new Date(2026, 7, 17, 0, 0, 0).toISOString())
  })
})

describe('computeGraceSeconds', () => {
  it('uses the fixed one-shot grace for once schedules', () => {
    expect(computeGraceSeconds({ kind: 'once', runAt: '2026-08-14T00:00:00Z' })).toBe(120)
  })

  it('clamps short intervals to the minimum grace', () => {
    expect(computeGraceSeconds({ kind: 'interval', minutes: 2 })).toBe(MIN_GRACE)
  })

  it('uses half the interval in the middle of the clamp range', () => {
    expect(computeGraceSeconds({ kind: 'interval', minutes: 10 })).toBe(300)
  })

  it('clamps long intervals to the maximum grace', () => {
    expect(computeGraceSeconds({ kind: 'interval', minutes: 480 })).toBe(MAX_GRACE)
  })

  it('derives the grace from the cron period, clamped', () => {
    expect(computeGraceSeconds({ kind: 'cron', expr: '*/5 * * * *' })).toBe(150)
    expect(computeGraceSeconds({ kind: 'cron', expr: '0 8 * * *' })).toBe(MAX_GRACE)
  })
})

describe('nextRunAfter', () => {
  it('returns the runAt for once schedules', () => {
    const runAt = '2026-08-20T09:00:00.000Z'
    expect(nextRunAfter({ kind: 'once', runAt }, 0)).toBe(Date.parse(runAt))
  })

  it('adds the interval to the anchor', () => {
    const anchor = new Date(2026, 7, 14, 10, 0, 0).getTime()
    expect(nextRunAfter({ kind: 'interval', minutes: 5 }, anchor)).toBe(anchor + 5 * 60_000)
  })

  it('delegates cron schedules to nextAfter', () => {
    const anchor = new Date(2026, 7, 14, 10, 0, 30).getTime()
    expect(nextRunAfter({ kind: 'cron', expr: '* * * * *' }, anchor)).toBe(
      nextAfter(parseCron('* * * * *'), anchor),
    )
  })
})

describe('isOneShotCatchable', () => {
  const now = new Date(2026, 7, 14, 12, 0, 0).getTime()

  it('is true for a once run within the 120s window', () => {
    expect(isOneShotCatchable({ kind: 'once', runAt: new Date(now - 60_000).toISOString() }, now)).toBe(true)
  })

  it('is false for a future once run', () => {
    expect(isOneShotCatchable({ kind: 'once', runAt: new Date(now + 60_000).toISOString() }, now)).toBe(false)
  })

  it('is false beyond the 120s window', () => {
    expect(isOneShotCatchable({ kind: 'once', runAt: new Date(now - 121_000).toISOString() }, now)).toBe(false)
  })

  it('is false for non-once schedules', () => {
    expect(isOneShotCatchable({ kind: 'interval', minutes: 5 }, now)).toBe(false)
  })
})
