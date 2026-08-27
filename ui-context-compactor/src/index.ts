/**
 * Single-session context-route manager.
 *
 * The plugin keeps one complete, versioned route snapshot inside the Session
 * log, projects the latest revision into every model request, and leaves exact
 * operational detail in the original append-only history.
 *
 * @module @deepseek-ai/dsh-client-ui-context-compactor
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, freezeMessage, MessageId, ReasoningEffortId, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import { assembleContextFor, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-commands'
import { canonicalHeader, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import type TokenMeter from '@deepseek-ai/dsh-token-meter'
import { z as zod } from 'zod'
import {
  FocusAuthority,
  UserInteractionAdvice,
  bindCandidateAdviceReceivers,
  bindEstablishedFocusCandidateReceivers,
  createExplicitUserExpression,
  presentFocusCanaryAdvice,
  type ChatRef,
  type FocusDecision,
} from './focus.ts'
import {
  BoundedAuxiliarySemanticCall,
  CONTEXT_MANAGER_STORAGE_DOMAIN,
  ManagedInteractiveRootClassifier,
  createBoundedActionFactNeedProposalRequest,
  directExpressionHash,
  isDirectUserSource,
  resolveManagedRuntimeConfig,
  type BoundedAuxiliarySemanticCallConfig,
  type ManagedRuntimeConfig,
} from './managed-runtime.ts'
import { ManagedAwareBasicCompactionEngine } from './managed-compaction.ts'
import { ManagedFailurePresenter, isManagedFailure } from './managed-failure.ts'
import { NoFocusHarness } from './no-focus-harness.ts'
import { NoFocusRecovery } from './no-focus-recovery.ts'
import {
  proveTelegramNoFocusAdmission,
  qualifyTelegramNoFocusAdmission,
  type ClosureOnlyProofRecord,
} from './no-focus-admission.ts'
import {
  CanonicalContextAuthority,
  CanonicalStateTransaction,
  EffectiveStatePreservation,
  parseCanonicalLocalRestrictionStateRecord,
  type LocalRestrictionStateRecord,
  parseCanonicalNoSafeActionStateRecord,
  parseCanonicalBackgroundStateRecord,
  type CanonicalNoSafeActionTransaction,
  type BackgroundStateRecord,
  type NoSafeActionStateRecord,
} from './state-transaction.ts'
import {
  ActionFactBoundaryAuthority,
  bindActionBoundaryCandidateReceivers,
  type ActionFactBoundary,
  type CompletedMultiFactEvidenceActionableBoundary,
  type CompletedMultiSourceEvidenceActionableBoundary,
  type CompletedMultiSourceEvidenceLocalRestrictionBoundary,
  type CompletedMultiSourceEvidenceNoSafeActionBoundary,
  type CompletedSingleEvidenceActionableBoundary,
  type ClaimedStructuredDirect,
} from './action-boundary.ts'
import {
  F03_EXACT_FACT_DIRECT,
  F03_EXACT_MULTI_FACT_DIRECT,
  F03_EXACT_MULTI_SOURCE_DIRECT,
  type EvidenceConclusionSet,
} from './fact-resolution.ts'
import {
  BackgroundCandidateFormation,
  CandidateBasisFreshnessReviewer,
  CandidateContentReviewer,
  renderCandidateBackground,
  type CandidateAssemblySnapshot,
  type CandidatePreparationSnapshot,
  type ExplicitBackgroundUpdateRuntimeEvidence,
  type FixedH1CandidateBudgetProof,
  type RollingCandidateRuntimeEvidence,
} from './candidate.ts'
import { type CandidateQualificationDecision, type CandidateQualificationIssue, type CandidateRef, type C28Result } from './candidate-qualification.ts'
import { createBackgroundStateComposition } from './background-state.ts'
import { createQualifiedBackgroundAdapter } from './adapters/qualified-background.ts'
import { createRollingCandidateAdapter, type RollingCandidateAdapter } from './adapters/rolling-candidate.ts'
import {
  projectFutureCriticalPoints,
  type AuthenticatedStructuredFutureCriticalMaterial,
  type FutureCriticalPointProjection,
} from './future-critical-candidate.ts'
import { projectExactTwoFactResults } from './multi-fact-resolution.ts'
import {
  LocalRestrictionAdapter,
  UserInteractionAdvice as ActionFactUserInteractionAdvice,
} from './local-restriction.ts'
import { NoSafeActionAdapter } from './no-safe-action.ts'
import {
  assertRouteFreshForCompaction,
  createRouteRearmMessage,
  foldRoute,
  renderRouteBootstrapContext,
  routeNeedsCompletedTurnRecovery,
  routeNeedsRearm,
  type BuildRouteMaterialConfig,
  type LargeToolResultPreprocessingConfig,
} from './route.ts'
import {
  routeUpdateFailureCode,
  updateRoute,
  type RouteReducerConfig,
  type RouteUpdateFailureCode,
} from './reducer.ts'

/** Stable Cordis plugin name. */
export const name = 'ui-context-compactor'

/** Services used by route reduction and the stable model-facing policy. */
export const inject = ['llm', 'systemPrompt', 'agents']

/** Deployment policy for the auxiliary route reducer. */
export interface Config {
  /** Optional explicit reducer provider; must be paired with model. */
  readonly provider?: string
  /** Optional explicit reducer model; must be paired with provider. */
  readonly model?: string
  /** Optional reasoning level used only by the auxiliary reducer call. */
  readonly reasoningEffort?: string
  /** Maximum reducer-input characters after bounded extraction. */
  readonly maxInputChars?: number
  /** Maximum route JSON output tokens. */
  readonly maxOutputTokens?: number
  /** Experimental reducer-input preprocessing for large mechanical tool results. */
  readonly largeToolResultPreprocessing?: {
    /** Disabled by default; when enabled, reducer input keeps only a reference placeholder. */
    readonly enabled?: boolean
    /** Minimum rendered tool-result characters before elision is considered. */
    readonly minChars?: number
  }
  /** Force one safe standalone compaction after this many completed root turns. Disabled when omitted. */
  readonly compactEveryTurns?: number
  /** H1-only local Harness canary. It accepts only the two exact test chat ids. */
  readonly focusCanary?:
    | {
        readonly mode: 'observe'
      }
    | {
        readonly mode: 'enforce'
        readonly safeUpdateMarginTokens?: number
        readonly allowlist: readonly string[]
        readonly auxiliary: BoundedAuxiliarySemanticCallConfig
      }
  /** F01-T3-only native-writer and scoped-command composition gate. */
  readonly nativeWriterArbitration?: {
    readonly mode: 'enforce'
  }
  /** F03-only real-Web evidence canary; valid only with the local H1 enforce canary. */
  readonly evidenceCanary?: {
    readonly mode: 'enforce'
  }
}
type EnforcedFocusCanaryConfig = Extract<NonNullable<Config['focusCanary']>, { readonly mode: 'enforce' }>

export const Config: z<Config> = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  maxInputChars: z.number().step(1).min(32_000).default(32_000),
  // A route update is a complete replacement snapshot, including valid prior
  // decisions and retired routes.  2,400 tokens can truncate a healthy
  // long-session snapshot in the middle of its JSON, leaving the safety gate
  // permanently stale.  Keep enough headroom for the bounded 18k-char route.
  maxOutputTokens: z.number().step(1).min(256).default(8_192),
  largeToolResultPreprocessing: z.object({
    enabled: z.boolean().default(false),
    minChars: z.number().step(1).min(1_024).default(2_500),
  }),
  compactEveryTurns: z.number().step(1).min(1),
  focusCanary: z.union([
    z.object({
      mode: z.const('observe').required(),
    }),
    z.object({
      mode: z.const('enforce').required(),
      safeUpdateMarginTokens: z.number().step(1).min(1),
      allowlist: z.array(z.string()).required(),
      auxiliary: z.object({
        provider: z.string().required(),
        model: z.string().required(),
        maxOutputTokens: z.number().step(1).min(1).required(),
        timeoutMs: z.number().step(1).min(1).required(),
        maxExpressionChars: z.number().step(1).min(1).required(),
        maxProjectionTokens: z.number().step(1).min(1).required(),
        safetyMarginTokens: z.number().step(1).min(1),
      }).required(),
    }),
    // Schemastery object schemas otherwise materialize `{}` for omitted values
    // and then validate nested enforce-only fields. An explicit undefined
    // fallback preserves legacy configs as genuinely absent.
  ]).default(undefined as never),
  nativeWriterArbitration: z.object({
    mode: z.const('enforce').required(),
  }).default(undefined as never),
  evidenceCanary: z.object({
    mode: z.const('enforce').required(),
  }).default(undefined as never),
}) as z<Config>

function resolveCompactEveryTurns(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('ui-context-compactor: compactEveryTurns must be a positive safe integer')
  }
  return value
}

function resolveConfig(config: Config): RouteReducerConfig {
  const hasProvider = config.provider !== undefined
  const hasModel = config.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('ui-context-compactor: provider and model must be configured together')
  }
  if (hasProvider && (config.provider?.trim().length === 0 || config.model?.trim().length === 0)) {
    throw new Error('ui-context-compactor: provider and model overrides must be non-blank')
  }
  if (config.reasoningEffort !== undefined && config.reasoningEffort.trim().length === 0) {
    throw new Error('ui-context-compactor: reasoningEffort must be non-blank when configured')
  }
  const maxInputChars = config.maxInputChars ?? 32_000
  const maxOutputTokens = config.maxOutputTokens ?? 8_192
  if (!Number.isSafeInteger(maxInputChars) || maxInputChars < 32_000) {
    throw new Error('ui-context-compactor: maxInputChars must be a safe integer of at least 32000')
  }
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 256) {
    throw new Error('ui-context-compactor: maxOutputTokens must be a safe integer of at least 256')
  }
  const materialConfig = resolveMaterialConfig(config.largeToolResultPreprocessing)
  return {
    ...config.provider === undefined ? {} : { provider: config.provider },
    ...config.model === undefined ? {} : { model: config.model },
    ...config.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(config.reasoningEffort.trim()) },
    maxInputChars,
    maxOutputTokens,
    ...materialConfig === undefined ? {} : { materialConfig },
  }
}

function resolveMaterialConfig(
  preprocessing: Config['largeToolResultPreprocessing'],
): BuildRouteMaterialConfig | undefined {
  if (preprocessing === undefined) return undefined
  const enabled = preprocessing.enabled ?? false
  const minChars = preprocessing.minChars ?? 2_500
  if (!Number.isSafeInteger(minChars) || minChars < 1_024) {
    throw new Error('ui-context-compactor: largeToolResultPreprocessing.minChars must be a safe integer of at least 1024')
  }
  const largeToolResultPreprocessing: LargeToolResultPreprocessingConfig = { enabled, minChars }
  return { largeToolResultPreprocessing }
}

export const FOCUS_CANARY_IDS = Object.freeze([
  'session-context-manager-focus-canary-a',
  'session-context-manager-focus-canary-b',
] as const)

const focusCanaryRecordSchema = zod.object({
  original: zod.object({
    messageId: zod.string().min(1),
    hash: zod.string().min(1),
  }).strict(),
  proposal: zod.object({
    kind: zod.literal('focus'),
    relation: zod.literal('new'),
    subject: zod.string().min(1).max(240),
  }).strict(),
  decision: zod.object({
    kind: zod.literal('focus_established'),
    ref: zod.string().min(1),
    chat: zod.string().min(1),
    currentMatter: zod.string().min(1).max(240),
    latestCorrections: zod.string(),
  }).strict(),
}).strict()
type FocusCanaryRecord = zod.infer<typeof focusCanaryRecordSchema>

const noFocusDecisionSchema = zod.object({
  kind: zod.literal('no_focus'),
  ref: zod.string().min(1),
  chat: zod.string().min(1),
  latestCorrections: zod.string(),
}).strict()

const closureOnlyProofRecordSchema = zod.object({
  closure: zod.object({
    phase: zod.union([zod.literal('pending'), zod.literal('physically_proved')]),
    original: zod.object({
      messageId: zod.string().min(1),
      hash: zod.string().min(1),
    }).strict(),
  }).strict(),
}).strict()

function contractReportSchema<
  Subject extends zod.ZodTypeAny,
  Business extends zod.ZodTypeAny,
  Partial extends zod.ZodTypeAny,
>(
  code: string,
  subject: Subject,
  business: Business,
  partial: Partial,
) {
  const identity = zod.object({ contract: zod.literal(code), call: zod.string().min(1), subject }).strict()
  return zod.union([
    zod.object({ kind: zod.literal('received'), identity }).strict(),
    zod.object({ kind: zod.literal('accepted'), identity }).strict(),
    zod.object({ kind: zod.literal('business_result'), identity, value: business }).strict(),
    zod.object({ kind: zod.literal('rejected'), identity, reason: zod.object({
      kind: zod.union([zod.literal('outside_receiver_authority'), zod.literal('target_not_uniquely_identified'), zod.literal('known_business_precondition_not_met')]),
      detail: zod.string().min(1),
    }).strict() }).strict(),
    zod.object({ kind: zod.literal('known_failure'), identity, problem: zod.object({ detail: zod.string().min(1), affected: zod.string().min(1) }).strict() }).strict(),
    zod.object({ kind: zod.literal('unknown'), identity, problem: zod.object({ detail: zod.string().min(1), affected: zod.string().min(1) }).strict() }).strict(),
    zod.object({ kind: zod.literal('partial'), identity, established: partial, notEstablished: zod.string().min(1) }).strict(),
  ])
}

const refSchema = zod.string().min(1)
const noUsableEstablishedFactSchema = zod.object({ kind: zod.literal('no_usable_established_fact'), processedPart: refSchema }).strict()
const acceptedNoFocusSchema = zod.object({ kind: zod.literal('accepted_for_contract'), value: noFocusDecisionSchema }).strict()
const c06Schema = contractReportSchema('C06', refSchema, acceptedNoFocusSchema, noUsableEstablishedFactSchema)
const c07Schema = contractReportSchema('C07', refSchema, acceptedNoFocusSchema, noUsableEstablishedFactSchema)
const c29Schema = contractReportSchema('C29', refSchema, zod.union([
  zod.object({ kind: zod.literal('eligible'), state: refSchema }).strict(),
  zod.object({ kind: zod.literal('ineligible'), state: refSchema, missing: refSchema }).strict(),
]), noUsableEstablishedFactSchema)
const c30Schema = contractReportSchema('C30', refSchema, zod.union([
  zod.object({ kind: zod.literal('established'), state: refSchema }).strict(),
  zod.object({ kind: zod.literal('same_complete_state_already_recoverable'), state: refSchema, proof: refSchema }).strict(),
]), zod.object({ state: refSchema, establishedScope: refSchema }).strict())
const c31Schema = contractReportSchema('C31', refSchema, zod.union([
  zod.object({ kind: zod.literal('uniquely_replaced'), state: refSchema }).strict(),
  zod.object({ kind: zod.literal('same_state_already_uniquely_visible'), state: refSchema, proof: refSchema }).strict(),
]), zod.object({ state: refSchema, changedScope: refSchema }).strict())
const c32CurrentStateSchema = zod.object({
  kind: zod.literal('canonical'),
  state: zod.object({
    kind: zod.literal('no_focus'), ref: refSchema, target: refSchema,
    focus: zod.object({ kind: zod.literal('no_focus'), ref: refSchema, latestCorrections: zod.string() }).strict(),
  }).strict(),
}).strict()
const c32Schema = zod.object({
  kind: zod.literal('business_result'),
  identity: zod.object({
    contract: zod.literal('C32'), call: refSchema,
    subject: zod.object({ kind: zod.literal('canonical_state'), state: refSchema }).strict(),
  }).strict(),
  value: zod.object({ kind: zod.literal('current_context_accepted'), state: c32CurrentStateSchema }).strict(),
}).strict()
const c33Schema = contractReportSchema('C33', refSchema, zod.union([
  zod.object({ kind: zod.literal('saved'), material: refSchema }).strict(),
  zod.object({ kind: zod.literal('same_complete_material_already_saved'), material: refSchema, proof: refSchema }).strict(),
]), zod.object({ material: refSchema, savedScope: refSchema }).strict())
const completeStateMaterialSchema = zod.object({
  kind: zod.literal('no_focus_material'),
  ref: refSchema,
  target: refSchema,
  canonicalState: zod.object({
    kind: zod.literal('no_focus'), ref: refSchema,
    focus: zod.object({ kind: zod.literal('no_focus'), ref: refSchema, latestCorrections: zod.string() }).strict(),
  }).strict(),
}).strict()

const noFocusTransactionBaseSchema = zod.object({
  pendingRef: refSchema,
  canonicalRef: refSchema,
  generation: zod.number().step(1).min(1),
  machine: zod.object({
    kind: zod.literal('no_focus'),
    focusRef: refSchema,
    chat: refSchema,
    latestCorrections: zod.string(),
    closeMessageId: refSchema,
    closeHash: refSchema,
  }).strict(),
  body: zod.string().min(1),
  bodyHash: refSchema,
  material: completeStateMaterialSchema,
  c06: c06Schema,
  c07: c07Schema,
  c29: c29Schema,
}).strict()
const noFocusTransactionPendingSchema = noFocusTransactionBaseSchema.extend({
  phase: zod.literal('pending'),
}).strict()
const noFocusTransactionCurrentSchema = noFocusTransactionBaseSchema.extend({
  phase: zod.literal('current'),
  c33: c33Schema,
  c30: c30Schema,
  firstC31: c31Schema,
  firstC32: c32Schema,
  firstReplaceSeq: zod.number().step(1).min(0),
}).strict()
const noFocusRepairSchema = zod.union([
  zod.object({
    phase: zod.literal('repair_pending'),
    targetMessageId: refSchema,
  }).strict(),
  zod.object({
    phase: zod.literal('repair_finalized'),
    targetMessageId: refSchema,
    targetReplaceSeq: zod.number().step(1).min(0),
  }).strict(),
])
const noFocusTransactionFinalizedSchema = noFocusTransactionBaseSchema.extend({
  phase: zod.literal('finalized'),
  c33: c33Schema,
  c30: c30Schema,
  firstC31: c31Schema,
  firstC32: c32Schema,
  firstReplaceSeq: zod.number().step(1).min(0),
  finalizedC31: c31Schema,
  finalizedC32: c32Schema,
  finalizedReplaceSeq: zod.number().step(1).min(0),
  repair: noFocusRepairSchema.optional(),
}).strict()
const noFocusTransactionSchema = zod.union([
  noFocusTransactionPendingSchema,
  noFocusTransactionCurrentSchema,
  noFocusTransactionFinalizedSchema,
]).superRefine((transaction, context) => {
  const problem = (path: (string | number)[], message: string): void => {
    context.addIssue({ code: zod.ZodIssueCode.custom, path, message })
  }
  const { pendingRef, canonicalRef, machine, material } = transaction
  if (material.target !== machine.chat
    || material.canonicalState.ref !== canonicalRef
    || material.canonicalState.focus.ref !== machine.focusRef
    || material.canonicalState.focus.latestCorrections !== machine.latestCorrections) {
    problem(['material'], 'complete material does not match the transaction identity')
  }
  if (createHash('sha256').update(transaction.body).digest('hex') !== transaction.bodyHash) {
    problem(['bodyHash'], 'transaction body hash does not match its exact body')
  }
  const hasExactAcceptedNoFocus = (report: typeof transaction.c06 | typeof transaction.c07): boolean => {
    return report.kind === 'business_result'
      && report.identity.subject === machine.focusRef
      && report.value.kind === 'accepted_for_contract'
      && report.value.value.kind === 'no_focus'
      && report.value.value.ref === machine.focusRef
      && report.value.value.chat === machine.chat
      && report.value.value.latestCorrections === machine.latestCorrections
  }
  if (!hasExactAcceptedNoFocus(transaction.c06)) {
    problem(['c06'], 'C06 does not carry the exact no-focus decision')
  }
  if (!hasExactAcceptedNoFocus(transaction.c07)) {
    problem(['c07'], 'C07 does not carry the exact no-focus decision')
  }
  if (transaction.c29.kind !== 'business_result'
    || transaction.c29.identity.subject !== pendingRef
    || transaction.c29.value.kind !== 'eligible'
    || transaction.c29.value.state !== pendingRef) {
    problem(['c29'], 'C29 is not the exact eligible result for this pending state')
  }
  if (transaction.phase === 'pending') return
  if (transaction.c33.kind !== 'business_result'
    || transaction.c33.identity.subject !== material.ref
    || transaction.c33.value.material !== material.ref
    || transaction.c30.kind !== 'business_result'
    || transaction.c30.identity.subject !== pendingRef
    || transaction.c30.value.state !== pendingRef
    || transaction.firstC31.kind !== 'business_result'
    || transaction.firstC31.identity.subject !== pendingRef
    || transaction.firstC31.value.state !== pendingRef
    || transaction.firstC32.identity.subject.state !== canonicalRef
    || transaction.firstC32.value.state.kind !== 'canonical'
    || transaction.firstC32.value.state.state.ref !== canonicalRef
    || transaction.firstC32.value.state.state.target !== machine.chat
    || transaction.firstC32.value.state.state.focus.ref !== machine.focusRef
    || transaction.firstC32.value.state.state.focus.latestCorrections !== machine.latestCorrections) {
    problem(['phase'], 'current transaction reports do not describe one canonical no-focus state')
  }
  if (transaction.phase !== 'finalized') return
  if (transaction.finalizedReplaceSeq <= transaction.firstReplaceSeq) {
    problem(['finalizedReplaceSeq'], 'finalized replacement must follow the current replacement')
  }
  if (transaction.repair?.phase === 'repair_finalized'
    && transaction.repair.targetReplaceSeq <= transaction.finalizedReplaceSeq) {
    problem(['repair', 'targetReplaceSeq'], 'repair replacement must follow the live finalized replacement')
  }
  if (transaction.finalizedC31.kind !== 'business_result'
    || transaction.finalizedC31.identity.subject !== pendingRef
    || transaction.finalizedC31.value.state !== pendingRef
    || transaction.finalizedC32.identity.subject.state !== canonicalRef
    || transaction.finalizedC32.value.state.kind !== 'canonical'
    || transaction.finalizedC32.value.state.state.ref !== canonicalRef
    || transaction.finalizedC32.value.state.state.target !== machine.chat
    || transaction.finalizedC32.value.state.state.focus.ref !== machine.focusRef
    || transaction.finalizedC32.value.state.state.focus.latestCorrections !== machine.latestCorrections) {
    problem(['phase'], 'finalized transaction reports do not describe one canonical no-focus state')
  }
})

