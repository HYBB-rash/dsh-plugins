import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { foldEvents, prepareRecord, type ExplorationEventV1, type ExplorationItem, type Integrity, type RecordInput } from './domain.ts'

export const MAX_LEDGER_BYTES = 16 * 1024 * 1024
export type RecordResult = { ok: true; created: boolean; eventId: string; item: ExplorationItem; integrity: Integrity } | { ok: false; code: string; message: string; attemptedEventId?: string; integrity?: Integrity; candidates?: unknown[] }
export type QueryResult = { ok: true; items: ExplorationItem[]; total: number; truncated: boolean; integrity: Integrity } | { ok: false; code: 'invalid_input' | 'ledger_unavailable' | 'read_failed'; message: string }
export interface FileHandleLike { write(data: Uint8Array): Promise<{ bytesWritten: number }>; sync(): Promise<void>; close(): Promise<void> }
export interface FsSeam { stat(path: string): Promise<{ size: number; mode: number }>; readFile(path: string, encoding: 'utf8'): Promise<string>; mkdir(path: string, options: { recursive: true; mode: number }): Promise<void>; chmod(path: string, mode: number): Promise<void>; open(path: string, flags: string, mode: number): Promise<FileHandleLike> }
const realFs: FsSeam = { stat: path => fs.stat(path), readFile: (path, encoding) => fs.readFile(path, encoding), mkdir: (path, options) => fs.mkdir(path, options).then(() => undefined), chmod: (path, mode) => fs.chmod(path, mode), open: (path, flags, mode) => fs.open(path, flags, mode) }
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
class LedgerCapacityError extends Error {}

export class ExplorationStore {
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly dataDir: string, private readonly deps: { fs?: FsSeam; now?: () => string; uuid?: () => string } = {}) {}
  private get io(): FsSeam { return this.deps.fs ?? realFs }
  private file(): string { return join(this.dataDir, 'events.jsonl') }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const result = this.queue.then(operation, operation); this.queue = result.then(() => undefined, () => undefined); return result }
  private async read(): Promise<{ items: ReadonlyMap<string, ExplorationItem>; integrity: Integrity; fileSize: number }> {
    let content = ''
    let fileSize = 0
    try { const stat = await this.io.stat(this.file()); fileSize = stat.size; if (fileSize > MAX_LEDGER_BYTES) throw new LedgerCapacityError('探索账本超过容量上限'); content = await this.io.readFile(this.file(), 'utf8') } catch (error) { if (absent(error)) return { items: new Map(), integrity: { status: 'ok', skippedLines: 0, skippedEvents: 0, trailingPartial: false }, fileSize: 0 }; throw error }
    const trailingPartial = content !== '' && !content.endsWith('\n')
    const lines = content.split('\n'); if (trailingPartial) lines.pop(); else lines.pop()
    const folded = foldEvents(lines.filter(line => line !== ''), trailingPartial)
    return { items: folded.itemsById, integrity: folded.integrity, fileSize }
  }
  async query(input: { state?: 'active' | 'dismissed' | 'all'; query?: string; limit?: number } = {}): Promise<QueryResult> { return this.serial(async () => {
    const state = input.state ?? 'active'; const query = input.query?.trim() ?? ''; const limit = input.limit ?? 20
    if (!['active', 'dismissed', 'all'].includes(state) || !Number.isInteger(limit) || limit < 1 || limit > 20 || Array.from(query).length > 200 || ((state === 'dismissed' || state === 'all') && query === '')) return { ok: false, code: 'invalid_input', message: 'query 参数不合法' }
    let snapshot; try { snapshot = await this.read() } catch (error) { return error instanceof LedgerCapacityError ? { ok: false, code: 'ledger_unavailable', message: '探索账本超过容量上限' } : { ok: false, code: 'read_failed', message: '无法读取探索账本' } }
    const needle = query.toLocaleLowerCase(); const all = [...snapshot.items.values()].filter(item => (state === 'all' || item.state === state) && (needle === '' || [item.title, item.hook, item.currentFinding, item.nextQuestion, item.canonicalUrl].some(value => value?.toLocaleLowerCase().includes(needle))))
    all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    return { ok: true, items: all.slice(0, limit), total: all.length, truncated: all.length > limit, integrity: snapshot.integrity }
  }) }
  async record(input: RecordInput): Promise<RecordResult> { return this.serial(async () => {
    let snapshot; try { snapshot = await this.read() } catch { return { ok: false, code: 'ledger_unavailable', message: '无法读取探索账本' } }
    if (snapshot.integrity.status === 'degraded') return { ok: false, code: 'ledger_degraded', message: '探索账本不完整，拒绝写入', integrity: snapshot.integrity }
    const now = (this.deps.now ?? (() => new Date().toISOString()))(); const uuid = this.deps.uuid ?? randomUUID
    const prepared = prepareRecord(snapshot.items, input, now, uuid)
    if (!prepared.ok) return { ok: false, code: prepared.code, message: prepared.message, ...(prepared.candidates === undefined ? {} : { candidates: prepared.candidates }) }
    const eventId = uuid(); const event: ExplorationEventV1 = { schemaVersion: 1, eventId, occurredAt: now, operation: prepared.operation, signal: prepared.signal, item: prepared.item }; const line = `${JSON.stringify(event)}\n`
    const bytes = Buffer.from(line, 'utf8')
    if (bytes.byteLength > 65_536) return { ok: false, code: 'persistence_failed', message: '账本行超过上限' }
    if (snapshot.fileSize + bytes.byteLength > MAX_LEDGER_BYTES) return { ok: false, code: 'persistence_failed', message: '探索账本容量已满' }
    let handle: FileHandleLike | undefined; let wrote = 0
    try {
      try { const stat = await this.io.stat(this.file()); if ((stat.mode & 0o077) !== 0) return { ok: false, code: 'ledger_unavailable', message: '账本权限不安全' } } catch (error) { if (!absent(error)) throw error; await this.io.mkdir(this.dataDir, { recursive: true, mode: 0o700 }); await this.io.chmod(this.dataDir, 0o700) }
      handle = await this.io.open(this.file(), 'a', 0o600)
      let offset = 0
      while (offset < bytes.byteLength) {
        const result = await handle.write(bytes.subarray(offset))
        if (!Number.isInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > bytes.byteLength - offset) throw new Error('partial write')
        offset += result.bytesWritten
        wrote += result.bytesWritten
      }
      await handle.sync(); await handle.close(); handle = undefined
      return { ok: true, created: prepared.created, eventId, item: prepared.item, integrity: snapshot.integrity }
    } catch {
      if (handle !== undefined) { try { await handle.close() } catch { wrote = Math.max(wrote, 1) } }
      return wrote > 0 ? { ok: false, code: 'persistence_uncertain', message: '账本写入状态不确定', attemptedEventId: eventId } : { ok: false, code: 'persistence_failed', message: '账本尚未写入' }
    }
  }) }
}

export function defaultDataDir(dshHome: string): string { return join(dshHome, 'storages', 'dsh-explore') }
