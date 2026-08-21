/**
 * Generic prepared-delivery environment for unattended Agent jobs.
 *
 * A business-owned driver receives two bounded JSON requests:
 * - prepare: persist/validate the exact final payload before delivery;
 * - settle: commit business state only from cron's durable delivery receipt.
 *
 * dsh-cron never interprets the opaque metadata and never knows the business
 * domain. The driver command is operator configuration and is invoked without
 * a shell.
 */

import { createHash } from 'node:crypto'
import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {
  CronAgentEnvironmentProvider,
  CronAgentEnvironmentPrepareContext,
} from './run-environment.ts'
import type { CommandPayload, CronRunFinishedEvent } from './types.ts'

const execFileAsync = promisify(nodeExecFile)

export const PREPARED_DELIVERY_ENVIRONMENT_MARKER = 'prepared-delivery/v1'
export const PREPARE_DELIVERY_TOOL = 'cron_prepare_delivery'
export const MAX_PREPARED_TEXT_BYTES = 64 * 1024
export const MAX_PREPARED_METADATA_BYTES = 64 * 1024

const PREPARED_DELIVERY_PROMPT = [
  '可靠交付规则：',
  `- 最终回复前必须且只能成功调用一次 ${PREPARE_DELIVERY_TOOL}。`,
  '- text 必须与随后输出的最终回复逐字相同。',
  '- metadata 只携带当前业务驱动要求的有界 JSON，不得包含秘密或无关上下文。',
  '- prepare 成功后只输出同一份 text，不要添加前后缀或第二份总结。',
].join('\n')

export interface PreparedDeliveryBinding {
  readonly jobId: string
  readonly driver: CommandPayload
  readonly cwd?: string
}

export interface PreparedDeliveryDriverRequest {
  readonly protocolVersion: 1
  readonly operation: 'prepare' | 'settle'
  readonly jobId: string
  readonly runId: string
  readonly payload?: {
    readonly text: string
    readonly metadata: Readonly<Record<string, unknown>>
  }
  readonly event?: CronRunFinishedEvent
}

export interface PreparedDeliveryExecFile {
  (
    file: string,
    args: readonly string[],
    options: {
      cwd?: string
      env: Readonly<Record<string, string | undefined>>
      timeout: number
      maxBuffer: number
    },
  ): Promise<{ stdout: string; stderr: string }>
}

export interface PreparedDeliveryProviderOptions {
  readonly bindings: readonly PreparedDeliveryBinding[]
  readonly execFile?: PreparedDeliveryExecFile
}

interface PreparedRecord {
  readonly text: string
  readonly metadata: Readonly<Record<string, unknown>>
}

/** Create one provider that can serve several explicitly bound jobs. */
export function createPreparedDeliveryEnvironmentProvider(
  options: PreparedDeliveryProviderOptions,
): CronAgentEnvironmentProvider {
  const bindings = new Map<string, PreparedDeliveryBinding>()
  for (const binding of options.bindings) {
    if (binding.jobId.trim() === '') throw new Error('prepared-delivery binding requires a non-empty jobId')
    if (bindings.has(binding.jobId)) throw new Error(`duplicate prepared-delivery binding for ${binding.jobId}`)
    validateCommand(binding.driver)
    bindings.set(binding.jobId, Object.freeze({ ...binding, driver: freezeCommand(binding.driver) }))
  }
  if (bindings.size === 0) throw new Error('prepared-delivery provider requires at least one binding')
  const execFile = options.execFile ?? execFileAsync as unknown as PreparedDeliveryExecFile

  return {
    marker: PREPARED_DELIVERY_ENVIRONMENT_MARKER,
    requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
    prepare: async context => prepareLease(context, bindings, execFile),
    settleRecoveredRun: async event => {
      const binding = bindings.get(event.jobId)
      if (binding === undefined) throw new Error(`prepared-delivery has no binding for job ${event.jobId}`)
      await runDriver(execFile, binding, {
        protocolVersion: 1,
        operation: 'settle',
        jobId: event.jobId,
        runId: event.runId,
        event,
      })
    },
  }
}

