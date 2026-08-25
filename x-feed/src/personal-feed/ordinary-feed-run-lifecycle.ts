import type { Context } from '@deepseek-ai/cordis'
import type {
  CronDeliveryReceipt,
  CronAgentEnvironmentLease,
  CronAgentEnvironmentPrepareContext,
  CronRunDeliveryMeaningRunPort,
} from '@deepseek-ai/dsh-cron'
import type {
  ContextEnabledCrossSourceEditor,
  DeliveryAndReceipt,
  PeriodBusinessFinalizer,
  PeriodIdentity,
} from '@herman/personal-feed'
import type { CandidateLocalStateRuntime } from './candidate-local-state.ts'
import type { OrdinaryBusinessFinalizationOwner } from './ordinary-business-finalization-owner.ts'
import { createOrdinaryFeedEditingProposalValidator } from './ordinary-feed-editing-proposal.ts'
import { createOrdinaryFeedEditorAdapter } from './ordinary-feed-editor-adapter.ts'
import {
  createOrdinaryFeedEditorAgent,
  type OrdinaryFeedEditorAgentProposalPort,
} from './ordinary-feed-editor-agent.ts'
import { createOrdinaryFeedPostReceiptAdapter } from './ordinary-feed-post-receipt-adapter.ts'
import { createOrdinaryFeedPreparedDeliveryAdapter } from './ordinary-feed-prepared-delivery-adapter.ts'

export interface OrdinaryFeedRunLifecycleOptions {
  readonly ctx: Context
  readonly editor: ContextEnabledCrossSourceEditor
  readonly finalizer: PeriodBusinessFinalizer
  readonly deliveryAndReceipt: Pick<
    DeliveryAndReceipt,
    'readFormalFeedContentDeliveryRequest' | 'readFormalFeedContentDeliveryRequestForPeriod'
  >
  readonly candidateLocalState: Pick<CandidateLocalStateRuntime, 'completePendingSourceDispositions'>
  readonly finalizationOwner: Pick<OrdinaryBusinessFinalizationOwner, 'readAcceptedOrdinaryFinalization'>
}

interface OrdinaryFeedRunInput {
  readonly period: PeriodIdentity
  readonly context: CronAgentEnvironmentPrepareContext
}

interface OrdinaryFeedRunLifecycle {
  readonly recoverExistingOrdinaryFeed: (
    input: OrdinaryFeedRunInput,
  ) => CronAgentEnvironmentLease | undefined
  readonly prepareOrdinaryFeed: (input: OrdinaryFeedRunInput) => Promise<CronAgentEnvironmentLease>
}

type OrdinaryFeedRecoveryDiagnosticStage =
  | 'read_model_materials'
  | 'structured_agent'
  | 'proposal_validation'
  | 'adapter'

type OrdinaryFeedRecoveryDiagnosticCode =
  | 'materials_not_accepted'
  | 'structured_agent_failed'
  | 'proposal_not_accepted'
  | 'adapter_not_accepted'

interface OrdinaryFeedRecoveryWarningBinding {
  readonly jobId: string
  readonly runId: string
  readonly sessionId: string
  readonly stage: OrdinaryFeedRecoveryDiagnosticStage
  readonly code: OrdinaryFeedRecoveryDiagnosticCode
}

const ORDINARY_FEED_RECOVERY_WARNING_CAPACITY = 64

function sanitizeOrdinaryFeedRecoveryWarningId(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '?')
}

function hasSameOrdinaryFeedRecoveryWarningBinding(
  left: OrdinaryFeedRecoveryWarningBinding,
  right: OrdinaryFeedRecoveryWarningBinding,
): boolean {
  return left.jobId === right.jobId
    && left.runId === right.runId
    && left.sessionId === right.sessionId
    && left.stage === right.stage
    && left.code === right.code
}

function createOrdinaryFeedRecoveryWarningReporter(
  logger: Context['logger'],
): (binding: OrdinaryFeedRecoveryWarningBinding) => void {
  const warnedBindings: OrdinaryFeedRecoveryWarningBinding[] = []

  return (binding): void => {
    if (warnedBindings.some(warned => hasSameOrdinaryFeedRecoveryWarningBinding(warned, binding))) return
    const warning = 'x-feed: ordinary recovery failed category=ordinary_feed_recovery'
      + ` stage=${binding.stage} code=${binding.code}`
      + ` jobId=${sanitizeOrdinaryFeedRecoveryWarningId(binding.jobId)}`
      + ` runId=${sanitizeOrdinaryFeedRecoveryWarningId(binding.runId)}`
      + ` sessionId=${sanitizeOrdinaryFeedRecoveryWarningId(binding.sessionId)}`
    try {
      logger.warn(warning)
    } catch {
      return
    }
    if (warnedBindings.length >= ORDINARY_FEED_RECOVERY_WARNING_CAPACITY) warnedBindings.shift()
    warnedBindings.push(binding)
  }
}

