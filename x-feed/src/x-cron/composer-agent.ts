import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolSchema, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  COMPOSER_SUMMARY_MAX_UTF8_BYTES,
  isValidComposerPlainText,
  parseComposerDto,
  type ComposerDto,
  type ComposerSectionKind,
  type TwoCallContractCode,
} from './two-call-contract.ts'
import {
  OneShotStructuredAgentSurface,
  type OneShotStructuredAgentWireRequest,
} from './one-shot-structured-agent.ts'

export const SUBMIT_X_CRON_COMPOSER = 'submit_x_cron_composer'

export const COMPOSER_SYSTEM_PROMPT = [
  '你是一次性的 X 洞察 composer Agent，运行在 scheduler 已创建的当前 cron session 中。',
  '只能依据当前 user message 中已选条目、一次探索状态、精确目标事实和 section allowlist 工作。',
  `必须调用 ${SUBMIT_X_CRON_COMPOSER} 一次，提交严格结构化 composer DTO；不要输出普通文本。`,
  '只能使用当前输入中的 itemId，不能创造 ID，不能返回网址或 Markdown。',
  '不要调用搜索、探索、主题状态、准备、渲染、Python 或其他工具。',
].join('\n')

export const SUBMIT_X_CRON_COMPOSER_SCHEMA: ToolSchema = {
  name: SUBMIT_X_CRON_COMPOSER,
  description: '提交当前 cron run 的严格结构化 composer DTO。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['highlight', 'timeline', 'wander', 'focus', 'source'] },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { itemId: { type: 'string' }, summary: { type: 'string' } },
                required: ['itemId', 'summary'],
              },
            },
          },
          required: ['kind', 'items'],
        },
      },
    },
    required: ['title', 'sections'],
  },
}

const SECTION_KINDS: readonly ComposerSectionKind[] = ['highlight', 'timeline', 'wander', 'focus', 'source']
const MAX_ITEMS = 20
const MAX_FACTS = 20
const MAX_ITEM_TEXT_BYTES = 1_200
const MAX_FACT_TEXT_BYTES = 1_200
const MAX_EXPLORATION_TEXT_BYTES = 1_200
const MAX_MATERIAL_BYTES = 24_000

export interface XFeedComposerSelectedItem {
  readonly itemId: string
  readonly title: string
  readonly summary: string
}

export type XFeedComposerExploration =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'search'; topicId: string; status: 'success' | 'failed'; summary: string }>
  | Readonly<{ kind: 'explore'; candidateId: string; status: 'success' | 'failed'; summary: string }>

export interface XFeedComposerFact {
  readonly targetId: string
  readonly summary: string
}

export interface XFeedComposerMaterial {
  readonly selectedItems: readonly XFeedComposerSelectedItem[]
  readonly exploration: XFeedComposerExploration
  readonly facts: readonly XFeedComposerFact[]
  readonly allowedSectionKinds: readonly ComposerSectionKind[]
}

export type XFeedComposerWireRequest = OneShotStructuredAgentWireRequest

export interface XFeedComposerOutcome {
  readonly text: string
  readonly error: string | undefined
}

export class XFeedComposerAgentError extends Error {
  readonly code: 'invalid-material' | 'surface-contaminated' | 'invalid-submission' | 'wrong-request-count' | 'outcome-invalid' | TwoCallContractCode

  constructor(
    code: 'invalid-material' | 'surface-contaminated' | 'invalid-submission' | 'wrong-request-count' | 'outcome-invalid' | TwoCallContractCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'XFeedComposerAgentError'
    this.code = code
  }
}

/**
 * Narrow setup/finalize seam for the scheduler-owned per-run Agent. This
 * class never creates, flushes, disposes, renders, prepares, or mutates the
 * scheduler Agent; its owner remains responsible for that lifecycle.
 */
export class XFeedComposerAgentSurface {
  readonly materialText: string
  readonly toolNames = Object.freeze([SUBMIT_X_CRON_COMPOSER])
  readonly wires: readonly XFeedComposerWireRequest[]
  private readonly material: XFeedComposerMaterial
  private readonly itemIds: readonly string[]
  private readonly allowedSectionKinds: ReadonlySet<ComposerSectionKind>
  private readonly protocol: OneShotStructuredAgentSurface<ComposerDto>

  constructor(options: { readonly material: XFeedComposerMaterial }) {
    this.material = validateMaterial(options.material)
    this.itemIds = Object.freeze(this.material.selectedItems.map(item => item.itemId))
    this.allowedSectionKinds = new Set(this.material.allowedSectionKinds)
    this.materialText = serializeMaterial(this.material)
    this.protocol = new OneShotStructuredAgentSurface({
      promptSectionName: 'x-cron:composer-system',
      systemPrompt: COMPOSER_SYSTEM_PROMPT,
      toolSchema: SUBMIT_X_CRON_COMPOSER_SCHEMA,
      materialMessage: createMaterialMessage(this.materialText),
      parseSubmission: value => {
        const projected = projectComposerSubmission(value, this.itemIds, this.allowedSectionKinds)
        const parsed = parseComposerDto(JSON.stringify(projected), { itemIds: this.itemIds })
        if (!parsed.ok) throw new XFeedComposerAgentError(parsed.code, parsed.message)
        this.validateAllowedSections(parsed.value)
        return parsed.value
      },
      serializeOutcome: value => JSON.stringify(value),
    })
    this.wires = this.protocol.wires
  }

