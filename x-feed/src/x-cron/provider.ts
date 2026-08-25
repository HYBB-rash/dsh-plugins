import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  MaterialProjectionReportScopeEstablished,
  MechanicalAdmissionPeriodScopeEstablished,
  PeriodIdentity,
  SourceCandidateReportAccepted,
} from '@herman/personal-feed'
import type {
  CronAgentEnvironmentSkip,
  CronAgentEnvironmentLease,
  CronAgentEnvironmentProvider,
  CronAgentEnvironmentRequirements,
} from '@deepseek-ai/dsh-cron'
import {
  createBoundFactProjectionPreflight,
  type CandidateDescriptor,
  type CandidateFactAssessment,
  type ProjectionBudget,
  type ProjectionFailure,
  type ReadyFactProjectionSession,
} from '../fact-projection/index.ts'
import { createExactTargetAssessment } from './exact-target-facts.ts'
import {
  XFeedComposerAgentSurface,
  type XFeedComposerFact,
} from './composer-agent.ts'
import { runXCronPlanner } from './planner-agent.ts'
import {
  generateXDigest,
  type GenerateXDigestPorts,
  type XFeedDigestCandidateInput,
  type XFeedExploreResult,
  type XFeedRandomWalkPlan,
  type XFeedSearchResult,
} from './generate-x-digest.ts'
import { itemIdFor } from './current-run-item-registry.ts'
import { parseXStatusIdentity } from './x-status-identity.ts'
import {
  createXFeedPythonPorts,
  type PythonCommandRunner,
  type XFeedArtifactReader,
  type XFeedInsightPackage,
  type XFeedRunCapabilities,
} from './python-ports.ts'
import {
  prepareAndSubmitXSourceCandidateReport,
  normalizeXCurrentCollection,
  type XSourceCandidateReportPorts,
  type XSourceCandidateReportPort,
  type XSourceCollectionEvidence,
} from './source-candidate-report.ts'
import {
  projectXAcceptedReportIntoEditingInputs,
  type XCandidateEditingInputPorts,
} from './candidate-editing-input.ts'
import {
  createXSourceCandidateMaterialSnapshotStore,
  type XSourceCandidateMaterialSnapshot,
  type XSourceCandidateMaterialSnapshotBinding,
} from './source-candidate-material-snapshot.ts'

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

const UNCLASSIFIED_THEME_ID = 'mixed'

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
  readonly sourceCandidateReport?: XFeedSourceCandidateReportWiring
}

/** The provider receives C32/C35 and the source's narrow C36 boundary from the cron adapter. */
export interface XFeedSourceCandidateReportWiring {
  readonly period: PeriodIdentity
  readonly mechanicalAdmissionScope: MechanicalAdmissionPeriodScopeEstablished
  readonly materialProjectionReportScope: MaterialProjectionReportScopeEstablished
  readonly candidatePort: XSourceCandidateReportPorts
  readonly reportPort: XSourceCandidateReportPort
  readonly periodFinalizer?: XCandidateEditingInputPorts['periodFinalizer']
  readonly crossSourceEditor?: XCandidateEditingInputPorts['crossSourceEditor']
  readonly acceptedReport?: SourceCandidateReportAccepted
}

interface OrdinaryFeedRunPreparationPort {
  readonly prepareOrdinaryFeed: () => Promise<CronAgentEnvironmentLease>
}

type XFeedCronProviderOptionsWithoutJobId = Omit<XFeedCronProviderOptions, 'cronJobId'>

type XFeedCronProviderMode =
  | { readonly kind: 'legacy'; readonly cronJobId: string }
  | { readonly kind: 'ordinary' }

interface InternalXFeedCronProviderOptions extends XFeedCronProviderOptionsWithoutJobId {
  readonly mode: XFeedCronProviderMode
  readonly ordinaryFeedRunPreparationPort?: OrdinaryFeedRunPreparationPort
}