const noFocusCanaryRecordSchema = zod.object({
  focus: focusCanaryRecordSchema,
  closure: zod.object({
    // This is an internal transaction-proof marker, not a new user-visible
    // focus state. A pending close is deliberately unrecoverable on restart.
    phase: zod.union([zod.literal('pending'), zod.literal('physically_proved')]),
    original: zod.object({
      messageId: zod.string().min(1),
      hash: zod.string().min(1),
    }).strict(),
    proposal: zod.object({
      kind: zod.literal('close'),
      relation: zod.literal('current'),
    }).strict(),
    decision: zod.object({
      kind: zod.literal('no_focus'),
      ref: zod.string().min(1),
      chat: zod.string().min(1),
      latestCorrections: zod.string(),
    }).strict(),
  }).strict(),
  // F07-H1 extends the existing pre-canonical row rather than opening a
  // second domain or teaching H2's cache to claim canonical authority.
  transaction: noFocusTransactionSchema.optional(),
}).strict().superRefine((record, context) => {
  const transaction = record.transaction
  if (transaction === undefined) return
  const problem = (path: (string | number)[], message: string): void => {
    context.addIssue({ code: zod.ZodIssueCode.custom, path, message })
  }
  if (record.closure.phase !== 'physically_proved') {
    problem(['closure', 'phase'], 'a canonical transaction requires a physically-proved close')
  }
  if (transaction.machine.focusRef !== record.closure.decision.ref
    || transaction.machine.chat !== record.closure.decision.chat
    || transaction.machine.latestCorrections !== record.closure.decision.latestCorrections) {
    problem(['transaction', 'machine'], 'transaction machine does not match the proved no-focus decision')
  }
  if (transaction.machine.closeMessageId !== record.closure.original.messageId
    || transaction.machine.closeHash !== record.closure.original.hash) {
    problem(['transaction', 'machine'], 'transaction machine does not match the proved close input')
  }
  if (record.focus.decision.chat !== record.closure.decision.chat) {
    problem(['focus', 'decision', 'chat'], 'pre-canonical focus and no-focus closure belong to different chats')
  }
})
type NoFocusCanaryRecord = zod.infer<typeof noFocusCanaryRecordSchema>
const closureOnlyNoFocusRecordSchema = zod.object({
  closure: noFocusCanaryRecordSchema.shape.closure,
  transaction: noFocusTransactionSchema.optional(),
}).strict().superRefine((record, context) => {
  const transaction = record.transaction
  if (transaction === undefined) return
  const problem = (path: (string | number)[], message: string): void => {
    context.addIssue({ code: zod.ZodIssueCode.custom, path, message })
  }
  if (record.closure.phase !== 'physically_proved') {
    problem(['closure', 'phase'], 'a canonical transaction requires a physically-proved close')
  }
  if (transaction.machine.focusRef !== record.closure.decision.ref
    || transaction.machine.chat !== record.closure.decision.chat
    || transaction.machine.latestCorrections !== record.closure.decision.latestCorrections
    || transaction.machine.closeMessageId !== record.closure.original.messageId
    || transaction.machine.closeHash !== record.closure.original.hash) {
    problem(['transaction', 'machine'], 'transaction machine does not match the proved closure-only decision')
  }
})
type ClosureOnlyNoFocusRecord = zod.infer<typeof closureOnlyNoFocusRecordSchema>
type StoredNoFocusRecord = NoFocusCanaryRecord | ClosureOnlyNoFocusRecord
const localRestrictionStateRecordSchema = zod.custom<LocalRestrictionStateRecord>(
  value => parseCanonicalLocalRestrictionStateRecord(value) !== undefined,
  { message: 'invalid exact local restriction state record' },
)
const noSafeActionStateRecordSchema = zod.custom<NoSafeActionStateRecord>(
  value => parseCanonicalNoSafeActionStateRecord(value) !== undefined,
  { message: 'invalid exact no-safe-action state record' },
)
const backgroundStateRecordSchema = zod.custom<BackgroundStateRecord>(
  value => parseCanonicalBackgroundStateRecord(value) !== undefined,
  { message: 'invalid exact background state record' },
)
const h1CanaryRecordSchema = zod.union([
  focusCanaryRecordSchema,
  noFocusCanaryRecordSchema,
  closureOnlyNoFocusRecordSchema,
  closureOnlyProofRecordSchema,
  localRestrictionStateRecordSchema,
  noSafeActionStateRecordSchema,
  backgroundStateRecordSchema,
])
type H1CanaryRecord = zod.infer<typeof h1CanaryRecordSchema>

/**
 * The sidecar parser validated the full transaction schema before this narrow
 * adapter returns only the physically fresh, schema-validated shape permitted
 * to begin this live transaction; recovery owns every persisted transaction.
 */
/** F07-H1 live may begin only from a freshly proof-committed H2 row. */
function validatedNoFocusCarrier(record: NoFocusCanaryRecord): (Omit<NoFocusCanaryRecord, 'transaction'> & { readonly transaction?: never }) | undefined {
  const parsed = noFocusCanaryRecordSchema.safeParse(record)
  if (!parsed.success || parsed.data.closure.phase !== 'physically_proved' || parsed.data.transaction !== undefined) return undefined
  const { transaction: _transaction, ...carrier } = parsed.data
  return carrier
}

const focusCanaryDomainSpec = defineDomain({
  name: CONTEXT_MANAGER_STORAGE_DOMAIN,
  version: 1,
  tables: {
    focus_precanonical: domainTable<string, H1CanaryRecord>(h1CanaryRecordSchema),
  },
})
type FocusCanaryDomain = Domain<typeof focusCanaryDomainSpec>

function managed(agent: Agent, classifier: ManagedInteractiveRootClassifier | undefined): boolean {
  return classifier?.isManagedInteractiveRoot(String(agent.session.id), agent.session.header.delegationDepth) === true
}

const MANAGED_COMPACT_CLOSED_TEXT = '上下文管理候选尚未换入，本次未压缩。'
const MANAGED_COMPACT_UPDATED_TEXT = '当前背景已通过同一受管更新事务换入。'

interface ManagedCompactRequest {
  request(agent: Agent): Promise<boolean>
}

/**
 * Mount the managed-only command in the exact agent scope that received it.
 * A synchronous `agent/created` throw vetoes publication, so a failed mount
 * cannot leave a managed agent able to resolve the global native command.
 */
function installManagedCompactCommand(
  ctx: Context,
  classifier: ManagedInteractiveRootClassifier,
  request: ManagedCompactRequest,
): void {
  if (ctx.get('commands') === undefined) {
    throw new Error('ui-context-compactor: native writer arbitration requires the commands service')
  }
  ctx.on('agent/created', ({ agent }) => {
    if (!managed(agent, classifier)) return
    // The global definition must already be present. It remains the complete
    // behavior for every unmanaged/cron/worker agent and is restored when the
    // agent-scoped registration is disposed.
    // `Context#get()` is Cordis' public non-injected service lookup. Its
    // traceable receiver still binds CommandRuntime.register() to this exact
    // Agent scope. It is synchronous (unlike mounting a child plugin), so the
    // scoped layer exists before the first post-creation event.
    const commands = agent.ctx.get('commands')
    if (commands === undefined) {
      throw new Error('ui-context-compactor: native writer arbitration requires the commands service')
    }
    if (commands.find(agent, 'compact') === undefined) {
      throw new Error('ui-context-compactor: native writer arbitration requires the global compact command')
    }
    const handler = async () => await request.request(agent)
      ? { kind: 'success' as const, text: MANAGED_COMPACT_UPDATED_TEXT }
      : { kind: 'error' as const, text: MANAGED_COMPACT_CLOSED_TEXT }
    const dispose = commands.register({
      name: 'compact',
      description: 'Request a managed context update',
      handler,
    })
    // The registration itself is an agent-scope effect, rather than a global
    // closure held by this plugin; disposal of the Agent tears it down.
    if (commands.find(agent, 'compact')?.handler !== handler) {
      dispose()
      throw new Error('ui-context-compactor: managed compact command did not shadow the global definition')
    }
  }, { prepend: true })
}

function resolveManagedCompaction(
  ctx: Context,
  runtime: ManagedRuntimeConfig,
): ManagedAwareBasicCompactionEngine {
  const compaction = ctx.get('compaction')
  if (!(compaction instanceof ManagedAwareBasicCompactionEngine)) {
    throw new Error('ui-context-compactor: native writer arbitration requires ManagedAwareBasicCompactionEngine')
  }
  if (!compaction.hasManagedRuntime(runtime)) {
    throw new Error('ui-context-compactor: managed runtime config must exactly match focus canary')
  }
  return compaction
}

function validateFocusCanaryAllowlist(runtime: ManagedRuntimeConfig): void {
  const expected = new Set<string>(FOCUS_CANARY_IDS)
  const actual = new Set(runtime.allowlist)
  const exactTelegram = actual.size === 1 && actual.has('session-telegram')
  if (!exactTelegram && (actual.size !== expected.size
    || [...actual].some(id => !expected.has(id))
    || [...expected].some(id => !actual.has(id)))) {
    throw new Error('ui-context-compactor: focus canary allowlist must contain exactly the two H1 chat ids')
  }
}

function textOf(message: UserMessage): string | undefined {
  if (message.content.length !== 1 || message.content[0]?.type !== 'text') return undefined
  const text = message.content[0].text
  return text.trim().length === 0 ? undefined : text
}

function hasPriorCanaryDisqualifier(agent: Agent, claimed: readonly UserMessage[]): boolean {
  // A context/route/native injection can still be sitting in this exact
  // claimed batch and has not reached the append-only Session yet. Treat it
  // exactly like an already-recorded prior non-user message.
  if (claimed.some(message => !isDirectUserSource(message.source))) return true
  return agent.session.events.some((event) => {
    if (event.type === 'turn/start') return false
    if (event.type === 'session/end-seed') return false
    return event.type === 'assistant/message'
      || event.type.startsWith('compaction/')
      || event.type === 'user/message'
  })
}

function sameFocus(left: FocusDecision, right: FocusCanaryRecord['decision']): boolean {
  return left.kind === 'focus_established'
    && left.ref === right.ref
    && left.chat === right.chat
    && left.currentMatter === right.currentMatter
    && left.latestCorrections === right.latestCorrections
}

function sameNoFocus(
  left: FocusDecision,
  right: (NoFocusCanaryRecord | ClosureOnlyNoFocusRecord)['closure']['decision'],
): boolean {
  return left.kind === 'no_focus'
    && left.ref === right.ref
    && left.chat === right.chat
    && left.latestCorrections === right.latestCorrections
}

function isNoFocusCanaryRecord(record: H1CanaryRecord): record is NoFocusCanaryRecord {
  return noFocusCanaryRecordSchema.safeParse(record).success
}

function isClosureOnlyNoFocusRecord(record: H1CanaryRecord): record is ClosureOnlyNoFocusRecord {
  return closureOnlyNoFocusRecordSchema.safeParse(record).success
}

function isAnyNoFocusRecord(
  record: H1CanaryRecord,
): record is NoFocusCanaryRecord | ClosureOnlyNoFocusRecord | ClosureOnlyProofRecord {
  return 'closure' in record
}

function isLocalRestrictionStateRecord(record: H1CanaryRecord): record is LocalRestrictionStateRecord {
  return 'family' in record && record.family === 'local_restriction'
}

function isNoSafeActionStateRecord(record: H1CanaryRecord): record is NoSafeActionStateRecord {
  return 'family' in record && record.family === 'no_safe_action'
}

function isBackgroundStateRecord(record: H1CanaryRecord): record is BackgroundStateRecord {
  return 'family' in record && record.family === 'background'
}

function originalFromSession(agent: Agent, record: FocusCanaryRecord): UserMessage | undefined {
  return agent.session.events.find((event): event is Extract<typeof event, { type: 'user/message' }> =>
    event.type === 'user/message'
      && event.data.source.kind === 'user'
      && String(event.data.id) === record.original.messageId,
  )?.data
}

function hasLaterDirectUserEvidence(agent: Agent, record: FocusCanaryRecord): boolean {
  const original = agent.session.events.find(event => event.type === 'user/message'
    && event.data.source.kind === 'user'
    && String(event.data.id) === record.original.messageId)
  if (original === undefined) return true
  return agent.session.events.some(event => event.seq > original.seq
    && event.type === 'user/message'
    && event.data.source.kind === 'user')
}

function detachedCanonicalEventMatches(
  event: SessionEvent | undefined,
  record: StoredNoFocusRecord,
  phase: 'current' | 'finalized',
  expectedSeq: number,
): event is SessionEvent<'user/message'> {
  const transaction = record.transaction
  if (transaction?.phase !== 'finalized'
    || event?.type !== 'user/message'
    || event.seq !== expectedSeq
    || event.data.source.kind !== 'context-manager-canonical') return false
  const text = textOf(event.data)
  const source = event.data.source
  return source.phase === phase
    && source.pendingStateRef === transaction.pendingRef
    && source.canonicalStateRef === transaction.canonicalRef
    && source.generation === transaction.generation
    && source.chat === transaction.machine.chat
    && source.bodyHash === transaction.bodyHash
    && source.machine.kind === 'no_focus'
    && source.machine.focusRef === transaction.machine.focusRef
    && source.machine.latestCorrections === transaction.machine.latestCorrections
    && source.machine.closeMessageId === transaction.machine.closeMessageId
    && source.machine.closeHash === transaction.machine.closeHash
    && text === transaction.body
    && createHash('sha256').update(text ?? '').digest('hex') === transaction.bodyHash
}

/**
 * H1R-F treats the detached Session suffix as the recovery publication proof.
 * It never repairs or appends here: a mismatch simply keeps the managed agent
 * closed before any pre-step reaches provider, tool, or auxiliary work.
 */
function hasDetachedFinalizedRecoveryProof(
  agent: Agent,
  record: StoredNoFocusRecord,
  detached: readonly SessionEvent[],
): boolean {
  const transaction = record.transaction
  if (transaction?.phase !== 'finalized') return false
  const finalizedSeq = transaction.repair?.phase === 'repair_finalized'
    ? transaction.repair.targetReplaceSeq : transaction.finalizedReplaceSeq
  const close = detached.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message'
    && event.data.source.kind === 'user'
    && String(event.data.id) === record.closure.original.messageId)
  const current = detached.filter(event => detachedCanonicalEventMatches(event, record, 'current', transaction.firstReplaceSeq))
  const finalized = detached.filter(event => detachedCanonicalEventMatches(event, record, 'finalized', finalizedSeq))
  if (close.length !== 1 || current.length !== 1 || finalized.length !== 1
    || finalizedSeq <= transaction.firstReplaceSeq
    || transaction.repair?.phase === 'repair_finalized'
      && String(finalized[0]!.data.id) !== transaction.repair.targetMessageId) return false
  const closeText = textOf(close[0]!.data)
  if (closeText === undefined
    || directExpressionHash(record.closure.original.messageId, closeText) !== record.closure.original.hash) return false
  const hasOneUserId = (events: readonly SessionEvent[], id: string): boolean => events.filter(event => event.type === 'user/message'
    && String(event.data.id) === id).length === 1
  const liveBySeq = (seq: number): SessionEvent | undefined => agent.session.events.find(event => event.seq === seq)
  const liveClose = liveBySeq(close[0]!.seq)
  if (!hasOneUserId(detached, record.closure.original.messageId)
    || !hasOneUserId(agent.session.events, record.closure.original.messageId)
    || liveClose?.type !== 'user/message'
    || String(liveClose.data.id) !== record.closure.original.messageId
    || liveClose.data.source.kind !== 'user'
    || textOf(liveClose.data) !== closeText
    || directExpressionHash(String(liveClose.data.id), closeText) !== record.closure.original.hash) return false
  const sameCanonical = (
    detachedEvent: SessionEvent<'user/message'>,
    phase: 'current' | 'finalized',
    seq: number,
  ): boolean => {
    const id = String(detachedEvent.data.id)
    const live = liveBySeq(seq)
    return hasOneUserId(detached, id)
      && hasOneUserId(agent.session.events, id)
      && detachedCanonicalEventMatches(live, record, phase, seq)
      && live?.type === 'user/message'
      && String(live.data.id) === id
      && textOf(live.data) === textOf(detachedEvent.data)
  }
  return sameCanonical(current[0]!, 'current', transaction.firstReplaceSeq)
    && sameCanonical(finalized[0]!, 'finalized', finalizedSeq)
}

function hasExpectedNoFocusWithoutTransaction(agent: Agent): boolean {
  return agent.session.events.some(event => event.type === 'user/message'
    && event.data.source.kind === 'user'
    && textOf(event.data) === '这件事结束了')
}

interface ExactClosureOnlyProofTranscript {
  readonly close: UserMessage
  readonly closeSeq: number
  readonly continuationId?: string
  readonly continuationSeq?: number
}

function sameDirectPayload(left: UserMessage, right: UserMessage): boolean {
  return String(left.id) === String(right.id)
    && left.role === right.role
    && JSON.stringify(left.source) === JSON.stringify(right.source)
    && JSON.stringify(left.content) === JSON.stringify(right.content)
}

/** One managed failure turn, from durable inbox insertion through error end. */
function exactFailedDirectTurn(
  events: readonly SessionEvent[],
  start: number,
  expectedText: string,
  expectedId?: string,
): { readonly next: number; readonly message: UserMessage; readonly seq: number } | undefined {
  const insertion = events[start]
  const turnStart = events[start + 1]
  const claim = events[start + 2]
  const direct = events[start + 3]
  const turnEnd = events[start + 4]
  if (insertion?.type !== 'agent/inbox/spliced'
    || insertion.data.target !== 'next-turn' || insertion.data.start !== 0
    || insertion.data.removedCount !== undefined || insertion.data.outcome !== undefined
    || insertion.data.inserted.length !== 1
    || turnStart?.type !== 'turn/start'
    || claim?.type !== 'agent/inbox/spliced'
    || claim.data.target !== 'next-turn' || claim.data.start !== 0
    || claim.data.removedCount !== 1 || claim.data.outcome !== undefined
    || claim.data.inserted.length !== 0
    || direct?.type !== 'user/message' || !isDirectUserSource(direct.data.source)
    || textOf(direct.data) !== expectedText
    || expectedId !== undefined && String(direct.data.id) !== expectedId
    || !sameDirectPayload(insertion.data.inserted[0]!, direct.data)
    || turnEnd?.type !== 'turn/end'
    || turnEnd.data.turn !== turnStart.data.turn
    || turnEnd.data.reason.kind !== 'error') return undefined
  return Object.freeze({ next: start + 5, message: direct.data, seq: direct.seq })
}

function skipEndSeeds(events: readonly SessionEvent[], start: number): number {
  let cursor = start
  while (events[cursor]?.type === 'session/end-seed') cursor += 1
  return cursor
}

/**
 * The proof-only row may recover only the exact one- or two-failure transcript
 * produced by the managed close contract.  No unrelated tail is erased by the
 * canonical replacement.
 */
function exactClosureOnlyProofTranscript(
  sessionId: string,
  events: readonly SessionEvent[],
  record: ClosureOnlyProofRecord,
): ExactClosureOnlyProofTranscript | undefined {
  if (sessionId !== 'session-telegram' || record.closure.phase !== 'physically_proved') return undefined
  const closeEvents = events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message'
    && String(event.data.id) === record.closure.original.messageId)
  const exactCloseTextEvents = events.filter(event => event.type === 'user/message'
    && isDirectUserSource(event.data.source) && textOf(event.data) === '这件事结束了')
  const close = closeEvents[0]
  const closeText = close?.type === 'user/message' ? textOf(close.data) : undefined
  if (closeEvents.length !== 1 || exactCloseTextEvents.length !== 1 || close === undefined
    || !isDirectUserSource(close.data.source) || closeText !== '这件事结束了'
    || directExpressionHash(record.closure.original.messageId, closeText) !== record.closure.original.hash) return undefined
  const closeIndex = events.indexOf(close)
  const start = closeIndex - 3
  if (start < 0
    || !events.slice(0, start).some(event => event.type === 'user/message' || event.type === 'assistant/message')
    || events.slice(0, start).some(event => event.type === 'user/message'
      && (event.data.source.kind === 'context-manager-canonical'
        || event.data.source.kind === 'context-manager-local-restriction'
        || event.data.source.kind === 'context-manager-no-safe-action'))) return undefined
  const closeTurn = exactFailedDirectTurn(events, start, '这件事结束了', record.closure.original.messageId)
  if (closeTurn === undefined) return undefined
  let cursor = skipEndSeeds(events, closeTurn.next)
  let continuation: ReturnType<typeof exactFailedDirectTurn>
  if (cursor < events.length) {
    continuation = exactFailedDirectTurn(events, cursor, '继续')
    if (continuation === undefined) return undefined
    cursor = skipEndSeeds(events, continuation.next)
  }
  if (cursor !== events.length) return undefined
  const tailDirects = events.slice(closeIndex).filter(event => event.type === 'user/message'
    && isDirectUserSource(event.data.source))
  if (tailDirects.length !== (continuation === undefined ? 1 : 2)) return undefined
  return Object.freeze({
    close: closeTurn.message,
    closeSeq: closeTurn.seq,
    ...(continuation === undefined ? {} : {
      continuationId: String(continuation.message.id),
      continuationSeq: continuation.seq,
    }),
  })
}

function sameClosureOnlyProofTranscript(
  left: ExactClosureOnlyProofTranscript,
  right: ExactClosureOnlyProofTranscript,
): boolean {
  return left.closeSeq === right.closeSeq
    && sameDirectPayload(left.close, right.close)
    && left.continuationId === right.continuationId
    && left.continuationSeq === right.continuationSeq
}

/** Recreate the durable repair target, never a fresh identity after a crash. */
function repairCanonicalMessage(canonical: UserMessage, targetMessageId: string): UserMessage {
  // The target inherits every already-validated, branded source field from
  // the logged finalized message; only the pre-persisted message identity is
  // replaced.  Index never rebrands raw sidecar strings.
  return freezeMessage({ ...canonical, id: MessageId(targetMessageId) })
}

function sameFinalizedCanonical(message: { readonly role: string; readonly content: readonly { readonly type: string; readonly text?: string }[]; readonly source: UserMessage['source'] }, transaction: Extract<NoFocusCanaryRecord['transaction'], { readonly phase: 'finalized' }>): boolean {
  const source = message.source
  const body = message.content.length === 1 && message.content[0]?.type === 'text'
    ? message.content[0].text : undefined
  return source.kind === 'context-manager-canonical'
    && message.role === 'user'
    && source.phase === 'finalized'
    && source.pendingStateRef === transaction.pendingRef
    && source.canonicalStateRef === transaction.canonicalRef
    && source.generation === transaction.generation
    && source.chat === transaction.machine.chat
    && source.bodyHash === transaction.bodyHash
    && source.machine.kind === 'no_focus'
    && source.machine.focusRef === transaction.machine.focusRef
    && source.machine.latestCorrections === transaction.machine.latestCorrections
    && source.machine.closeMessageId === transaction.machine.closeMessageId
    && source.machine.closeHash === transaction.machine.closeHash
    && body === transaction.body
    && createHash('sha256').update(transaction.body).digest('hex') === transaction.bodyHash
}

