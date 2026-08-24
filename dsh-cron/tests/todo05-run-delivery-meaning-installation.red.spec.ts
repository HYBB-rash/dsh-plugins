import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { CRON_RUN_DELIVERY_MEANING_LIFECYCLE } from '../src/run-environment.ts'
import * as publicRoot from '../src/index.ts'

import type {
  CronDeliveryReceipt,
  PreparedDeliveryObject,
} from '../src/index.ts'
import { isValidPreparedDeliveryObject } from '../src/index.ts'

// These generic prepared-delivery contracts remain public provider seams.
type _PublicPreparedDeliveryObject = PreparedDeliveryObject
type _PublicCronDeliveryReceipt = CronDeliveryReceipt
void isValidPreparedDeliveryObject

// Durable run-ledger rows and event constants are scheduler/store internals.
// Each directive is intentionally one-to-one: if any internal name leaks from
// the package root, that directive becomes unused and strict type-checking fails.
type _PublicRootModule = typeof import('../src/index.ts')
type _PublicRootTypes = import('../src/index.ts')
// @ts-expect-error internal durable event must not be exported from the public root
type _NoPreparedDeliveryEvent = _PublicRootModule['PREPARED_DELIVERY_EVENT']
// @ts-expect-error internal durable event must not be exported from the public root
type _NoDeliveryAttemptClaimEvent = _PublicRootModule['DELIVERY_ATTEMPT_CLAIM_EVENT']
// @ts-expect-error internal durable event must not be exported from the public root
type _NoDeliveryReceiptEvent = _PublicRootModule['DELIVERY_RECEIPT_EVENT']
// @ts-expect-error internal durable event must not be exported from the public root
type _NoPrefinishSettleEvent = _PublicRootModule['ENVIRONMENT_PREFINISH_SETTLE_EVENT']
// @ts-expect-error internal durable row must not be exported from the public root
type _NoRunHistoryRecord = _PublicRootTypes['RunHistoryRecord']
// @ts-expect-error internal durable row must not be exported from the public root
type _NoRunPreparedDeliveryRecord = _PublicRootTypes['RunPreparedDeliveryRecord']
// @ts-expect-error internal durable row must not be exported from the public root
type _NoRunDeliveryAttemptClaimRecord = _PublicRootTypes['RunDeliveryAttemptClaimRecord']
// @ts-expect-error internal durable row must not be exported from the public root
type _NoRunDeliveryReceiptRecord = _PublicRootTypes['RunDeliveryReceiptRecord']
// @ts-expect-error internal durable row must not be exported from the public root
type _NoRunEnvironmentPrefinishSettleRecord = _PublicRootTypes['RunEnvironmentPrefinishSettleRecord']

/**
 * TODO05 scheduler-owned meaning-factory installation RED.
 *
 * The installer is package-internal: it receives the real Cordis context and
 * exact scheduler store directory, while the public barrel exposes neither
 * the helper nor the owner factory.
 */
describe('TODO05 run-delivery meaning factory installation', () => {
  it('installs one frozen scheduler-owned factory through the internal helper', async () => {
    const module = await import('../src/run-delivery-meaning.ts') as Record<string, unknown>
    const install = module.provideCronRunDeliveryMeaningPortFactory
    expect(typeof install).toBe('function')
    if (typeof install !== 'function') return

    const ctx = new Context()
    install(ctx, { storeDir: '/tmp/todo05-run-delivery-meaning-installation' })
    const factory = ctx.get(CRON_RUN_DELIVERY_MEANING_LIFECYCLE) as Record<string, unknown>
    expect(Object.isFrozen(factory)).toBe(true)
    expect(Object.keys(factory)).toEqual(['createRunPort'])
    expect(typeof publicRoot.isValidPreparedDeliveryObject).toBe('function')
  })

  it('keeps installation scheduler-owned and tied to config.storeDir', async () => {
    const [schedulerSource, indexSource] = await Promise.all([
      readFile(new URL('../src/scheduler.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/index.ts', import.meta.url), 'utf8'),
    ])
    const helperCalls = schedulerSource.match(
      /provideCronRunDeliveryMeaningPortFactory\s*\(/g,
    ) ?? []
    expect(helperCalls).toHaveLength(1)
    expect(schedulerSource).toMatch(
      /provideCronRunDeliveryMeaningPortFactory\([\s\S]{0,160}config\.storeDir/u,
    )
    expect(indexSource).not.toContain('provideCronRunDeliveryMeaningPortFactory')

    for (const internalExport of [
      'PREPARED_DELIVERY_EVENT',
      'DELIVERY_ATTEMPT_CLAIM_EVENT',
      'DELIVERY_RECEIPT_EVENT',
      'ENVIRONMENT_PREFINISH_SETTLE_EVENT',
      'RunHistoryRecord',
      'RunPreparedDeliveryRecord',
      'RunDeliveryAttemptClaimRecord',
      'RunDeliveryReceiptRecord',
      'RunEnvironmentPrefinishSettleRecord',
    ]) {
      expect(indexSource, `public root source must not export ${internalExport}`).not.toContain(internalExport)
      expect(Object.keys(publicRoot), `public root runtime must not expose ${internalExport}`).not.toContain(internalExport)
    }
  })
})