/** Build the exact provider registered for one configured cron job. */
export function createXFeedCronEnvironmentProvider(
  options: XFeedCronProviderOptions,
): CronAgentEnvironmentProvider {
  return createInternalXFeedCronEnvironmentProvider({
    ...options,
    mode: { kind: 'legacy', cronJobId: options.cronJobId },
  })
}

/** Build the ordinary Feed provider without exposing the seam through the barrel. */
export function createXFeedCronEnvironmentProviderForOrdinaryFeed(
  options: XFeedCronProviderOptionsWithoutJobId,
  port: OrdinaryFeedRunPreparationPort,
): CronAgentEnvironmentProvider {
  const wiring = options.sourceCandidateReport
  if (wiring === undefined
    || wiring.periodFinalizer === undefined
    || wiring.crossSourceEditor === undefined) {
    throw new Error('ordinary X cron provider requires source candidate report C10 wiring')
  }
  return createInternalXFeedCronEnvironmentProvider({
    ...options,
    mode: { kind: 'ordinary' },
    ordinaryFeedRunPreparationPort: port,
  })
}

function createInternalXFeedCronEnvironmentProvider(
  options: InternalXFeedCronProviderOptions,
): CronAgentEnvironmentProvider {
  if (options.mode.kind === 'legacy' && options.mode.cronJobId.trim() === '') {
    throw new Error('X cron provider requires a non-empty cronJobId')
  }
  if (options.dataDir.trim() === '') throw new Error('X cron provider requires a non-empty dataDir')
  if (basename(options.pipelinePath) !== 'x_insight_pipeline.py') {
    throw new Error('X cron provider only accepts the shipped x_insight_pipeline.py adapter')
  }
  const hasPeriodFinalizer = options.sourceCandidateReport?.periodFinalizer !== undefined
  const hasCrossSourceEditor = options.sourceCandidateReport?.crossSourceEditor !== undefined
  if (hasPeriodFinalizer !== hasCrossSourceEditor) {
    throw new Error('X source candidate report wiring requires both periodFinalizer and crossSourceEditor')
  }

  return {
    marker: X_CRON_AGENT_ENVIRONMENT_MARKER,
    requirements: X_CRON_ENVIRONMENT_REQUIREMENTS,
    prepare: async context => prepareXFeedRun(options, context),
  }
}