/** Only the normal H1 post-response tail can be repaired; every other tail closes. */
function isExactNormalNoFocusTail(agent: Agent, record: StoredNoFocusRecord): boolean {
  const transaction = record.transaction
  if (transaction?.phase !== 'finalized') return false
  const visible = agent.session.deriveMessages()
  const canonical = visible[0]
  const notice = visible[1]
  const assistant = visible[2]
  if (visible.length !== 3 || canonical === undefined || canonical.role !== 'user'
    || notice === undefined || notice.role !== 'user' || assistant === undefined || assistant.role !== 'assistant'
    || !sameFinalizedCanonical(canonical, transaction)
    || notice.source.kind !== 'plugin' || notice.source.plugin !== 'ui-context-compactor:no-focus'
    || notice.source.form !== 'notice'
    || notice.source.summary !== 'no-focus closure receipt'
    || notice.content.length !== 1 || notice.content[0]?.type !== 'text'
    || notice.content[0].text !== '当前事项已结束。请告诉我接下来要开始哪件事。'
    || assistant.source.kind !== 'model') return false
  const finalEvent = agent.session.events.find(event => event.seq === transaction.finalizedReplaceSeq)
  const assistantEvents = agent.session.events.filter((event): event is Extract<SessionEvent, { type: 'assistant/message' }> =>
    event.type === 'assistant/message' && String(event.data.message.id) === String(assistant.id))
  if (finalEvent?.type !== 'user/message' || String(finalEvent.data.id) !== String(canonical.id)
    || assistantEvents.length !== 1) return false
  const finalIndex = agent.session.events.indexOf(finalEvent)
  if (finalIndex < 0) return false
  const tail = agent.session.events.slice(finalIndex + 1)
  const start = tail[0]
  const noticeEvent = tail[1]
  if (start?.type !== 'step/start'
    || noticeEvent?.type !== 'user/message'
    || String(noticeEvent.data.id) !== String(notice.id)) return false
  let cursor = 2
  let requestHeader = 0
  let requestContext = 0
  while (tail[cursor]?.type === 'request/header' || tail[cursor]?.type === 'request/context') {
    if (tail[cursor]?.type === 'request/header') requestHeader += 1
    else requestContext += 1
    cursor += 1
  }
  if (requestHeader > 1 || requestContext > 1) return false
  let chunks = 0
  for (;;) {
    const chunk = tail[cursor]
    if (chunk?.type !== 'assistant/chunk') break
    if (chunk.data.turn !== start.data.turn || chunk.data.step !== start.data.step) return false
    chunks += 1
    cursor += 1
  }
  const assistantEvent = tail[cursor]
  const end = tail[cursor + 1]
  const turnEnd = tail[cursor + 2]
  const seed = tail[cursor + 3]
  if (chunks === 0 || assistantEvent?.type !== 'assistant/message'
    || assistantEvent.data.turn !== start.data.turn || assistantEvent.data.step !== start.data.step
    || String(assistantEvent.data.message.id) !== String(assistant.id)
    || end?.type !== 'step/end' || end.data.turn !== start.data.turn || end.data.step !== start.data.step
    || turnEnd?.type !== 'turn/end' || turnEnd.data.turn !== start.data.turn) return false
  // Session resume contributes exactly this trailing persistence record.  No
  // additional lifecycle/chunk event is tolerated, so neither a second turn
  // nor an unrelated tail can smuggle itself through the repair whitelist.
  return (seed === undefined || seed.type === 'session/end-seed')
    && tail.length === cursor + (seed === undefined ? 3 : 4)
}

function isCleanFinalizedCanonical(agent: Agent, record: StoredNoFocusRecord): boolean {
  const transaction = record.transaction
  const visible = agent.session.deriveMessages()
  const canonical = visible[0]
  return transaction?.phase === 'finalized' && visible.length === 1
    && canonical !== undefined && canonical.role === 'user' && sameFinalizedCanonical(canonical, transaction)
}

async function repairNormalNoFocusTail(
  ctx: Context,
  agent: Agent,
  record: StoredNoFocusRecord,
  save: (record: StoredNoFocusRecord) => Promise<void>,
): Promise<StoredNoFocusRecord | undefined> {
  const transaction = record.transaction
  if (transaction?.phase !== 'finalized') return undefined
  if (transaction.repair?.phase === 'repair_finalized') {
    const visible = agent.session.deriveMessages()[0]
    return isCleanFinalizedCanonical(agent, record) && visible !== undefined
      && String(visible.id) === transaction.repair.targetMessageId ? record : undefined
  }
  if (transaction.repair === undefined && isCleanFinalizedCanonical(agent, record)) return record
  const existingTarget = transaction.repair === undefined ? [] : agent.session.events.filter(
    (event): event is Extract<SessionEvent, { type: 'user/message' }> =>
      event.type === 'user/message' && String(event.data.id) === transaction.repair!.targetMessageId,
  )
  const targetAlreadyVisible = existingTarget.length === 1
    && sameFinalizedCanonical(existingTarget[0]!.data, transaction)
    && isCleanFinalizedCanonical(agent, record)
    && String(agent.session.deriveMessages()[0]?.id) === transaction.repair?.targetMessageId
  if (!targetAlreadyVisible && !isExactNormalNoFocusTail(agent, record)) return undefined
  const targetMessageId = transaction.repair?.targetMessageId ?? crypto.randomUUID()
  const pending: StoredNoFocusRecord = transaction.repair === undefined
    ? { ...record, transaction: { ...transaction, repair: { phase: 'repair_pending', targetMessageId } } }
    : record
  if (transaction.repair === undefined) await save(pending)
  const originalFinalized = agent.session.events.find((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
    event.seq === transaction.finalizedReplaceSeq && event.type === 'user/message')
  if (originalFinalized === undefined || !sameFinalizedCanonical(originalFinalized.data, transaction)) return undefined
  const target = repairCanonicalMessage(originalFinalized.data, targetMessageId)
  const existing = agent.session.events.filter((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
    event.type === 'user/message' && String(event.data.id) === targetMessageId)
  let seq: number
  if (existing.length === 0) {
    const nodes = [...agent.session.surface.nodes]
    if (nodes.length === 0) return undefined
    seq = agent.session.append('user/message', target, {
      surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! }, sourceEventSeqs: nodes,
    }).seq
  } else if (existing.length === 1 && sameFinalizedCanonical(existing[0]!.data, transaction)) {
    seq = existing[0]!.seq
  } else return undefined
  const sessions = sessionsFlushPort(ctx)
  const persistence = sessionPersistencePort(ctx)
  if (sessions === undefined || persistence === undefined || !await sessions.flush(agent.session)) return undefined
  const detached = await persistence.readFrom(String(agent.session.id), seq)
  const exact = detached.events.filter(event => event.seq === seq)
  const sameId = detached.events.filter(event => event.type === 'user/message' && String(event.data.id) === targetMessageId)
  if (exact.length !== 1 || sameId.length !== 1 || exact[0]?.type !== 'user/message'
    || !sameFinalizedCanonical(exact[0].data, transaction)
    || !isCleanFinalizedCanonical(agent, pending)) return undefined
  const finalized: StoredNoFocusRecord = {
    ...pending,
    transaction: { ...transaction, repair: { phase: 'repair_finalized', targetMessageId, targetReplaceSeq: seq } },
  }
  await save(finalized)
  return finalized
}

const FOCUS_CANARY_UNAVAILABLE_TEXT = '已识别方向变化，但唯一背景尚未安全换入，本轮未继续行动'
const LOCAL_RESTRICTION_TRACER_EXPRESSION = '环境名还没确定；先把已经确认的只读检查列出来。'
const NO_SAFE_ACTION_TRACER_EXPRESSION = '把生产里的那条记录删掉'
const NO_SAFE_ACTION_TOOL_DENIAL = '当前请求没有可安全执行的行动，工具未执行。'
const F03_MAX_PRESENTATION_CHARS = 16_384
const F03_MULTI_SOURCE_FACT = 'DeepSeek Harness 最新版本'
const F03_MULTI_SOURCE_BLOCKED_ACTION = '升级 DeepSeek Harness'
const F03_MULTI_SOURCE_SAFE_ACTION = '列出已确认的只读升级前检查'

function isF03EvidenceDirect(
  text: string | undefined,
): text is typeof F03_EXACT_FACT_DIRECT
  | typeof F03_EXACT_MULTI_FACT_DIRECT
  | typeof F03_EXACT_MULTI_SOURCE_DIRECT {
  return text === F03_EXACT_FACT_DIRECT
    || text === F03_EXACT_MULTI_FACT_DIRECT
    || text === F03_EXACT_MULTI_SOURCE_DIRECT
}

/** Mechanically project only the owner-signed conclusion, provenance and action scope. */
function createEvidenceActionableMessage(
  completion: CompletedSingleEvidenceActionableBoundary,
): UserMessage | undefined {
  const { boundary, c22, provenance } = completion
  const conclusion = provenance.conclusion
  const accepted = c22.kind === 'business_result' && c22.value.kind === 'accepted_for_contract'
    ? c22.value.value
    : undefined
  if (completion.family !== 'actionable'
    || accepted !== boundary
    || c22.identity.contract !== 'C22'
    || c22.identity.subject !== boundary.ref
    || !('kind' in conclusion)
    || conclusion.kind !== 'direct_fact'
    || conclusion.degree !== 'established'
    || provenance.source !== conclusion.source
    || provenance.url === undefined
    || provenance.observedAt === undefined
    || boundary.usableFacts.length !== 1
    || boundary.usableFacts[0] !== conclusion
    || boundary.unresolvedFacts.length !== 0
    || boundary.preciselyBlockedActions.length !== 0
    || boundary.safelyContinuableActions.length === 0) return undefined
  const body = [
    '当前请求的已签行动事实：',
    `fact: ${conclusion.fact}`,
    `meaning: ${conclusion.meaning}`,
    `source: ${provenance.source}`,
    `url: ${provenance.url}`,
    `observedAt: ${provenance.observedAt}`,
    `publishedAt: ${String(provenance.publishedAt)}`,
    `blockedActions: ${boundary.preciselyBlockedActions.join('、')}`,
    `safeActions: ${boundary.safelyContinuableActions.join('、')}`,
  ].join('\n')
  if (body.length === 0 || body.length > F03_MAX_PRESENTATION_CHARS) return undefined
  return createUserMessage({
    content: [{ type: 'text', text: body }],
    source: {
      kind: 'plugin',
      plugin: 'ui-context-compactor:evidence-actionable',
      form: 'notice',
      summary: 'signed evidence action scope',
    },
  })
}

/** Project two exact conclusions in requirement order without exposing query or material content. */
function createMultiFactEvidenceActionableMessage(
  completion: CompletedMultiFactEvidenceActionableBoundary,
): UserMessage | undefined {
  const { boundary, c22, provenances } = completion
  const accepted = c22.kind === 'business_result' && c22.value.kind === 'accepted_for_contract'
    ? c22.value.value
    : undefined
  const items = provenances.map((provenance, index) => ({
    requirement: boundary.requiredFacts.requirements[index],
    conclusion: provenance.conclusion,
    provenance,
  }))
  const projection = projectExactTwoFactResults(
    boundary.requiredFacts.requirements,
    items.filter((item): item is {
      readonly requirement: NonNullable<typeof item.requirement>
      readonly conclusion: typeof item.conclusion
      readonly provenance: typeof item.provenance
    } => item.requirement !== undefined),
    conclusion => 'kind' in conclusion && conclusion.kind === 'direct_fact',
  )
  if (completion.kind !== 'multi'
    || completion.family !== 'actionable'
    || accepted !== boundary
    || c22.identity.contract !== 'C22'
    || c22.identity.subject !== boundary.ref
    || projection === undefined
    || projection.unresolvedFacts.length !== 0
    || projection.usableFacts.length !== 2
    || boundary.usableFacts.length !== 2
    || boundary.usableFacts[0] !== projection.conclusions[0]
    || boundary.usableFacts[1] !== projection.conclusions[1]
    || boundary.unresolvedFacts.length !== 0
    || boundary.preciselyBlockedActions.length !== 0
    || boundary.safelyContinuableActions.length === 0
    || provenances.some(provenance => provenance.url === undefined
      || provenance.observedAt === undefined
      || provenance.source !== provenance.conclusion.source
      || !('kind' in provenance.conclusion)
      || provenance.conclusion.kind !== 'direct_fact'
      || provenance.conclusion.degree !== 'established')) return undefined
  const factLines = provenances.flatMap((provenance, index) => [
    `fact[${index + 1}]: ${provenance.conclusion.fact}`,
    `meaning[${index + 1}]: ${provenance.conclusion.meaning}`,
    `source[${index + 1}]: ${provenance.source}`,
    `url[${index + 1}]: ${provenance.url}`,
    `observedAt[${index + 1}]: ${provenance.observedAt}`,
    `publishedAt[${index + 1}]: ${String(provenance.publishedAt)}`,
  ])
  const body = [
    '当前请求的已签行动事实：',
    ...factLines,
    `blockedActions: ${boundary.preciselyBlockedActions.join('、')}`,
    `safeActions: ${boundary.safelyContinuableActions.join('、')}`,
  ].join('\n')
  if (body.length === 0 || body.length > F03_MAX_PRESENTATION_CHARS) return undefined
  return createUserMessage({
    content: [{ type: 'text', text: body }],
    source: {
      kind: 'plugin',
      plugin: 'ui-context-compactor:evidence-actionable',
      form: 'notice',
      summary: 'signed multi-fact evidence action scope',
    },
  })
}

type CompletedMultiSourceEvidenceBoundary =
  | CompletedMultiSourceEvidenceActionableBoundary
  | CompletedMultiSourceEvidenceLocalRestrictionBoundary
  | CompletedMultiSourceEvidenceNoSafeActionBoundary

function sameOrderedStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

/** Render only C13-checked, owner-projected source facts; never decode conclusion meaning. */
function createMultiSourceEvidenceMessage(
  completion: CompletedMultiSourceEvidenceBoundary,
): UserMessage | undefined {
  const { boundary, c22, provenances, sourceFindings } = completion
  const accepted = c22.kind === 'business_result' && c22.value.kind === 'accepted_for_contract'
    ? c22.value.value
    : undefined
  const requirement = boundary.requiredFacts.requirements[0]
  const established = completion.resolution === 'agree' || completion.resolution === 'conditional'
  const finalConclusion = established ? boundary.usableFacts[0] : boundary.unresolvedFacts[0]
  const exactActionScope = established
    ? boundary.kind === 'actionable'
      && sameOrderedStrings(boundary.preciselyBlockedActions, [])
      && sameOrderedStrings(boundary.safelyContinuableActions, [
        F03_MULTI_SOURCE_BLOCKED_ACTION,
        F03_MULTI_SOURCE_SAFE_ACTION,
      ])
    : boundary.kind === 'local_restriction'
      && sameOrderedStrings(boundary.preciselyBlockedActions, [F03_MULTI_SOURCE_BLOCKED_ACTION])
      && sameOrderedStrings(boundary.safelyContinuableActions, [F03_MULTI_SOURCE_SAFE_ACTION])
  if (completion.kind !== 'multi_source'
    || accepted !== boundary
    || c22.identity.contract !== 'C22'
    || c22.identity.subject !== boundary.ref
    || requirement === undefined
    || boundary.requiredFacts.requirements.length !== 1
    || requirement.fact !== F03_MULTI_SOURCE_FACT
    || !sameOrderedStrings(requirement.neededFor, [F03_MULTI_SOURCE_BLOCKED_ACTION])
    || finalConclusion === undefined
    || finalConclusion.fact !== F03_MULTI_SOURCE_FACT
    || !exactActionScope
    || (established
      ? boundary.usableFacts.length !== 1
        || boundary.unresolvedFacts.length !== 0
        || !('kind' in finalConclusion)
        || finalConclusion.kind !== 'direct_fact'
        || finalConclusion.degree !== 'established'
      : boundary.usableFacts.length !== 0
        || boundary.unresolvedFacts.length !== 1
        || 'kind' in finalConclusion
        || (completion.resolution === 'conflict'
          ? finalConclusion.degree !== 'conflicting'
          : finalConclusion.degree !== 'insufficient' && finalConclusion.degree !== 'unknown'))
    || provenances.length > 2
    || sourceFindings.length > 2
    || new Set(provenances.map(provenance => provenance.source)).size !== provenances.length
    || new Set(provenances.map(provenance => provenance.url)).size !== provenances.length
    || provenances.some(provenance => provenance.conclusion !== finalConclusion
      || provenance.url === undefined
      || provenance.observedAt === undefined)
    || sourceFindings.some(finding => {
      const provenance = provenances.find(candidate => candidate.source === finding.source)
      return provenance === undefined
        || provenance.url !== finding.url
        || provenance.observedAt !== finding.observedAt
        || provenance.publishedAt !== finding.publishedAt
    })) return undefined

  if (completion.resolution !== 'source_incomplete') {
    const first = sourceFindings[0]
    const second = sourceFindings[1]
    if (provenances.length !== 2 || sourceFindings.length !== 2
      || first === undefined || second === undefined
      || (completion.resolution === 'agree'
        ? first.conclusion !== second.conclusion || first.appliesWhen !== second.appliesWhen
        : completion.resolution === 'conditional'
          ? first.appliesWhen === second.appliesWhen
          : first.conclusion === second.conclusion || first.appliesWhen !== second.appliesWhen)) return undefined
  }

  const sourceLines = provenances.flatMap(provenance => {
    const finding = sourceFindings.find(candidate => candidate.source === provenance.source)
    return [
      `source: ${provenance.source}`,
      `url: ${provenance.url}`,
      ...(finding === undefined
        ? [
            `observedAt: ${provenance.observedAt}`,
            `publishedAt: ${String(provenance.publishedAt)}`,
            'findingStatus: missing',
          ]
        : [
            `conclusion: ${finding.conclusion}`,
            `appliesWhen: ${finding.appliesWhen}`,
            `observedAt: ${finding.observedAt}`,
            `publishedAt: ${String(finding.publishedAt)}`,
            `futureUse: ${finding.futureUse}`,
          ]),
    ]
  })
  const branchLines = completion.resolution === 'agree'
    ? [`sameConclusion: ${sourceFindings[0]?.conclusion}`]
    : completion.resolution === 'conditional'
      ? ['conditionScope: 两份结论按各自 appliesWhen 并立，版本事实只在对应条件内成立']
      : completion.resolution === 'conflict'
        ? [`conflictPoint: ${sourceFindings[0]?.conclusion} ↔ ${sourceFindings[1]?.conclusion}`]
        : [
            `obtainedSources: ${provenances.length}/2`,
            `verifiedFindings: ${sourceFindings.length}/2`,
            `missingFindings: ${2 - sourceFindings.length}`,
          ]
  const body = [
    `多来源事实核对：${completion.resolution}`,
    `fact: ${F03_MULTI_SOURCE_FACT}`,
    'sourceOrder: 仅为稳定展示，不表示强弱或胜负',
    ...sourceLines,
    ...branchLines,
    `restrictedFact: ${F03_MULTI_SOURCE_FACT}`,
    `blockedActions: ${boundary.preciselyBlockedActions.join('、')}`,
    `safeActions: ${boundary.safelyContinuableActions.join('、')}`,
  ].join('\n')
  if (body.length === 0 || body.length > F03_MAX_PRESENTATION_CHARS) return undefined
  return createUserMessage({
    content: [{ type: 'text', text: body }],
    source: {
      kind: 'plugin',
      plugin: 'ui-context-compactor:multi-source-evidence',
      form: 'notice',
      summary: 'signed multi-source evidence and action scope',
    },
  })
}

async function projectCompletedMultiSourceFutureCriticalPoint(
  completion: CompletedMultiSourceEvidenceBoundary,
  semantic: BoundedAuxiliarySemanticCall,
  signal: AbortSignal,
): Promise<FutureCriticalPointProjection> {
  const first = completion.sourceFindings[0]
  const second = completion.sourceFindings[1]
  const firstProvenance = first === undefined
    ? undefined
    : completion.provenances.find(candidate => candidate.source === first.source)
  const secondProvenance = second === undefined
    ? undefined
    : completion.provenances.find(candidate => candidate.source === second.source)
  if (completion.resolution !== 'agree'
    || !Object.isFrozen(completion)
    || first === undefined
    || second === undefined
    || firstProvenance?.url === undefined
    || secondProvenance?.url === undefined
    || first.conclusion !== second.conclusion
    || first.appliesWhen !== second.appliesWhen
    || first.futureUse !== second.futureUse) {
    return await projectFutureCriticalPoints(Object.freeze([]), semantic, signal)
  }
  const material: AuthenticatedStructuredFutureCriticalMaterial = Object.freeze({
    kind: 'authenticated_structured',
    material: `${firstProvenance.url}\n${secondProvenance.url}`,
    source: `${first.source}\n${second.source}`,
    conclusion: first.conclusion,
    appliesWhen: first.appliesWhen,
    futureUse: first.futureUse,
  })
  return await projectFutureCriticalPoints(Object.freeze([material]), semantic, signal)
}

/**
 * H2 only needs the public detached suffix read.  Keep this structural port
 * private so the published plugin declaration does not acquire an undeclared
 * session-persistence peer dependency.
 */
interface SessionPersistenceReadPort {
  readFrom(sessionId: string, fromSeq: number): Promise<{ events: readonly SessionEvent[] }>
}

interface SessionsFlushPort {
  flush(session: Agent['session']): Promise<boolean>
}

type NoFocusRecoveryGate =
  | { readonly kind: 'restoring' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'closed' }

interface NoSafeActionDenialState {
  readonly family: 'no_safe_action'
  readonly evidence: 'exact_sidecar' | 'visible_expected_missing'
  readonly generation: number
  readonly canonical: {
    readonly pendingStateRef: string
    readonly canonicalStateRef: string
    readonly messageId: string
    readonly eventSeq: number
  }
}

function finalizedReplacement(
  finalizedReplaceSeq: number | undefined,
  repair: {
    readonly phase: 'repair_pending' | 'repair_finalized'
    readonly targetMessageId: string
    readonly targetReplaceSeq?: number
  } | undefined,
): { readonly seq: number; readonly messageId?: string } | undefined {
  if (repair?.phase === 'repair_finalized') {
    return repair.targetReplaceSeq === undefined ? undefined
      : { seq: repair.targetReplaceSeq, messageId: repair.targetMessageId }
  }
  return finalizedReplaceSeq === undefined ? undefined : { seq: finalizedReplaceSeq }
}

function exactNoSafeActionDenial(
  agent: Agent,
  record: unknown,
): NoSafeActionDenialState | undefined {
  const exact = parseCanonicalNoSafeActionStateRecord(record)
  const transaction = exact?.transaction
  return transaction === undefined
    ? undefined
    : exactNoSafeActionDenialFromTransaction(agent, transaction)
}

function exactNoSafeActionDenialFromTransaction(
  agent: Agent,
  transaction: CanonicalNoSafeActionTransaction,
): NoSafeActionDenialState | undefined {
  if (transaction.phase !== 'finalized'
    || !Number.isSafeInteger(transaction.generation) || transaction.generation < 1
    || transaction.material.target !== String(agent.session.id)) return undefined
  const replacement = finalizedReplacement(transaction.finalizedReplaceSeq, transaction.repair)
  if (replacement === undefined) return undefined
  const events = agent.session.events.filter(event => event.seq === replacement.seq)
  const event = events[0]
  if (events.length !== 1 || event?.type !== 'user/message'
    || replacement.messageId !== undefined && String(event.data.id) !== replacement.messageId
    || agent.session.events.filter(candidate => candidate.type === 'user/message'
      && String(candidate.data.id) === String(event.data.id)).length !== 1
    || event.data.source.kind !== 'context-manager-no-safe-action') return undefined
  const source = event.data.source
  const body = textOf(event.data)
  if (source.phase !== 'finalized'
    || source.pendingStateRef !== transaction.pendingRef
    || source.canonicalStateRef !== transaction.canonicalRef
    || source.generation !== transaction.generation
    || source.chat !== transaction.material.target
    || source.bodyHash !== transaction.bodyHash
    || JSON.stringify(source.machine) !== JSON.stringify(transaction.machine)
    || body !== transaction.body
    || createHash('sha256').update(body ?? '').digest('hex') !== transaction.bodyHash) return undefined
  return Object.freeze({
    family: 'no_safe_action',
    evidence: 'exact_sidecar',
    generation: transaction.generation,
    canonical: Object.freeze({
      pendingStateRef: transaction.pendingRef,
      canonicalStateRef: transaction.canonicalRef,
      messageId: String(event.data.id),
      eventSeq: event.seq,
    }),
  })
}

/**
 * A missing/corrupt row cannot prove recovery. It can still prove that the
 * current surface expects no-safe state strongly enough to close tool-body
 * execution: only the currently derived surface is inspected, never an
 * arbitrary historical no-safe event.
 */
function expectedMissingNoSafeActionDenial(agent: Agent): NoSafeActionDenialState | undefined {
  const visible = agent.session.deriveMessages()
  const candidates = visible.filter(message => message.role === 'user'
    && message.source.kind === 'context-manager-no-safe-action')
  const canonical = candidates[0]
  if (candidates.length !== 1 || canonical === undefined || canonical.role !== 'user'
    || canonical.source.kind !== 'context-manager-no-safe-action') return undefined
  const source = canonical.source
  const machine = source.machine
  const body = canonical.content.length === 1 && canonical.content[0]?.type === 'text'
    ? canonical.content[0].text : undefined
  const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  if (source.phase !== 'finalized'
    || !Number.isSafeInteger(source.generation) || source.generation < 1
    || source.chat !== String(agent.session.id)
    || !nonblank(source.pendingStateRef) || !nonblank(source.canonicalStateRef)
    || !nonblank(source.bodyHash) || machine?.kind !== 'no_safe_action'
    || !nonblank(machine.focusRef) || !nonblank(machine.currentMatter)
    || !nonblank(machine.boundaryRef) || !nonblank(machine.originMessageId)
    || !nonblank(machine.originHash)
    || !Array.isArray(machine.preciselyBlockedActions) || machine.preciselyBlockedActions.length === 0
    || !machine.preciselyBlockedActions.every(nonblank)
    || !Array.isArray(machine.safelyContinuableActions) || machine.safelyContinuableActions.length !== 0
    || !Array.isArray(machine.unresolvedFacts) || machine.unresolvedFacts.length === 0
    || body === undefined
    || createHash('sha256').update(body).digest('hex') !== source.bodyHash) return undefined
  const physical = agent.session.events.filter(event => event.type === 'user/message'
    && String(event.data.id) === String(canonical.id)
    && event.data.source.kind === 'context-manager-no-safe-action')
  const event = physical[0]
  if (physical.length !== 1 || event?.type !== 'user/message'
    || event.data.source.kind !== 'context-manager-no-safe-action'
    || event.data.source.phase !== source.phase
    || event.data.source.generation !== source.generation
    || event.data.source.pendingStateRef !== source.pendingStateRef
    || event.data.source.canonicalStateRef !== source.canonicalStateRef
    || event.data.source.chat !== source.chat
    || event.data.source.bodyHash !== source.bodyHash
    || JSON.stringify(event.data.source.machine) !== JSON.stringify(machine)
    || textOf(event.data) !== body) return undefined
  return Object.freeze({
    family: 'no_safe_action',
    evidence: 'visible_expected_missing',
    generation: source.generation,
    canonical: Object.freeze({
      pendingStateRef: source.pendingStateRef,
      canonicalStateRef: source.canonicalStateRef,
      messageId: String(canonical.id),
      eventSeq: event.seq,
    }),
  })
}

/** A visible canonical background without its exact row is not a fresh chat. */
function hasExpectedBackgroundWithoutTransaction(agent: Agent): boolean {
  const candidates = agent.session.deriveMessages().filter(message => message.role === 'user'
    && message.source.kind === 'context-manager-canonical'
    && message.source.machine.kind === 'background')
  const canonical = candidates[0]
  if (candidates.length !== 1 || canonical === undefined || canonical.role !== 'user'
    || canonical.source.kind !== 'context-manager-canonical') return false
  const source = canonical.source
  const machine = source.machine
  const body = canonical.content.length === 1 && canonical.content[0]?.type === 'text'
    ? canonical.content[0].text : undefined
  if (machine.kind !== 'background') return false
  if (source.phase !== 'finalized'
    || source.chat !== String(agent.session.id)
    || !Number.isSafeInteger(source.generation) || source.generation < 1
    || source.pendingStateRef.trim().length === 0 || source.canonicalStateRef.trim().length === 0
    || source.bodyHash.trim().length === 0 || machine.candidateRef.trim().length === 0
    || machine.focusRef.trim().length === 0 || machine.currentMatter.trim().length === 0
    || machine.boundaryRef.trim().length === 0 || machine.evidenceRef.trim().length === 0
    || machine.originMessageId.trim().length === 0 || machine.originHash.trim().length === 0
    || body === undefined || createHash('sha256').update(body).digest('hex') !== source.bodyHash) return false
  const physical = agent.session.events.filter(event => event.type === 'user/message'
    && String(event.data.id) === String(canonical.id))
  const event = physical[0]
  return physical.length === 1 && event?.type === 'user/message' && event.data === canonical
}

function sameNoSafeActionDenial(
  left: NoSafeActionDenialState,
  right: NoSafeActionDenialState,
): boolean {
  return left.family === right.family
    && left.generation === right.generation
    && left.canonical.pendingStateRef === right.canonical.pendingStateRef
    && left.canonical.canonicalStateRef === right.canonical.canonicalStateRef
    && left.canonical.messageId === right.canonical.messageId
    && left.canonical.eventSeq === right.canonical.eventSeq
}

function exactUniqueLocalRestrictionAfter(
  agent: Agent,
  record: unknown,
  generation: number,
): boolean {
  const exact = parseCanonicalLocalRestrictionStateRecord(record)
  const transaction = exact?.transaction
  const visible = agent.session.deriveMessages()
  const only = visible[0]
  if (transaction?.phase !== 'finalized' || transaction.generation <= generation
    || transaction.material.target !== String(agent.session.id)
    || visible.length !== 1 || only === undefined || only.role !== 'user') return false
  const replacement = finalizedReplacement(transaction.finalizedReplaceSeq, transaction.repair)
  if (replacement === undefined) return false
  const events = agent.session.events.filter(candidate => candidate.seq === replacement.seq)
  const event = events[0]
  if (events.length !== 1 || event?.type !== 'user/message' || event.data !== only
    || replacement.messageId !== undefined && String(event.data.id) !== replacement.messageId
    || agent.session.events.filter(candidate => candidate.type === 'user/message'
      && String(candidate.data.id) === String(event.data.id)).length !== 1
    || event.data.source.kind !== 'context-manager-local-restriction') return false
  const source = event.data.source
  const body = textOf(event.data)
  return source.phase === 'finalized'
    && source.pendingStateRef === transaction.pendingRef
    && source.canonicalStateRef === transaction.canonicalRef
    && source.generation === transaction.generation
    && source.chat === transaction.material.target
    && source.bodyHash === transaction.bodyHash
    && JSON.stringify(source.machine) === JSON.stringify(transaction.machine)
    && body === transaction.body
    && createHash('sha256').update(body ?? '').digest('hex') === transaction.bodyHash
}

function exactUniqueNoFocusAfter(
  agent: Agent,
  record: unknown,
  generation: number,
): boolean {
  const parsed = noFocusCanaryRecordSchema.safeParse(record)
  const transaction = parsed.success ? parsed.data.transaction : undefined
  const visible = agent.session.deriveMessages()
  const only = visible[0]
  if (transaction?.phase !== 'finalized' || transaction.generation <= generation
    || transaction.material.target !== String(agent.session.id)
    || visible.length !== 1 || only === undefined || only.role !== 'user') return false
  const replacement = finalizedReplacement(transaction.finalizedReplaceSeq, transaction.repair)
  if (replacement === undefined) return false
  const events = agent.session.events.filter(candidate => candidate.seq === replacement.seq)
  const event = events[0]
  if (events.length !== 1 || event?.type !== 'user/message' || event.data !== only
    || replacement.messageId !== undefined && String(event.data.id) !== replacement.messageId
    || agent.session.events.filter(candidate => candidate.type === 'user/message'
      && String(candidate.data.id) === String(event.data.id)).length !== 1
    || event.data.source.kind !== 'context-manager-canonical') return false
  const source = event.data.source
  const body = textOf(event.data)
  return source.phase === 'finalized'
    && source.pendingStateRef === transaction.pendingRef
    && source.canonicalStateRef === transaction.canonicalRef
    && source.generation === transaction.generation
    && source.chat === transaction.material.target
    && source.bodyHash === transaction.bodyHash
    && JSON.stringify(source.machine) === JSON.stringify(transaction.machine)
    && body === transaction.body
    && createHash('sha256').update(body ?? '').digest('hex') === transaction.bodyHash
}

function provesNewCompleteNonNoSafeState(
  agent: Agent,
  record: unknown,
  deniedGeneration: number,
): boolean {
  return exactUniqueLocalRestrictionAfter(agent, record, deniedGeneration)
    || exactUniqueNoFocusAfter(agent, record, deniedGeneration)
}

function sessionPersistencePort(ctx: Context): SessionPersistenceReadPort | undefined {
  return (ctx as unknown as {
    get(name: 'sessionPersistence'): SessionPersistenceReadPort | undefined
  }).get('sessionPersistence')
}

function sessionsFlushPort(ctx: Context): SessionsFlushPort | undefined {
  return (ctx as unknown as {
    get(name: 'sessions'): SessionsFlushPort | undefined
  }).get('sessions')
}

async function preserveClaimedInput(
  ctx: Context,
  agent: Agent,
  message: UserMessage,
): Promise<void> {
  const text = textOf(message)
  if (text === undefined || !isDirectUserSource(message.source)) throw new Error('invalid canary input')
  const expectedHash = directExpressionHash(String(message.id), text)
  const existing = agent.session.events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && String(event.data.id) === String(message.id))
  let chosen: SessionEvent<'user/message'>
  if (existing.length === 0) {
    chosen = agent.session.append('user/message', message, { surfaceOp: 'append' })
  } else if (existing.length === 1) {
    const candidate = existing[0]!
    const candidateText = textOf(candidate.data)
    if (!isDirectUserSource(candidate.data.source)
      || candidateText !== text
      || directExpressionHash(String(candidate.data.id), candidateText ?? '') !== expectedHash) {
      throw new Error('canary input existing physical evidence is not exact')
    }
    chosen = candidate
  } else {
    throw new Error('canary input physical evidence is duplicated')
  }
  const sessions = sessionsFlushPort(ctx)
  if (sessions === undefined || !await sessions.flush(agent.session)) {
    throw new Error('canary input has no persistence listener')
  }
  const persistence = sessionPersistencePort(ctx)
  if (persistence === undefined) throw new Error('canary input persistence is unavailable')
  const persisted = await persistence.readFrom(String(agent.session.id), chosen.seq)
  const liveBySeq = agent.session.events.filter(event => event.seq === chosen.seq)
  const readbacks = persisted.events.filter(event => event.seq === chosen.seq)
  const sameIdInSession = agent.session.events.filter(event => event.type === 'user/message'
    && String(event.data.id) === String(message.id))
  const sameIdInReadback = persisted.events.filter(event => event.type === 'user/message'
    && String(event.data.id) === String(message.id))
  const live = liveBySeq[0]
  const readback = readbacks[0]
  if (liveBySeq.length !== 1
    || readbacks.length !== 1
    || sameIdInSession.length !== 1
    || sameIdInReadback.length !== 1
    || live?.type !== 'user/message'
    || String(live.data.id) !== String(message.id)
    || !isDirectUserSource(live.data.source)
    || textOf(live.data) !== text
    || directExpressionHash(String(live.data.id), textOf(live.data) ?? '') !== expectedHash
    || readback?.type !== 'user/message'
    || String(readback.data.id) !== String(message.id)
    || !isDirectUserSource(readback.data.source)
    || textOf(readback.data) !== text
    || directExpressionHash(String(readback.data.id), text) !== expectedHash) {
    throw new Error('canary input did not survive detached readback')
  }
}

