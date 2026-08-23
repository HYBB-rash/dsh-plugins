import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defaultStoreDir } from './store.ts'

/** Shared operator configuration for the X business runtime. */
export interface XFeedRuntimeConfig {
  readonly cronJobId?: string
  readonly dataDir?: string
  readonly pythonBin?: string
  readonly pipelinePath?: string
  readonly telegramSessionId?: string
  readonly feedbackPendingTtlMs?: number
  readonly feedbackTurnTimeoutMs?: number
  /** Feed TODO01 audit root; separate from every X-private state file. */
  readonly personalFeedDataDir?: string
  /** Explicit caller-selected sources for this X-backed period. */
  readonly personalFeedRequiredSources?: readonly string[]
  /** Explicit finite C34 boundary relative to the durable claim time. */
  readonly candidateReportingWindowMs?: number
}

export interface ResolvedXFeedRuntimeConfig {
  readonly cronJobId: string
  readonly dataDir: string
  readonly pythonBin: string
  readonly pipelinePath: string
  readonly telegramSessionId: string
  readonly feedbackPendingTtlMs: number
  readonly feedbackTurnTimeoutMs: number
  readonly personalFeedDataDir: string
  readonly personalFeedRequiredSources: readonly string[]
  readonly candidateReportingWindowMs: number | undefined
}

const DEFAULT_FEEDBACK_PENDING_TTL_MS = 600_000
const DEFAULT_FEEDBACK_TURN_TIMEOUT_MS = 30_000

/** Parse the bounded JSON object supplied by a trusted host extension loader. */
export function parseXFeedRuntimeConfig(
  input: Readonly<Record<string, unknown>>,
): ResolvedXFeedRuntimeConfig {
  const cronJobId = optionalString(input, 'cronJobId')
  const dataDir = optionalString(input, 'dataDir')
  const pythonBin = optionalString(input, 'pythonBin')
  const pipelinePath = optionalString(input, 'pipelinePath')
  const telegramSessionId = optionalString(input, 'telegramSessionId')
  const feedbackPendingTtlMs = optionalInteger(input, 'feedbackPendingTtlMs', 1, 86_400_000)
  const feedbackTurnTimeoutMs = optionalInteger(input, 'feedbackTurnTimeoutMs', 1, 120_000)
  const personalFeedDataDir = optionalString(input, 'personalFeedDataDir')
  const personalFeedRequiredSources = optionalStringArray(input, 'personalFeedRequiredSources')
  const candidateReportingWindowMs = optionalPositiveSafeInteger(input, 'candidateReportingWindowMs')
  return Object.freeze({
    cronJobId: cronJobId ?? '',
    dataDir: resolveDataDir(dataDir === undefined ? {} : { dataDir }),
    pythonBin: pythonBin ?? '/usr/bin/python3',
    pipelinePath: resolvePipelinePath(pipelinePath === undefined ? {} : { pipelinePath }),
    telegramSessionId: telegramSessionId ?? 'session-telegram',
    feedbackPendingTtlMs: feedbackPendingTtlMs ?? DEFAULT_FEEDBACK_PENDING_TTL_MS,
    feedbackTurnTimeoutMs: feedbackTurnTimeoutMs ?? DEFAULT_FEEDBACK_TURN_TIMEOUT_MS,
    personalFeedDataDir: personalFeedDataDir ?? join(resolveDshHome(), 'storages', 'personal-feed'),
    personalFeedRequiredSources: Object.freeze([...(personalFeedRequiredSources ?? [])]),
    candidateReportingWindowMs,
  })
}

/** Preserve the existing data location so the refactor never migrates or deletes user data. */
export function resolveDataDir(config: Pick<XFeedRuntimeConfig, 'dataDir'>): string {
  return config.dataDir !== undefined && config.dataDir !== ''
    ? config.dataDir
    : defaultStoreDir(resolveDshHome())
}

/** Resolve the shipped Python pipeline from either source or bundled output. */
export function resolvePipelinePath(config: Pick<XFeedRuntimeConfig, 'pipelinePath'>): string {
  if (config.pipelinePath !== undefined && config.pipelinePath !== '') return config.pipelinePath
  const here = fileURLToPath(new URL('.', import.meta.url))
  return join(here, '..', 'python', 'x_insight_pipeline.py')
}

function optionalString(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`x-feed config ${key} must be a string`)
  return value
}

function optionalInteger(
  input: Readonly<Record<string, unknown>>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`x-feed config ${key} must be an integer between ${min} and ${max}`)
  }
  return value as number
}

function optionalPositiveSafeInteger(
  input: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`x-feed config ${key} must be a positive safe integer`)
  }
  return value as number
}

function optionalStringArray(
  input: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`x-feed config ${key} must be an array of strings`)
  }
  return value
}