  get sessionId(): SessionId | undefined { return this.protocol.sessionId }

  /** Install only the current composer prompt and submit tool on an existing Agent. */
  setupAgent(agentCtx: Context): void {
    this.protocol.setupAgent(agentCtx)
  }

  /** Capture only the scheduler-created Agent's actual model requests. */
  capture(ctx: Context, sessionId: SessionId): void {
    this.protocol.capture(ctx, sessionId)
  }

  /** Verify the installed surface and lock it to the scheduler's session. */
  async verifySurface(agent: Agent): Promise<void> {
    try { await this.protocol.verifySurface(agent) } catch (error) { throw asComposerError(error, 'surface-contaminated') }
  }

  /** Validate the mechanical JSON outcome for the downstream finalizer. */
  finalizeOutcome(outcome: XFeedComposerOutcome): ComposerDto {
    try { return this.protocol.finalizeOutcome(outcome) } catch (error) { throw asComposerError(error, 'invalid-submission') }
  }

  /** Release only the wire listener; the scheduler owns Agent cleanup. */
  dispose(): void {
    this.protocol.dispose()
  }

  private validateAllowedSections(dto: ComposerDto): void {
    for (const section of dto.sections) {
      if (!this.allowedSectionKinds.has(section.kind)) {
        throw new XFeedComposerAgentError('invalid-submission', `section kind ${section.kind} is not allowlisted for this run`)
      }
    }
  }

}

function projectComposerSubmission(
  value: unknown,
  itemIds: readonly string[],
  allowedSectionKinds: ReadonlySet<ComposerSectionKind>,
): unknown {
  if (!isRecord(value) || !hasExactKeys(value, ['title', 'sections'])) {
    throw new XFeedComposerAgentError('invalid-submission', 'composer submission has an invalid top-level shape')
  }
  if (!Array.isArray(value.sections)) {
    throw new XFeedComposerAgentError('invalid-submission', 'composer submission sections must be an array')
  }

  const allowedItemIds = new Set(itemIds)
  const seenItems = new Set<string>()
  const sections: Array<{ kind: ComposerSectionKind; items: Array<{ itemId: string; summary: string }> }> = []
  for (const section of value.sections) {
    if (!isRecord(section) || !hasExactKeys(section, ['kind', 'items'])) {
      throw new XFeedComposerAgentError('invalid-submission', 'composer submission section is invalid')
    }
    const kind = section.kind
    if (typeof kind !== 'string' || !SECTION_KINDS.includes(kind as ComposerSectionKind)) {
      throw new XFeedComposerAgentError('invalid-submission', 'composer submission section kind is invalid')
    }
    if (!allowedSectionKinds.has(kind as ComposerSectionKind)) {
      throw new XFeedComposerAgentError('invalid-submission', `section kind ${kind} is not allowlisted for this run`)
    }
    if (!Array.isArray(section.items)) {
      throw new XFeedComposerAgentError('invalid-submission', 'composer submission section items must be an array')
    }
    const items: Array<{ itemId: string; summary: string }> = []
    for (const item of section.items) {
      if (!isRecord(item) || !hasExactKeys(item, ['itemId', 'summary'])) {
        throw new XFeedComposerAgentError('invalid-submission', 'composer submission item is invalid')
      }
      const itemId = item.itemId
      const summary = item.summary
      if (typeof itemId !== 'string' || !allowedItemIds.has(itemId)) {
        throw new XFeedComposerAgentError('invalid-submission', 'composer submission item is not in the allowlist')
      }
      if (!isValidComposerPlainText(summary, COMPOSER_SUMMARY_MAX_UTF8_BYTES)) {
        throw new XFeedComposerAgentError('invalid-submission', 'composer submission item summary is invalid')
      }
      if (seenItems.has(itemId)) continue
      seenItems.add(itemId)
      items.push({ itemId, summary })
    }
    if (items.length > 0) sections.push({ kind: kind as ComposerSectionKind, items })
  }
  if (sections.length === 0) {
    throw new XFeedComposerAgentError('invalid-submission', 'composer submission has no items after projection')
  }
  return { title: value.title, sections }
}