function ordinaryFeedRecoverySessionId(context: CronAgentEnvironmentPrepareContext): string | undefined {
  const sessionId = (context as CronAgentEnvironmentPrepareContext & { readonly sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

class OrdinaryFeedRecoveryDiagnosticError extends Error {
  readonly stage: OrdinaryFeedRecoveryDiagnosticStage
  readonly code: OrdinaryFeedRecoveryDiagnosticCode

  constructor(
    stage: OrdinaryFeedRecoveryDiagnosticStage,
    code: OrdinaryFeedRecoveryDiagnosticCode,
  ) {
    super('ordinary Feed recovery failed')
    this.name = 'OrdinaryFeedRecoveryDiagnosticError'
    this.stage = stage
    this.code = code
  }
}

interface ObservedOrdinaryFeedProposal {
  readonly proposal: OrdinaryFeedEditorAgentProposalPort
  readonly failedStage: () => OrdinaryFeedRecoveryDiagnosticStage | undefined
}

function observeOrdinaryFeedProposal(
  proposal: OrdinaryFeedEditorAgentProposalPort,
): ObservedOrdinaryFeedProposal {
  let stage: OrdinaryFeedRecoveryDiagnosticStage | undefined
  const observed = Object.freeze({
    readModelMaterials: () => {
      try {
        const result = proposal.readModelMaterials()
        stage = result.status === 'accepted' ? undefined : 'read_model_materials'
        return result
      } catch (error) {
        stage = 'read_model_materials'
        throw error
      }
    },
    validateProposal: (input: unknown) => {
      try {
        const result = proposal.validateProposal(input)
        stage = result.status === 'accepted' ? undefined : 'proposal_validation'
        return result
      } catch (error) {
        stage = 'proposal_validation'
        throw error
      }
    },
  })
  return Object.freeze({ proposal: observed, failedStage: () => stage })
}

function recoveryDiagnosticFor(
  stage: OrdinaryFeedRecoveryDiagnosticStage | undefined,
): OrdinaryFeedRecoveryDiagnosticError {
  if (stage === 'read_model_materials') {
    return new OrdinaryFeedRecoveryDiagnosticError(stage, 'materials_not_accepted')
  }
  if (stage === 'proposal_validation') {
    return new OrdinaryFeedRecoveryDiagnosticError(stage, 'proposal_not_accepted')
  }
  if (stage === 'adapter') {
    return new OrdinaryFeedRecoveryDiagnosticError(stage, 'adapter_not_accepted')
  }
  return new OrdinaryFeedRecoveryDiagnosticError('structured_agent', 'structured_agent_failed')
}

export function createOrdinaryFeedRunLifecycle(
  options: OrdinaryFeedRunLifecycleOptions,
): OrdinaryFeedRunLifecycle {
  if (options.ctx === undefined || options.editor === undefined || options.finalizer === undefined) {
    throw new Error('ordinary Feed run lifecycle requires its extension-owned collaborators')
  }
  if (options.deliveryAndReceipt === undefined
    || options.candidateLocalState === undefined
    || options.finalizationOwner === undefined) {
    throw new Error('ordinary Feed run lifecycle requires its delivery collaborators')
  }
  const reportRecoveryWarning = createOrdinaryFeedRecoveryWarningReporter(options.ctx.logger)

  const recoverExistingOrdinaryFeed = (input: OrdinaryFeedRunInput): CronAgentEnvironmentLease | undefined => {
    const existingDelivery = options.deliveryAndReceipt.readFormalFeedContentDeliveryRequestForPeriod(input.period)
    if (existingDelivery.status === 'missing') return undefined
    if (existingDelivery.status !== 'found') {
      throw new Error(`ordinary Feed existing C19 owner read was ${existingDelivery.status}`)
    }
    const runDeliveryMeaningPort = requireRunDeliveryMeaningPort(input.context)
    const preparedDelivery = createOrdinaryFeedPreparedDeliveryAdapter({
      delivery: options.deliveryAndReceipt,
      finalizer: options.finalizer,
    })
    const replayed = options.finalizer.requestFormalContentDelivery(existingDelivery.value.request)
    if (replayed.status !== 'accepted') {
      throw new Error('ordinary Feed existing C19 owner could not be replayed')
    }
    const deliveryResult = preparedDelivery.prepareAcceptedContent(replayed.value)
    if (deliveryResult.status !== 'accepted') {
      throw new Error('ordinary Feed existing prepared delivery was not accepted')
    }
    return createPreparedLease(
      deliveryResult.value.preparedDelivery,
      runDeliveryMeaningPort,
      options,
    )
  }

  return Object.freeze({
    recoverExistingOrdinaryFeed,
    prepareOrdinaryFeed: async (input: OrdinaryFeedRunInput): Promise<CronAgentEnvironmentLease> => {
      const recovered = recoverExistingOrdinaryFeed(input)
      if (recovered !== undefined) return recovered
      const runDeliveryMeaningPort = requireRunDeliveryMeaningPort(input.context)
      const preparedDelivery = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: options.deliveryAndReceipt,
        finalizer: options.finalizer,
      })
      const proposal = createOrdinaryFeedEditingProposalValidator({
        period: input.period,
        editor: options.editor,
      })
      const observedProposal = observeOrdinaryFeedProposal(proposal)
      const editorAgent = createOrdinaryFeedEditorAgent({
        ctx: options.ctx,
        proposal: observedProposal.proposal,
      })
      const editor = createOrdinaryFeedEditorAdapter({
        period: input.period,
        editor: options.editor,
        finalizer: options.finalizer,
      })
      const reportRecoveryDiagnostic = (error: OrdinaryFeedRecoveryDiagnosticError): OrdinaryFeedRecoveryDiagnosticError => {
        const sessionId = ordinaryFeedRecoverySessionId(input.context)
        if (sessionId !== undefined) {
          reportRecoveryWarning({
            jobId: input.context.jobId,
            runId: input.context.runId,
            sessionId,
            stage: error.stage,
            code: error.code,
          })
        }
        return error
      }
      const agentResult = await editorAgent.formEditingProposal()
      if (agentResult.status !== 'accepted') {
        throw reportRecoveryDiagnostic(recoveryDiagnosticFor(observedProposal.failedStage()))
      }
      let contentResult: ReturnType<typeof editor.acceptEditingProposal>
      try {
        contentResult = editor.acceptEditingProposal(agentResult.value.proposal)
      } catch {
        throw reportRecoveryDiagnostic(recoveryDiagnosticFor('adapter'))
      }
      if (contentResult.status !== 'accepted') {
        throw reportRecoveryDiagnostic(recoveryDiagnosticFor('adapter'))
      }
      const deliveryResult = preparedDelivery.prepareAcceptedContent(contentResult.value)
      if (deliveryResult.status !== 'accepted') {
        throw new Error('ordinary Feed prepared delivery was not accepted')
      }

      return createPreparedLease(
        deliveryResult.value.preparedDelivery,
        runDeliveryMeaningPort,
        options,
      )
    },
  })
}

function requireRunDeliveryMeaningPort(
  context: CronAgentEnvironmentPrepareContext,
): CronRunDeliveryMeaningRunPort {
  if (context.runDeliveryMeaningPort === undefined) {
    throw new Error('ordinary Feed run requires a run delivery meaning port')
  }
  return context.runDeliveryMeaningPort
}

function createPreparedLease(
  preparedDelivery: NonNullable<CronAgentEnvironmentLease['preparedDelivery']>,
  runDeliveryMeaningPort: CronRunDeliveryMeaningRunPort,
  options: OrdinaryFeedRunLifecycleOptions,
): CronAgentEnvironmentLease {
  let disposed = false
  return Object.freeze({
    preparedDelivery,
    setupAgent: (): void => undefined,
    verifySurface: async (): Promise<void> => undefined,
    dispose: async (): Promise<void> => {
      if (disposed) return
      disposed = true
    },
    settleDeliveryBeforeFinish: async (receipt: CronDeliveryReceipt): Promise<{ readonly status: 'accepted' }> => {
      const postReceipt = createOrdinaryFeedPostReceiptAdapter({
        delivery: options.deliveryAndReceipt,
        finalizer: options.finalizer,
        candidateLocalState: options.candidateLocalState,
        finalizationOwner: options.finalizationOwner,
        runDeliveryMeaningPort,
      })
      const settled = await postReceipt.settleDurableReceipt(receipt)
      if (settled.status !== 'accepted') {
        throw new Error('ordinary Feed durable receipt settlement was not accepted')
      }
      return { status: 'accepted' }
    },
  })
}