async function prepareXFeedRun(
  options: InternalXFeedCronProviderOptions,
  context: { readonly jobId: string; readonly runId: string },
): Promise<CronAgentEnvironmentLease | CronAgentEnvironmentSkip> {
  if (options.mode.kind === 'legacy' && context.jobId !== options.mode.cronJobId) {
    throw new Error(`X cron provider job id mismatch: expected ${options.mode.cronJobId}, got ${context.jobId}`)
  }

  const runPart = safeRunPart(context.runId)
  const runDir = join(options.dataDir, '.runs', runPart)

  try {
    const sourceCandidateReport = options.sourceCandidateReport
    if (sourceCandidateReport?.acceptedReport !== undefined) {
      mkdirSync(runDir, { recursive: true })
    }
    const materialSnapshotStore = sourceCandidateReport === undefined
      ? undefined
      : createXSourceCandidateMaterialSnapshotStore({
        ledgerPath: join(runDir, 'source-candidate-material-snapshot.jsonl'),
      })

    if (sourceCandidateReport?.acceptedReport !== undefined) {
      if (options.ordinaryFeedRunPreparationPort === undefined || materialSnapshotStore === undefined) {
        throw new Error('ordinary X source candidate recovery requires its preparation and snapshot ports')
      }
      const binding: XSourceCandidateMaterialSnapshotBinding = {
        runId: context.runId,
        period: sourceCandidateReport.period,
        materialProjectionReportScope: sourceCandidateReport.materialProjectionReportScope,
      }
      const readSnapshot = materialSnapshotStore.readSnapshot(binding)
      if (readSnapshot.status !== 'found') {
        throw new Error(`X source candidate material snapshot recovery was ${readSnapshot.status}`)
      }
      await replayAcceptedSourceCandidateReport(
        sourceCandidateReport.acceptedReport,
        readSnapshot.value,
        sourceCandidateReport,
      )
      return options.ordinaryFeedRunPreparationPort.prepareOrdinaryFeed()
    }

    const budget = options.projectionBudget ?? DEFAULT_PROJECTION_BUDGET

    // Readiness is deliberately mechanical. No assessment Agent exists on this
    // path; the same file readers are pinned before any Python action starts.
    let exactAssessment: ((candidate: CandidateDescriptor) => CandidateFactAssessment | ProjectionFailure) | undefined
    const preflight = createBoundFactProjectionPreflight(options.dataDir, budget, navigation => {
      exactAssessment = candidate => createExactTargetAssessment({ candidate, navigation })
      return { checkReadiness: () => ({ ready: true as const }) }
    })
    if (preflight.kind !== 'ready') {
      throw new Error(`X cron preflight ${preflight.kind}: ${preflight.code}: ${preflight.message}`)
    }
    if (exactAssessment === undefined) throw new Error('X cron preflight completed without its exact-target assessment binder')
    const projectionSession = preflight.session
    const packagePath = join(options.dataDir, 'x_insight_package.json')
    const shownPath = join(options.dataDir, 'x_shown.json')
    const collectionPath = join(runDir, 'collection.jsonl')
    const topicSearchOutputPath = join(runDir, 'topic-search.jsonl')
    mkdirSync(runDir, { recursive: true })

    const baseCapabilities = createCapabilities({
      runId: runPart,
      cronJobId: context.jobId,
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
    if (sourceCandidateReport !== undefined) {
      if (parsed.currentCollection === undefined) {
        throw new Error('X source candidate report requires current_collection in the Python package')
      }
      const evidence = collectionEvidence(insightPackage, baseCapabilities, context.runId)
      if (materialSnapshotStore === undefined) {
        throw new Error('X source candidate report requires its material snapshot store')
      }
      const normalizedCollection = normalizeXCurrentCollection(parsed.currentCollection)
      const snapshot: XSourceCandidateMaterialSnapshot = {
        runId: context.runId,
        period: sourceCandidateReport.period,
        materialProjectionReportScope: sourceCandidateReport.materialProjectionReportScope,
        collectionEvidence: evidence,
        currentCollection: normalizedCollection,
      }
      const acceptedSnapshot = materialSnapshotStore.acceptSnapshot(snapshot)
      if (acceptedSnapshot.status !== 'accepted') {
        throw new Error(`X source candidate material snapshot was ${acceptedSnapshot.status}`)
      }
      const readSnapshot = materialSnapshotStore.readSnapshot({
        runId: acceptedSnapshot.value.runId,
        period: acceptedSnapshot.value.period,
        materialProjectionReportScope: acceptedSnapshot.value.materialProjectionReportScope,
      })
      if (readSnapshot.status !== 'found') {
        throw new Error(`X source candidate material snapshot readback was ${readSnapshot.status}`)
      }
      const materialSnapshot = readSnapshot.value
      const acceptedReport = await prepareAndSubmitXSourceCandidateReport({
        period: sourceCandidateReport.period,
        mechanicalAdmissionScope: sourceCandidateReport.mechanicalAdmissionScope,
        materialProjectionReportScope: sourceCandidateReport.materialProjectionReportScope,
        collectionEvidence: materialSnapshot.collectionEvidence,
        currentCollection: materialSnapshot.currentCollection,
        candidatePort: sourceCandidateReport.candidatePort,
        reportPort: sourceCandidateReport.reportPort,
      })
      if (sourceCandidateReport.periodFinalizer !== undefined) {
        await projectXAcceptedReportIntoEditingInputs({
          period: sourceCandidateReport.period,
          collectionEvidence: materialSnapshot.collectionEvidence,
          acceptedReport,
          currentCollection: materialSnapshot.currentCollection,
          periodFinalizer: sourceCandidateReport.periodFinalizer,
          crossSourceEditor: sourceCandidateReport.crossSourceEditor!,
        })
      }
      if (options.ordinaryFeedRunPreparationPort !== undefined
        && acceptedReport.report.candidates.length === 0) {
        return { kind: 'skip', outcome: { text: undefined, error: undefined } }
      }
    }
    if (options.ordinaryFeedRunPreparationPort !== undefined) {
      return options.ordinaryFeedRunPreparationPort.prepareOrdinaryFeed()
    }
    if (parsed.candidates.length === 0) {
      return { kind: 'skip', outcome: { text: undefined, error: undefined } }
    }

    const capabilities = createCapabilities(parsed.capabilities)
    const ports = createPythonPorts(options, capabilities)
    const servicePorts: GenerateXDigestPorts = {
      plan: async request => (await runXCronPlanner(options.ctx, request)).dto,
      search: async topic => normalizeSearchResult(await ports.searchTopic(topic)),
      explore: async candidateId => normalizeExploreResult(await ports.exploreCandidate(candidateId)),
      projectFacts: item => projectExactTargetFacts(item, projectionSession, exactAssessment!),
      prepareDelivery: (text, urls, prepareOptions) => ports.prepareDelivery(text, urls, prepareOptions),
    }
    const generated = await generateXDigest({
      candidates: parsed.candidates,
      allowedThemes: parsed.allowedThemes,
      allowedTopics: parsed.allowedTopics,
      allowlistedExploreIds: parsed.allowlistedExploreIds,
      mechanicalSignals: parsed.mechanicalSignals,
      ...(parsed.randomWalk === undefined ? {} : { randomWalk: parsed.randomWalk }),
      ports: servicePorts,
    })
    if (generated.kind === 'skip') return generated
    const surface = new XFeedComposerAgentSurface({ material: generated.composerMaterial })
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
      finalizeOutcome: async outcome => generated.finalize(surface.finalizeOutcome(outcome)),
      dispose: () => surface.dispose(),
    }
  } catch (error) {
    // A failed prepare never returns a lease to dsh-cron. The per-run
    // directory was created by this provider and is safe to leave as bounded
    // audit evidence; no user-owned persistent state is removed here.
    throw error
  }
}

async function replayAcceptedSourceCandidateReport(
  acceptedReport: SourceCandidateReportAccepted,
  snapshot: XSourceCandidateMaterialSnapshot,
  wiring: XFeedSourceCandidateReportWiring,
): Promise<void> {
  if (wiring.periodFinalizer === undefined || wiring.crossSourceEditor === undefined) {
    throw new Error('ordinary X source candidate recovery requires C26/C16/C10 wiring')
  }
  const projected = await projectXAcceptedReportIntoEditingInputs({
    period: wiring.period,
    collectionEvidence: snapshot.collectionEvidence,
    acceptedReport,
    currentCollection: snapshot.currentCollection,
    periodFinalizer: wiring.periodFinalizer,
    crossSourceEditor: wiring.crossSourceEditor,
  })
  const expected = acceptedReport.report.candidates
    .map(candidate => candidate.candidate.stableReference)
    .sort()
  const actual = projected
    .map(candidate => candidate.candidate.stableReference)
    .sort()
  if (!sameStringArray(expected, actual)) {
    throw new Error('X source candidate recovery did not project every C36 member into C26/C16/C10')
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

interface ParsedPackage {
  readonly capabilities: XFeedRunCapabilities
  readonly allowedThemes: readonly string[]
  readonly allowedTopics: readonly string[]
  readonly allowlistedExploreIds: readonly string[]
  readonly mechanicalSignals: Readonly<Record<string, boolean | number | string>>
  readonly randomWalk?: XFeedRandomWalkPlan
  readonly candidates: readonly XFeedDigestCandidateInput[]
  readonly currentCollection: readonly unknown[] | undefined
}

function createPythonPorts(options: XFeedCronProviderOptionsWithoutJobId, capabilities: XFeedRunCapabilities) {
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
  const candidates: XFeedDigestCandidateInput[] = []
  const currentCollection = Object.prototype.hasOwnProperty.call(value, 'current_collection')
    && Array.isArray(value.current_collection)
    ? Object.freeze([...value.current_collection])
    : undefined
  const seenIds = new Set<string>()
  for (const raw of value.recent_items) {
    const candidate = parseCandidate(raw)
    if (seenIds.has(candidate.id)) throw new Error(`X insight package contains duplicate candidate id: ${candidate.id}`)
    seenIds.add(candidate.id)
    candidates.push(candidate)
    if (candidates.length > 20) throw new Error('X insight package exceeds the 20-candidate run bound')
  }
  if (candidates.length === 0) {
    return {
      capabilities: { ...base, allowedTopics: [], candidates: {}, preparedUrls: [] },
      allowedThemes: [],
      allowedTopics: [],
      allowlistedExploreIds: [],
      mechanicalSignals: { candidateCount: 0 },
      candidates: Object.freeze([]),
      currentCollection,
    }
  }
  const decision = isRecord(value.decision) ? value.decision : {}
  const candidateTopics = candidates.flatMap(candidate => candidate.topics)
  const hasExplicitThemeAllowlist = Object.prototype.hasOwnProperty.call(value, 'allowed_themes')
    || Object.prototype.hasOwnProperty.call(value, 'allowedThemes')
  const explicitThemeSource = value.allowed_themes ?? value.allowedThemes
  if (hasExplicitThemeAllowlist && collectAllowlist(explicitThemeSource, []).length === 0) {
    throw new Error('X insight package does not expose a bounded theme allowlist')
  }
  const derivedThemes = collectAllowlist(
    explicitThemeSource ?? value.allowed_topics ?? decision.allowed_themes ?? decision.top_theme,
    candidateTopics,
  )
  const usesUnclassifiedTheme = derivedThemes.length === 0
  const allowedThemes = usesUnclassifiedTheme ? Object.freeze([UNCLASSIFIED_THEME_ID]) : derivedThemes
  const allowedTopics = collectAllowlist(
    value.allowed_topics ?? value.allowedTopics ?? decision.allowed_topics ?? candidateTopics,
    usesUnclassifiedTheme ? candidateTopics : allowedThemes,
  )
  const randomWalk = collectRandomWalkPlan(value, decision, candidates)
  const selectedUrls = parseUrls(value.selected_urls, 'selected_urls')
  const preparedUrls = [...new Set([...selectedUrls, ...candidates.map(candidate => candidate.source)])]
  const mechanicalSignals = collectMechanicalSignals(decision, candidates.length)
  const randomWalkCapabilities = randomWalk?.options.flatMap(option => option.kind === 'search'
    ? [option.topicId, option.themeId]
    : [option.themeId]) ?? []
  const capabilities: XFeedRunCapabilities = {
    ...base,
    allowedTopics: Object.freeze([...new Set([...allowedTopics, ...allowedThemes, ...randomWalkCapabilities])]),
    candidates: Object.fromEntries(candidates.map(candidate => [candidate.id, {
      id: candidate.id,
      url: candidate.source,
      ...(candidate.topics.length === 0 ? {} : { topics: candidate.topics }),
    }])),
    preparedUrls,
  }
  return {
    capabilities,
    allowedThemes,
    allowedTopics,
    allowlistedExploreIds: Object.freeze(candidates.map(candidate => candidate.id)),
    mechanicalSignals,
    ...(randomWalk === undefined ? {} : { randomWalk }),
    candidates: Object.freeze(candidates),
    currentCollection,
  }
}

function collectionEvidence(
  value: XFeedInsightPackage,
  capabilities: XFeedRunCapabilities,
  runId: string,
): XSourceCollectionEvidence {
  const collectionBatch = requirePackageString(value.collection_batch, 'collection_batch')
  if (collectionBatch !== capabilities.collectionPath) {
    throw new Error('X insight package collection_batch does not match the known run collection path')
  }
  const deliveryId = requirePackageString(value.delivery_id, 'delivery_id')
  const ts = value.ts
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts <= 0) {
    throw new Error('X insight package ts is invalid')
  }
  const collectionStatus = value.collection_status
  if (collectionStatus !== 'ok' && collectionStatus !== 'empty') {
    throw new Error('X insight package collection_status is invalid')
  }
  return {
    runId,
    source: 'x',
    collectionPath: capabilities.collectionPath,
    collectionBatch,
    deliveryId,
    ts,
  }
}

function requirePackageString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`X insight package ${name} is invalid`)
  }
  return value
}

