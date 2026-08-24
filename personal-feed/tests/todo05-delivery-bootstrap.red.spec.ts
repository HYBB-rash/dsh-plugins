import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []

function snapshot(directory: string): readonly [string, string][] {
  return readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name), 'utf8')])
}

describe('TODO05 DeliveryAndReceipt bootstrap seam', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('exposes the real DeliveryAndReceipt factory before any behavior matrix runs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'todo05-delivery-bootstrap-'))
    temporaryDirectories.push(directory)
    const before = snapshot(directory)
    const production = await import('../src/index.ts') as typeof import('../src/index.ts') & {
      readonly createDeliveryAndReceipt?: unknown
    }

    try {
      expect(typeof production.createDeliveryAndReceipt).toBe('function')
      if (typeof production.createDeliveryAndReceipt === 'function') {
        const seam = production.createDeliveryAndReceipt({ ledgerPath: join(directory, 'delivery.jsonl') })
        expect(typeof seam.acceptFormalFeedContent).toBe('function')
        expect(typeof seam.readFormalFeedContentDeliveryRequest).toBe('function')
        expect(typeof seam.readFormalFeedContentDeliveryRequestForPeriod).toBe('function')
      }
    } finally {
      expect(snapshot(directory)).toEqual(before)
    }
  })
})