async function canaryFailure(ctx: Context, agent: Agent, message: UserMessage): Promise<never> {
  try {
    await preserveClaimedInput(ctx, agent, message)
  } catch {
    // The Agent error is still the only honest public result when physical
    // preservation itself could not be proved. It must not use the more
    // specific known-unavailable text below.
  }
  throw new Error('focus-canary')
}

async function knownUnavailable(
  ctx: Context,
  agent: Agent,
  message: UserMessage,
  commitPhysicalProof: () => Promise<void>,
  afterPhysicalProof?: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  try {
    await preserveClaimedInput(ctx, agent, message)
    await commitPhysicalProof()
  } catch {
    throw new Error('focus-canary')
  }
  if (afterPhysicalProof !== undefined) return await afterPhysicalProof()
  throw new Error(FOCUS_CANARY_UNAVAILABLE_TEXT)
}

/** A cold-recovery veto may speak only after the newly claimed direct input is durable. */
async function closedRecoveryInput(
  ctx: Context,
  agent: Agent,
  message: UserMessage,
  managedFailure: ManagedFailurePresenter,
): Promise<never> {
  try {
    await preserveClaimedInput(ctx, agent, message)
  } catch {
    throw new Error('focus-canary')
  }
  return managedFailure.afterPhysicallyProvedInput({ physicallyProved: true })
}

type ClosureOnlyLiveStage = 'bounded-proposal' | 'decision-and-carrier' | 'canonical-transaction'

const PROOF_ONLY_COLD_RECOVERY_MODULE = 'proof-only-cold-recovery'
type ClosureOnlyLiveErrorName = 'Error' | 'TypeError' | 'RangeError' | 'AbortError' | 'UnknownError'

function fixedClosureOnlyLiveErrorName(error: unknown): ClosureOnlyLiveErrorName {
  if (!(error instanceof Error)) return 'UnknownError'
  switch (error.name) {
    case 'Error':
    case 'TypeError':
    case 'RangeError':
    case 'AbortError':
      return error.name
    default:
      return 'UnknownError'
  }
}

/** Fixed-code diagnostic only: never log the caught value, request, record, or user text. */
function warnClosureOnlyLiveFailure(ctx: Context, stage: ClosureOnlyLiveStage, error: unknown): void {
  ctx.logger.warn(
    `ui-context-compactor: closure-only-live failure module=closure-only-live stage=${stage} error=${fixedClosureOnlyLiveErrorName(error)}`,
  )
}

/** Fixed-code failure only: never log the caught value, record, or user text. */
function warnProofOnlyColdRecoveryPutFailure(ctx: Context, error: unknown): void {
  ctx.logger.warn(
    `module=${PROOF_ONLY_COLD_RECOVERY_MODULE} stage=put-fail error=${fixedClosureOnlyLiveErrorName(error)}`,
  )
}

/** Preserve every actually inserted direct claim in an unsupported managed batch. */
async function rejectManagedBatch(
  ctx: Context,
  agent: Agent,
  messages: readonly UserMessage[],
  inserted: Map<string, Set<string>>,
): Promise<never> {
  const sessionId = String(agent.session.id)
  const claims = inserted.get(sessionId)
  const preserved = new Set<string>()
  for (const message of messages) {
    const id = String(message.id)
    if (!isDirectUserSource(message.source) || preserved.has(id) || !claims?.delete(id)) continue
    preserved.add(id)
    try {
      await preserveClaimedInput(ctx, agent, message)
    } catch {
      // Keep working through the claimed batch so every independently
      // appendable direct input receives the same preservation attempt.
    }
  }
  if (claims?.size === 0) inserted.delete(sessionId)
  throw new Error('focus-canary')
}

function isCanaryFailure(error: unknown): boolean {
  return error instanceof Error && error.message === 'focus-canary'
}