function parseCandidate(value: unknown): XFeedDigestCandidateInput {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === ''
    || typeof value.url !== 'string' || typeof value.text !== 'string' || value.text.trim() === '') {
    throw new Error('X insight package contains a candidate without reliable id, text, or canonical URL')
  }
  const identity = parseXStatusIdentity(value.url)
  if (identity === undefined) throw new Error(`X insight package candidate URL is not a canonical X status URL: ${value.url}`)
  const rawId = value.id
  if (/[^\x20-\x7e]/u.test(rawId) || /[\u0000-\u001f\u007f]/u.test(rawId)) throw new Error('X insight package candidate id is not canonical')
  if (!/^[1-9]\d*$/u.test(rawId) || rawId !== identity.statusId) {
    throw new Error('X insight package candidate id is not a reliable canonical status id')
  }
  const id = `x-status:${identity.statusId}`
  const topics = parseTopicArray(value.topics ?? value.theme)
  const content = boundedPlainText(value.text, '', 12_000)
  const title = boundedPlainText(value.title, content, 320)
  const summary = boundedPlainText(value.summary, content, 1_200)
  return Object.freeze({ id, content, source: identity.canonicalUrl, topics, title, summary })
}

function collectAllowlist(primary: unknown, fallback: readonly string[]): readonly string[] {
  const values: unknown[] = Array.isArray(primary) ? [...primary] : primary === undefined ? [] : [primary]
  values.push(...fallback)
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

function collectMechanicalSignals(
  decision: Record<string, unknown>,
  candidateCount: number,
): Readonly<Record<string, boolean | number | string>> {
  const signals: Record<string, boolean | number | string> = { candidateCount }
  for (const key of ['wander_suggested', 'flooded', 'recent_count'] as const) {
    const value = decision[key]
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) signals[key] = value
  }
  return Object.freeze(signals)
}

