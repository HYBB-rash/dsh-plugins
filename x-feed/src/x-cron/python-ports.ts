/**
 * Run-local adapters for the mature X Python chain.
 *
 * This module is deliberately a fixed command port. Callers can choose the
 * shipped interpreter and script locations while composing a provider, but a
 * model-facing caller can choose neither a command nor an argument. Every
 * operation below owns its argv and checks the current run capability state
 * before crossing the Python boundary.
 */

import { execFile as childExecFile } from 'node:child_process'
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { basename, join, resolve } from 'node:path'
import { validateXFeedRichMarkdown } from './output-contract.ts'

const execFile = promisify(childExecFile)

export type PythonPortErrorCode =
  | 'aborted'
  | 'timeout'
  | 'non-zero-exit'
  | 'invalid-json'
  | 'oversized-stdout'
  | 'spawn-failed'
  | 'capability-denied'
  | 'pipeline-failure'
  | 'invalid-output'
  | 'artifact-read-failed'
  | 'artifact-invalid'
  | 'invalid-capability'

export class XFeedPythonPortError extends Error {
  readonly code: PythonPortErrorCode
  readonly details?: Readonly<Record<string, unknown>>

  constructor(code: PythonPortErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message)
    this.name = 'XFeedPythonPortError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export interface PythonCommandRequest {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly timeoutMs: number
  readonly maxBuffer: number
  readonly shell: false
  readonly signal?: AbortSignal
}

export interface PythonCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type PythonCommandRunner = (request: PythonCommandRequest) => Promise<PythonCommandResult>

export interface XFeedCandidateCapability {
  readonly id: string
  readonly url: string
  readonly topics?: readonly string[]
}

export interface XFeedRunCapabilities {
  readonly runId: string
  readonly cronJobId: string
  readonly dataDir: string
  readonly packagePath: string
  readonly shownPath: string
  readonly collectionPath: string
  readonly topicSearchOutputPath: string
  readonly allowedTopics: readonly string[]
  readonly candidates: Readonly<Record<string, XFeedCandidateCapability>>
  readonly preparedUrls: readonly string[]
}

export interface XFeedPythonPortOptions {
  readonly pythonBin: string
  readonly pythonDirectory: string
  readonly pipelinePath: string
  readonly topicSearchPath: string
  readonly explorerPath: string
  readonly insightEnginePath?: string
  readonly capabilities: XFeedRunCapabilities
  readonly run?: PythonCommandRunner
  readonly readFile?: XFeedArtifactReader
  readonly timeoutMs?: number
  readonly maxStdoutBytes?: number
  readonly maxArtifactBytes?: number
  readonly maxArtifactItemBytes?: number
  readonly maxArtifactItems?: number
}

export type XFeedArtifactReader = (path: string, maxBytes: number) => Promise<string>

export interface XFeedInsightPackage {
  readonly [key: string]: unknown
}

export interface XFeedPreparedArtifact {
  readonly [key: string]: unknown
}

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_MAX_STDOUT_BYTES = 256 * 1024
const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024
const DEFAULT_MAX_ARTIFACT_ITEM_BYTES = 24 * 1024
const DEFAULT_MAX_ARTIFACT_ITEMS = 50

const SCRIPT_NAMES = {
  pipeline: 'x_insight_pipeline.py',
  topicSearch: 'x_topic_search.py',
  explorer: 'x_explorer.py',
  insightEngine: 'insight_engine.py',
} as const