function installFocusCanary(
  ctx: Context,
  config: EnforcedFocusCanaryConfig,
  classifier: ManagedInteractiveRootClassifier,
  domain: FocusCanaryDomain,
  tokenMeter: TokenMeter,
  evidenceWeb: Context['web'] | undefined,
): ManagedCompactRequest {
  const auxiliary = new BoundedAuxiliarySemanticCall(ctx.llm, tokenMeter, config.auxiliary)
  const managedFailure = new ManagedFailurePresenter()
  const candidateAdvice = new UserInteractionAdvice()
  type EstablishedFocus = Extract<FocusDecision, { readonly kind: 'focus_established' }>
  type CandidateTerminal =
    | { readonly kind: 'issue'; readonly text: string; readonly reason?: 'basis_incomplete' }
    | { readonly kind: 'failed' }
  const candidateTerminals = new Map<string, CandidateTerminal>()
  const candidateRuntimeEvidence = new Map<string, ExplicitBackgroundUpdateRuntimeEvidence>()
  const candidateFocusBasis = new Map<string, EstablishedFocus>()
  const candidateActionBasis = new Map<string, ActionFactBoundary>()
  const candidateEvidenceBasis = new Map<string, EvidenceConclusionSet>()
  const candidateFutureCriticalPoints = new Map<string, FutureCriticalPointProjection>()
  const postCanonicalBasisDirects = new Map<string, Set<string>>()
  const postCanonicalNonBasisUpdates = new Map<string, {
    readonly generation: number
    readonly directIds: Set<string>
  }>()
  // One installed plugin context owns all state authorities. Background state
  // keeps the qualification owner private and returns only input/apply ports.
  const focusAuthority = FocusAuthority.createOwner()
  const recoveryPreservation = new EffectiveStatePreservation(focusAuthority)
  const recoveryCanonicalAuthority = new CanonicalContextAuthority()
  const stateTransaction = new CanonicalStateTransaction(recoveryPreservation, recoveryCanonicalAuthority)
  const actionComposition = ActionFactBoundaryAuthority.createComposition({
    preservation: recoveryPreservation,
    canonicalContext: recoveryCanonicalAuthority,
    userInteraction: new ActionFactUserInteractionAdvice(),
  }, evidenceWeb === undefined ? undefined : {
    web: Object.freeze({
      search: (request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> =>
        evidenceWeb.search(request, signal),
    }),
    semantic: auxiliary,
  })
  let rollingCandidate: RollingCandidateAdapter | undefined
  const background = createBackgroundStateComposition({
    userAdvice: Object.freeze({
      acceptCandidateQualificationIssue<Ref extends CandidateRef>(
        issue: CandidateQualificationIssue<Ref>,
      ) {
        const report = candidateAdvice.acceptCandidateQualificationIssue(issue)
        if (report.kind !== 'business_result') {
          const chat = issue.subject.kind === 'candidate'
            ? issue.subject.candidate.target : issue.subject.chat
          candidateTerminals.set(chat, { kind: 'failed' })
          return report
        }
        const presentation = candidateAdvice.presentCandidateQualificationIssue(report)
        const chat = issue.subject.kind === 'candidate'
          ? issue.subject.candidate.target : issue.subject.chat
        candidateTerminals.set(chat, presentation === undefined
          ? { kind: 'failed' }
          : Object.freeze({
              kind: 'issue',
              text: presentation,
              ...issue.kind === 'currently_unprovable'
                && issue.subject.kind === 'no_candidate'
                && issue.missingOrUncertain.length === 1
                && issue.missingOrUncertain[0] === 'basis_incomplete'
                ? { reason: 'basis_incomplete' as const }
                : {},
            }))
        return report
      },
    }),
    focusOwner: focusAuthority,
    actionOwner: actionComposition.authority,
    transaction: stateTransaction,
    qualifiedCandidateObserver: Object.freeze({
      acceptOwnerQualifiedCandidate<Ref extends CandidateRef>(
        decision: Extract<CandidateQualificationDecision<Ref>, { readonly kind: 'qualified' }>,
        c28: C28Result<Ref>,
      ) {
        rollingCandidate?.acceptOwnerQualifiedCandidate(decision, c28)
      },
    }),
  })
  const qualification = background.qualification
  const contentReviewer = new CandidateContentReviewer({ qualification })
  const freshnessReviewer = new CandidateBasisFreshnessReviewer({ qualification })
  const formation = new BackgroundCandidateFormation({
    contentReview: contentReviewer,
    freshnessReview: freshnessReviewer,
    qualification,
    runtimeEvidence: Object.freeze({
      takeExplicitUpdateEvidence(chat: ChatRef) {
        const evidence = candidateRuntimeEvidence.get(chat)
        candidateRuntimeEvidence.delete(chat)
        return evidence
      },
    }),
  })
  const qualifiedBackground = createQualifiedBackgroundAdapter({
    formation,
    state: background.state,
  })
  rollingCandidate = createRollingCandidateAdapter({
    current: qualifiedBackground.current,
    formation,
  })
  if (!bindCandidateAdviceReceivers(candidateAdvice, { formation })) {
    throw new Error('ui-context-compactor: candidate advice binding failed')
  }
  if (!bindEstablishedFocusCandidateReceivers(focusAuthority, {
    contentReview: contentReviewer,
    freshnessReview: freshnessReviewer,
    formation: Object.freeze({
      acceptFocusBasis(focus: FocusDecision) {
        const report = formation.acceptFocusBasis(focus)
        if (report.kind === 'business_result' && focus.kind === 'focus_established') {
          candidateFocusBasis.set(focus.chat, focus)
        }
        return report
      },
    }),
  })) throw new Error('ui-context-compactor: candidate focus binding failed')
  const noFocusHarness = new NoFocusHarness(stateTransaction)
  const noFocusRecovery = new NoFocusRecovery({
    preservation: recoveryPreservation,
    focusAuthority,
    canonicalAuthority: recoveryCanonicalAuthority,
  })
  if (!bindActionBoundaryCandidateReceivers(actionComposition.authority, {
    contentReview: contentReviewer,
    freshnessReview: freshnessReviewer,
    formation: Object.freeze({
      acceptActionFactBoundary(boundary: ActionFactBoundary) {
        const report = formation.acceptActionFactBoundary(boundary)
        if (report.kind === 'business_result') {
          candidateActionBasis.set(boundary.chat, boundary)
          rollingCandidate?.acceptActionFactBoundary(boundary)
        }
        return report
      },
    }),
  })) throw new Error('ui-context-compactor: candidate action binding failed')
  if (evidenceWeb !== undefined && !actionComposition.bindEvidenceConclusionCandidateReceivers({
    formation: Object.freeze({
      acceptEvidenceConclusions(conclusions: EvidenceConclusionSet) {
        const report = formation.acceptEvidenceConclusions(conclusions)
        if (report.kind === 'business_result') {
          candidateEvidenceBasis.set(conclusions.chat, conclusions)
          rollingCandidate?.acceptEvidenceConclusions(conclusions)
        }
        return report
      },
    }),
    contentReview: contentReviewer,
    freshnessReview: freshnessReviewer,
  })) throw new Error('ui-context-compactor: candidate evidence binding failed')
  const localRestriction = new LocalRestrictionAdapter({
    focus: focusAuthority,
    actionBoundaryOwner: actionComposition.authority,
    completeActionBoundary: actionComposition.completeLocalRestrictionBoundary,
    stateTransaction,
  })
  const localLive = localRestriction.createFullLivePort()
  const localRepair = stateTransaction.createLocalRestrictionRepairPort()
  const localRecovery = localRestriction.createRecoveryPort()
  const noSafeAction = new NoSafeActionAdapter({
    focus: focusAuthority,
    actionBoundaryOwner: actionComposition.authority,
    completeActionBoundary: actionComposition.completeActionFactBoundary,
    stateTransaction,
  })
  const noSafeLive = noSafeAction.createFullLivePort()
  const noSafeRepair = noSafeAction.createRepairPort()
  const noSafeRecovery = noSafeAction.createRecoveryPort()
  const inserted = new Map<string, Set<string>>()
  const insertedMessages = new WeakMap<Agent, Map<string, UserMessage>>()
  const claimedNoFocusMessages = new WeakMap<Agent, Map<string, UserMessage>>()
  const claimedDirects = new WeakMap<Agent, Map<string, ClaimedStructuredDirect>>()
  const recoveryGates = new WeakMap<Agent, { kind: NoFocusRecoveryGate['kind'] }>()
  const noSafeDenials = new WeakMap<Agent, NoSafeActionDenialState>()
  const releaseClaimTracking = (agent: Agent, messageId: string): void => {
    const exact = insertedMessages.get(agent)
    exact?.delete(messageId)
    if (exact?.size === 0) insertedMessages.delete(agent)
    const admitted = claimedDirects.get(agent)
    admitted?.delete(messageId)
    if (admitted?.size === 0) claimedDirects.delete(agent)
    const noFocus = claimedNoFocusMessages.get(agent)
    noFocus?.delete(messageId)
    if (noFocus?.size === 0) claimedNoFocusMessages.delete(agent)
  }
  const finishClaimTracking = (agent: Agent, messageId: string): void => {
    const sessionId = String(agent.session.id)
    const ids = inserted.get(sessionId)
    ids?.delete(messageId)
    if (ids?.size === 0) inserted.delete(sessionId)
    releaseClaimTracking(agent, messageId)
  }
  const fingerprint = (value: string): string =>
    createHash('sha256').update(value).digest('hex')
  const withoutChat = <Value extends { readonly chat: ChatRef }>(value: Value): Omit<Value, 'chat'> => {
    const { chat: _chat, ...rest } = value
    return Object.freeze(structuredClone(rest))
  }
  const buildCandidateRuntimeEvidence = async (
    agent: Agent,
    message: UserMessage,
    boundaryMessages: readonly Message[],
    signal: AbortSignal,
    exactText?: '请更新当前背景',
  ): Promise<(RollingCandidateRuntimeEvidence & { readonly text: string }) | undefined> => {
    const chat = String(agent.session.id) as ChatRef
    const text = textOf(message)
    const messageId = String(message.id)
    const originHash = text === undefined ? undefined : directExpressionHash(messageId, text)
    const matchingBoundaryMessages = boundaryMessages.filter(candidate => String(candidate.id) === messageId)
    if (text === undefined
      || exactText !== undefined && text !== exactText
      || originHash === undefined
      || matchingBoundaryMessages.length !== 1
      || matchingBoundaryMessages[0] !== message
      || insertedMessages.get(agent)?.get(messageId) !== message
      || agent.session.events.some(event => event.type === 'user/message'
        && String(event.data.id) === messageId)) return undefined
    const focus = candidateFocusBasis.get(chat)
    const action = candidateActionBasis.get(chat)
    const evidence = candidateEvidenceBasis.get(chat)
    const currentHeader = agent.session.requestHeader()
    const currentContext = agent.session.requestContext()
    const margin = config.safeUpdateMarginTokens
    if (focus === undefined || action === undefined || evidence === undefined
      || focus.chat !== chat || action.chat !== chat || evidence.chat !== chat
      || currentHeader === undefined || currentContext === undefined
      || !Number.isSafeInteger(margin) || (margin ?? 0) <= 0) return undefined
    try {
      const firstAssemblyValue = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
      const secondAssemblyValue = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
      signal.throwIfAborted()
      const firstAssemblyBytes = JSON.stringify(firstAssemblyValue)
      const secondAssemblyBytes = JSON.stringify(secondAssemblyValue)
      if (firstAssemblyBytes !== secondAssemblyBytes) return undefined
      const firstPrepared = await ctx.llm.prepareCall(currentHeader.config, signal)
      const secondPrepared = await ctx.llm.prepareCall(currentHeader.config, signal)
      signal.throwIfAborted()
      const firstPreparedBytes = JSON.stringify({
        config: firstPrepared.config,
        context: firstPrepared.context,
        adapterDefaults: firstPrepared.adapterDefaults,
        inputModalities: firstPrepared.inputModalities,
      })
      const secondPreparedBytes = JSON.stringify({
        config: secondPrepared.config,
        context: secondPrepared.context,
        adapterDefaults: secondPrepared.adapterDefaults,
        inputModalities: secondPrepared.inputModalities,
      })
      if (firstPreparedBytes !== secondPreparedBytes) return undefined
      const system = renderPrompt(firstAssemblyValue)
      const effectiveHeader = canonicalHeader({
        config: firstPrepared.config,
        ...firstPrepared.adapterDefaults.reasoningEffort === true
          || firstPrepared.adapterDefaults.maxTokens === true
          ? { adapterDefaults: firstPrepared.adapterDefaults }
          : {},
        ...system.length === 0 ? {} : { system },
        ...firstAssemblyValue.tools.length === 0 ? {} : { tools: firstAssemblyValue.tools },
      })
      const headerBytes = JSON.stringify(effectiveHeader)
      if (headerBytes !== JSON.stringify(canonicalHeader(currentHeader))) return undefined
      const contextWindow = firstPrepared.context?.contextWindow
      const outputTokens = firstPrepared.config.maxTokens
      if (!Number.isSafeInteger(contextWindow) || (contextWindow ?? 0) <= 0
        || !Number.isSafeInteger(outputTokens) || (outputTokens ?? 0) < 0
        || currentContext.provider !== firstPrepared.config.provider
        || currentContext.model !== firstPrepared.config.model
        || currentContext.contextWindow !== contextWindow) return undefined
      const firstMeasurement = tokenMeter.measure(agent.session, effectiveHeader)
      const secondMeasurement = tokenMeter.measure(agent.session, effectiveHeader)
      const boundaryTokens = boundaryMessages.map(candidate => tokenMeter.estimateMessage(candidate))
      if (firstMeasurement.logRevision !== secondMeasurement.logRevision
        || firstMeasurement.totalTokens !== secondMeasurement.totalTokens
        || boundaryTokens.some(value => !Number.isSafeInteger(value) || value < 0)) return undefined
      const baseInputTokens = firstMeasurement.totalTokens
        + boundaryTokens.reduce((total, value) => total + value, 0)
      if (!Number.isSafeInteger(baseInputTokens) || baseInputTokens < 0) return undefined
      const futureCriticalPoints = candidateFutureCriticalPoints.get(chat)
      const body = renderCandidateBackground({
        target: chat,
        focus: withoutChat(focus),
        action: withoutChat(action),
        evidence: withoutChat(evidence),
        knownFutureCriticalPoints: futureCriticalPoints?.kind === 'projected'
          ? futureCriticalPoints.points
          : Object.freeze([]),
      })
      const bodyTokens = tokenMeter.estimateMessage(createUserMessage({
        content: [{ type: 'text', text: body }],
        source: {
          kind: 'plugin', plugin: 'ui-context-compactor:candidate-budget',
          form: 'notice', summary: 'candidate budget body',
        },
      }))
      if (!Number.isSafeInteger(bodyTokens) || bodyTokens <= 0) return undefined
      const headerFingerprint = fingerprint(headerBytes)
      const contextFingerprint = fingerprint(JSON.stringify({
        requestContext: currentContext,
        runtimeContexts: firstAssemblyValue.contexts,
        boundaryMessages,
      }))
      const assemblyFingerprint = fingerprint(JSON.stringify({
        assembly: firstAssemblyBytes,
        headerFingerprint,
        contextFingerprint,
        revision: firstMeasurement.logRevision,
        direct: { messageId, hash: originHash, text, chat },
        baseInputTokens,
      }))
      const assemblyValues = {
        fingerprint: assemblyFingerprint,
        provider: firstPrepared.config.provider,
        model: firstPrepared.config.model,
        headerFingerprint,
        contextFingerprint,
        revision: firstMeasurement.logRevision,
        directMessageId: messageId,
        directHash: originHash,
        directText: text,
        directChat: chat,
        baseInputTokens,
      }
      const firstAssembly: CandidateAssemblySnapshot = Object.freeze({ ...assemblyValues })
      const secondAssembly: CandidateAssemblySnapshot = Object.freeze({ ...assemblyValues })
      const preparationValues = {
        fingerprint: fingerprint(firstPreparedBytes),
        provider: firstPrepared.config.provider,
        model: firstPrepared.config.model,
        contextWindow: contextWindow!,
        outputTokens: outputTokens!,
      }
      const firstPreparation: CandidatePreparationSnapshot = Object.freeze({ ...preparationValues })
      const secondPreparation: CandidatePreparationSnapshot = Object.freeze({ ...preparationValues })
      const budget: FixedH1CandidateBudgetProof = Object.freeze({
        kind: 'fixed_h1_known_envelope',
        firstAssembly,
        secondAssembly,
        firstPreparation,
        secondPreparation,
        bodyHash: fingerprint(body),
        bodyTokens,
        safeUpdateMarginTokens: margin!,
      })
      return Object.freeze({
        chat,
        text,
        origin: Object.freeze({ messageId, hash: originHash }),
        budget,
        ...futureCriticalPoints === undefined ? {} : { futureCriticalPoints },
      })
    } catch {
      return undefined
    }
  }
  const publishCandidateResult = async (
    agent: Agent,
    text: string,
  ): Promise<void> => {
    const notice = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin', plugin: 'ui-context-compactor:candidate-qualification',
        form: 'notice', summary: 'candidate qualification result',
      },
    })
    const appended = agent.session.append('user/message', notice, { surfaceOp: 'append' })
    const sessions = sessionsFlushPort(ctx)
    const persistence = sessionPersistencePort(ctx)
    if (sessions === undefined || persistence === undefined || !await sessions.flush(agent.session)) {
      throw new Error('candidate qualification publication is not durable')
    }
    const detached = await persistence.readFrom(String(agent.session.id), appended.seq)
    const exact = detached.events.filter(event => event.seq === appended.seq)
    if (exact.length !== 1 || exact[0]?.type !== 'user/message'
      || String(exact[0].data.id) !== String(notice.id)
      || textOf(exact[0].data) !== text
      || exact[0].data.source.kind !== 'plugin'
      || exact[0].data.source.plugin !== 'ui-context-compactor:candidate-qualification') {
      throw new Error('candidate qualification publication readback is not exact')
    }
  }
  const runEvidenceTracer = async (
    agent: Agent,
    message: UserMessage,
    signal: AbortSignal,
    claimedDirect: ClaimedStructuredDirect | undefined,
  ): Promise<PreStepDecision> => {
    const sessionId = String(agent.session.id)
    const failClosed = async (): Promise<never> =>
      await closedRecoveryInput(ctx, agent, message, managedFailure)
    try {
      if (evidenceWeb === undefined) throw new Error('evidence canary web service is unavailable')
      const text = textOf(message)
      const origin = text === undefined ? undefined : {
        messageId: String(message.id), hash: directExpressionHash(String(message.id), text),
      }
      const table = domain.table('focus_precanonical')
      const stored = table.get(sessionId)
      const parsedFocus = focusCanaryRecordSchema.safeParse(stored)
      const parsedBackground = stored !== undefined && isBackgroundStateRecord(stored)
        ? parseCanonicalBackgroundStateRecord(stored)
        : undefined
      const currentBackground = parsedBackground?.transaction?.phase === 'finalized'
        ? parsedBackground.transaction
        : undefined
      if (!isF03EvidenceDirect(text) || origin === undefined
        || !parsedFocus.success && currentBackground === undefined
        || claimedDirect === undefined
        || claimedDirect.origin.messageId !== origin.messageId
        || claimedDirect.origin.hash !== origin.hash
        || claimedDirect.admission.session !== agent.session
        || claimedDirect.admission.target !== sessionId
        || agent.session.events.some(event => event.type === 'user/message'
          && String(event.data.id) === origin.messageId)) {
        throw new Error('evidence precommit admission is not exact')
      }
      const established = (() => {
        if (parsedFocus.success) {
          const existing = parsedFocus.data
          const original = originalFromSession(agent, existing)
          const originalText = original === undefined ? undefined : textOf(original)
          if (originalText === undefined
            || directExpressionHash(existing.original.messageId, originalText) !== existing.original.hash) return undefined
          const storedOrigin = { messageId: existing.original.messageId, hash: existing.original.hash }
          const restored = focusAuthority.fromBoundProposal({
            kind: 'proposal', origin: storedOrigin,
            value: { kind: 'focus', relation: 'new', subject: existing.proposal.subject, origin: storedOrigin },
          }).decideFocus(createExplicitUserExpression(originalText, sessionId as ChatRef, storedOrigin))
          const decision = restored.kind === 'business_result' ? restored.value : undefined
          return decision?.kind === 'focus_established' && sameFocus(decision, existing.decision)
            ? decision : undefined
        }
        const current = candidateFocusBasis.get(sessionId)
        const canonicalFocus = currentBackground?.material.canonicalState.focus
        return current !== undefined && canonicalFocus?.kind === 'focus_established'
          && current.chat === sessionId
          && current.ref === canonicalFocus.ref
          && current.currentMatter === canonicalFocus.currentMatter
          && current.latestCorrections === canonicalFocus.latestCorrections
          ? current : undefined
      })()
      if (established === undefined) throw new Error('evidence precommit focus restoration is not exact')
      if (currentBackground !== undefined
        && rollingCandidate?.acceptCurrent(sessionId as ChatRef, stored) !== true) {
        throw new Error('rolling candidate has no exact current C41 state')
      }
      const request = createBoundedActionFactNeedProposalRequest(
        createExplicitUserExpression(text, sessionId as ChatRef, origin), origin, established,
      )
      if (request === undefined) throw new Error('evidence bounded request was not formed')
      const outcome = await auxiliary.proposeActionFacts(request, signal)
      const proposal = localRestriction.formActionBoundaryProposal(established, outcome, claimedDirect)
      if (proposal === undefined) throw new Error('evidence bounded proposal was not established')
      const completion = await actionComposition.completeEvidenceActionFactBoundary.accept(
        established, proposal, signal,
      )
      if (signal.aborted) return await failClosed()
      if (completion === undefined) throw new Error('evidence action boundary was not completed')
      const isMultiSourceDirect = text === F03_EXACT_MULTI_SOURCE_DIRECT
      const hasMultiSourceProjection = 'sourceFindings' in completion
      if (isMultiSourceDirect !== hasMultiSourceProjection) {
        throw new Error('evidence multi-source completion did not match its direct origin')
      }
      const multiSourceProjection = isMultiSourceDirect && hasMultiSourceProjection
        ? createMultiSourceEvidenceMessage(completion)
        : undefined
      if (isMultiSourceDirect && multiSourceProjection === undefined) {
        throw new Error('evidence multi-source presentation was not exact')
      }
      if (isMultiSourceDirect && hasMultiSourceProjection) {
        const futureCriticalPoints = await projectCompletedMultiSourceFutureCriticalPoint(
          completion,
          auxiliary,
          signal,
        )
        if (signal.aborted) return await failClosed()
        candidateFutureCriticalPoints.set(sessionId, futureCriticalPoints)
      }

      if (completion.family === 'actionable') {
        const projection = multiSourceProjection
          ?? ('provenances' in completion
            ? createMultiFactEvidenceActionableMessage(completion)
            : createEvidenceActionableMessage(completion))
        if (projection === undefined) throw new Error('evidence actionable presentation was not exact')
        if (signal.aborted) return await failClosed()
        if (currentBackground !== undefined) {
          const runtimeEvidence = await buildCandidateRuntimeEvidence(
            agent, message, [message, projection], signal,
          )
          if (runtimeEvidence === undefined || rollingCandidate === undefined
            || !rollingCandidate.requestRollingCandidate({
              chat: sessionId as ChatRef,
              generation: currentBackground.generation,
              runtimeEvidence,
            })) {
            throw new Error('rolling candidate formation did not receive exact C41/C14/C15 evidence')
          }
          const terminal = candidateTerminals.get(sessionId)
          candidateTerminals.delete(sessionId)
          if (terminal?.kind === 'failed') {
            throw new Error('rolling candidate qualification did not close exactly')
          }
          if (terminal?.kind === 'issue') {
            await preserveClaimedInput(ctx, agent, message)
            await publishCandidateResult(agent, terminal.text)
            return { kind: 'enter', messages: [] }
          }
          const rolling = rollingCandidate.takeQualification(sessionId as ChatRef)
          if (rolling === undefined) throw new Error('rolling candidate has no owner-qualified C28 outcome')
          if (rolling.kind === 'identical') {
            if (!background.state.discardObservedQualification(sessionId, rolling.decision, rolling.c28)) {
              throw new Error('identical qualified candidate is not the retained owner C28')
            }
          } else {
            const sessions = sessionsFlushPort(ctx)
            const persistence = sessionPersistencePort(ctx)
            if (sessions === undefined || persistence === undefined || signal.aborted) {
              throw new Error('rolling candidate has no exact live transaction inputs')
            }
            const currentHeader = agent.session.requestHeader()
            if (currentHeader === undefined
              || tokenMeter.measure(agent.session, currentHeader).logRevision
                !== runtimeEvidence.budget.firstAssembly.revision) {
              throw new Error('rolling background writer revision changed after formation')
            }
            const committed = await qualifiedBackground.apply.apply({
              sessionId,
              session: agent.session,
              record: currentBackground === undefined ? { family: 'background' } : stored as BackgroundStateRecord,
              focus: established,
              boundary: candidateActionBasis.get(sessionId) ?? completion.boundary,
              origin: runtimeEvidence.origin,
              save: async value => {
                const exact = backgroundStateRecordSchema.safeParse(value)
                if (!exact.success) throw new Error('rolling background live sidecar record failed exact schema validation')
                await table.put(sessionId, exact.data)
              },
              flush: async () => await sessions.flush(agent.session),
              readFrom: async fromSeq => await persistence.readFrom(sessionId, fromSeq),
            })
            const visible = agent.session.deriveMessages()
            const canonical = visible[0]
            if (committed.record.phase !== 'finalized'
              || committed.record.generation !== currentBackground.generation + 1
              || visible.length !== 1 || canonical === undefined
              || canonical.source.kind !== 'context-manager-canonical'
              || canonical.source.machine.kind !== 'background') {
              throw new Error('rolling background finalized publication is not uniquely visible')
            }
          }
          const directIds = postCanonicalBasisDirects.get(sessionId) ?? new Set<string>()
          directIds.add(origin.messageId)
          postCanonicalBasisDirects.set(sessionId, directIds)
        }
        // A rolling C28 either installed the new canonical state or proved its
        // exact identity.  In both cases this admitted direct is the sole
        // post-canonical request input; its evidence projection is already in
        // the qualified background and must not be duplicated in the request.
        return currentBackground === undefined
          ? { kind: 'enter', messages: [message, projection] }
          : { kind: 'enter', messages: [message] }
      }

      const sessions = sessionsFlushPort(ctx)
      const persistence = sessionPersistencePort(ctx)
      if (sessions === undefined || persistence === undefined) {
        throw new Error('evidence fixed-family transaction has no physical proof ports')
      }
      if (completion.family === 'local_restriction') {
        if (signal.aborted) return await failClosed()
        const committed = await localLive.commit({
          sessionId, session: agent.session, record: { family: 'local_restriction' },
          focus: established, completion,
          save: async value => {
            const exact = localRestrictionStateRecordSchema.safeParse(value)
            if (!exact.success) throw new Error('evidence local sidecar record failed exact schema validation')
            await table.put(sessionId, exact.data)
          },
          flush: async () => await sessions.flush(agent.session),
          readFrom: async fromSeq => await persistence.readFrom(sessionId, fromSeq),
        })
        if (signal.aborted) return await failClosed()
        const visible = agent.session.deriveMessages()
        const canonical = visible[0]
        if (committed === undefined || committed.finalized.record.family !== 'local_restriction'
          || visible.length !== 1 || canonical === undefined || canonical.role !== 'user'
          || canonical.source.kind !== 'context-manager-local-restriction'
          || canonical.source.machine.kind !== 'local_restriction') {
          throw new Error('evidence local finalized publication is not exact')
        }
        if (signal.aborted) return await failClosed()
        return multiSourceProjection === undefined
          ? { kind: 'enter', messages: [message] }
          : { kind: 'enter', messages: [message, multiSourceProjection] }
      }

      if (signal.aborted) return await failClosed()
      const committed = await noSafeLive.commit({
        sessionId, session: agent.session, record: { family: 'no_safe_action' },
        focus: established, completion,
        save: async value => {
          const exact = noSafeActionStateRecordSchema.safeParse(value)
          if (!exact.success) throw new Error('evidence no-safe sidecar record failed exact schema validation')
          await table.put(sessionId, exact.data)
        },
        flush: async () => await sessions.flush(agent.session),
        readFrom: async fromSeq => await persistence.readFrom(sessionId, fromSeq),
      })
      if (signal.aborted) return await failClosed()
      const visible = agent.session.deriveMessages()
      const canonical = visible[0]
      if (committed === undefined || committed.finalized.record.family !== 'no_safe_action'
        || visible.length !== 1 || canonical === undefined || canonical.role !== 'user'
        || canonical.source.kind !== 'context-manager-no-safe-action'
        || canonical.source.machine.kind !== 'no_safe_action') {
        throw new Error('evidence no-safe finalized publication is not exact')
      }
      const denial = exactNoSafeActionDenialFromTransaction(agent, committed.finalized.record)
      if (denial === undefined) throw new Error('evidence no-safe finalized denial state was not established')
      noSafeDenials.set(agent, denial)
      if (signal.aborted) return await failClosed()
      return multiSourceProjection === undefined
        ? { kind: 'enter', messages: [message, committed.notice] }
        : { kind: 'enter', messages: [message, multiSourceProjection] }
    } catch (error) {
      if (isManagedFailure(error)) throw error
      return await failClosed()
    }
  }
  const runLocalRestrictionTracer = async (
    agent: Agent,
    message: UserMessage,
    signal: AbortSignal,
    claimedDirect: ClaimedStructuredDirect | undefined,
  ): Promise<PreStepDecision> => {
    const sessionId = String(agent.session.id)
    const text = textOf(message)
    const failLocal = async (): Promise<never> =>
      await closedRecoveryInput(ctx, agent, message, managedFailure)
    const origin = text === undefined ? undefined : {
      messageId: String(message.id),
      hash: directExpressionHash(String(message.id), text),
    }
    const table = domain.table('focus_precanonical')
    const parsed = focusCanaryRecordSchema.safeParse(table.get(sessionId))
    if (text !== LOCAL_RESTRICTION_TRACER_EXPRESSION || origin === undefined || !parsed.success
      || claimedDirect === undefined
      || claimedDirect.origin.messageId !== origin.messageId
      || claimedDirect.origin.hash !== origin.hash
      || claimedDirect.admission.session !== agent.session
      || claimedDirect.admission.target !== sessionId
      || agent.session.events.some(event => event.type === 'user/message'
        && String(event.data.id) === origin.messageId)) {
      return await failLocal()
    }
    const existing = parsed.data
    const original = originalFromSession(agent, existing)
    const originalText = original === undefined ? undefined : textOf(original)
    if (originalText === undefined
      || directExpressionHash(existing.original.messageId, originalText) !== existing.original.hash) {
      return await failLocal()
    }
    const storedOrigin = { messageId: existing.original.messageId, hash: existing.original.hash }
    const restored = focusAuthority.fromBoundProposal({
      kind: 'proposal', origin: storedOrigin,
      value: { kind: 'focus', relation: 'new', subject: existing.proposal.subject, origin: storedOrigin },
    }).decideFocus(createExplicitUserExpression(originalText, sessionId as ChatRef, storedOrigin))
    const established = restored.kind === 'business_result' ? restored.value : undefined
    if (established?.kind !== 'focus_established' || !sameFocus(established, existing.decision)) {
      return await failLocal()
    }
    const request = createBoundedActionFactNeedProposalRequest(
      createExplicitUserExpression(text, sessionId as ChatRef, origin),
      origin,
      established,
    )
    if (request === undefined) return await failLocal()
    const outcome = await auxiliary.proposeActionFacts(request, signal)
    const proposal = localRestriction.formActionBoundaryProposal(established, outcome, claimedDirect)
    if (proposal === undefined) return await failLocal()
    let committed: Awaited<ReturnType<typeof localLive.commit>>
    try {
      committed = await localLive.commit({
        sessionId, session: agent.session, record: { family: 'local_restriction' },
        focus: established, proposal,
        save: async value => {
          const exact = localRestrictionStateRecordSchema.safeParse(value)
          if (!exact.success) throw new Error('local live sidecar record failed exact schema validation')
          await table.put(sessionId, exact.data)
        },
        flush: async () => {
          const sessions = sessionsFlushPort(ctx)
          if (sessions === undefined) throw new Error('local live transaction has no persistence listener')
          return await sessions.flush(agent.session)
        },
        readFrom: async fromSeq => {
          const persistence = sessionPersistencePort(ctx)
          if (persistence === undefined) throw new Error('local live transaction persistence is unavailable')
          return await persistence.readFrom(sessionId, fromSeq)
        },
      })
    } catch {
      return await failLocal()
    }
    const visible = agent.session.deriveMessages()
    const canonical = visible[0]
    if (committed === undefined || committed.finalized.record.family !== 'local_restriction'
      || visible.length !== 1 || canonical === undefined || canonical.role !== 'user'
      || canonical.source.kind !== 'context-manager-local-restriction'
      || canonical.source.machine.kind !== 'local_restriction') {
      return await failLocal()
    }
    // The replace already installed the unique canonical message. AgentLoop
    // appends this exact claimed direct once after this decision returns.
    return { kind: 'enter', messages: [message] }
  }

  const runNoSafeActionTracer = async (
    agent: Agent,
    message: UserMessage,
    signal: AbortSignal,
    claimedDirect: ClaimedStructuredDirect | undefined,
  ): Promise<PreStepDecision> => {
    const sessionId = String(agent.session.id)
    const failClosed = async (): Promise<never> =>
      await closedRecoveryInput(ctx, agent, message, managedFailure)
    try {
      const text = textOf(message)
      const sessions = sessionsFlushPort(ctx)
      const persistence = sessionPersistencePort(ctx)
      const origin = text === undefined ? undefined : {
        messageId: String(message.id), hash: directExpressionHash(String(message.id), text),
      }
      const table = domain.table('focus_precanonical')
      const parsed = focusCanaryRecordSchema.safeParse(table.get(sessionId))
      if (text !== NO_SAFE_ACTION_TRACER_EXPRESSION || origin === undefined || !parsed.success
        || sessions === undefined || persistence === undefined || claimedDirect === undefined
        || claimedDirect.origin.messageId !== origin.messageId || claimedDirect.origin.hash !== origin.hash
        || claimedDirect.admission.session !== agent.session || claimedDirect.admission.target !== sessionId
        || agent.session.events.some(event => event.type === 'user/message'
          && String(event.data.id) === origin.messageId)) {
        throw new Error('no-safe precommit admission is not exact')
      }
      const existing = parsed.data
      const original = originalFromSession(agent, existing)
      const originalText = original === undefined ? undefined : textOf(original)
      if (originalText === undefined
        || directExpressionHash(existing.original.messageId, originalText) !== existing.original.hash) {
        throw new Error('no-safe precommit focus origin is not exact')
      }
      const storedOrigin = { messageId: existing.original.messageId, hash: existing.original.hash }
      const restored = focusAuthority.fromBoundProposal({
        kind: 'proposal', origin: storedOrigin,
        value: { kind: 'focus', relation: 'new', subject: existing.proposal.subject, origin: storedOrigin },
      }).decideFocus(createExplicitUserExpression(originalText, sessionId as ChatRef, storedOrigin))
      const established = restored.kind === 'business_result' ? restored.value : undefined
      if (established?.kind !== 'focus_established' || !sameFocus(established, existing.decision)) {
        throw new Error('no-safe precommit focus restoration is not exact')
      }
      const request = createBoundedActionFactNeedProposalRequest(
        createExplicitUserExpression(text, sessionId as ChatRef, origin), origin, established,
      )
      if (request === undefined) throw new Error('no-safe bounded request was not formed')
      const outcome = await auxiliary.proposeActionFacts(request, signal)
      const proposal = noSafeAction.formActionBoundaryProposal(established, outcome, claimedDirect)
      if (proposal === undefined) throw new Error('no-safe bounded proposal was not established')
      const committed = await noSafeLive.commit({
        sessionId, session: agent.session, record: { family: 'no_safe_action' },
        focus: established, proposal,
        save: async value => {
          const exact = noSafeActionStateRecordSchema.safeParse(value)
          if (!exact.success) throw new Error('no-safe live sidecar record failed exact schema validation')
          await table.put(sessionId, exact.data)
        },
        flush: async () => await sessions.flush(agent.session),
        readFrom: async fromSeq => await persistence.readFrom(sessionId, fromSeq),
      })
      const visible = agent.session.deriveMessages()
      const canonical = visible[0]
      if (committed === undefined || committed.finalized.record.family !== 'no_safe_action'
        || visible.length !== 1 || canonical === undefined || canonical.role !== 'user'
        || canonical.source.kind !== 'context-manager-no-safe-action'
        || canonical.source.machine.kind !== 'no_safe_action') {
        throw new Error('no-safe finalized publication is not exact')
      }
      const denial = exactNoSafeActionDenialFromTransaction(agent, committed.finalized.record)
      if (denial === undefined) throw new Error('no-safe finalized denial state was not established')
      noSafeDenials.set(agent, denial)
      // AgentLoop appends the exact direct input and its C22-derived notice
      // once, then dispatches one ordinary root request over that surface.
      return { kind: 'enter', messages: [message, committed.notice] }
    } catch (error) {
      if (isManagedFailure(error)) throw error
      return await failClosed()
    }
  }

  ctx.on('agent/disposed', ({ agent }) => {
    recoveryGates.delete(agent)
    inserted.delete(String(agent.session.id))
    insertedMessages.delete(agent)
    claimedNoFocusMessages.delete(agent)
    claimedDirects.delete(agent)
    noSafeDenials.delete(agent)
    postCanonicalBasisDirects.delete(String(agent.session.id))
    postCanonicalNonBasisUpdates.delete(String(agent.session.id))
  })

  type RecoveryLifecycle = {
    phase: 'pending' | 'inFlight' | 'settled'
    waitingForIdle: boolean
  }
  type RecoveryAttemptStart = 'async' | 'retry' | undefined
  const recoveryInstalled = new WeakSet<Agent>()
  const recoveryLifecycles = new WeakMap<Agent, RecoveryLifecycle>()

  const finishRecoveryAttempt = (
    agent: Agent,
    lifecycle: RecoveryLifecycle,
    gate: { kind: NoFocusRecoveryGate['kind'] },
    maintenance: Promise<unknown>,
  ): void => {
    void maintenance.then(() => {
      if (recoveryLifecycles.get(agent) !== lifecycle) return
      if (gate.kind === 'ready') {
        lifecycle.phase = 'settled'
        recoveryLifecycles.delete(agent)
      } else {
        lifecycle.phase = 'pending'
      }
    }, () => {
      if (recoveryLifecycles.get(agent) === lifecycle) lifecycle.phase = 'pending'
    })
  }

  const attemptAgentRecovery = (agent: Agent, lifecycle: RecoveryLifecycle): RecoveryAttemptStart => {
    const sessionId = String(agent.session.id)
    let record: H1CanaryRecord | undefined
    try {
      record = domain.table('focus_precanonical').get(sessionId)
    } catch (error) {
      const expected = expectedMissingNoSafeActionDenial(agent)
      const expectedBackground = hasExpectedBackgroundWithoutTransaction(agent)
      if (expected === undefined && !expectedBackground) throw error
      if (expected !== undefined) noSafeDenials.set(agent, expected)
      recoveryGates.set(agent, { kind: 'closed' })
      return
    }
    const expected = expectedMissingNoSafeActionDenial(agent)
    const exactStoredNoSafe = record === undefined ? undefined : exactNoSafeActionDenial(agent, record)
    if (expected !== undefined && exactStoredNoSafe === undefined) {
      noSafeDenials.set(agent, expected)
      recoveryGates.set(agent, { kind: 'closed' })
      return
    }
    // A genuinely fresh chat has neither sidecar state nor a durable H2 close.
    // It remains ordinary H1/T3 behavior; H1R-F never signs a new-chat result.
    if (record === undefined) {
      if (hasExpectedNoFocusWithoutTransaction(agent)
        || hasExpectedBackgroundWithoutTransaction(agent)) recoveryGates.set(agent, { kind: 'closed' })
      return
    }
    const proofOnly = closureOnlyProofRecordSchema.safeParse(record)
    if (proofOnly.success) {
      if (proofOnly.data.closure.phase !== 'physically_proved') {
        recoveryGates.set(agent, { kind: 'closed' })
        return
      }
      const gate: { kind: NoFocusRecoveryGate['kind'] } = { kind: 'restoring' }
      recoveryGates.set(agent, gate)
      try {
        const maintenance = agent.runMaintenance(async signal => {
          try {
            if (signal.aborted) return
            const sessions = sessionsFlushPort(ctx)
            const persistence = sessionPersistencePort(ctx)
            if (sessions === undefined || persistence === undefined
              || !await sessions.flush(agent.session)) return
            const detached = await persistence.readFrom(sessionId, 0)
            const liveTranscript = exactClosureOnlyProofTranscript(sessionId, agent.session.events, proofOnly.data)
            const detachedTranscript = exactClosureOnlyProofTranscript(sessionId, detached.events, proofOnly.data)
            if (liveTranscript === undefined || detachedTranscript === undefined
              || !sameClosureOnlyProofTranscript(liveTranscript, detachedTranscript)
              || signal.aborted) return
            const closeText = textOf(liveTranscript.close)
            if (closeText !== '这件事结束了') return
            const origin = proofOnly.data.closure.original
            const proposal = await auxiliary.proposeProofOnlyColdRecovery(closeText, origin, signal)
            if (proposal.kind !== 'proposal' || proposal.value.kind !== 'close') return
            const result = focusAuthority.fromBoundProposal(proposal)
              .decideFocus(createExplicitUserExpression(closeText, sessionId as ChatRef, origin))
            const decision = result.kind === 'business_result' ? result.value : undefined
            if (result.kind !== 'business_result' || decision?.kind !== 'no_focus'
              || decision.chat !== sessionId) return
            const advice = candidateAdvice.acceptMatterRelation(decision)
            if (advice.kind !== 'business_result') return
            const carrier: ClosureOnlyNoFocusRecord = {
              closure: {
                ...proofOnly.data.closure,
                phase: 'physically_proved',
                proposal: { kind: proposal.value.kind, relation: proposal.value.relation },
                decision: {
                  kind: decision.kind,
                  ref: decision.ref,
                  chat: decision.chat,
                  latestCorrections: decision.latestCorrections,
                },
              },
            }
            const exactCarrier = closureOnlyNoFocusRecordSchema.safeParse(carrier)
            if (!exactCarrier.success || exactCarrier.data.transaction !== undefined) return
            const freshCarrier: Omit<ClosureOnlyNoFocusRecord, 'transaction'> & {
              readonly transaction?: never
            } = { closure: exactCarrier.data.closure }
            await noFocusHarness.enter({
              sessionId,
              session: agent.session,
              record: freshCarrier,
              close: exactCarrier.data.closure.original,
              decision,
              save: async value => {
                const parsed = closureOnlyNoFocusRecordSchema.safeParse(value)
                if (!parsed.success) throw new Error('closure-only recovery transaction row failed exact schema validation')
                try {
                  await domain.table('focus_precanonical').put(sessionId, parsed.data)
                } catch (error) {
                  warnProofOnlyColdRecoveryPutFailure(ctx, error)
                  throw error
                }
              },
              flush: async () => await sessions.flush(agent.session),
              readFrom: async fromSeq => await persistence.readFrom(sessionId, fromSeq),
            })
            const finalized = closureOnlyNoFocusRecordSchema.safeParse(
              domain.table('focus_precanonical').get(sessionId),
            )
            if (!finalized.success || finalized.data.transaction?.phase !== 'finalized' || signal.aborted) return
            if (recoveryGates.get(agent) === gate) gate.kind = 'ready'
          } finally {
            if (recoveryGates.get(agent) === gate && gate.kind !== 'ready') gate.kind = 'closed'
          }
        })
        finishRecoveryAttempt(agent, lifecycle, gate, maintenance)
        return 'async'
      } catch {
        gate.kind = 'closed'
        return 'retry'
      }
    }
    if (isBackgroundStateRecord(record)) {
      const exact = parseCanonicalBackgroundStateRecord(record)
      if (exact === undefined || exact.transaction?.phase === 'current') {
        recoveryGates.set(agent, { kind: 'closed' })
        return
      }
      const gate: { kind: NoFocusRecoveryGate['kind'] } = { kind: 'restoring' }
      recoveryGates.set(agent, gate)
      try {
        const maintenance = agent.runMaintenance(async signal => {
          try {
            if (signal.aborted) return
            const restored = await background.state.recover({
              sessionId,
              session: agent.session,
              record: exact,
              save: async value => {
                const parsed = backgroundStateRecordSchema.safeParse(value)
                if (!parsed.success) throw new Error('background repair sidecar record failed exact schema validation')
                await domain.table('focus_precanonical').put(sessionId, parsed.data)
              },
              flush: async () => {
                const sessions = sessionsFlushPort(ctx)
                return sessions !== undefined && await sessions.flush(agent.session)
              },
              readFrom: async fromSeq => {
                const persistence = sessionPersistencePort(ctx)
                if (persistence === undefined) throw new Error('background repair persistence is unavailable')
                return await persistence.readFrom(sessionId, fromSeq)
              },
            })
            if (restored === undefined || signal.aborted) return
            if (recoveryGates.get(agent) === gate) gate.kind = 'ready'
          } finally {
            if (recoveryGates.get(agent) === gate && gate.kind !== 'ready') gate.kind = 'closed'
          }
        })
        finishRecoveryAttempt(agent, lifecycle, gate, maintenance)
        return 'async'
      } catch {
        gate.kind = 'closed'
        return 'retry'
      }
    }
    if (isNoSafeActionStateRecord(record)) {
      const exact = parseCanonicalNoSafeActionStateRecord(record)
      const denial = exactNoSafeActionDenial(agent, record)
      if (exact === undefined || exact.transaction?.phase !== 'finalized' || denial === undefined) {
        recoveryGates.set(agent, { kind: 'closed' })
        return
      }
      noSafeDenials.set(agent, denial)
      const gate: { kind: NoFocusRecoveryGate['kind'] } = { kind: 'restoring' }
      recoveryGates.set(agent, gate)
      try {
        const maintenance = agent.runMaintenance(async signal => {
          try {
            if (signal.aborted) return
            const repaired = await noSafeRepair.repair({
              sessionId, session: agent.session, record: exact,
              save: async value => {
                const parsed = noSafeActionStateRecordSchema.safeParse(value)
                if (!parsed.success) throw new Error('no-safe repair sidecar record failed exact schema validation')
                await domain.table('focus_precanonical').put(sessionId, parsed.data)
              },
              flush: async () => {
                const sessions = sessionsFlushPort(ctx)
                return sessions !== undefined && await sessions.flush(agent.session)
              },
              readFrom: async fromSeq => {
                const persistence = sessionPersistencePort(ctx)
                if (persistence === undefined) throw new Error('no-safe repair persistence is unavailable')
                return await persistence.readFrom(sessionId, fromSeq)
              },
            })
            if (repaired === undefined || signal.aborted) return
            const restored = noSafeRecovery.restore({ session: agent.session, record: repaired })
            if (restored === undefined || signal.aborted) return
            if (recoveryGates.get(agent) === gate) gate.kind = 'ready'
          } finally {
            if (recoveryGates.get(agent) === gate && gate.kind !== 'ready') gate.kind = 'closed'
          }
        })
        finishRecoveryAttempt(agent, lifecycle, gate, maintenance)
        return 'async'
      } catch {
        gate.kind = 'closed'
        return 'retry'
      }
    }
    if (isLocalRestrictionStateRecord(record)) {
      const exact = parseCanonicalLocalRestrictionStateRecord(record)
      if (exact === undefined) {
        recoveryGates.set(agent, { kind: 'closed' })
        return
      }
      const gate: { kind: NoFocusRecoveryGate['kind'] } = { kind: 'restoring' }
      recoveryGates.set(agent, gate)
      try {
        const maintenance = agent.runMaintenance(async signal => {
          try {
            if (signal.aborted) return
            const repaired = await localRepair.repair({
              sessionId, session: agent.session, record: exact,
              save: async value => {
                const parsed = localRestrictionStateRecordSchema.safeParse(value)
                if (!parsed.success) throw new Error('local repair sidecar record failed exact schema validation')
                await domain.table('focus_precanonical').put(sessionId, parsed.data)
              },
              flush: async () => {
                const sessions = sessionsFlushPort(ctx)
                return sessions !== undefined && await sessions.flush(agent.session)
              },
              readFrom: async fromSeq => {
                const persistence = sessionPersistencePort(ctx)
                if (persistence === undefined) throw new Error('local repair persistence is unavailable')
                return await persistence.readFrom(sessionId, fromSeq)
              },
            })
            if (repaired === undefined || signal.aborted) return
            const restored = localRecovery.restore({ session: agent.session, record: repaired })
            if (restored === undefined || signal.aborted) return
            if (recoveryGates.get(agent) === gate) gate.kind = 'ready'
          } finally {
            if (recoveryGates.get(agent) === gate && gate.kind !== 'ready') gate.kind = 'closed'
          }
        })
        finishRecoveryAttempt(agent, lifecycle, gate, maintenance)
        return 'async'
      } catch {
        gate.kind = 'closed'
        return 'retry'
      }
    }
    if (!isNoFocusCanaryRecord(record) && !isClosureOnlyNoFocusRecord(record)) {
      if (isAnyNoFocusRecord(record)) recoveryGates.set(agent, { kind: 'closed' })
      return
    }
    const parsed = isNoFocusCanaryRecord(record)
      ? noFocusCanaryRecordSchema.safeParse(record)
      : closureOnlyNoFocusRecordSchema.safeParse(record)
    if (!parsed.success || parsed.data.closure.phase !== 'physically_proved') {
      recoveryGates.set(agent, { kind: 'closed' })
      return
    }
    if (parsed.data.transaction?.phase === 'pending') {
      const gate: { kind: NoFocusRecoveryGate['kind'] } = { kind: 'restoring' }
      recoveryGates.set(agent, gate)
      // Pending replay is a cold maintenance transaction: it must settle
      // before any provider/tool/auxiliary pre-step can observe this agent.
      try {
        const maintenance = agent.runMaintenance(async signal => {
          try {
            if (signal.aborted) return
            const restored = await noFocusRecovery.restorePending({
              sessionId,
              stored: { session: agent.session, record: parsed.data },
              save: async value => {
                const legacy = noFocusCanaryRecordSchema.safeParse(value)
                const exact = legacy.success ? legacy : closureOnlyNoFocusRecordSchema.safeParse(value)
                if (!exact.success) throw new Error('pending replay sidecar record failed exact schema validation')
                await domain.table('focus_precanonical').put(sessionId, exact.data)
              },
              flush: async () => {
                const sessions = sessionsFlushPort(ctx)
                if (sessions === undefined) throw new Error('pending replay has no persistence listener')
                return await sessions.flush(agent.session)
              },
              readFrom: async fromSeq => {
                const persistence = sessionPersistencePort(ctx)
                if (persistence === undefined) throw new Error('pending replay persistence is unavailable')
                return await persistence.readFrom(sessionId, fromSeq)
              },
            })
            if (restored === undefined || signal.aborted) return
            if (recoveryGates.get(agent) === gate) gate.kind = 'ready'
          } finally {
            if (recoveryGates.get(agent) === gate && gate.kind !== 'ready') gate.kind = 'closed'
          }
        })
        finishRecoveryAttempt(agent, lifecycle, gate, maintenance)
        return 'async'
      } catch {
        gate.kind = 'closed'
        return 'retry'
      }
    }
    if (parsed.data.transaction?.phase !== 'finalized') {
      recoveryGates.set(agent, { kind: 'closed' })
      return
    }
    const gate: { kind: NoFocusRecoveryGate['kind'] } = { kind: 'restoring' }
    recoveryGates.set(agent, gate)
    // `runMaintenance()` claims the idle slot synchronously; later Agent.send
    // traffic is latched by AgentLoop until this attempt has settled.
    try {
      const maintenance = agent.runMaintenance(async signal => {
        try {
          if (signal.aborted) return
          const repaired = await repairNormalNoFocusTail(ctx, agent, parsed.data, async value => {
            const exact = isNoFocusCanaryRecord(value)
              ? noFocusCanaryRecordSchema.safeParse(value)
              : closureOnlyNoFocusRecordSchema.safeParse(value)
            if (!exact.success) throw new Error('no-focus repair sidecar record failed exact schema validation')
            await domain.table('focus_precanonical').put(sessionId, exact.data)
          })
          if (repaired === undefined || signal.aborted) return
          const sessions = sessionsFlushPort(ctx)
          const persistence = sessionPersistencePort(ctx)
          if (sessions === undefined || persistence === undefined || !await sessions.flush(agent.session)) return
          const detached = await persistence.readFrom(sessionId, 0)
          if (signal.aborted || !hasDetachedFinalizedRecoveryProof(agent, repaired, detached.events)) return
          const restored = noFocusRecovery.restore({ stored: { session: agent.session, record: repaired } })
          if (restored === undefined || signal.aborted) return
          if (recoveryGates.get(agent) === gate) gate.kind = 'ready'
        } finally {
          if (recoveryGates.get(agent) === gate && gate.kind !== 'ready') gate.kind = 'closed'
        }
      })
      finishRecoveryAttempt(agent, lifecycle, gate, maintenance)
      return 'async'
    } catch {
      gate.kind = 'closed'
      return 'retry'
    }
  }

  const scheduleAgentRecovery = (agent: Agent): void => {
    const lifecycle = recoveryLifecycles.get(agent)
    if (lifecycle === undefined || lifecycle.phase !== 'pending' || lifecycle.waitingForIdle) return
    lifecycle.waitingForIdle = true
    void agent.whenIdle().then(() => {
      lifecycle.waitingForIdle = false
      if (recoveryLifecycles.get(agent) !== lifecycle || lifecycle.phase !== 'pending') return
      lifecycle.phase = 'inFlight'
      let started: RecoveryAttemptStart
      try {
        started = attemptAgentRecovery(agent, lifecycle)
      } catch {
        lifecycle.phase = 'pending'
        return
      }
      if (started === 'async') return
      if (started === 'retry') {
        lifecycle.phase = 'pending'
        return
      }
      lifecycle.phase = 'settled'
      recoveryLifecycles.delete(agent)
    }, () => {
      lifecycle.waitingForIdle = false
      if (recoveryLifecycles.get(agent) === lifecycle) lifecycle.phase = 'pending'
    })
  }

  const installAgentRecovery = (agent: Agent): void => {
    if (recoveryInstalled.has(agent)) return
    recoveryInstalled.add(agent)
    if (!managed(agent, classifier)) return
    const sessionId = String(agent.session.id)
    const tools = agent.ctx.get('tools')
    if (tools === undefined) throw new Error('ui-context-compactor: managed no-safe policy requires the tools service')
    tools.guard(() => {
      let current: H1CanaryRecord | undefined
      try {
        current = domain.table('focus_precanonical').get(sessionId)
      } catch {
        const expected = expectedMissingNoSafeActionDenial(agent)
        if (expected !== undefined) {
          noSafeDenials.set(agent, expected)
          recoveryGates.set(agent, { kind: 'closed' })
        }
        return NO_SAFE_ACTION_TOOL_DENIAL
      }
      const gate = recoveryGates.get(agent)
      const denied = noSafeDenials.get(agent)
      if (denied !== undefined) {
        if (current !== undefined
          && provesNewCompleteNonNoSafeState(agent, current, denied.generation)) {
          noSafeDenials.delete(agent)
          recoveryGates.set(agent, { kind: 'ready' })
          return undefined
        }
        const currentNoSafe = current === undefined ? undefined : exactNoSafeActionDenial(agent, current)
        if (currentNoSafe !== undefined) {
          if (currentNoSafe.generation > denied.generation
            || denied.evidence === 'visible_expected_missing'
              && sameNoSafeActionDenial(currentNoSafe, denied)) noSafeDenials.set(agent, currentNoSafe)
          return NO_SAFE_ACTION_TOOL_DENIAL
        }
        if (gate !== undefined && gate.kind !== 'ready') return NO_SAFE_ACTION_TOOL_DENIAL
        return NO_SAFE_ACTION_TOOL_DENIAL
      }
      if (gate !== undefined && gate.kind !== 'ready') return NO_SAFE_ACTION_TOOL_DENIAL
      const established = current === undefined ? undefined : exactNoSafeActionDenial(agent, current)
      if (established !== undefined) {
        noSafeDenials.set(agent, established)
        return NO_SAFE_ACTION_TOOL_DENIAL
      }
      if (current !== undefined && isNoSafeActionStateRecord(current)) {
        return NO_SAFE_ACTION_TOOL_DENIAL
      }
      const expected = expectedMissingNoSafeActionDenial(agent)
      if (expected === undefined) return undefined
      noSafeDenials.set(agent, expected)
      recoveryGates.set(agent, { kind: 'closed' })
      // Exact no-safe state denies the body. A malformed no-safe row also
      // denies, but cannot replace the last exact monotonic identity.
      return NO_SAFE_ACTION_TOOL_DENIAL
    })
    recoveryLifecycles.set(agent, { phase: 'pending', waitingForIdle: false })
    scheduleAgentRecovery(agent)
  }

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') scheduleAgentRecovery(agent)
  })
  ctx.on('agent/created', ({ agent }) => { installAgentRecovery(agent) }, { prepend: true })
  for (const id of config.allowlist) {
    const agent = ctx.agents.get(SessionId(id))
    if (agent !== undefined) installAgentRecovery(agent)
  }
  ctx.on('agent/disposed', ({ agent }) => { recoveryLifecycles.delete(agent) })

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!managed(agent, classifier) || !isDirectUserSource(message.source)) return
    const sessionId = String(agent.session.id)
    const messageId = String(message.id)
    const ids = inserted.get(sessionId) ?? new Set<string>()
    ids.add(messageId)
    inserted.set(sessionId, ids)
    const exact = insertedMessages.get(agent) ?? new Map<string, UserMessage>()
    if (!exact.has(messageId)) exact.set(messageId, message)
    insertedMessages.set(agent, exact)
  }, { prepend: true })

  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (!managed(agent, classifier) || !isDirectUserSource(message.source)) return
    const sessionId = String(agent.session.id)
    const messageId = String(message.id)
    const registered = insertedMessages.get(agent)?.get(messageId)
    const text = textOf(message)
    if (sessionId === 'session-telegram' && registered === message && text === '这件事结束了') {
      const exact = claimedNoFocusMessages.get(agent) ?? new Map<string, UserMessage>()
      exact.set(messageId, message)
      claimedNoFocusMessages.set(agent, exact)
    }
    let record: H1CanaryRecord | undefined
    try {
      record = domain.table('focus_precanonical').get(sessionId)
    } catch (error) {
      // The no-safe tracer owns one containment boundary after claim. Do not
      // let this earlier lookup bypass its single physical-proof/presenter
      // attempt; an absent claim is rejected inside that same boundary.
      if (text === NO_SAFE_ACTION_TRACER_EXPRESSION
        || evidenceWeb !== undefined && isF03EvidenceDirect(text)) return
      throw error
    }
    const focusRecord = focusCanaryRecordSchema.safeParse(record)
    const backgroundRecord = record !== undefined && isBackgroundStateRecord(record)
      ? parseCanonicalBackgroundStateRecord(record)
      : undefined
    const canIssueForCurrentBackground = backgroundRecord?.transaction?.phase === 'finalized'
      && candidateFocusBasis.has(sessionId)
    // The issuer is used only for the two established-focus action branches.
    // Focus, close and continuation inputs cannot strand an action token.
    if (registered !== message || record === undefined || isAnyNoFocusRecord(record)
      || isLocalRestrictionStateRecord(record) || isNoSafeActionStateRecord(record)
      || !focusRecord.success && !canIssueForCurrentBackground
      || (text !== LOCAL_RESTRICTION_TRACER_EXPRESSION
        && text !== NO_SAFE_ACTION_TRACER_EXPRESSION
        && (evidenceWeb === undefined || !isF03EvidenceDirect(text)))) return
    const issued = actionComposition.claimedStructuredDirectIssuer.issue(
      agent.session, sessionId as ChatRef, message,
    )
    if (issued === undefined) return
    const claims = claimedDirects.get(agent) ?? new Map<string, ClaimedStructuredDirect>()
    claims.set(messageId, issued)
    claimedDirects.set(agent, claims)
  }, { prepend: true })

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    if (!managed(agent, classifier)) return await next()
    const sessionId = String(agent.session.id)
    const message = messages[0]
    const claims = inserted.get(sessionId)
    // This mechanical gate intentionally precedes every downstream listener.
    // H1 supports one and only one claimed structured direct-user message;
    // continuation, tool, context, and mixed batches fail closed.
    if (messages.length !== 1
      || message === undefined
      || !isDirectUserSource(message.source)
      || !claims?.has(String(message.id))) {
      for (const candidate of messages) releaseClaimTracking(agent, String(candidate.id))
      return await rejectManagedBatch(ctx, agent, messages, inserted)
    }
    // Recovery never lets a partial, missing, or still-maintaining finalized
    // candidate reach the ordinary pre-step. The current direct input is first
    // retained exactly once, then AgentLoop exposes the bounded public error.
    const recoveryGate = recoveryGates.get(agent)
    if (recoveryGate !== undefined && recoveryGate.kind !== 'ready') {
      claims.delete(String(message.id))
      if (claims.size === 0) inserted.delete(sessionId)
      releaseClaimTracking(agent, String(message.id))
      return await closedRecoveryInput(ctx, agent, message, managedFailure)
    }
    // H2's known-unavailable result is only available after detached physical
    // readback. Only the exact close expression can create pre-canonical
    // no-focus, so it alone must close before downstream/auxiliary/C01 when
    // that proof port is unavailable; ordinary H1 focus input stays available
    // to the F01-T3 composition.
    if (textOf(message) === '这件事结束了'
      && (sessionPersistencePort(ctx) === undefined || sessionsFlushPort(ctx) === undefined)) {
      claims.delete(String(message.id))
      if (claims.size === 0) inserted.delete(sessionId)
      releaseClaimTracking(agent, String(message.id))
      return await canaryFailure(ctx, agent, message)
    }
    const messageId = String(message.id)
    if (evidenceWeb !== undefined && isF03EvidenceDirect(textOf(message))) {
      const claimedDirect = claimedDirects.get(agent)?.get(messageId)
      try {
        return await runEvidenceTracer(agent, message, signal, claimedDirect)
      } finally {
        finishClaimTracking(agent, messageId)
      }
    }
    if (textOf(message) === LOCAL_RESTRICTION_TRACER_EXPRESSION) {
      const claimedDirect = claimedDirects.get(agent)?.get(messageId)
      try {
        return await runLocalRestrictionTracer(agent, message, signal, claimedDirect)
      } finally {
        finishClaimTracking(agent, messageId)
      }
    }
    if (textOf(message) === NO_SAFE_ACTION_TRACER_EXPRESSION) {
      const claimedDirect = claimedDirects.get(agent)?.get(messageId)
      try {
        return await runNoSafeActionTracer(agent, message, signal, claimedDirect)
      } finally {
        finishClaimTracking(agent, messageId)
      }
    }
    let preNextRecord: ReturnType<ReturnType<typeof domain.table>['get']>
    try {
      preNextRecord = domain.table('focus_precanonical').get(sessionId)
    } catch {
      finishClaimTracking(agent, messageId)
      return await canaryFailure(ctx, agent, message)
    }
    if (preNextRecord !== undefined && isLocalRestrictionStateRecord(preNextRecord)
      && (recoveryGate?.kind !== 'ready'
        || preNextRecord.transaction?.phase !== 'finalized'
        || textOf(message) !== '继续')) {
      finishClaimTracking(agent, messageId)
      return await closedRecoveryInput(ctx, agent, message, managedFailure)
    }
    if (preNextRecord !== undefined && isNoSafeActionStateRecord(preNextRecord)) {
      finishClaimTracking(agent, messageId)
      return await closedRecoveryInput(ctx, agent, message, managedFailure)
    }
    const base = await next()
    if (base.kind === 'reject') {
      finishClaimTracking(agent, messageId)
      return base
    }
    if (textOf(message) === '请更新当前背景') {
      try {
        const prior = preNextRecord !== undefined && isBackgroundStateRecord(preNextRecord)
          ? parseCanonicalBackgroundStateRecord(preNextRecord)?.transaction
          : undefined
        if (preNextRecord !== undefined && isBackgroundStateRecord(preNextRecord)) {
          const c41 = qualifiedBackground.current.acceptCurrent(sessionId as ChatRef, preNextRecord)
          if (prior?.phase !== 'finalized'
            || c41?.kind !== 'business_result'
            || c41.identity.contract !== 'C41'
            || c41.identity.subject !== prior.canonicalRef
            || c41.value.kind !== 'accepted_for_contract'
            || c41.value.value.ref !== prior.canonicalRef
            || c41.value.value.target !== sessionId) {
            throw new Error('candidate update has no exact current C41 state')
          }
          const finalizedReplaceSeq = prior.finalizedReplaceSeq
          if (typeof finalizedReplaceSeq !== 'number' || !Number.isSafeInteger(finalizedReplaceSeq)) {
            throw new Error('current C41 state has no finalized writer revision')
          }
          const acceptedDirects = postCanonicalBasisDirects.get(sessionId)
          const acceptedNonBasisUpdates = postCanonicalNonBasisUpdates.get(sessionId)
          const unqualifiedDirect = agent.session.events.some(event => event.type === 'user/message'
            && event.seq > finalizedReplaceSeq
            && event.data.source.kind === 'user'
            && String(event.data.id) !== prior.machine.originMessageId
            && acceptedDirects?.has(String(event.data.id)) !== true
            && (acceptedNonBasisUpdates?.generation !== prior.generation
              || !acceptedNonBasisUpdates.directIds.has(String(event.data.id))))
          if (unqualifiedDirect) throw new Error('post-canonical direct work is not present in the new basis')
        }
        const runtimeEvidence = await buildCandidateRuntimeEvidence(
          agent, message, base.messages, signal, '请更新当前背景',
        )
        if (runtimeEvidence === undefined || runtimeEvidence.text !== '请更新当前背景') {
          throw new Error('candidate runtime evidence was not exact')
        }
        candidateTerminals.delete(sessionId)
        candidateRuntimeEvidence.set(sessionId, runtimeEvidence as ExplicitBackgroundUpdateRuntimeEvidence)
        const c38 = candidateAdvice.requestExplicitBackgroundUpdate({ chat: sessionId as ChatRef })
        candidateRuntimeEvidence.delete(sessionId)
        const terminal = candidateTerminals.get(sessionId)
        candidateTerminals.delete(sessionId)
        if (c38.kind !== 'business_result' || terminal?.kind === 'failed') {
          throw new Error('candidate qualification did not close exactly')
        }
        if (terminal?.kind === 'issue') {
          await preserveClaimedInput(ctx, agent, message)
          finishClaimTracking(agent, messageId)
          await publishCandidateResult(agent, terminal.text)
          if (prior !== undefined && terminal.reason === 'basis_incomplete') {
            const existing = postCanonicalNonBasisUpdates.get(sessionId)
            const markers = existing?.generation === prior.generation
              ? existing
              : Object.freeze({ generation: prior.generation, directIds: new Set<string>() })
            markers.directIds.add(messageId)
            postCanonicalNonBasisUpdates.set(sessionId, markers)
          }
          return { kind: 'enter', messages: [] }
        }
        const focus = candidateFocusBasis.get(sessionId)
        const boundary = candidateActionBasis.get(sessionId)
        const sessions = sessionsFlushPort(ctx)
        const persistence = sessionPersistencePort(ctx)
        if (focus === undefined || boundary === undefined
          || sessions === undefined || persistence === undefined || signal.aborted) {
          throw new Error('qualified background has no exact live transaction inputs')
        }
        const currentHeader = agent.session.requestHeader()
        if (currentHeader === undefined
          || tokenMeter.measure(agent.session, currentHeader).logRevision
            !== runtimeEvidence.budget.firstAssembly.revision) {
          throw new Error('qualified background writer revision changed after formation')
        }
        const table = domain.table('focus_precanonical')
        const stored = table.get(sessionId)
        const record: BackgroundStateRecord = stored !== undefined && isBackgroundStateRecord(stored)
          ? stored : { family: 'background' }
        const committed = await qualifiedBackground.apply.apply({
          sessionId,
          session: agent.session,
          record,
          focus,
          boundary,
          origin: runtimeEvidence.origin,
          save: async value => {
            const exact = backgroundStateRecordSchema.safeParse(value)
            if (!exact.success) throw new Error('background live sidecar record failed exact schema validation')
            await table.put(sessionId, exact.data)
          },
          flush: async () => await sessions.flush(agent.session),
          readFrom: async fromSeq => await persistence.readFrom(sessionId, fromSeq),
        })
        const visible = agent.session.deriveMessages()
        const canonical = visible[0]
        if (signal.aborted || committed.record.phase !== 'finalized'
          || committed.record.generation !== (prior === undefined ? 1 : prior.generation + 1)
          || visible.length !== 1 || canonical === undefined || canonical.role !== 'user'
          || canonical.source.kind !== 'context-manager-canonical'
          || canonical.source.machine.kind !== 'background'
          || agent.session.events.some(event => event.type === 'user/message'
            && String(event.data.id) === messageId)) {
          throw new Error('background finalized publication is not uniquely visible')
        }
        postCanonicalBasisDirects.delete(sessionId)
        postCanonicalNonBasisUpdates.delete(sessionId)
        finishClaimTracking(agent, messageId)
        // AgentLoop appends this exact direct once after canonical commit and
        // assembles the one request from canonical background plus the direct.
        return { kind: 'enter', messages: [message] }
      } catch {
        candidateRuntimeEvidence.delete(sessionId)
        candidateTerminals.delete(sessionId)
        finishClaimTracking(agent, messageId)
        return await closedRecoveryInput(ctx, agent, message, managedFailure)
      }
    }
    if (preNextRecord !== undefined && isBackgroundStateRecord(preNextRecord)) {
      finishClaimTracking(agent, messageId)
      return base
    }
    const noFocusInserted = insertedMessages.get(agent)?.get(messageId)
    const noFocusClaimed = claimedNoFocusMessages.get(agent)?.get(messageId)
    claims.delete(messageId)
    if (claims.size === 0) inserted.delete(sessionId)
    releaseClaimTracking(agent, messageId)
    try {
      const text = textOf(message)
      if (text === undefined) return await canaryFailure(ctx, agent, message)
      const origin = { messageId: String(message.id), hash: directExpressionHash(String(message.id), text) }
      const table = domain.table('focus_precanonical')
      const existing = table.get(sessionId)
      let decision: FocusDecision
      if (existing === undefined) {
        const telegramAdmission = qualifyTelegramNoFocusAdmission({
          agent,
          message,
          inserted: noFocusInserted,
          claimed: noFocusClaimed,
          stored: existing,
        })
        if (telegramAdmission !== undefined) {
          const sessions = sessionsFlushPort(ctx)
          const persistence = sessionPersistencePort(ctx)
          if (sessions === undefined || persistence === undefined) return await canaryFailure(ctx, agent, message)
          let proof: ClosureOnlyProofRecord
          try {
            proof = await proveTelegramNoFocusAdmission({
              admission: telegramAdmission,
              save: async value => {
                const parsed = closureOnlyProofRecordSchema.safeParse(value)
                if (!parsed.success) throw new Error('closure-only proof row failed exact schema validation')
                await table.put(sessionId, parsed.data)
              },
              flush: async () => await sessions.flush(agent.session),
              readFrom: async fromSeq => await persistence.readFrom(sessionId, fromSeq),
            })
          } catch {
            return await canaryFailure(ctx, agent, message)
          }
          let closureOnlyStage: ClosureOnlyLiveStage = 'bounded-proposal'
          try {
            const proposal = await auxiliary.propose(text, origin, signal)
            if (proposal.kind !== 'proposal' || proposal.value.kind !== 'close') {
              throw new Error('closure-only bounded proposal was not established')
            }
            closureOnlyStage = 'decision-and-carrier'
            const result = focusAuthority.fromBoundProposal(proposal)
              .decideFocus(createExplicitUserExpression(text, sessionId as ChatRef, origin))
            const noFocusDecision = result.kind === 'business_result' ? result.value : undefined
            if (result.kind !== 'business_result' || noFocusDecision?.kind !== 'no_focus'
              || candidateAdvice.acceptMatterRelation(noFocusDecision).kind !== 'business_result') {
              throw new Error('closure-only bounded no-focus decision was not established')
            }
            const carrier: ClosureOnlyNoFocusRecord = {
              closure: {
                ...proof.closure,
                phase: 'physically_proved',
                proposal: { kind: proposal.value.kind, relation: proposal.value.relation },
                decision: {
                  kind: noFocusDecision.kind,
                  ref: noFocusDecision.ref,
                  chat: noFocusDecision.chat,
                  latestCorrections: noFocusDecision.latestCorrections,
                },
              },
            }
            const exactCarrier = closureOnlyNoFocusRecordSchema.safeParse(carrier)
            if (!exactCarrier.success || exactCarrier.data.transaction !== undefined) {
              throw new Error('closure-only no-focus carrier is not exact')
            }
            const freshCarrier: Omit<ClosureOnlyNoFocusRecord, 'transaction'> & {
              readonly transaction?: never
            } = { closure: exactCarrier.data.closure }
            closureOnlyStage = 'canonical-transaction'
            const entered = await noFocusHarness.enter({
              sessionId,
              session: agent.session,
              record: freshCarrier,
              close: exactCarrier.data.closure.original,
              decision: noFocusDecision,
              save: async value => {
                const parsed = closureOnlyNoFocusRecordSchema.safeParse(value)
                if (!parsed.success) throw new Error('closure-only transaction row failed exact schema validation')
                await table.put(sessionId, parsed.data)
              },
              flush: async () => await sessions.flush(agent.session),
              readFrom: async fromSeq => await persistence.readFrom(sessionId, fromSeq),
            })
            return { kind: 'enter', messages: [entered.notice] }
          } catch (error) {
            warnClosureOnlyLiveFailure(ctx, closureOnlyStage, error)
            return managedFailure.afterPhysicallyProvedInput({ physicallyProved: true })
          }
        }
        if (hasPriorCanaryDisqualifier(agent, messages)) return await canaryFailure(ctx, agent, message)
        const proposal = await auxiliary.propose(text, origin, signal)
        const result = focusAuthority.fromBoundProposal(proposal)
          .decideFocus(createExplicitUserExpression(text, sessionId as ChatRef, origin))
        if (result.kind !== 'business_result' || result.value.kind !== 'focus_established') {
          return await canaryFailure(ctx, agent, message)
        }
        decision = result.value
        if (proposal.kind !== 'proposal' || proposal.value.kind !== 'focus') return await canaryFailure(ctx, agent, message)
        // The stored proposal remains unsigned. The independently established
        // decision is merely a pre-canonical projection for restart revalidation.
        await table.put(sessionId, {
          original: origin,
          proposal: { kind: proposal.value.kind, relation: proposal.value.relation, subject: proposal.value.subject },
          decision: {
            kind: decision.kind,
            ref: decision.ref,
            chat: decision.chat,
            currentMatter: decision.currentMatter,
            latestCorrections: decision.latestCorrections,
          },
        })
      } else {
        if (isLocalRestrictionStateRecord(existing)) {
          // A completed cold recovery has already re-established the exact
          // focus/boundary association. Only the explicit continuation may
          // enter the ordinary root; no claimed-direct admission is revived.
          if (recoveryGate?.kind === 'ready' && existing.transaction?.phase === 'finalized') {
            if (text !== '继续') return await closedRecoveryInput(ctx, agent, message, managedFailure)
            return base
          }
          return await closedRecoveryInput(ctx, agent, message, managedFailure)
        }
        if (isNoSafeActionStateRecord(existing)) {
          return await closedRecoveryInput(ctx, agent, message, managedFailure)
        }
        if (isBackgroundStateRecord(existing)) return base
        if (isNoFocusCanaryRecord(existing) || isClosureOnlyNoFocusRecord(existing)) {
          // A recovered finalized transaction owns the surface already. Its
          // next exact "continue" is a normal root input, appended by the
          // loop once; H2 must not manually append/rejudge it again.
          if (recoveryGate?.kind === 'ready' && existing.transaction?.phase === 'finalized') {
            if (text !== '继续') return await closedRecoveryInput(ctx, agent, message, managedFailure)
            return base
          }
          const closure = existing.closure
          // A sidecar write may have completed before append/flush/readback.
          // Such an orphan is intentionally not eligible for restart
          // rejudgment; only the proof-committed row is a no-focus canary.
          if (closure.phase !== 'physically_proved') return await canaryFailure(ctx, agent, message)
          const original = agent.session.events.find((event): event is Extract<typeof event, { type: 'user/message' }> =>
            event.type === 'user/message'
              && event.data.source.kind === 'user'
              && String(event.data.id) === closure.original.messageId,
          )?.data
          const originalText = original === undefined ? undefined : textOf(original)
          if (originalText === undefined
            || directExpressionHash(closure.original.messageId, originalText) !== closure.original.hash) {
            return await canaryFailure(ctx, agent, message)
          }
          const storedOrigin = { messageId: closure.original.messageId, hash: closure.original.hash }
          const result = focusAuthority.fromBoundProposal({
            kind: 'proposal',
            origin: storedOrigin,
            value: { kind: 'close', relation: 'current', origin: storedOrigin },
          }).decideFocus(createExplicitUserExpression(originalText, sessionId as ChatRef, storedOrigin))
          if (result.kind !== 'business_result'
            || result.value.kind !== 'no_focus'
            || !sameNoFocus(result.value, closure.decision)) {
            return await canaryFailure(ctx, agent, message)
          }
          const advice = candidateAdvice.acceptMatterRelation(result.value)
          if (advice.kind !== 'business_result') return await canaryFailure(ctx, agent, message)
          return await knownUnavailable(ctx, agent, message, async () => {})
        }
        if (isAnyNoFocusRecord(existing)) return await canaryFailure(ctx, agent, message)
        if (text !== '这件事结束了' && text !== '继续') return await canaryFailure(ctx, agent, message)
        if (text === '这件事结束了') {
          const proposal = await auxiliary.propose(text, origin, signal)
          const result = focusAuthority.fromBoundProposal(proposal)
            .decideFocus(createExplicitUserExpression(text, sessionId as ChatRef, origin))
          const noFocusDecision = result.kind === 'business_result' ? result.value : undefined
          if (result.kind !== 'business_result'
            || noFocusDecision?.kind !== 'no_focus'
            || proposal.kind !== 'proposal'
            || proposal.value.kind !== 'close') {
            return await canaryFailure(ctx, agent, message)
          }
          const advice = candidateAdvice.acceptMatterRelation(noFocusDecision)
          if (advice.kind !== 'business_result') return await canaryFailure(ctx, agent, message)
          const pending: NoFocusCanaryRecord = {
            focus: existing,
            closure: {
              phase: 'pending',
              original: origin,
              proposal: { kind: proposal.value.kind, relation: proposal.value.relation },
              decision: {
                kind: noFocusDecision.kind,
                ref: noFocusDecision.ref,
                chat: noFocusDecision.chat,
                latestCorrections: noFocusDecision.latestCorrections,
              },
            },
          }
          // Do not append the claimed close input before this durable pending
          // sidecar write. If later physical proof fails, restart sees pending
          // and remains fail-closed rather than treating it as no-focus.
          await table.put(sessionId, pending)
          const physicallyProved: NoFocusCanaryRecord = {
            ...pending,
            closure: { ...pending.closure, phase: 'physically_proved' },
          }
          return await knownUnavailable(ctx, agent, message, async () => {
            await table.put(sessionId, physicallyProved)
          }, async () => {
            try {
              const carrier = validatedNoFocusCarrier(physicallyProved)
              if (carrier === undefined) throw new Error('physically-proved no-focus carrier is not a fresh exact sidecar row')
              const entered = await noFocusHarness.enter({
                sessionId,
                session: agent.session,
                record: carrier,
                close: physicallyProved.closure.original,
                // The live transaction consumes the actual C01 result that
                // this natural close branch just established, never a
                // reconstituted sidecar projection.
                decision: noFocusDecision,
                save: async record => {
                  const parsed = noFocusCanaryRecordSchema.safeParse(record)
                  if (!parsed.success) throw new Error('canonical transaction sidecar record failed exact schema validation')
                  await table.put(sessionId, parsed.data)
                },
                flush: async () => {
                  const sessions = sessionsFlushPort(ctx)
                  if (sessions === undefined) throw new Error('canonical state has no persistence listener')
                  return await sessions.flush(agent.session)
                },
                readFrom: async fromSeq => {
                  const persistence = sessionPersistencePort(ctx)
                  if (persistence === undefined) throw new Error('canonical state persistence is unavailable')
                  return await persistence.readFrom(sessionId, fromSeq)
                },
              })
              // H2 already appended the close manually. Discard every base
              // projection and return only this finalized interaction notice,
              // so AgentLoop cannot append the same close id a second time.
              return { kind: 'enter', messages: [entered.notice] }
            } catch {
              return managedFailure.afterPhysicallyProvedInput({ physicallyProved: true })
            }
          })
        }
        if (text !== '继续') return await canaryFailure(ctx, agent, message)
        if (hasLaterDirectUserEvidence(agent, existing)) return await canaryFailure(ctx, agent, message)
        const original = originalFromSession(agent, existing)
        const originalText = original === undefined ? undefined : textOf(original)
        if (originalText === undefined
          || directExpressionHash(existing.original.messageId, originalText) !== existing.original.hash) {
          return await canaryFailure(ctx, agent, message)
        }
        const storedOrigin = { messageId: existing.original.messageId, hash: existing.original.hash }
        const result = focusAuthority.fromBoundProposal({
          kind: 'proposal',
          origin: storedOrigin,
          value: { kind: 'focus', relation: 'new', subject: existing.proposal.subject, origin: storedOrigin },
        }).decideFocus(createExplicitUserExpression(originalText, sessionId as ChatRef, storedOrigin))
        if (result.kind !== 'business_result'
          || result.value.kind !== 'focus_established'
          || !sameFocus(result.value, existing.decision)) {
          return await canaryFailure(ctx, agent, message)
        }
        decision = result.value
        // This durable no-shape-change write is the restart transaction's
        // commit point: the same pre-canonical projection may be retained only
        // after C01 has independently re-established every decision field.
        await table.put(sessionId, {
          ...existing,
          decision: {
            kind: decision.kind,
            ref: decision.ref,
            chat: decision.chat,
            currentMatter: decision.currentMatter,
            latestCorrections: decision.latestCorrections,
          },
        })
      }
      const advice = candidateAdvice.acceptMatterRelation(decision)
      const presentation = presentFocusCanaryAdvice(advice)
      if (presentation === undefined) return await canaryFailure(ctx, agent, message)
      return {
        kind: 'enter',
        messages: [...base.messages, createUserMessage({
          content: [{ type: 'text', text: presentation }],
          source: { kind: 'plugin', plugin: 'ui-context-compactor:focus-canary-advice', form: 'notice', summary: 'focus canary advice' },
        })],
      }
    } catch (error) {
      if (isCanaryFailure(error)
        || isManagedFailure(error)
        || error instanceof Error && error.message === FOCUS_CANARY_UNAVAILABLE_TEXT) throw error
      return await canaryFailure(ctx, agent, message)
    }
  }, { prepend: true })

  return Object.freeze({
    async request(agent: Agent): Promise<boolean> {
      const recoveryGate = recoveryGates.get(agent)
      if (!managed(agent, classifier)
        || recoveryGate !== undefined && recoveryGate.kind !== 'ready') return false
      const sessionId = String(agent.session.id)
      let before: BackgroundStateRecord | undefined
      try {
        const stored = domain.table('focus_precanonical').get(sessionId)
        before = stored !== undefined && isBackgroundStateRecord(stored)
          ? parseCanonicalBackgroundStateRecord(stored)
          : undefined
      } catch {
        return false
      }
      const prior = before?.transaction
      if (prior?.phase !== 'finalized') return false
      const nativeBefore = agent.session.events.filter(event => event.type.startsWith('compaction/')).length
      const direct = createUserMessage({
        content: [{ type: 'text', text: '请更新当前背景' }],
        source: { kind: 'user' },
      })
      try {
        agent.followup(direct)
        await agent.whenIdle()
        const stored = domain.table('focus_precanonical').get(sessionId)
        const after = stored !== undefined && isBackgroundStateRecord(stored)
          ? parseCanonicalBackgroundStateRecord(stored)?.transaction
          : undefined
        const exactDirect = agent.session.events.filter(event => event.type === 'user/message'
          && event.data.source.kind === 'user' && String(event.data.id) === String(direct.id))
        const nativeAfter = agent.session.events.filter(event => event.type.startsWith('compaction/')).length
        return after?.phase === 'finalized'
          && after.generation === prior.generation + 1
          && after.canonicalRef !== prior.canonicalRef
          && exactDirect.length === 1
          && nativeAfter === nativeBefore
      } catch {
        return false
      }
    },
  })
}