function collectRandomWalkPlan(
  value: XFeedInsightPackage,
  decision: Record<string, unknown>,
  candidates: readonly XFeedDigestCandidateInput[],
): XFeedRandomWalkPlan | undefined {
  if (decision.wander_suggested !== true || typeof decision.random_roll !== 'number'
    || !Number.isFinite(decision.random_roll) || decision.random_roll < 0 || decision.random_roll >= 1) return undefined
  const topTheme = typeof decision.top_theme === 'string' ? decision.top_theme : undefined
  const options: Array<XFeedRandomWalkPlan['options'][number]> = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(value.explore_candidates) ? value.explore_candidates : []) {
    if (!isRecord(raw)) continue
    const topicId = parseRandomWalkLabel(raw.topic)
    if (topicId === undefined || topicId === topTheme || seen.has(`search:${topicId}`)) continue
    seen.add(`search:${topicId}`)
    options.push(Object.freeze({ kind: 'search', topicId, themeId: topicId }))
    if (options.length >= 20) break
  }
  if (options.length === 0) {
    const candidateIdByUrl = new Map(candidates.map(candidate => [candidate.source, candidate.id]))
    for (const raw of Array.isArray(decision.candidates) ? decision.candidates : []) {
      if (!isRecord(raw) || typeof raw.url !== 'string') continue
      const identity = parseXStatusIdentity(raw.url)
      if (identity === undefined) continue
      const candidateId = candidateIdByUrl.get(identity.canonicalUrl)
      if (candidateId === undefined || seen.has(`explore:${candidateId}`)) continue
      const themeId = parseRandomWalkLabel(raw.theme) ?? UNCLASSIFIED_THEME_ID
      if (themeId === topTheme) continue
      seen.add(`explore:${candidateId}`)
      options.push(Object.freeze({ kind: 'explore', candidateId, themeId }))
      if (options.length >= 20) break
    }
  }
  if (options.length === 0) return undefined
  return Object.freeze({ roll: decision.random_roll, options: Object.freeze(options) })
}

