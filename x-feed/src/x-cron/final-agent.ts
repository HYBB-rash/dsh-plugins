import {
  assembleContextFor,
  type Agent,
} from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  ToolArgsError,
  type JsonSchemaNode,
  validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools'
import type {
  CandidateDescriptor,
  LookupResult,
  ProjectionView,
} from '../fact-projection/contracts.ts'
import {
  createXFeedRunTools,
  type XFeedRunToolFailure,
  type XFeedRunToolPort,
  type XFeedRunToolResult,
} from './run-tools.ts'
import { validateXFeedRichMarkdown } from './output-contract.ts'

/** The sole system prompt for the final per-run X Agent. */
export const X_CRON_FINAL_SYSTEM_PROMPT = [
  '你是一次性的 X 洞察投递 Agent。',
  '你只能依据当前 run material、当前候选、当前候选的 ProjectionView 和本轮工具结果工作。',
  '不得读取、猜测或延续任何旧 cron session、旧文件、反馈、偏好、图谱、原始历史、浏览器、shell、Telegram 或其他通用能力。',
  '候选的事实相关性已经由独立的 neutral assessment 与 TODO5 projection 完成；不得重新发明事实、locator、ticket 或 URL。',
  '需要事实正文时，只能使用当前候选 ProjectionView 中的 ticket，并调用精确 ticket lookup；lookup 只能使用当前已签发的 ticket。',
  '只能使用当前 run allowlist 中的 topic、candidate 与 URL。',
  '最终回复必须是完整 Rich Markdown：第一行以「📦 X 洞察」开始，标题后空一行；每个出现的 ⭐、🌊、🔄、🎯、📌 小节前空一行；小节内容必须是连续的 `- ` 列表，每个列表项恰好包含一个当前 run URL。',
  '在最终回复前必须且只能成功调用一次 x_feed_prepare_delivery，传入与最终正文完全相同的 text 和其中实际使用的 URL 集合。该工具不发送 Telegram，也不标记 shown。',
  '调用 prepare 成功后，只输出同一份 text，不要添加解释、前后缀或第二份总结。',
].join('\n')

export const X_CRON_FINAL_PROJECT_TOOL = 'x_feed_project_candidate_facts'
export const X_CRON_FINAL_LOOKUP_TOOL = 'x_feed_lookup_fact_ticket'

const MAX_MATERIAL_UTF8_BYTES = 24_000
const MAX_WIRE_UTF8_BYTES = 96_000

export interface XFeedFinalCandidate extends CandidateDescriptor {
  readonly topics: readonly string[]
}

export interface XFeedFinalAgentMaterial {
  readonly runId: string
  readonly allowedTopics: readonly string[]
  readonly candidates: readonly XFeedFinalCandidate[]
}

export interface XFeedFinalProjectionPort {
  project(candidateId: string): Promise<ProjectionView | XFeedRunToolFailure>
  lookup(ticketId: string): LookupResult | XFeedRunToolFailure
}

export interface XFeedFinalPrepareRecord {
  readonly text: string
  readonly urls: readonly string[]
}

export interface XFeedFinalWireRequest {
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly messages: readonly Message[]
  readonly system: string
  readonly tools: readonly ToolSchema[]
}

export interface XFeedFinalAgentOptions {
  readonly material: XFeedFinalAgentMaterial
  readonly runTools: XFeedRunToolPort
  readonly projection: XFeedFinalProjectionPort
}

/**
 * Owns the model-facing surface and the evidence needed by the provider's
 * finalize seam. It is intentionally independent of dsh-cron's scheduler.
 */
export class XFeedFinalAgentSurface {
  readonly materialText: string
  readonly toolNames: readonly string[]
  readonly prepared: XFeedFinalPrepareRecord[] = []
  readonly wires: XFeedFinalWireRequest[] = []
  prepareAttempts = 0
  prepareFailed = false
  private disposeCapture: (() => void) | undefined
  private materialPreStepCount = 0

  readonly #material: XFeedFinalAgentMaterial
  readonly #runTools: XFeedRunToolPort
  readonly #projection: XFeedFinalProjectionPort
  readonly #tools: readonly ToolDefinition[]

