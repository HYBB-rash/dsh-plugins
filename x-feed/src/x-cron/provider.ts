import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  CronAgentEnvironmentLease,
  CronAgentEnvironmentProvider,
  CronAgentEnvironmentRequirements,
} from '@deepseek-ai/dsh-cron'
import {
  createBoundFactProjectionPreflight,
  type ProjectionBudget,
  type ProjectionView,
} from '../fact-projection/index.ts'
import {
  createCandidateFactAssessmentPort,
} from './assessment-agent.ts'
import {
  XFeedFinalAgentSurface,
  type XFeedFinalAgentMaterial,
  type XFeedFinalCandidate,
  type XFeedFinalProjectionPort,
} from './final-agent.ts'
import {
  createXFeedPythonPorts,
  type PythonCommandRunner,
  type XFeedArtifactReader,
  type XFeedInsightPackage,
  type XFeedRunCapabilities,
} from './python-ports.ts'
import type { XFeedRunToolFailure } from './run-tools.ts'

export const X_CRON_AGENT_ENVIRONMENT_MARKER = 'dsh-x-feed/v1'

export const X_CRON_ENVIRONMENT_REQUIREMENTS: CronAgentEnvironmentRequirements = Object.freeze({
  jobKind: 'agent',
  sessionMode: 'per_run',
  gate: 'forbidden',
})

const DEFAULT_PROJECTION_BUDGET: ProjectionBudget = Object.freeze({
  maxInlineFacts: 6,
  maxLookupTickets: 6,
  maxSerializedBytes: 16_000,
})

export interface XFeedCronProviderOptions {
  readonly ctx: Context
  readonly cronJobId: string
  readonly dataDir: string
  readonly pythonBin: string
  readonly pipelinePath: string
  readonly projectionBudget?: ProjectionBudget
  readonly run?: PythonCommandRunner
  readonly readFile?: XFeedArtifactReader
  readonly timeoutMs?: number
  readonly maxStdoutBytes?: number
  readonly maxArtifactBytes?: number
  readonly maxArtifactItemBytes?: number
  readonly maxArtifactItems?: number
}

/** Build the exact provider registered for one configured cron job. */
export function createXFeedCronEnvironmentProvider(
  options: XFeedCronProviderOptions,
): CronAgentEnvironmentProvider {
  if (options.cronJobId.trim() === '') throw new Error('X cron provider requires a non-empty cronJobId')
  if (options.dataDir.trim() === '') throw new Error('X cron provider requires a non-empty dataDir')
  if (basename(options.pipelinePath) !== 'x_insight_pipeline.py') {
    throw new Error('X cron provider only accepts the shipped x_insight_pipeline.py adapter')
  }

  return {
    marker: X_CRON_AGENT_ENVIRONMENT_MARKER,
    requirements: X_CRON_ENVIRONMENT_REQUIREMENTS,
    prepare: async context => prepareXFeedRun(options, context),
  }
}

