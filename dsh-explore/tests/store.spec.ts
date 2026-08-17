import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExplorationStore, type FsSeam } from '../src/store.ts'

const base = { operation: 'keep' as const, sourceUrl: 'https://x.com/a/status/1', title: 'Pi', hook: 'cache', currentFinding: 'finding', nextQuestion: 'why', citations: ['https://x.com/a/status/1'], signal: 'explicit_interest' as const }
const storeAt = async () => { let id = 0; return new ExplorationStore(await mkdtemp(join(tmpdir(), 'dsh-explore-')), { now: () => '2026-08-17T00:00:00.000Z', uuid: () => `10000000-0000-4000-8000-${String(++id).padStart(12, '0')}` }) }

describe('JSONL store', () => {
  it('does not report success until append, fsync, and close complete', async () => { const store = await storeAt(); const result = await store.record(base); expect(result.ok).toBe(true); if (result.ok) expect(result.item.revision).toBe(1) })
  it('queries legal projections while corrupt ledger makes later records fail closed', async () => { const dir = await mkdtemp(join(tmpdir(), 'dsh-explore-')); await writeFile(join(dir, 'events.jsonl'), '{bad\n'); const store = new ExplorationStore(dir); expect((await store.query()).ok).toBe(true); expect((await store.record(base)).ok).toBe(false); expect((await store.record(base) as { code: string }).code).toBe('ledger_degraded') })
  it('classifies partial write and fsync failure as uncertain, never success', async () => { const dir = await mkdtemp(join(tmpdir(), 'dsh-explore-')); let synced = false; const fake: FsSeam = { stat: async () => { const error = Object.assign(new Error(), { code: 'ENOENT' }); throw error }, readFile: async () => '', mkdir: async () => undefined, chmod: async () => undefined, open: async () => ({ write: async (data: Uint8Array) => ({ bytesWritten: Math.min(2, data.byteLength) }), sync: async () => { synced = true; throw new Error('fsync') }, close: async () => undefined }) }; const store = new ExplorationStore(dir, { fs: fake, now: () => '2026-08-17T00:00:00.000Z', uuid: () => '10000000-0000-4000-8000-000000000001' }); const result = await store.record(base); expect(synced).toBe(true); expect(result).toMatchObject({ ok: false, code: 'persistence_uncertain' }) })
  it('serializes concurrent record calls so same URL advances one id', async () => { const store = await storeAt(); await Promise.all([store.record(base), store.record({ ...base, currentFinding: 'new' })]); const result = await store.query(); expect(result.ok && result.total).toBe(1); if (result.ok) expect(result.items[0]?.revision).toBe(2) })
  it('writes JSONL only after successful durable append', async () => { const store = await storeAt(); const result = await store.record(base); expect(result.ok).toBe(true); const file = join((store as unknown as { dataDir: string }).dataDir, 'events.jsonl'); expect((await readFile(file, 'utf8')).endsWith('\n')).toBe(true) })
  it('writes raw bytes across one-byte partial writes without corrupting Chinese text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-explore-')); const chunks: Buffer[] = []
    const fake = { stat: async () => { const error = Object.assign(new Error(), { code: 'ENOENT' }); throw error }, readFile: async () => '', mkdir: async () => undefined, chmod: async () => undefined, open: async () => ({ write: async (data: Buffer) => { chunks.push(Buffer.from(data.subarray(0, 1))); return { bytesWritten: 1 } }, sync: async () => undefined, close: async () => undefined }) } as unknown as FsSeam
    const store = new ExplorationStore(dir, { fs: fake, now: () => '2026-08-17T00:00:00.000Z', uuid: (() => { let i = 0; return () => `10000000-0000-4000-8000-${String(++i).padStart(12, '0')}` })() })
    const result = await store.record({ ...base, hook: '缓存命中', currentFinding: '中文正文不能损坏' })
    expect(result.ok).toBe(true)
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8')).item).toMatchObject({ hook: '缓存命中', currentFinding: '中文正文不能损坏' })
  })
  it('rejects an append that would cross the ledger byte cap without opening or writing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-explore-')); let opened = false
    const fake: FsSeam = { stat: async () => ({ size: 16 * 1024 * 1024 - 1, mode: 0o600 }), readFile: async () => '', mkdir: async () => undefined, chmod: async () => undefined, open: async () => { opened = true; throw new Error('must not open') } }
    const result = await new ExplorationStore(dir, { fs: fake, now: () => '2026-08-17T00:00:00.000Z', uuid: () => '10000000-0000-4000-8000-000000000001' }).record(base)
    expect(result).toMatchObject({ ok: false, code: 'persistence_failed' }); expect(opened).toBe(false)
  })
  it('reports an already oversized ledger as unavailable, never as an empty projection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-explore-')); const fake: FsSeam = { stat: async () => ({ size: 16 * 1024 * 1024 + 1, mode: 0o600 }), readFile: async () => '', mkdir: async () => undefined, chmod: async () => undefined, open: async () => { throw new Error('must not open') } }
    const store = new ExplorationStore(dir, { fs: fake }); expect(await store.query()).toMatchObject({ ok: false, code: 'ledger_unavailable' }); expect(await store.record(base)).toMatchObject({ ok: false, code: 'ledger_unavailable' })
  })
  it('distinguishes open-before-write, interrupted partial write, and close-after-write failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-explore-')); const absentStat = async () => { const error = Object.assign(new Error(), { code: 'ENOENT' }); throw error }
    const common = { stat: absentStat, readFile: async () => '', mkdir: async () => undefined, chmod: async () => undefined }
    const options = { now: () => '2026-08-17T00:00:00.000Z', uuid: (() => { let i = 0; return () => `10000000-0000-4000-8000-${String(++i).padStart(12, '0')}` })() }
    expect(await new ExplorationStore(dir, { fs: { ...common, open: async () => { throw new Error('open') } }, ...options }).record(base)).toMatchObject({ ok: false, code: 'persistence_failed' })
    let writes = 0
    expect(await new ExplorationStore(dir, { fs: { ...common, open: async () => ({ write: async () => { writes++; if (writes === 1) return { bytesWritten: 1 }; throw new Error('write') }, sync: async () => undefined, close: async () => undefined }) }, ...options }).record(base)).toMatchObject({ ok: false, code: 'persistence_uncertain' })
    expect(await new ExplorationStore(dir, { fs: { ...common, open: async () => ({ write: async (data: Uint8Array) => ({ bytesWritten: data.byteLength }), sync: async () => undefined, close: async () => { throw new Error('close') } }) }, ...options }).record(base)).toMatchObject({ ok: false, code: 'persistence_uncertain' })
  })
  it('refuses to append an existing ledger with unsafe permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-explore-')); const fake: FsSeam = { stat: async () => ({ size: 0, mode: 0o644 }), readFile: async () => '', mkdir: async () => undefined, chmod: async () => undefined, open: async () => { throw new Error('must not open') } }
    expect(await new ExplorationStore(dir, { fs: fake }).record(base)).toMatchObject({ ok: false, code: 'ledger_unavailable' })
  })
})