function isRootSession(delegationDepth: number | undefined): boolean {
  return (delegationDepth ?? 0) === 0
}

function warnRouteFailure(ctx: Context, code: RouteUpdateFailureCode): void {
  const message = `ui-context-compactor: route update failed (${code}); raw Session history is retained and compaction stays blocked until a later successful update`
  ctx.logger.warn(message)
  // Cordis always buffers the record, but some Web profiles have no stdout
  // logger exporter. Keep the diagnostic fixed-code and secret-free.
  console.warn(message)
}

/** Count fully completed root turns after the latest successful compaction transaction. */
export function completedTurnsSinceLastSuccessfulCompaction(
  events: readonly (SessionEvent | undefined)[],
): number {
  let latestSuccessfulCompactionEnd = -1
  for (const event of events) {
    if (event?.type === 'compaction/end' && event.data.error === undefined) {
      latestSuccessfulCompactionEnd = event.seq
    }
  }
  let completed = 0
  for (const event of events) {
    if (event !== undefined
      && event.seq > latestSuccessfulCompactionEnd
      && event.type === 'turn/end'
      && event.data.reason.kind === 'completed') completed += 1
  }
  return completed
}

function warnPeriodicCompactionFailure(ctx: Context, code: 'stale-route' | 'backend-call'): void {
  ctx.logger.warn(
    `ui-context-compactor: periodic compaction failed (${code}); raw Session history is retained and the next completed root turn will retry`,
  )
}