async function prepareXFeedRun(
  options: XFeedCronProviderOptions,
  context: { readonly jobId: string; readonly runId: string },
): Promise<CronAgentEnvironmentLease> {
  if (context.jobId !== options.cronJobId) {
    throw new Error(`X cron provider job id mismatch: expected ${options.cronJobId}, got ${context.jobId}`)
  }

  const budget = options.projectionBudget ?? DEFAULT_PROJECTION_BUDGET

  // This is intentionally the first host operation. Its binder is called only
  // after the projection layer has pinned and validated the exact facts and
  // navigation snapshot, so readiness and every later prime share one source.
  let capturedAssessment: ReturnType<typeof createCandidateFactAssessmentPort> | undefined
  const preflight = createBoundFactProjectionPreflight(
    options.dataDir,
    budget,
    navigation => {
      const assessment = createCandidateFactAssessmentPort(options.ctx, navigation)
      capturedAssessment = assessment
      return assessment
    },
  )
  if (preflight.kind !== 'ready') {
    throw new Error(`X cron preflight ${preflight.kind}: ${preflight.code}: ${preflight.message}`)
  }
  if (capturedAssessment === undefined) {
    throw new Error('X cron preflight completed without its pinned assessment port')
  }
  const assessment = capturedAssessment

  const runPart = safeRunPart(context.runId)
  const runDir = join(options.dataDir, '.runs', runPart)
  const packagePath = join(options.dataDir, 'x_insight_package.json')
  const shownPath = join(options.dataDir, 'x_shown.json')
  const collectionPath = join(runDir, 'collection.jsonl')
  const topicSearchOutputPath = join(runDir, 'topic-search.jsonl')
  mkdirSync(runDir, { recursive: true })

  try {
    const baseCapabilities = createCapabilities({
      runId: runPart,
      cronJobId: options.cronJobId,
      dataDir: options.dataDir,
      packagePath,
      shownPath,
      collectionPath,
      topicSearchOutputPath,
      allowedTopics: [],
      candidates: {},
      preparedUrls: [],
    })
    const basePorts = createPythonPorts(options, baseCapabilities)
    const insightPackage = await basePorts.runPipeline()
    const parsed = parseInsightPackage(insightPackage, baseCapabilities)

    const capabilities = createCapabilities(parsed.capabilities)
    const ports = createPythonPorts(options, capabilities)
    const projections = new Map<string, ProjectionEntry>()
    for (const candidate of parsed.candidates) {
      // TODO5's assessment/project contract intentionally accepts the exact
      // three-field CandidateDescriptor only. Topics stay in the bounded
      // final material/capability allowlist and never become assessment keys.
      const assessmentCandidate = {
        id: candidate.id,
        content: candidate.content,
        source: candidate.source,
      } as const
      const request = {
        candidate: assessmentCandidate,
        navigation: assessment.navigation.items,
        budget,
      } as const
      const prime = await assessment.prime(request)
      const projected = preflight.session.project(assessmentCandidate, prime.assessment)
      if (projected.kind !== 'ready') {
        throw new Error(`X cron candidate projection failed for ${candidate.id}: ${projected.code}: ${projected.message}`)
      }
      if (projections.has(candidate.id)) throw new Error(`X cron candidate projection id is duplicated: ${candidate.id}`)
      projections.set(candidate.id, { view: projected.view, lookup: projected.lookup })
    }

    const projection: XFeedFinalProjectionPort = {
      project: async candidateId => {
        const entry = projections.get(candidateId)
        return entry === undefined
          ? failure('candidate-not-allowlisted', 'Candidate is not in the current run projection allowlist.')
          : entry.view
      },
      lookup: ticketId => {
        for (const entry of projections.values()) {
          const result = entry.lookup(ticketId)
          if (result.kind !== 'lookup-failure' || result.code !== 'ticket_not_found') return result
        }
        return failure('ticket-not-allowlisted', 'Ticket is not signed by the current run projection.')
      },
    }

    const material: XFeedFinalAgentMaterial = {
      runId: runPart,
      allowedTopics: parsed.allowedTopics,
      candidates: parsed.candidates,
    }
    const surface = new XFeedFinalAgentSurface({ material, runTools: ports, projection })
    return {
      setupAgent: agentCtx => surface.setupAgent(agentCtx as Context),
      verifySurface: async agent => {
        const actualAgent = agent as Agent
        const actualSessionId = actualAgent.session.id
        if (actualSessionId.trim() === '') {
          throw new Error('X cron final Agent omitted its actual session id')
        }
        surface.capture(options.ctx, actualSessionId)
        await surface.verifySurface(actualAgent)
      },
      finalizeOutcome: outcome => surface.finalizeOutcome(outcome),
      dispose: () => surface.dispose(),
    }
  } catch (error) {
    // A failed prepare never returns a lease to dsh-cron. The per-run
    // directory was created by this provider and is safe to leave as bounded
    // audit evidence; no user-owned persistent state is removed here.
    throw error
  }
}

interface ProjectionEntry {
  readonly view: ProjectionView
  readonly lookup: (ticketId: string) => import('../fact-projection/contracts.ts').LookupResult
}

interface ParsedPackage {
  readonly capabilities: XFeedRunCapabilities
  readonly allowedTopics: readonly string[]
  readonly candidates: readonly XFeedFinalCandidate[]
}

function createPythonPorts(options: XFeedCronProviderOptions, capabilities: XFeedRunCapabilities) {
  return createXFeedPythonPorts({
    pythonBin: options.pythonBin,
    pythonDirectory: dirname(options.pipelinePath),
    pipelinePath: options.pipelinePath,
    topicSearchPath: join(dirname(options.pipelinePath), 'x_topic_search.py'),
    explorerPath: join(dirname(options.pipelinePath), 'x_explorer.py'),
    insightEnginePath: join(dirname(options.pipelinePath), 'insight_engine.py'),
    capabilities,
    ...(options.run === undefined ? {} : { run: options.run }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: options.maxStdoutBytes }),
    ...(options.maxArtifactBytes === undefined ? {} : { maxArtifactBytes: options.maxArtifactBytes }),
    ...(options.maxArtifactItemBytes === undefined ? {} : { maxArtifactItemBytes: options.maxArtifactItemBytes }),
    ...(options.maxArtifactItems === undefined ? {} : { maxArtifactItems: options.maxArtifactItems }),
  })
}

function createCapabilities(input: XFeedRunCapabilities): XFeedRunCapabilities {
  return Object.freeze({
    ...input,
    allowedTopics: Object.freeze([...input.allowedTopics]),
    preparedUrls: Object.freeze([...input.preparedUrls]),
    candidates: Object.freeze(Object.fromEntries(
      Object.entries(input.candidates).map(([id, candidate]) => [id, Object.freeze({
        ...candidate,
        ...(candidate.topics === undefined ? {} : { topics: Object.freeze([...candidate.topics]) }),
      })]),
    )),
  })
}

