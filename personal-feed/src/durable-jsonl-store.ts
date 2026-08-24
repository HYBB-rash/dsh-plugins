import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PersonalFeedScopeStoreError } from './errors.ts'

export function readJsonLines(path: string, storeName: string): readonly unknown[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown
    } catch (cause) {
      throw new PersonalFeedScopeStoreError(
        `personal Feed ${storeName} ledger line ${index + 1} is not valid JSON`,
        { cause },
      )
    }
  })
}

export function appendJsonLine(
  path: string,
  records: readonly unknown[],
  record: unknown,
  serialize: (value: unknown) => string = value => JSON.stringify(value),
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const next = `${records.map(serialize).join('\n')}${records.length === 0 ? '' : '\n'}${serialize(record)}\n`
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporaryPath, next, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporaryPath, path)
}