function parseRandomWalkLabel(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > 320 || /(?:https?:\/\/|ftp:\/\/|www\.)/iu.test(value)
    || /!?(?:\[[^\]]*\]\([^)]*\)|`{1,3}|\*\*|__|^\s{0,3}#{1,6}\s|(?:^|\s)[*+-]\s)/mu.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)) return undefined
  return value
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
    const identity = parseXStatusIdentity(item)
    if (identity === undefined) throw new Error(`X insight package ${name} contains a non-canonical URL: ${item}`)
    if (seen.has(identity.canonicalUrl)) throw new Error(`X insight package ${name} contains duplicate URL: ${identity.canonicalUrl}`)
    seen.add(identity.canonicalUrl)
    urls.push(identity.canonicalUrl)
  }
  return Object.freeze(urls)
}

function boundedPlainText(value: unknown, fallback: string, maxBytes: number): string {
  const source = typeof value === 'string' && value.trim() !== '' ? value : fallback
  const cleaned = source
    .replace(/(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>()]*/giu, ' ')
    .replace(/!?(?:\[[^\]]*\]\([^)]*\)|`{1,3}|\*\*|__)/gu, ' ')
    .replace(/(?:^|\s)[#>*+-]+\s/gu, ' ')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (cleaned === '') throw new Error('X insight package candidate has no representable planner text')
  return boundUtf8(cleaned, maxBytes)
}

function boundUtf8(value: string, maxBytes: number): string {
  let result = ''
  let bytes = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maxBytes) break
    result += character
    bytes += size
  }
  return result.trim()
}

