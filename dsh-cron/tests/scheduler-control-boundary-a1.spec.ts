/** Lane A1 boundary guard: scheduler owns timing and must not depend on control RPC readiness. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const schedulerSource = readFileSync(new URL('../src/scheduler.ts', import.meta.url), 'utf8')

describe('scheduler/control boundary', () => {
  it('does not import or ping the manager control service', () => {
    expect(schedulerSource).not.toContain("from './control.ts'")
    expect(schedulerSource).not.toContain("from './control-rpc.ts'")
    expect(schedulerSource).not.toMatch(/readiness\s*\(/)
  })
})