function validateMaterial(value: XFeedComposerMaterial): XFeedComposerMaterial {
  if (!isRecord(value) || !hasExactKeys(value, ['selectedItems', 'exploration', 'facts', 'allowedSectionKinds'])) throw new XFeedComposerAgentError('invalid-material', 'composer material has an invalid shape')
  if (!Array.isArray(value.selectedItems) || value.selectedItems.length === 0 || value.selectedItems.length > MAX_ITEMS) throw new XFeedComposerAgentError('invalid-material', 'composer material requires a bounded non-empty selected item list')
  const ids = new Set<string>()
  const selectedItems: XFeedComposerSelectedItem[] = []
  for (const item of value.selectedItems) {
    if (!isRecord(item) || !hasExactKeys(item, ['itemId', 'title', 'summary']) || !isValidComposerPlainText(item.itemId, MAX_ITEM_TEXT_BYTES) || !isValidComposerPlainText(item.title, MAX_ITEM_TEXT_BYTES) || !isValidComposerPlainText(item.summary, MAX_ITEM_TEXT_BYTES)) throw new XFeedComposerAgentError('invalid-material', 'composer selected item is invalid or contains forbidden content')
    if (ids.has(item.itemId)) throw new XFeedComposerAgentError('invalid-material', 'composer selected item IDs must be unique')
    ids.add(item.itemId)
    selectedItems.push({ itemId: item.itemId, title: item.title, summary: item.summary })
  }
  const exploration = validateExploration(value.exploration)
  if (!Array.isArray(value.facts) || value.facts.length > MAX_FACTS) throw new XFeedComposerAgentError('invalid-material', 'composer facts exceed their bound')
  const facts: XFeedComposerFact[] = []
  for (const fact of value.facts) {
    if (!isRecord(fact) || !hasExactKeys(fact, ['targetId', 'summary'])) throw new XFeedComposerAgentError('invalid-material', 'composer fact is not an exact bounded target fact')
    const targetId = fact.targetId
    const summary = fact.summary
    if (typeof targetId !== 'string' || typeof summary !== 'string' || !ids.has(targetId) || !isValidComposerPlainText(targetId, MAX_ITEM_TEXT_BYTES) || !isValidComposerPlainText(summary, MAX_FACT_TEXT_BYTES)) throw new XFeedComposerAgentError('invalid-material', 'composer fact is not an exact bounded target fact')
    facts.push({ targetId, summary })
  }
  if (!Array.isArray(value.allowedSectionKinds) || value.allowedSectionKinds.length === 0 || value.allowedSectionKinds.some(kind => !SECTION_KINDS.includes(kind)) || new Set(value.allowedSectionKinds).size !== value.allowedSectionKinds.length) throw new XFeedComposerAgentError('invalid-material', 'composer section allowlist is invalid')
  const material = Object.freeze({
    selectedItems: Object.freeze(selectedItems),
    exploration,
    facts: Object.freeze(facts),
    allowedSectionKinds: Object.freeze([...value.allowedSectionKinds]),
  })
  if (Buffer.byteLength(JSON.stringify(material), 'utf8') > MAX_MATERIAL_BYTES) throw new XFeedComposerAgentError('invalid-material', 'composer material exceeds its serialized bound')
  return material
}

function validateExploration(value: unknown): XFeedComposerExploration {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new XFeedComposerAgentError('invalid-material', 'composer exploration state is invalid')
  if (value.kind === 'none') {
    if (!hasExactKeys(value, ['kind'])) throw new XFeedComposerAgentError('invalid-material', 'none exploration has unexpected fields')
    return { kind: 'none' }
  }
  if (value.kind === 'search') {
    const topicId = value.topicId
    const status = value.status
    const summary = value.summary
    if (!hasExactKeys(value, ['kind', 'topicId', 'status', 'summary']) || typeof topicId !== 'string' || (status !== 'success' && status !== 'failed') || typeof summary !== 'string' || !isValidComposerPlainText(topicId, MAX_ITEM_TEXT_BYTES) || !isValidComposerPlainText(summary, MAX_EXPLORATION_TEXT_BYTES)) throw new XFeedComposerAgentError('invalid-material', 'search exploration state is invalid')
    return { kind: 'search', topicId, status, summary }
  }
  if (value.kind === 'explore') {
    const candidateId = value.candidateId
    const status = value.status
    const summary = value.summary
    if (!hasExactKeys(value, ['kind', 'candidateId', 'status', 'summary']) || typeof candidateId !== 'string' || (status !== 'success' && status !== 'failed') || typeof summary !== 'string' || !isValidComposerPlainText(candidateId, MAX_ITEM_TEXT_BYTES) || !isValidComposerPlainText(summary, MAX_EXPLORATION_TEXT_BYTES)) throw new XFeedComposerAgentError('invalid-material', 'explore exploration state is invalid')
    return { kind: 'explore', candidateId, status, summary }
  }
  throw new XFeedComposerAgentError('invalid-material', 'composer exploration kind is unknown')
}

function serializeMaterial(material: XFeedComposerMaterial): string {
  return JSON.stringify({ kind: 'x-cron-current-composer-material', ...material })
}

function createMaterialMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'x-feed' } })
}

function asComposerError(error: unknown, fallback: 'surface-contaminated' | 'invalid-submission'): XFeedComposerAgentError {
  if (error instanceof XFeedComposerAgentError) return error
  return new XFeedComposerAgentError(fallback, error instanceof Error ? error.message : String(error), { cause: error })
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