async function prepareLease(
  context: CronAgentEnvironmentPrepareContext,
  bindings: ReadonlyMap<string, PreparedDeliveryBinding>,
  execFile: PreparedDeliveryExecFile,
) {
  const binding = bindings.get(context.jobId)
  if (binding === undefined) {
    throw new Error(`prepared-delivery has no binding for job ${context.jobId}`)
  }
  let prepareAttempts = 0
  let prepared: PreparedRecord | undefined
  let disposeTool: (() => void) | undefined
  let disposePrompt: (() => void) | undefined

  const tool: ToolDefinition = {
    name: PREPARE_DELIVERY_TOOL,
    description: 'Freeze and validate the exact final text before cron delivers it.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
      },
      required: ['text', 'metadata'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async args => {
      prepareAttempts += 1
      if (prepareAttempts !== 1) {
        return { ok: false, code: 'duplicate_prepare', message: 'prepared delivery accepts exactly one prepare call' }
      }
      const parsed = parsePrepareArgs(args)
      if (!parsed.ok) return parsed
      const request: PreparedDeliveryDriverRequest = {
        protocolVersion: 1,
        operation: 'prepare',
        jobId: context.jobId,
        runId: context.runId,
        payload: { text: parsed.text, metadata: parsed.metadata },
      }
      await runDriver(execFile, binding, request)
      prepared = Object.freeze({ text: parsed.text, metadata: Object.freeze({ ...parsed.metadata }) })
      return {
        ok: true,
        digest: createHash('sha256').update(parsed.text).digest('hex'),
      }
    },
  }

  return {
    setupAgent: (value: unknown) => {
      const agentCtx = value as Context
      disposeTool = agentCtx.tools.register(tool)
      disposePrompt = agentCtx.systemPrompt.section({
        name: 'cron:prepared-delivery',
        order: -900,
        text: PREPARED_DELIVERY_PROMPT,
      })
    },
    verifySurface: (value: unknown) => {
      const agent = value as Agent
      const matches = agent.ctx.tools.schemas(agent).filter(schema => schema.name === PREPARE_DELIVERY_TOOL)
      if (matches.length !== 1) {
        throw new Error(`prepared-delivery tool surface expected exactly one ${PREPARE_DELIVERY_TOOL}`)
      }
    },
    finalizeOutcome: (outcome: { readonly text: string; readonly error: string | undefined }) => {
      if (outcome.error !== undefined) throw new Error(`prepared-delivery Agent failed: ${outcome.error}`)
      if (prepareAttempts !== 1 || prepared === undefined) {
        throw new Error('prepared-delivery requires exactly one successful prepare call')
      }
      if (outcome.text !== prepared.text) {
        throw new Error('prepared-delivery final text differs from the prepared payload')
      }
    },
    settleRun: async (event: CronRunFinishedEvent) => {
      if (event.jobId !== context.jobId || event.runId !== context.runId) {
        throw new Error('prepared-delivery received a terminal event for a different run')
      }
      const request: PreparedDeliveryDriverRequest = {
        protocolVersion: 1,
        operation: 'settle',
        jobId: context.jobId,
        runId: context.runId,
        event,
      }
      await runDriver(execFile, binding, request)
    },
    dispose: () => {
      disposeTool?.()
      disposePrompt?.()
      disposeTool = undefined
      disposePrompt = undefined
    },
  }
}

type ParsedPrepareArgs =
  | { readonly ok: true; readonly text: string; readonly metadata: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly code: string; readonly message: string }

function parsePrepareArgs(value: unknown): ParsedPrepareArgs {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, code: 'invalid_prepare', message: 'prepare arguments must be an object' }
  }
  const input = value as Record<string, unknown>
  if (typeof input.text !== 'string' || input.text.trim() === '') {
    return { ok: false, code: 'invalid_text', message: 'prepared text must be non-empty' }
  }
  if (Buffer.byteLength(input.text, 'utf8') > MAX_PREPARED_TEXT_BYTES) {
    return { ok: false, code: 'text_too_large', message: `prepared text exceeds ${MAX_PREPARED_TEXT_BYTES} bytes` }
  }
  if (typeof input.metadata !== 'object' || input.metadata === null || Array.isArray(input.metadata)) {
    return { ok: false, code: 'invalid_metadata', message: 'prepared metadata must be an object' }
  }
  let encoded: string
  try {
    encoded = JSON.stringify(input.metadata)
  } catch {
    return { ok: false, code: 'invalid_metadata', message: 'prepared metadata must be JSON-safe' }
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PREPARED_METADATA_BYTES) {
    return { ok: false, code: 'metadata_too_large', message: `prepared metadata exceeds ${MAX_PREPARED_METADATA_BYTES} bytes` }
  }
  return { ok: true, text: input.text, metadata: input.metadata as Record<string, unknown> }
}

async function runDriver(
  execFile: PreparedDeliveryExecFile,
  binding: PreparedDeliveryBinding,
  request: PreparedDeliveryDriverRequest,
): Promise<void> {
  const [file, ...baseArgs] = binding.driver.argv
  if (file === undefined) throw new Error('prepared-delivery driver argv is empty')
  const { stdout } = await execFile(file, [...baseArgs, JSON.stringify(request)], {
    ...(binding.cwd === undefined ? {} : { cwd: binding.cwd }),
    env: process.env,
    timeout: binding.driver.timeoutSeconds * 1_000,
    maxBuffer: binding.driver.outputMaxBytes,
  })
  let result: unknown
  try {
    result = JSON.parse(stdout.trim())
  } catch {
    throw new Error('prepared-delivery driver returned invalid JSON')
  }
  if (typeof result !== 'object' || result === null || (result as Record<string, unknown>).ok !== true) {
    const message = typeof result === 'object' && result !== null
      ? String((result as Record<string, unknown>).message ?? (result as Record<string, unknown>).code ?? 'driver rejected request')
      : 'driver rejected request'
    throw new Error(`prepared-delivery driver failed: ${message}`)
  }
}

function validateCommand(command: CommandPayload): void {
  if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some(arg => typeof arg !== 'string' || arg === '')) {
    throw new Error('prepared-delivery driver requires a non-empty argv')
  }
  if (!Number.isSafeInteger(command.timeoutSeconds) || command.timeoutSeconds < 1 || command.timeoutSeconds > 3_600) {
    throw new Error('prepared-delivery driver timeoutSeconds is invalid')
  }
  if (!Number.isSafeInteger(command.outputMaxBytes) || command.outputMaxBytes < 1 || command.outputMaxBytes > 1_048_576) {
    throw new Error('prepared-delivery driver outputMaxBytes is invalid')
  }
}

function freezeCommand(command: CommandPayload): CommandPayload {
  return Object.freeze({ ...command, argv: Object.freeze([...command.argv]) })
}
