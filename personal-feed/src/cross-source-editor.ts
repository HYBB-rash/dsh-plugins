import { createCandidatePeriodStore } from './candidate-period-store.ts'
import { createCurrentContextInputStore, currentContextInputReceiptFor } from './current-context-input-store.ts'
import { createEditingInputStore } from './editing-input-store.ts'
import { PersonalFeedScopeStoreError } from './errors.ts'
import { createPeriodScopeStore } from './store.ts'
import type {
  C10Result,
  C11Result,
  CandidateMaterial,
  ContextEnabledCrossSourceEditor,
  CurrentContextEditorOptions,
  CrossSourceEditor,
  CurrentContextProjectionPeriodScopeEstablished,
  CurrentContextResult,
  EditingInputAccepted,
  PeriodIdentity,
} from './types.ts'

export interface CrossSourceEditorOptions {
  readonly candidatePeriodLedgerPath: string
  readonly editingInputLedgerPath: string
}

export type ContextEnabledCrossSourceEditorOptions = CrossSourceEditorOptions & CurrentContextEditorOptions

export function createCrossSourceEditor(
  options: ContextEnabledCrossSourceEditorOptions,
): ContextEnabledCrossSourceEditor
export function createCrossSourceEditor(options: CrossSourceEditorOptions): CrossSourceEditor
export function createCrossSourceEditor(
  options: CrossSourceEditorOptions | ContextEnabledCrossSourceEditorOptions,
): CrossSourceEditor | ContextEnabledCrossSourceEditor {
  validateContextOptions(options)
  const candidatePeriodStore = createCandidatePeriodStore(options.candidatePeriodLedgerPath)
  const editingInputStore = createEditingInputStore(options.editingInputLedgerPath)
  const contextEnabled = 'periodScopeLedgerPath' in options
    && 'currentContextInputLedgerPath' in options
  const periodScopeStore = contextEnabled
    ? createPeriodScopeStore(options.periodScopeLedgerPath)
    : undefined
  const currentContextInputStore = contextEnabled
    ? createCurrentContextInputStore(options.currentContextInputLedgerPath)
    : undefined

  const editor: CrossSourceEditor = {
    acceptCandidateMaterial: (input: CandidateMaterial): C10Result => {
      try {
        if (!hasCompleteMaterial(input)) return { status: 'rejected', input }
        const accepted = candidatePeriodStore.findCandidate(input.period, input.candidate)
        if (accepted === undefined
          || !sameValue(accepted, input.acceptedIntoPeriod)
          || !sameValue(accepted.nomination, input.nomination)) {
          return { status: 'rejected', input }
        }

        const existing = editingInputStore.findByCandidate(input)
        if (existing !== undefined) {
          return sameValue(existing, input)
            ? acceptedInputResult(existing)
            : { status: 'rejected', input }
        }

        editingInputStore.append(input)
        return acceptedInputResult(deepFreeze(structuredClone(input)))
      } catch {
        return { status: 'failed', input }
      }
    },
    listAcceptedInputs: () => editingInputStore.list(),
  }
  if (!contextEnabled || periodScopeStore === undefined || currentContextInputStore === undefined) {
    return Object.freeze(editor)
  }
  return Object.freeze({
    ...editor,
    acceptCurrentContext: (input: CurrentContextResult): C11Result => {
      try {
        if (!isRecord(input) || (input.kind !== 'available' && input.kind !== 'unavailable')) {
          return { status: 'rejected', input }
        }
        const identity = currentContextIdentity(input)
        if (identity === undefined) return { status: 'rejected', input }
        const periodScope = periodScopeStore.list().find(record => samePeriod(record.c01.value.period, identity.period))
        if (periodScope === undefined || !sameValue(periodScope.c33.value, identity.scope)) {
          return { status: 'rejected', input }
        }

        const receipt = currentContextInputReceiptFor(input)
        if (receipt === undefined) return { status: 'rejected', input }
        const existing = currentContextInputStore.findByPeriod(identity.period)
        if (existing !== undefined) {
          return existing.digest === receipt.digest && existing.branch === receipt.branch
            ? { status: 'accepted', value: input }
            : { status: 'rejected', input }
        }
        currentContextInputStore.append(receipt)
        return { status: 'accepted', value: input }
      } catch {
        return { status: 'failed', input }
      }
    },
  })
}

function validateContextOptions(options: CrossSourceEditorOptions | ContextEnabledCrossSourceEditorOptions): void {
  const hasPeriodScopeLedger = 'periodScopeLedgerPath' in options
  const hasContextInputLedger = 'currentContextInputLedgerPath' in options
  if (hasPeriodScopeLedger !== hasContextInputLedger) {
    throw new PersonalFeedScopeStoreError(
      'personal Feed C11 requires both periodScopeLedgerPath and currentContextInputLedgerPath',
    )
  }
}

interface CurrentContextIdentity {
  readonly period: PeriodIdentity
  readonly scope: CurrentContextProjectionPeriodScopeEstablished
}

function currentContextIdentity(input: CurrentContextResult): CurrentContextIdentity | undefined {
  if (input.kind === 'available') {
    if (!isCurrentContext(input.context)
      || !samePeriod(input.context.scope.period, input.context.period)) return undefined
    return { period: input.context.period, scope: input.context.scope }
  }
  if (!isContextUnavailable(input.value)
    || !samePeriod(input.value.scope.period, input.value.period)) return undefined
  return { period: input.value.period, scope: input.value.scope }
}

function isCurrentContext(value: unknown): value is Extract<CurrentContextResult, { readonly kind: 'available' }>['context'] {
  return isRecord(value)
    && isContextScope(value.scope)
    && isPeriod(value.period)
    && Array.isArray(value.clues)
    && value.clues.every(isCurrentContextClue)
}

function isCurrentContextClue(value: unknown): boolean {
  return isRecord(value)
    && Object.hasOwn(value, 'factOwner')
    && Object.hasOwn(value, 'originalAttribution')
    && Object.hasOwn(value, 'exactLookup')
    && Object.hasOwn(value, 'currentFact')
}

function isContextUnavailable(value: unknown): value is Extract<CurrentContextResult, { readonly kind: 'unavailable' }>['value'] {
  return isRecord(value)
    && isContextScope(value.scope)
    && isPeriod(value.period)
    && Object.hasOwn(value, 'unavailableFact')
}

function isContextScope(value: unknown): value is { readonly period: { readonly run: string; readonly period: string } } {
  return isRecord(value) && isPeriod(value.period)
}

function isPeriod(value: unknown): value is { readonly run: string; readonly period: string } {
  return isRecord(value) && typeof value.run === 'string' && typeof value.period === 'string'
}

function samePeriod(left: { readonly run: string; readonly period: string }, right: { readonly run: string; readonly period: string }): boolean {
  return left.run === right.run && left.period === right.period
}

function acceptedInputResult(material: CandidateMaterial): C10Result {
  const value: EditingInputAccepted = { material }
  return { status: 'accepted', value }
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasCompleteMaterial(value: CandidateMaterial): boolean {
  return isRecord(value)
    && value.boundedContent !== undefined
    && value.attribution !== undefined
    && value.exactLookup !== undefined
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}
