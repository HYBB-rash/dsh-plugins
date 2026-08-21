import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import {
  runOneShotStructuredAgent,
  type OneShotStructuredAgentError,
  type OneShotStructuredAgentResult,
  type OneShotStructuredAgentWireRequest,
} from './one-shot-structured-agent.ts'
import {
  parsePlannerDto,
  type PlannerDto,
  type TwoCallContractCode,
} from './two-call-contract.ts'

export const SUBMIT_X_CRON_PLANNER = 'submit_x_cron_planner'

export const PLANNER_SYSTEM_PROMPT = [
  '你是一次性的 X 洞察 planner Agent。',
  '只能依据本轮 user message 中的有界候选、主题、话题、探索 ID 和机械信号做选择。',
  `必须调用 ${SUBMIT_X_CRON_PLANNER} 一次，提交严格结构化 planner DTO；不要输出普通文本。`,
  '只提交当前输入中的 ID，不得创造 ID、主题或话题。',
  '不要提交网址、Markdown、正文渲染内容，也不要调用搜索、探索、准备、主题状态或其他工具。',
].join('\n')

export const SUBMIT_X_CRON_PLANNER_SCHEMA = {
  name: SUBMIT_X_CRON_PLANNER,
  description: '提交本轮严格结构化 planner DTO。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      selectedCandidateIds: { type: 'array', items: { type: 'string' } },
      themeId: { type: 'string' },
      exploration: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['none', 'search', 'explore'] },
          topicId: { type: 'string' },
          candidateId: { type: 'string' },
        },
        required: ['kind'],
      },
    },
    required: ['selectedCandidateIds', 'themeId', 'exploration'],
  },
} as const