  constructor(options: XFeedFinalAgentOptions) {
    validateMaterial(options.material)
    this.#material = deepFreeze(structuredClone(options.material))
    this.materialText = serializeMaterial(this.#material)
    this.#runTools = options.runTools
    this.#projection = options.projection
    this.#tools = Object.freeze([
      ...createXFeedRunTools(this.createTrackedRunPort()),
      createProjectionTool(this.#projection),
      createLookupTool(this.#projection),
    ])
    this.toolNames = Object.freeze(this.#tools.map(tool => tool.name))
  }

  /** Install the complete prompt, narrow tools, and current run material. */
  setupAgent(agentCtx: Context): void {
    agentCtx.systemPrompt.section({
      name: 'x-cron:final-system',
      order: -1_000,
      text: X_CRON_FINAL_SYSTEM_PROMPT,
      complete: true,
    })
    agentCtx.systemPrompt.suppressRuntimeContext()
    agentCtx.tools.restrict({ allow: [] })
    agentCtx.tools.presentAs('native')
    for (const tool of this.#tools) agentCtx.tools.register(tool)
    agentCtx.on('agent/pre-step', async (payload) => {
      this.materialPreStepCount += 1
      if (this.materialPreStepCount === 1) {
        return {
          kind: 'enter' as const,
          messages: [createUserMessage({
            content: [{ type: 'text', text: this.materialText }],
            source: { kind: 'plugin', plugin: 'x-feed' },
          })],
        }
      }
      // Tool loops legitimately open later steps. Returning the claimed
      // messages directly bypasses every downstream/global pre-step listener
      // (and the default runtime-context injection) while the Agent still
      // carries the current run's material, assistant, and tool history in
      // its fresh session.
      return { kind: 'enter' as const, messages: payload.messages }
    }, { prepend: true })
  }

  /** Capture only the scheduler-created final session's real LLM requests. */
  capture(ctx: Context, sessionId: string): void {
    if (this.disposeCapture !== undefined) throw new Error('X final wire capture is already installed')
    this.disposeCapture = ctx.on('llm/stream', (request, next) => {
      if (request.sessionId === sessionId) this.wires.push(projectWireRequest(request))
      return next()
    })
  }

  /** Mechanical surface check after Agent creation and before the drive. */
  async verifySurface(agent: Agent): Promise<void> {
    const schemas = agent.ctx.tools.schemas(agent)
    if (!sameToolNames(schemas, this.toolNames)) {
      throw new Error(`X final Agent tool surface is contaminated: ${schemas.map(schema => schema.name).join(', ') || '(none)'}`)
    }
    const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
    if (assembly.sections.length !== 1 || assembly.sections[0]?.text !== X_CRON_FINAL_SYSTEM_PROMPT) {
      throw new Error('X final Agent system prompt is not the sole complete prompt')
    }
    if (assembly.contexts.length !== 0) {
      throw new Error('X final Agent runtime context is not suppressed')
    }
    if (!sameToolNames(assembly.tools, this.toolNames)) {
      throw new Error(`X final prompt tools are contaminated: ${assembly.tools.map(tool => tool.name).join(', ') || '(none)'}`)
    }
  }

  /** Validate the exact outcome immediately before cron delivery. */
  finalizeOutcome(outcome: { readonly text: string; readonly error: string | undefined }): void {
    if (outcome.error !== undefined) throw new Error(`X final Agent outcome failed: ${outcome.error}`)
    if (this.materialPreStepCount < 1) throw new Error('X final Agent did not install a run-material message')
    if (this.wires.length === 0) throw new Error('X final Agent produced no captured LLM wire')
    for (const wire of this.wires) this.validateWire(wire)
    if (this.prepareAttempts !== 1 || this.prepared.length !== 1 || this.prepareFailed) {
      throw new Error('X final Agent must have exactly one successful prepare-delivery call')
    }
    const prepared = this.prepared[0]!
    if (outcome.text !== prepared.text) {
      throw new Error('X final Agent outcome does not exactly equal the successful prepared text')
    }
    const guarded = validateXFeedRichMarkdown(outcome.text, { preparedUrls: prepared.urls })
    if (!guarded.ok) throw new Error(`${guarded.code}: ${guarded.message}`)
    const preparedSet = new Set(prepared.urls)
    const outputSet = new Set(guarded.urls)
    if (preparedSet.size !== outputSet.size || [...preparedSet].some(url => !outputSet.has(url))) {
      throw new Error('X final Agent prepared URL set does not equal the delivered output URL set')
    }
  }

  /** Release only the provider-owned wire listener; Agent cleanup is cron's job. */
  dispose(): void {
    this.disposeCapture?.()
    this.disposeCapture = undefined
  }

  private createTrackedRunPort(): XFeedRunToolPort {
    return {
      searchTopic: (topic, signal) => this.#runTools.searchTopic(topic, signal),
      exploreCandidate: (candidateId, signal) => this.#runTools.exploreCandidate(candidateId, signal),
      setTheme: (theme, signal) => this.#runTools.setTheme(theme, signal),
      prepareDelivery: async (text, urls, signal) => {
        this.prepareAttempts += 1
        if (this.prepareAttempts !== 1) {
          this.prepareFailed = true
          return failure('duplicate-prepare', 'This X run accepts exactly one prepare-delivery call.')
        }
        try {
          const value = await this.#runTools.prepareDelivery(text, urls, signal)
          if (isFailure(value)) {
            this.prepareFailed = true
            return value
          }
          this.prepared.push(Object.freeze({ text, urls: Object.freeze([...urls]) }))
          return value
        } catch (error) {
          this.prepareFailed = true
          throw error
        }
      },
    }
  }

  private validateWire(wire: XFeedFinalWireRequest): void {
    if (wire.system !== X_CRON_FINAL_SYSTEM_PROMPT || !sameToolNames(wire.tools, this.toolNames)) {
      throw new Error('X final LLM wire contains a contaminated system or tool surface')
    }
    const bytes = Buffer.byteLength(JSON.stringify({
      messages: wire.messages,
      system: wire.system,
      tools: wire.tools,
    }), 'utf8')
    if (bytes > MAX_WIRE_UTF8_BYTES) {
      throw new Error(`X final LLM wire exceeded the ${MAX_WIRE_UTF8_BYTES}-byte bound`)
    }
    const materialMessages = wire.messages.filter(message => message.content.some(block => block.type === 'text' && block.text === this.materialText))
    if (materialMessages.length !== 1) {
      throw new Error('X final LLM wire must contain exactly one current run-material message')
    }
    if (JSON.stringify(wire).includes('ordinary-long-session') || JSON.stringify(wire).includes('old-session-marker')) {
      throw new Error('X final LLM wire contains old session material')
    }
  }
}

function createProjectionTool(projection: XFeedFinalProjectionPort): ToolDefinition {
  const parameters: JsonSchemaNode = {
    type: 'object',
    properties: { candidateId: { type: 'string' } },
    required: ['candidateId'],
    additionalProperties: false,
  }
  return strictTool(X_CRON_FINAL_PROJECT_TOOL, 'Project the current candidate through the exact TODO5 fact projection.', parameters, async (args) => {
    const result = await projection.project(args.candidateId as string)
    if (isFailure(result)) return result
    return { ok: true, result: projectView(result) }
  })
}

function createLookupTool(projection: XFeedFinalProjectionPort): ToolDefinition {
  const parameters: JsonSchemaNode = {
    type: 'object',
    properties: { ticketId: { type: 'string' } },
    required: ['ticketId'],
    additionalProperties: false,
  }
  return strictTool(X_CRON_FINAL_LOOKUP_TOOL, 'Lookup one exact ticket previously issued by the current candidate projection.', parameters, async (args) => {
    const result = projection.lookup(args.ticketId as string)
    return isFailure(result) ? result : { ok: true, result }
  })
}

function strictTool(
  name: string,
  description: string,
  parameters: JsonSchemaNode,
  execute: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<XFeedRunToolResult>,
): ToolDefinition {
  return {
    name,
    description,
    parameters: parameters as Record<string, unknown>,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<XFeedRunToolResult> {
      const violations = validateJsonSchemaValue(parameters, args, '')
      if (violations.length > 0) throw new ToolArgsError(violations)
      return execute(args as Record<string, unknown>, exec)
    },
  }
}

function projectView(view: ProjectionView): Record<string, unknown> {
  return { facts: view.facts, tickets: view.tickets }
}

function serializeMaterial(material: XFeedFinalAgentMaterial): string {
  const text = JSON.stringify({
    kind: 'x-cron-current-run-material',
    allowedTopics: material.allowedTopics,
    candidates: material.candidates,
  })
  if (Buffer.byteLength(text, 'utf8') > MAX_MATERIAL_UTF8_BYTES) {
    throw new Error(`X final run material exceeded the ${MAX_MATERIAL_UTF8_BYTES}-byte bound`)
  }
  return text
}

function validateMaterial(material: XFeedFinalAgentMaterial): void {
  if (material.runId.trim() === '' || material.runId !== material.runId.trim()) throw new Error('X final run material has an invalid run id')
  if (material.candidates.length > 20) throw new Error('X final run material exceeds the candidate bound')
  const ids = new Set<string>()
  for (const candidate of material.candidates) {
    if (candidate.id.trim() === '' || candidate.content.trim() === '' || candidate.source.trim() === '') throw new Error('X final candidate material is incomplete')
    if (ids.has(candidate.id)) throw new Error(`duplicate X final candidate id ${candidate.id}`)
    ids.add(candidate.id)
  }
  if (material.allowedTopics.some(topic => topic.trim() === '' || topic !== topic.trim())) throw new Error('X final topic material is invalid')
}

function sameToolNames(left: readonly { readonly name: string }[], expected: readonly string[]): boolean {
  if (left.length !== expected.length) return false
  const actual = new Set(left.map(tool => tool.name))
  const wanted = new Set(expected)
  return actual.size === left.length
    && wanted.size === expected.length
    && actual.size === wanted.size
    && [...wanted].every(name => actual.has(name))
}

function projectWireRequest(request: GenerateOptions): XFeedFinalWireRequest {
  if (request.sessionId === undefined || request.system === undefined || request.tools === undefined) {
    throw new Error('X final wire omitted its session, system prompt, or tool schema')
  }
  return deepFreeze(structuredClone({
    sessionId: request.sessionId,
    provider: request.provider,
    model: request.model,
    messages: request.messages,
    system: request.system,
    tools: request.tools,
  }))
}

function isFailure(value: unknown): value is XFeedRunToolFailure {
  return typeof value === 'object' && value !== null && 'ok' in value && (value as { ok?: unknown }).ok === false
}

function failure(code: string, message: string): XFeedRunToolFailure {
  return { ok: false, code, message }
}
