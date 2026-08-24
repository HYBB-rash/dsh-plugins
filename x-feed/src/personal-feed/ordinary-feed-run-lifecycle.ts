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
import { createOrdinaryFeedEditorAgent } from './ordinary-feed-editor-agent.ts'
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
      const editorAgent = createOrdinaryFeedEditorAgent({
        ctx: options.ctx,
        proposal,
      })
      const editor = createOrdinaryFeedEditorAdapter({
        period: input.period,
        editor: options.editor,
        finalizer: options.finalizer,
      })
      const agentResult = await editorAgent.formEditingProposal()
      if (agentResult.status !== 'accepted') {
        throw new Error('ordinary Feed editor Agent did not produce an accepted proposal')
      }
      const contentResult = editor.acceptEditingProposal(agentResult.value.proposal)
      if (contentResult.status !== 'accepted') {
        throw new Error('ordinary Feed editor did not produce accepted content')
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