/** Register stable route policy, rearming, stale recovery, and turn-end reduction. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const resolved = resolveConfig(config)
  const compactEveryTurns = resolveCompactEveryTurns(config.compactEveryTurns)
  // Observe is intentionally a compatibility/no-op mode: it must not change
  // admission, storage, request contents, provider dispatch, or user output.
  // The H1 Harness chain is explicitly enforce-only.
  const enforcedCanary = config.focusCanary?.mode === 'enforce'
    ? config.focusCanary
    : undefined
  const nativeWriterArbitration = config.nativeWriterArbitration?.mode === 'enforce'
  const evidenceCanary = config.evidenceCanary?.mode === 'enforce'
  const enforcedRuntime = enforcedCanary === undefined
    ? undefined
    : resolveManagedRuntimeConfig({
      mode: enforcedCanary.mode,
      ...enforcedCanary.safeUpdateMarginTokens === undefined
        ? {}
        : { safeUpdateMarginTokens: enforcedCanary.safeUpdateMarginTokens },
      allowlist: enforcedCanary.allowlist,
    })
  // `ctx.inject()` is lifecycle registration, not an activation barrier.
  // Reject before installing the managed policy/listeners when an explicitly
  // enabled canary lacks either original H1 public host service.
  const storageDomain = ctx.get('storageDomain')
  const tokenMeter = ctx.get('tokenMeter')
  const evidenceWeb = evidenceCanary ? ctx.get('web') : undefined
  if (enforcedCanary !== undefined && (storageDomain === undefined || tokenMeter === undefined)) {
    throw new Error('ui-context-compactor: focus canary enforce requires storageDomain and tokenMeter')
  }
  if (evidenceCanary && enforcedCanary === undefined) {
    throw new Error('ui-context-compactor: evidence canary requires focus canary enforce mode')
  }
  if (evidenceCanary && evidenceWeb === undefined) {
    throw new Error('ui-context-compactor: evidence canary enforce requires the web service')
  }
  if (nativeWriterArbitration && enforcedRuntime === undefined) {
    throw new Error('ui-context-compactor: native writer arbitration requires focus canary enforce mode')
  }
  if (enforcedRuntime !== undefined) validateFocusCanaryAllowlist(enforcedRuntime)
  // Basic registers automatic listeners while the managed engine constructs;
  // the profile composes that engine synchronously before any Agent creation.
  // Once enabled, every context-manager gate reuses the engine's exact
  // classifier after the resolved H1 allowlist has been compared as a set.
  const managedCompaction = nativeWriterArbitration
    ? resolveManagedCompaction(ctx, enforcedRuntime!)
    : undefined
  // Open and validate the sidecar before registering the classifier with any
  // route listener. A bad medium/schema is a startup failure, never a first
  // managed input that silently falls through legacy handling.
  const canaryDomain = enforcedRuntime === undefined
    ? undefined
    : await storageDomain!.open(focusCanaryDomainSpec)
  // The caller owns an opened Domain. Attach the disposer before any later
  // system-prompt, listener, or optional-compaction registration can throw;
  // a failed plugin apply must leave the named domain reopenable.
  if (canaryDomain !== undefined) {
    ctx.effect(() => () => canaryDomain.close(), 'ui-context-compactor.focusCanaryDomain')
  }
  const classifier = enforcedRuntime === undefined
    ? undefined
    : managedCompaction?.classifier ?? new ManagedInteractiveRootClassifier(enforcedRuntime)

  ctx.systemPrompt.context({
    name: 'context-route:policy',
    order: -80,
    text: ({ agent }) => {
      if (agent === undefined
        || managed(agent, classifier)
        || !isRootSession(agent.session.header.delegationDepth)) return ''
      return renderRouteBootstrapContext(String(agent.session.id))
    },
  })

  // Run after downstream pre-step listeners. If automatic compaction just
  // shadowed the route, the same request receives a rearm before dispatch.
  // If a completed turn's reducer attempt failed, recover before the next
  // conversation request. Do not reduce after every tool step inside one
  // still-running turn: those facts remain in the visible working tail and
  // the normal turn-stopping checkpoint folds the whole turn once.
  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject'
      || managed(agent, classifier)
      || !isRootSession(agent.session.header.delegationDepth)
      || signal.aborted) return decision
    const projection = foldRoute(agent.session.events)
    if (routeNeedsCompletedTurnRecovery(
      agent.session.events,
      projection?.snapshot.asOfSeq ?? -1,
    )) {
      try {
        await updateRoute(ctx, agent, resolved, signal)
      } catch (error: unknown) {
        if (!signal.aborted) warnRouteFailure(ctx, routeUpdateFailureCode(error))
      }
      return decision
    }
    if (projection !== undefined
      && routeNeedsRearm(agent.session.events, agent.session.surface.nodes)) {
      try {
        agent.session.append(
          'user/message',
          createRouteRearmMessage(String(agent.session.id), projection.snapshot),
          { surfaceOp: 'append' },
        )
      } catch {
        warnRouteFailure(ctx, 'append')
      }
    }
    return decision
  })

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (managed(agent, classifier) || !isRootSession(agent.session.header.delegationDepth)) return
    try {
      await updateRoute(ctx, agent, resolved, signal)
    } catch (error: unknown) {
      if (signal.aborted) return
      warnRouteFailure(ctx, routeUpdateFailureCode(error))
    }
  })

  // `turn-stopping` still runs inside the active driver, so forced compaction
  // cannot safely use the idle-only backend there. Recompute the durable count
  // when the root agent becomes idle, then let compactNow reserve maintenance.
  // A failure writes no surface replacement; because only a successful
  // compaction/end resets the count, the next completed turn retries once.
  if (compactEveryTurns !== undefined) {
    ctx.inject(['compaction'], (compactionCtx) => {
      compactionCtx.on('agent/status', ({ agent, status }) => {
        if (status !== 'idle'
          || managed(agent, classifier)
          || !isRootSession(agent.session.header.delegationDepth)
          || completedTurnsSinceLastSuccessfulCompaction(agent.session.events) < compactEveryTurns) return
        try {
          assertRouteFreshForCompaction(agent.session.events, agent.session.surface.nodes)
        } catch {
          warnPeriodicCompactionFailure(compactionCtx, 'stale-route')
          return
        }
        try {
          void compactionCtx.compaction.compactNow(agent, new AbortController().signal).then((result) => {
            if (result === null) warnPeriodicCompactionFailure(compactionCtx, 'backend-call')
          }, () => {
            warnPeriodicCompactionFailure(compactionCtx, 'backend-call')
          })
        } catch {
          warnPeriodicCompactionFailure(compactionCtx, 'backend-call')
        }
      })
    })
  }
  if (enforcedCanary !== undefined) {
    const compactRequest = installFocusCanary(
      ctx, enforcedCanary, classifier!, canaryDomain!, tokenMeter!, evidenceWeb,
    )
    if (managedCompaction !== undefined) {
      installManagedCompactCommand(ctx, classifier!, compactRequest)
    }
  }
}

export {
  assertRouteFreshForCompaction,
  buildRouteMaterial,
  containsSecret,
  createRouteRearmMessage,
  createRouteRevisionMessage,
  decodeRouteMessage,
  decodeRouteRevision,
  foldRoute,
  isHumanAnswerEvent,
  isRouteContextEvent,
  isRouteRelevantEvent,
  latestRouteContextSeq,
  latestRouteRelevantSeq,
  parseRouteBody,
  renderRouteBootstrapContext,
  renderRouteContext,
  renderRouteMessageContent,
  renderLargeToolResultReference,
  routeNeedsCompletedTurnRecovery,
  routeNeedsRearm,
  routeBodyFailureCode,
  ROUTE_CONTEXT_SOURCE,
  shouldPreprocessLargeToolResult,
  type CurrentRoute,
  type BuildRouteMaterialConfig,
  type DetailReference,
  type DetailSourceKind,
  type LargeToolResultPreprocessingConfig,
  type RetiredRoute,
  type RetiredRouteStatus,
  type RouteBody,
  type RouteBodyFailureCode,
  type RouteContextSource,
  type RouteDecision,
  type RoutePublication,
  type RouteProjection,
  type RouteRevisionData,
  type RouteSnapshot,
  type RouteStatement,
  type RouteStatus,
} from './route.ts'
export {
  routeReducerSystemPrompt,
  routeUpdateFailureCode,
  updateRoute,
  type RouteReducerConfig,
  type RouteUpdateFailureCode,
} from './reducer.ts'
export {
  ManagedAwareBasicCompactionEngine,
  ManagedAwareBasicCompactionConfigSchema,
  type ManagedCompactionRuntimeConfig,
  type ManagedAwareBasicCompactionConfig,
} from './managed-compaction.ts'
