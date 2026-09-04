import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { NavigationSnapshot, NavigationSnapshotWriter } from '../trusted-facts/navigation-contract.ts'

export const TRUSTED_FACT_NAVIGATION_FILE_NAME = 'trusted-fact-navigation.json' as const

export class FileNavigationSnapshotStore implements NavigationSnapshotWriter {
  constructor(private readonly dataDir: string) {}

  replace(snapshot: NavigationSnapshot): void {
    const target = join(this.dataDir, TRUSTED_FACT_NAVIGATION_FILE_NAME)
    const temporary = this.createTemporaryPath(target)
    let descriptor: number | undefined

    try {
      mkdirSync(dirname(target), { recursive: true })
      descriptor = openSync(temporary, 'wx', 0o600)
      this.writeComplete(descriptor, serializeSnapshot(snapshot))
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, target)
    } finally {
      this.closeDescriptor(descriptor)
      this.removeTemporaryFile(temporary)
    }
  }

  private createTemporaryPath(target: string): string {
    return join(dirname(target), `.${TRUSTED_FACT_NAVIGATION_FILE_NAME}.${randomUUID()}.tmp`)
  }

  private writeComplete(descriptor: number, content: Buffer): void {
    let offset = 0
    while (offset < content.length) {
      const written = writeSync(descriptor, content, offset, content.length - offset, null)
      if (written <= 0) throw new Error('personal-feed: incomplete navigation snapshot write')
      offset += written
    }
  }

  private closeDescriptor(descriptor: number | undefined): void {
    if (descriptor === undefined) return
    closeSync(descriptor)
  }

  private removeTemporaryFile(path: string): void {
    try {
      unlinkSync(path)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
  }
}

function serializeSnapshot(snapshot: NavigationSnapshot): Buffer {
  return Buffer.from(`${JSON.stringify(snapshot)}\n`, 'utf8')
}

function isMissingFileError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