function parseInsightPackage(value: XFeedInsightPackage, base: XFeedRunCapabilities): ParsedPackage {
  if (!isRecord(value) || !Array.isArray(value.recent_items)) {
    throw new Error('X insight package must contain a bounded recent_items array')
  }
  const candidates: XFeedFinalCandidate[] = []
  const seenIds = new Set<string>()
  for (const raw of value.recent_items) {
    const candidate = parseCandidate(raw)
    if (seenIds.has(candidate.id)) throw new Error(`X insight package contains duplicate candidate id: ${candidate.id}`)
    seenIds.add(candidate.id)
    candidates.push(candidate)
    if (candidates.length > 20) throw new Error('X insight package exceeds the 20-candidate run bound')
  }
  const decision = isRecord(value.decision) ? value.decision : {}
  const allowedTopics = collectTopics(value, decision, candidates)
  const selectedUrls = parseUrls(value.selected_urls, 'selected_urls')
  const preparedUrls = [...new Set([...selectedUrls, ...candidates.map(candidate => candidate.source)])]
  const capabilities: XFeedRunCapabilities = {
    ...base,
    allowedTopics,
    candidates: Object.fromEntries(candidates.map(candidate => [candidate.id, {
      id: candidate.id,
      url: candidate.source,
      ...(candidate.topics.length === 0 ? {} : { topics: candidate.topics }),
    }])),
    preparedUrls,
  }
  return { capabilities, allowedTopics, candidates: Object.freeze(candidates) }
}

function parseCandidate(value: unknown): XFeedFinalCandidate {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === ''
    || typeof value.url !== 'string' || typeof value.text !== 'string' || value.text.trim() === '') {
    throw new Error('X insight package contains a candidate without reliable id, text, or canonical URL')
  }
  const source = canonicalStatusUrl(value.url)
  if (source === undefined) throw new Error(`X insight package candidate URL is not a canonical X status URL: ${value.url}`)
  const rawId = value.id
  if (/[^\x20-\x7e]/u.test(rawId) || /[\u0000-\u001f\u007f]/u.test(rawId)) throw new Error('X insight package candidate id is not canonical')
  const statusId = /\/status\/([1-9]\d*)$/u.exec(source)?.[1]
  if (statusId === undefined || !/^[1-9]\d*$/u.test(rawId) || rawId !== statusId) {
    throw new Error('X insight package candidate id is not a reliable canonical status id')
  }
  const id = `x-status:${statusId}`
  const topics = parseTopicArray(value.topics ?? value.theme)
  return Object.freeze({ id, content: value.text.trim().slice(0, 8_000), source, topics })
}

function collectTopics(
  value: XFeedInsightPackage,
  decision: Record<string, unknown>,
  candidates: readonly XFeedFinalCandidate[],
): readonly string[] {
  const values: unknown[] = []
  if (Array.isArray(value.allowed_topics)) values.push(...value.allowed_topics)
  if (typeof decision.top_theme === 'string') values.push(decision.top_theme)
  if (isRecord(decision.themes)) values.push(...Object.keys(decision.themes))
  for (const candidate of candidates) values.push(...candidate.topics)
  const topics: string[] = []
  const seen = new Set<string>()
  for (const item of values) {
    if (typeof item !== 'string' || item.trim() === '' || item !== item.trim() || /[\r\n]/u.test(item)) continue
    if (seen.has(item)) continue
    seen.add(item)
    topics.push(item)
    if (topics.length >= 50) break
  }
  return Object.freeze(topics)
}

function parseTopicArray(value: unknown): readonly string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return Object.freeze(values.filter((item): item is string => typeof item === 'string'
    && item.trim() !== '' && item === item.trim() && !/[\r\n]/u.test(item)).slice(0, 8))
}

function parseUrls(value: unknown, name: string): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) throw new Error(`X insight package ${name} must be an array`)
  const urls: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`X insight package ${name} contains a non-string URL`)
    const canonical = canonicalStatusUrl(item)
    if (canonical === undefined) throw new Error(`X insight package ${name} contains a non-canonical URL: ${item}`)
    if (seen.has(canonical)) throw new Error(`X insight package ${name} contains duplicate URL: ${canonical}`)
    seen.add(canonical)
    urls.push(canonical)
  }
  return Object.freeze(urls)
}

function canonicalStatusUrl(value: string): string | undefined {
  const match = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/([1-9]\d*)$/u.exec(value.trim())
  return match === null ? undefined : `https://x.com/${match[1]!.toLowerCase()}/status/${match[2]}`
}

function safeRunPart(runId: string): string {
  return `run-${createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 32)}`
}

function failure(code: string, message: string): XFeedRunToolFailure {
  return { ok: false, code, message }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