const MAX_CANDIDATES = 20
const MAX_ID_UTF8_BYTES = 160
const MAX_TITLE_UTF8_BYTES = 320
const MAX_SUMMARY_UTF8_BYTES = 1_200
const MAX_MATERIAL_UTF8_BYTES = 16_000
const FORBIDDEN_TEXT = /(?:https?:\/\/|ftp:\/\/|www\.)/iu
const FORBIDDEN_MARKDOWN = /!?(?:\[[^\]]*\]\([^)]*\)|`{1,3}|\*\*|__|^\s{0,3}#{1,6}\s|(?:^|\s)[*+-]\s)/mu

export interface XCronPlannerCandidate {
  readonly id: string
  readonly title: string
  readonly summary: string
}

/** Mechanical values are deliberately scalar and have no history channel. */
export type XCronPlannerMechanicalSignals = Readonly<Record<string, boolean | number | string>>

export interface XCronPlannerRequest {
  readonly candidates: readonly XCronPlannerCandidate[]
  readonly allowedThemes: readonly string[]
  readonly allowedTopics: readonly string[]
  readonly allowlistedExploreIds: readonly string[]
  readonly mechanicalSignals?: XCronPlannerMechanicalSignals
}

export interface XCronPlannerOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly modelSelection?: ModelSelection
  readonly defaultModelSelection?: () => ModelSelection
}

export interface XCronPlannerResult {
  readonly dto: PlannerDto
  readonly sessionId: OneShotStructuredAgentResult<PlannerDto>['sessionId']
  readonly wire: OneShotStructuredAgentWireRequest
}

export class XCronPlannerAgentError extends Error {
  readonly code: 'invalid-request' | TwoCallContractCode | OneShotStructuredAgentError['code']

  constructor(
    code: 'invalid-request' | TwoCallContractCode | OneShotStructuredAgentError['code'],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'XCronPlannerAgentError'
    this.code = code
  }
}

/**
 * Canonicalize the known union shapes emitted by the current tool schema.
 * Unknown fields stay visible to the strict DTO parser, and unsafe remnants
 * stay visible too, so projection cannot turn untrusted text into a valid DTO
 * by accident.
 */
export function projectPlannerSubmission(value: unknown): unknown {
  if (!isRecord(value)) return value
  const exploration = value.exploration
  if (!isRecord(exploration)) return { ...value }

  if (exploration.kind === 'explore'
    && hasExactKeys(exploration, ['kind', 'topicId'])
    && isSafeUnionResidual(exploration.topicId)) {
    return { ...value, exploration: { kind: 'search', topicId: exploration.topicId } }
  }
  if (exploration.kind === 'search'
    && hasExactKeys(exploration, ['kind', 'candidateId'])
    && isSafeUnionResidual(exploration.candidateId)) {
    return { ...value, exploration: { kind: 'explore', candidateId: exploration.candidateId } }
  }

  const oppositeKey = exploration.kind === 'explore'
    ? 'topicId'
    : exploration.kind === 'search'
      ? 'candidateId'
      : undefined
  const projectedExploration: Record<string, unknown> = { ...exploration }
  if (oppositeKey !== undefined
    && Object.prototype.hasOwnProperty.call(exploration, oppositeKey)
    && isSafeUnionResidual(exploration[oppositeKey])) {
    delete projectedExploration[oppositeKey]
  }
  return { ...value, exploration: projectedExploration }
}

function isSafeUnionResidual(value: unknown): value is string {
  return boundedPlainText(value, MAX_ID_UTF8_BYTES)
}

/** Run one fresh planner Agent and return only its validated DTO. */
export async function runXCronPlanner(
  ctx: Context,
  request: XCronPlannerRequest,
  options: XCronPlannerOptions = {},
): Promise<XCronPlannerResult> {
  const material = validatePlannerRequest(request)
  const context = {
    candidateIds: material.candidates.map(candidate => candidate.id),
    allowedTopicIds: [...material.allowedThemes, ...material.allowedTopics],
  } as const
  const message = createUserMessage({
    content: [{ type: 'text', text: `当前 planner 输入\n${JSON.stringify(material)}` }],
    source: { kind: 'plugin', plugin: 'x-feed' },
  })
  let parsed: PlannerDto | undefined
  const result = await runOneShotStructuredAgent<PlannerDto>({
    ctx,
    sessionPrefix: 'session-x-planner',
    promptSectionName: 'x-cron:planner-system',
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    inputMessage: message,
    toolName: SUBMIT_X_CRON_PLANNER,
    toolDescription: SUBMIT_X_CRON_PLANNER_SCHEMA.description,
    toolParameters: SUBMIT_X_CRON_PLANNER_SCHEMA.parameters,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.modelSelection === undefined ? {} : { modelSelection: options.modelSelection }),
    ...(options.defaultModelSelection === undefined ? {} : { defaultModelSelection: options.defaultModelSelection }),
    parseSubmission: (value, exec) => {
      const validated = parsePlannerDto(JSON.stringify(projectPlannerSubmission(value)), context)
      if (!validated.ok) {
        try {
          exec.agent?.cancel({ kind: 'hook', reason: `invalid planner DTO: ${validated.code}` })
        } catch {
          // The structured validation failure remains authoritative.
        }
        throw new XCronPlannerAgentError(validated.code, validated.message)
      }
      if (!material.allowedThemes.includes(validated.value.themeId)) {
        throw new XCronPlannerAgentError('unknown-theme-id', 'planner theme is not in the allowed theme list')
      }
      if (validated.value.exploration.kind === 'search' && !material.allowedTopics.includes(validated.value.exploration.topicId)) {
        throw new XCronPlannerAgentError('unknown-exploration-topic', 'planner exploration topic is not in the allowed topic list')
      }
      if (validated.value.exploration.kind === 'explore' && !material.allowlistedExploreIds.includes(validated.value.exploration.candidateId)) {
        throw new XCronPlannerAgentError('unknown-exploration-candidate', 'planner exploration candidate is not allowlisted')
      }
      parsed = validated.value
      return validated.value
    },
  })
  if (parsed === undefined) throw new XCronPlannerAgentError('invalid-request', 'planner Agent returned without a DTO')
  return { dto: result.value, sessionId: result.sessionId, wire: result.wire }
}

export function validateXCronPlannerRequest(value: unknown): XCronPlannerRequest {
  return validatePlannerRequest(value)
}

function validatePlannerRequest(value: unknown): XCronPlannerRequest {
  if (!isRecord(value)) throw new XCronPlannerAgentError('invalid-request', 'planner request must be an object')
  const keys = Object.keys(value)
  const allowed = new Set(['candidates', 'allowedThemes', 'allowedTopics', 'allowlistedExploreIds', 'mechanicalSignals'])
  if (keys.some(key => !allowed.has(key))) throw new XCronPlannerAgentError('invalid-request', 'planner request has unknown fields')
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    throw new XCronPlannerAgentError('invalid-request', 'planner requires a non-empty candidate list')
  }
  if (value.candidates.length > MAX_CANDIDATES) throw new XCronPlannerAgentError('invalid-request', 'planner candidate list exceeds its bound')
  const candidates: XCronPlannerCandidate[] = []
  const candidateIds = new Set<string>()
  for (const candidate of value.candidates) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ['id', 'title', 'summary'])) {
      throw new XCronPlannerAgentError('invalid-request', 'planner candidate has an invalid shape')
    }
    if (!boundedPlainText(candidate.id, MAX_ID_UTF8_BYTES) || !boundedPlainText(candidate.title, MAX_TITLE_UTF8_BYTES)
      || !boundedPlainText(candidate.summary, MAX_SUMMARY_UTF8_BYTES)) {
      throw new XCronPlannerAgentError('invalid-request', 'planner candidate contains invalid or oversized text')
    }
    if (candidateIds.has(candidate.id)) throw new XCronPlannerAgentError('invalid-request', 'planner candidate IDs must be unique')
    candidateIds.add(candidate.id)
    candidates.push({ id: candidate.id, title: candidate.title, summary: candidate.summary })
  }
  const allowedThemes = validateStringList(value.allowedThemes, 'allowed themes')
  const allowedTopics = validateStringList(value.allowedTopics, 'allowed topics')
  const allowlistedExploreIds = validateStringList(value.allowlistedExploreIds, 'explore allowlist')
  const candidateSet = new Set(candidates.map(candidate => candidate.id))
  if (allowlistedExploreIds.some(id => !candidateSet.has(id))) {
    throw new XCronPlannerAgentError('invalid-request', 'explore allowlist contains an unknown candidate')
  }
  const mechanicalSignals = value.mechanicalSignals === undefined
    ? undefined
    : validateMechanicalSignals(value.mechanicalSignals)
  const material: XCronPlannerRequest = {
    candidates: Object.freeze(candidates),
    allowedThemes: Object.freeze(allowedThemes),
    allowedTopics: Object.freeze(allowedTopics),
    allowlistedExploreIds: Object.freeze(allowlistedExploreIds),
    ...(mechanicalSignals === undefined ? {} : { mechanicalSignals }),
  }
  if (utf8Bytes(JSON.stringify(material)) > MAX_MATERIAL_UTF8_BYTES) {
    throw new XCronPlannerAgentError('invalid-request', 'planner input exceeds its serialized bound')
  }
  return Object.freeze(material)
}

function validateStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => !boundedPlainText(item, MAX_ID_UTF8_BYTES))) {
    throw new XCronPlannerAgentError('invalid-request', `${label} must be a bounded string list`)
  }
  const result = [...value] as string[]
  if (new Set(result).size !== result.length) throw new XCronPlannerAgentError('invalid-request', `${label} must not contain duplicates`)
  return result
}

function validateMechanicalSignals(value: unknown): XCronPlannerMechanicalSignals {
  if (!isRecord(value)) throw new XCronPlannerAgentError('invalid-request', 'mechanical signals must be a scalar record')
  const result: Record<string, boolean | number | string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!boundedPlainText(key, MAX_ID_UTF8_BYTES)
      || (typeof item !== 'boolean' && typeof item !== 'number' && !boundedPlainText(item, MAX_SUMMARY_UTF8_BYTES))) {
      throw new XCronPlannerAgentError('invalid-request', 'mechanical signals must contain only bounded scalar values')
    }
    if (typeof item === 'number' && !Number.isFinite(item)) throw new XCronPlannerAgentError('invalid-request', 'mechanical signals contain a non-finite number')
    result[key] = item
  }
  return Object.freeze(result)
}

function boundedPlainText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && !FORBIDDEN_TEXT.test(value) && !FORBIDDEN_MARKDOWN.test(value)
    && !/[\u0000-\u001f\u007f]/u.test(value) && utf8Bytes(value) <= maxBytes
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}
