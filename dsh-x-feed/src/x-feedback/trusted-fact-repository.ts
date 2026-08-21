import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  createTrustedFact,
  isTrustedFact,
  type TrustedFact,
  type TrustedFactInput,
} from '../trusted-facts/model.ts'
import type {
  LocatedTrustedFact,
  LocatedTrustedFactReader,
  LocatedTrustedFactSnapshot,
  Sha256Digest,
} from '../trusted-facts/navigation-contract.ts'

/** The only durable fact boundary exposed to the feedback application. */
export interface TrustedFactRepository {
  append(fact: TrustedFact): TrustedFactWriteResult
  readAll(warn?: (message: string) => void): TrustedFact[]
}

export type TrustedFactWriteResult =
  | { readonly ok: true; readonly fact: TrustedFact }
  | { readonly ok: false; readonly code: 'invalid_fact' | 'write_failed'; readonly message: string }

/** Append-only durable repository for TODO 1 branded facts. */
export class FileTrustedFactRepository implements TrustedFactRepository, LocatedTrustedFactReader {
  constructor(private readonly dataDir: string) {}

  append(fact: TrustedFact): TrustedFactWriteResult {
    if (!isTrustedFact(fact)) {
      return { ok: false, code: 'invalid_fact', message: '只能追加由可信事实工厂生成的事实。' }
    }

    try {
      this.appendLine(serializeFact(fact))
    } catch (error) {
      return {
        ok: false,
        code: 'write_failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
    return { ok: true, fact }
  }

  readAll(warn?: (message: string) => void): TrustedFact[] {
    return this.readLocatedSnapshot(warn).facts.map(located => located.fact)
  }

  readLocatedSnapshot(warn?: (message: string) => void): LocatedTrustedFactSnapshot {
    const raw = this.readRawFile()
    const sourceRevision = sha256(raw)
    const locatedFacts: LocatedTrustedFact[] = []
    const lines = raw.toString('utf8').split('\n')

    lines.forEach((line, index) => {
      const fact = this.readLocatedLine(line, index + 1, warn)
      if (fact !== undefined) locatedFacts.push(fact)
    })

    return { sourceRevision, facts: locatedFacts }
  }

  private readRawFile(): Buffer {
    const file = this.file()
    return existsSync(file) ? readFileSync(file) : Buffer.alloc(0)
  }

  private readLocatedLine(
    line: string,
    lineNumber: number,
    warn?: (message: string) => void,
  ): LocatedTrustedFact | undefined {
    const trimmed = line.trim()
    if (trimmed === '') return undefined

    try {
      const parsed: unknown = JSON.parse(trimmed)
      const input = deserializeFact(parsed)
      if (input === undefined) {
        warn?.(`dsh-x-feed: skipping invalid trusted-facts.jsonl line: ${trimmed.slice(0, 120)}`)
        return undefined
      }
      const result = createTrustedFact(input)
      if (!result.ok) {
        warn?.(`dsh-x-feed: skipping rejected trusted-facts.jsonl line: ${result.message}`)
        return undefined
      }
      const canonicalDigest = sha256(JSON.stringify(serializeFact(result.fact)))
      return {
        locator: {
          schemaVersion: 1,
          locatorId: `tf-jsonl-v0:${lineNumber}:${canonicalDigest}`,
          persistence: {
            sourceKind: 'trusted-fact-repository',
            sourceKey: 'trusted-facts.jsonl',
            lineNumber,
            canonicalDigest,
          },
        },
        fact: result.fact,
      }
    } catch {
      warn?.(`dsh-x-feed: skipping corrupt trusted-facts.jsonl line: ${trimmed.slice(0, 120)}`)
      return undefined
    }
  }

  private file(): string {
    return join(this.dataDir, 'trusted-facts.jsonl')
  }

  private appendLine(input: TrustedFactInput): void {
    const file = this.file()
    mkdirSync(dirname(file), { recursive: true })
    const line = `${JSON.stringify(input)}\n`
    const descriptor = openSync(file, 'a', 0o600)
    try {
      const expected = Buffer.byteLength(line)
      const written = writeSync(descriptor, line, undefined, 'utf8')
      if (written !== expected) throw new Error(`dsh-x-feed: incomplete trusted fact append (${written}/${expected} bytes)`)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }
}

function serializeFact(fact: TrustedFact): TrustedFactInput {
  return {
    target: {
      id: fact.target.id,
      content: fact.target.content,
      source: fact.target.source,
      scope: fact.target.scope,
    },
    dimension: fact.dimension,
    reason: fact.reason,
    applicationLevel: fact.applicationLevel,
    evidence: fact.evidence.kind === 'user_direct'
      ? {
          kind: 'user_direct',
          rawUserExpression: fact.evidence.rawUserExpression,
          ...(fact.evidence.explicitApplicationLevel === undefined
            ? {}
            : { explicitApplicationLevel: fact.evidence.explicitApplicationLevel }),
        }
      : {
          kind: 'user_confirmed_candidate',
          rawUserExpression: fact.evidence.rawUserExpression,
          candidate: fact.evidence.candidate,
          confirmation: fact.evidence.confirmation,
          ...(fact.evidence.explicitApplicationLevel === undefined
            ? {}
            : { explicitApplicationLevel: fact.evidence.explicitApplicationLevel }),
        },
  }
}

function sha256(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function deserializeFact(value: unknown): unknown {
  if (!isRecord(value) || !hasExactKeys(value, ['target', 'dimension', 'reason', 'applicationLevel', 'evidence'])) {
    return undefined
  }
  if (!isRecord(value.target) || !hasExactKeys(value.target, ['id', 'content', 'source', 'scope'])) return undefined
  if (!isRecord(value.evidence) || typeof value.evidence.kind !== 'string') return undefined

  const target = {
    id: value.target.id,
    content: value.target.content,
    source: value.target.source,
    scope: value.target.scope,
  }
  const evidence = value.evidence.kind === 'user_direct'
    ? pickDirectEvidence(value.evidence)
    : value.evidence.kind === 'user_confirmed_candidate'
      ? pickConfirmedEvidence(value.evidence)
      : undefined
  if (evidence === undefined) return undefined

  return {
    target,
    dimension: value.dimension,
    reason: value.reason,
    applicationLevel: value.applicationLevel,
    evidence,
  }
}

function pickDirectEvidence(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!hasExactKeys(value, ['kind', 'rawUserExpression']) && !hasExactKeys(value, ['kind', 'rawUserExpression', 'explicitApplicationLevel'])) return undefined
  return {
    kind: 'user_direct',
    rawUserExpression: value.rawUserExpression,
    ...optionalApplicationLevel(value.explicitApplicationLevel),
  }
}

function pickConfirmedEvidence(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const required = ['kind', 'rawUserExpression', 'candidate', 'confirmation']
  const optional = [...required, 'explicitApplicationLevel']
  if (!hasExactKeys(value, required) && !hasExactKeys(value, optional)) return undefined
  return {
    kind: 'user_confirmed_candidate',
    rawUserExpression: value.rawUserExpression,
    candidate: value.candidate,
    confirmation: value.confirmation,
    ...optionalApplicationLevel(value.explicitApplicationLevel),
  }
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === allowed.length && keys.every(key => allowed.includes(key))
}

function optionalApplicationLevel(value: unknown): { readonly explicitApplicationLevel?: unknown } {
  return value === undefined ? {} : { explicitApplicationLevel: value }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