function normalizeSearchResult(value: XFeedInsightPackage): XFeedSearchResult {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error('X topic search result is invalid')
  const items = value.items.map(item => {
    const candidate = parseCandidate(item)
    return candidate
  })
  const summary = boundedPlainText(value.summary, 'topic search result', 1_200)
  return { items, summary }
}

function normalizeExploreResult(value: XFeedInsightPackage): XFeedExploreResult {
  if (!isRecord(value) || typeof value.body !== 'string') throw new Error('X exploration result is invalid')
  const content = boundedPlainText(value.body, '', 12_000)
  const summary = boundedPlainText(value.title, content, 1_200)
  return { content, topics: parseTopicArray(value.topics), summary }
}

function projectExactTargetFacts(
  item: CandidateDescriptor,
  session: ReadyFactProjectionSession,
  assessmentFactory: (candidate: CandidateDescriptor) => CandidateFactAssessment | ProjectionFailure,
): { readonly facts: readonly XFeedComposerFact[]; readonly audit: { readonly policyId: 'x-cron-exact-target'; readonly policyVersion: '1'; readonly matchedLocatorCount: number } } {
  const candidate = { id: item.id, content: item.content, source: item.source }
  const assessment = assessmentFactory(candidate)
  if ('kind' in assessment) throw new Error(`X cron exact-target assessment failed: ${assessment.message}`)
  const projected = session.project(candidate, assessment)
  if (projected.kind !== 'ready') throw new Error(`X cron exact-target projection failed: ${projected.message}`)
  const inlineFacts = projected.view.facts.map(fact => ({
    targetId: itemIdFor(item.id),
    summary: boundedPlainText(fact.reason, fact.target.id, 1_200),
  }))
  const matchedLocatorCount = assessment.audit.decisions.filter(decision => decision.relevance === 'high').length
  return {
    facts: Object.freeze(inlineFacts),
    audit: { policyId: 'x-cron-exact-target', policyVersion: '1', matchedLocatorCount },
  }
}

function safeRunPart(runId: string): string {
  return `run-${createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 32)}`
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
