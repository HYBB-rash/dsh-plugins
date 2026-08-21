import { createHash } from 'node:crypto'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RunNowPort, RunNowResult } from './scheduler.ts'

export const RUN_NOW_TOOL_NAME = 'cron_run_now'
export const RUN_NOW_KEY_VERSION = 'v1'

function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function runNowRequestKey(sessionId: string, callId: string, jobId: string): string {
  return createHash('sha256')
    .update(`${RUN_NOW_KEY_VERSION}\0${sessionId}\0${callId}\0${jobId}`, 'utf8')
    .digest('hex')
}

function messageFor(result: RunNowResult): string {
  if (result.ok) return result.alreadyAccepted === true ? '该任务已接受过本次运行请求。' : '已接受运行请求。'
  switch (result.code) {
    case 'invalid_request': return '运行请求格式无效。'
    case 'job_not_found': return '没有找到这个 Cron 任务。'
    case 'invalid_job': return '这个 Cron 任务定义无效。'
    case 'job_active': return '这个 Cron 任务当前正在运行。'
    case 'claim_failed': return '运行请求未能持久化，请稍后重试。'
    case 'scheduler_unavailable': return 'Cron scheduler 当前不可用。'
  }
}

function registerRunNowTool(
  toolCtx: Agent['ctx'],
  port: RunNowPort,
  targetSessionId: string,
): () => void {
  return toolCtx.tools.register(defineTool({
    name: RUN_NOW_TOOL_NAME,
    description: '按精确 jobId 立即运行一个已有的 Cron Agent 任务；不会修改任务定义。',
    parameters: {
      jobId: {
        type: 'string',
        required: true,
        description: '由 Cron 返回的精确任务 ID。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          code: { type: 'string', required: true },
          message: { type: 'string', required: true },
          runId: { type: 'string' },
        },
      },
      render: renderValue,
    },
    async execute(args, exec: ToolRunContext) {
      const jobId = args.jobId
      if (typeof jobId !== 'string' || jobId.length === 0) {
        return { ok: false, code: 'invalid_request', message: '运行请求格式无效。' }
      }
      const sessionId = exec.agent?.session?.id
      if (sessionId !== targetSessionId) {
        return { ok: false, code: 'wrong_root', message: '该工具只允许在 Telegram 交互根会话中使用。' }
      }
      const callId = exec.callId
      if (typeof callId !== 'string' || callId.length === 0) {
        return { ok: false, code: 'invalid_request', message: '工具调用缺少稳定调用 ID。' }
      }
      try {
        const result = await port.runNow({
          jobId,
          requestKey: runNowRequestKey(targetSessionId, callId, jobId),
        })
        return result.ok
          ? {
              ok: true,
              code: result.alreadyAccepted === true ? 'already_accepted' : 'accepted',
              message: messageFor(result),
              runId: result.runId,
            }
          : { ok: false, code: result.code, message: messageFor(result) }
      } catch {
        return { ok: false, code: 'control_unavailable', message: 'Cron scheduler 当前不可用。' }
      }
    },
  }))
}

/** Install on the exact interactive Telegram root and all of its future replacements. */
export function installRunNowTools(
  host: Context,
  port: RunNowPort,
  targetSessionId = 'session-telegram',
): () => void {
  const installed = new Map<Agent, () => void>()
  let stopping = false

  const install = (agent: Agent): void => {
    if (stopping || installed.has(agent)) return
    if (!host.agents.roots().includes(agent)) return
    if (agent.session.id !== targetSessionId) return
    const dispose = agent.ctx.effect(
      () => registerRunNowTool(agent.ctx, port, targetSessionId),
      'dsh-cron.run-now()',
    )
    installed.set(agent, dispose)
  }

  for (const agent of host.agents.roots()) install(agent)
  const stopCreated = host.on('agent/created', ({ agent }) => install(agent))

  return () => {
    if (stopping) return
    stopping = true
    stopCreated()
    const cleanups = [...installed.values()]
    installed.clear()
    for (const cleanup of cleanups) cleanup()
  }
}