function isSafeRunPart(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !/[\\/\r\n\0]/.test(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function requireScript(path: string, expectedName: string): string {
  const absolute = resolve(path)
  if (basename(absolute) !== expectedName) {
    throw new XFeedPythonPortError(
      'invalid-capability',
      `X Python port only accepts the shipped ${expectedName} adapter`,
      { path: absolute, expectedName },
    )
  }
  return absolute
}

function validateCapabilities(capabilities: XFeedRunCapabilities): void {
  if (!isSafeRunPart(capabilities.runId)) {
    throw new XFeedPythonPortError('invalid-capability', 'runId is not a safe run-local path component')
  }
  if (!isNonEmptyString(capabilities.cronJobId) || !isNonEmptyString(capabilities.dataDir)) {
    throw new XFeedPythonPortError('invalid-capability', 'cronJobId and dataDir are required')
  }
  const dataRoot = resolve(capabilities.dataDir)
  for (const path of [capabilities.packagePath, capabilities.shownPath, capabilities.collectionPath, capabilities.topicSearchOutputPath]) {
    const absolute = resolve(path)
    if (absolute !== dataRoot && !absolute.startsWith(`${dataRoot}/`)) {
      throw new XFeedPythonPortError('invalid-capability', 'run artifact path escapes dataDir', { path: absolute })
    }
  }
  const seenUrls = new Set<string>()
  for (const url of capabilities.preparedUrls) {
    if (!isNonEmptyString(url) || seenUrls.has(url)) {
      throw new XFeedPythonPortError('invalid-capability', 'preparedUrls must contain unique non-empty URLs')
    }
    seenUrls.add(url)
  }
  for (const topic of capabilities.allowedTopics) {
    if (!isNonEmptyString(topic) || /[\r\n]/.test(topic)) {
      throw new XFeedPythonPortError('invalid-capability', 'allowedTopics contains an invalid topic')
    }
  }
  for (const candidate of Object.values(capabilities.candidates)) {
    if (!isSafeRunPart(candidate.id) || !isNonEmptyString(candidate.url)) {
      throw new XFeedPythonPortError('invalid-capability', 'candidate capability is invalid')
    }
    if (candidate.topics?.some(topic => !isNonEmptyString(topic) || /[\r\n]/.test(topic))) {
      throw new XFeedPythonPortError('invalid-capability', 'candidate topic capability is invalid')
    }
  }
}

async function runWithExecFile(request: PythonCommandRequest): Promise<PythonCommandResult> {
  try {
    const result = await execFile(request.file, [...request.args], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      timeout: request.timeoutMs,
      maxBuffer: request.maxBuffer,
      shell: false,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
  } catch (error) {
    const candidate = error as {
      code?: unknown
      killed?: unknown
      signal?: unknown
      stdout?: unknown
      stderr?: unknown
      status?: unknown
      message?: unknown
    }
    if (request.signal?.aborted || candidate.code === 'ABORT_ERR') {
      throw new XFeedPythonPortError('aborted', 'X Python command was aborted')
    }
    if (candidate.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new XFeedPythonPortError('oversized-stdout', 'X Python stdout exceeded the run budget')
    }
    if (candidate.code === 'ETIMEDOUT' || candidate.killed === true || candidate.signal === 'SIGTERM') {
      throw new XFeedPythonPortError('timeout', 'X Python command timed out')
    }
    if (typeof candidate.status === 'number') {
      return {
        stdout: typeof candidate.stdout === 'string' ? candidate.stdout : '',
        stderr: typeof candidate.stderr === 'string' ? candidate.stderr : '',
        exitCode: candidate.status,
      }
    }
    throw new XFeedPythonPortError('spawn-failed', candidate.message ? String(candidate.message) : 'X Python command failed to start')
  }
}

function lastJsonObject(stdout: string): XFeedInsightPackage {
  const line = stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean).at(-1)
  if (line === undefined) throw new XFeedPythonPortError('invalid-json', 'X Python command returned no JSON result')
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    throw new XFeedPythonPortError('invalid-json', 'X Python command returned invalid JSON', {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new XFeedPythonPortError('invalid-json', 'X Python command result must be a JSON object')
  }
  return value as XFeedInsightPackage
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

export interface XFeedPythonPorts {
  readonly capabilities: XFeedRunCapabilities
  runPipeline(signal?: AbortSignal): Promise<XFeedInsightPackage>
  searchTopic(topic: string, signal?: AbortSignal): Promise<XFeedInsightPackage>
  exploreCandidate(candidateId: string, signal?: AbortSignal): Promise<XFeedInsightPackage>
  setTheme(theme: string, signal?: AbortSignal): Promise<XFeedInsightPackage>
  prepareDelivery(text: string, urls: readonly string[], signal?: AbortSignal): Promise<XFeedPreparedArtifact>
}

/** Build the fixed, run-local Python port used by the X cron provider. */
export function createXFeedPythonPorts(options: XFeedPythonPortOptions): XFeedPythonPorts {
  validateCapabilities(options.capabilities)
  const pipelinePath = requireScript(options.pipelinePath, SCRIPT_NAMES.pipeline)
  const topicSearchPath = requireScript(options.topicSearchPath, SCRIPT_NAMES.topicSearch)
  const explorerPath = requireScript(options.explorerPath, SCRIPT_NAMES.explorer)
  const insightEnginePath = options.insightEnginePath === undefined
    ? undefined
    : requireScript(options.insightEnginePath, SCRIPT_NAMES.insightEngine)
  const pythonDirectory = resolve(options.pythonDirectory)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES
  const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES
  const maxArtifactItemBytes = options.maxArtifactItemBytes ?? DEFAULT_MAX_ARTIFACT_ITEM_BYTES
  const maxArtifactItems = options.maxArtifactItems ?? DEFAULT_MAX_ARTIFACT_ITEMS
  const run = options.run ?? runWithExecFile
  const readFile = options.readFile ?? (async (path: string, maxBytes: number) => {
    const metadata = await fsStat(path)
    if (metadata.size > maxBytes) {
      throw new XFeedPythonPortError('oversized-stdout', 'X artifact exceeded the run byte budget', { path, maxBytes })
    }
    return fsReadFile(path, 'utf8')
  })
  const capabilities = options.capabilities

  function request(args: readonly string[], signal?: AbortSignal): PythonCommandRequest {
    if (signal?.aborted) throw new XFeedPythonPortError('aborted', 'X Python command was aborted before dispatch')
    return {
      file: options.pythonBin,
      args: [...args],
      cwd: pythonDirectory,
      env: { ...process.env, DSH_X_FEED_DATA_DIR: resolve(capabilities.dataDir) },
      timeoutMs,
      maxBuffer: maxStdoutBytes,
      shell: false,
      ...(signal === undefined ? {} : { signal }),
    }
  }

  async function invoke(args: readonly string[], signal?: AbortSignal): Promise<XFeedInsightPackage> {
    const result = await run(request(args, signal))
    if (Buffer.byteLength(result.stdout, 'utf8') > maxStdoutBytes) {
      throw new XFeedPythonPortError('oversized-stdout', 'X Python stdout exceeded the run budget', {
        maxStdoutBytes,
      })
    }
    if (result.exitCode !== 0) {
      throw new XFeedPythonPortError('non-zero-exit', 'X Python command returned a non-zero exit code', {
        exitCode: result.exitCode,
        stderr: result.stderr.slice(-1000),
      })
    }
    const payload = lastJsonObject(result.stdout)
    if (payload.ok === false) {
      const errorClass = typeof payload.error_class === 'string' ? payload.error_class : 'python-pipeline-failed'
      const message = typeof payload.err === 'string'
        ? payload.err
        : typeof payload.detail === 'string' ? payload.detail : 'X Python pipeline reported failure'
      throw new XFeedPythonPortError('pipeline-failure', message, { errorClass })
    }
    return payload
  }

  async function readArtifact(path: string): Promise<string> {
    try {
      const contents = await readFile(path, maxArtifactBytes)
      if (Buffer.byteLength(contents, 'utf8') > maxArtifactBytes) {
        throw new XFeedPythonPortError('oversized-stdout', 'X artifact exceeded the run byte budget', { path, maxArtifactBytes })
      }
      return contents
    } catch (error) {
      if (error instanceof XFeedPythonPortError) throw error
      throw new XFeedPythonPortError('artifact-read-failed', `X artifact could not be read: ${path}`, {
        cause: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function normalizeStatusUrl(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const cleaned = value.trim().replace(/[),.;!?"'`}]+$/g, '')
    try {
      const parsed = new URL(cleaned)
      const host = parsed.hostname.toLowerCase()
      if (parsed.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host)) return undefined
      const parts = parsed.pathname.split('/').filter(Boolean)
      const statusIndex = parts.indexOf('status')
      if (statusIndex < 1 || statusIndex + 1 >= parts.length || !/^\d+$/.test(parts[statusIndex + 1]!)) return undefined
      return `https://x.com/${parts[statusIndex - 1]}/status/${parts[statusIndex + 1]}`
    } catch {
      return undefined
    }
  }

  const preparedUrlSet = new Set(capabilities.preparedUrls.map(url => normalizeStatusUrl(url) ?? url))

  function boundedItem(value: unknown): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const row = value as Record<string, unknown>
    const url = normalizeStatusUrl(row.url)
    const text = typeof row.text === 'string' ? row.text : undefined
    if (url === undefined || text === undefined) return undefined
    const item: Record<string, unknown> = {
      id: url.split('/').at(-1)!,
      url,
      text,
    }
    for (const key of ['time', 'user', 'topic', 'anchor', 'hop'] as const) {
      const field = row[key]
      if (typeof field === 'string' || typeof field === 'number') item[key] = field
    }
    return item
  }

  async function readSearchItems(): Promise<{ readonly items: readonly Record<string, unknown>[] }> {
    const contents = await readArtifact(capabilities.topicSearchOutputPath)
    const items: Record<string, unknown>[] = []
    for (const line of contents.split(/\r?\n/).filter(Boolean)) {
      if (Buffer.byteLength(line, 'utf8') > maxArtifactItemBytes) {
        throw new XFeedPythonPortError('oversized-stdout', 'X topic-search item exceeded the item byte budget')
      }
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch (error) {
        throw new XFeedPythonPortError('artifact-invalid', 'X topic-search artifact contains invalid JSONL', {
          cause: error instanceof Error ? error.message : String(error),
        })
      }
      const item = boundedItem(value)
      if (item !== undefined) {
        items.push(item)
        preparedUrlSet.add(item.url as string)
      }
      if (items.length > maxArtifactItems) {
        throw new XFeedPythonPortError('oversized-stdout', 'X topic-search artifact exceeded the item count budget')
      }
    }
    return { items }
  }

  async function readExploration(candidate: XFeedCandidateCapability): Promise<Record<string, unknown>> {
    const path = join(resolve(capabilities.dataDir), 'x_explore', `${candidate.id}.txt`)
    const contents = await readArtifact(path)
    const lines = contents.split(/\r?\n/)
    const title = lines.find(line => line.startsWith('TITLE:'))?.slice('TITLE:'.length).trim() ?? ''
    const linksMarker = lines.findIndex(line => line.startsWith('LINKS:'))
    const bodyStart = lines.findIndex((line, index) => index > 1 && line === '')
    const body = (lines.slice(bodyStart + 1, linksMarker >= 0 ? linksMarker : lines.length).join('\n')).trim()
    const urls = new Set<string>()
    for (const match of contents.match(/https?:\/\/[^\s<>()]+/g) ?? []) {
      const normalized = normalizeStatusUrl(match)
      if (normalized !== undefined) {
        urls.add(normalized)
        preparedUrlSet.add(normalized)
      }
    }
    return { title, body, urls: [...urls] }
  }

  function requireTopic(topic: string): void {
    if (!isNonEmptyString(topic) || !capabilities.allowedTopics.includes(topic)) {
      throw new XFeedPythonPortError('capability-denied', 'topic is not in the current run allowlist', { topic })
    }
    const candidateTopics = Object.values(capabilities.candidates).flatMap(candidate => candidate.topics ?? [])
    if (candidateTopics.length > 0 && !candidateTopics.includes(topic)) {
      throw new XFeedPythonPortError('capability-denied', 'topic is not attached to a current candidate', { topic })
    }
  }

  function requireCandidate(candidateId: string): XFeedCandidateCapability {
    const candidate = capabilities.candidates[candidateId]
    if (candidate === undefined) {
      throw new XFeedPythonPortError('capability-denied', 'candidate is not in the current run allowlist', { candidateId })
    }
    return candidate
  }

  function requirePreparedUrls(urls: readonly string[]): string[] {
    const unique = uniqueStrings(urls)
    if (unique.length !== urls.length || unique.some(url => !preparedUrlSet.has(url))) {
      throw new XFeedPythonPortError('capability-denied', 'delivery URL is not in the current run allowlist')
    }
    return unique
  }

  return {
    capabilities,
    async runPipeline(signal) {
      await invoke([
        pipelinePath,
        '--out', capabilities.packagePath,
        '--shown', capabilities.shownPath,
        '--batch-out', capabilities.collectionPath,
      ], signal)
      const contents = await readArtifact(capabilities.packagePath)
      let value: unknown
      try {
        value = JSON.parse(contents)
      } catch (error) {
        throw new XFeedPythonPortError('artifact-invalid', 'X insight package is invalid JSON', {
          cause: error instanceof Error ? error.message : String(error),
        })
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new XFeedPythonPortError('artifact-invalid', 'X insight package must be a JSON object')
      }
      return value as XFeedInsightPackage
    },
    async searchTopic(topic, signal) {
      requireTopic(topic)
      await invoke([topicSearchPath, topic, '--rolls', '3', '--live', '--out', capabilities.topicSearchOutputPath], signal)
      return await readSearchItems()
    },
    async exploreCandidate(candidateId, signal) {
      const candidate = requireCandidate(candidateId)
      await invoke([explorerPath, '--url', candidate.url, '--name', candidate.id], signal)
      return await readExploration(candidate)
    },
    async setTheme(theme, signal) {
      requireTopic(theme)
      if (insightEnginePath === undefined) {
        throw new XFeedPythonPortError('capability-denied', 'the run does not expose the theme port')
      }
      return await invoke([
        insightEnginePath, 'set-theme',
        '--last', join(resolve(capabilities.dataDir), 'x_last_theme.json'),
        '--theme', theme,
      ], signal)
    },
    async prepareDelivery(text, urls, signal) {
      if (!isNonEmptyString(text)) {
        throw new XFeedPythonPortError('capability-denied', 'delivery text must be non-empty')
      }
      const uniqueUrls = requirePreparedUrls(urls)
      const output = validateXFeedRichMarkdown(text, { preparedUrls: uniqueUrls })
      if (!output.ok) {
        throw new XFeedPythonPortError('invalid-output', `${output.code}: ${output.message}`)
      }
      return await invoke([
        pipelinePath, 'prepare-delivery',
        '--package', capabilities.packagePath,
        '--cron-job-id', capabilities.cronJobId,
        ...(uniqueUrls.length === 0 ? [] : ['--urls', ...uniqueUrls]),
      ], signal)
    },
  }
}

export { runWithExecFile }
