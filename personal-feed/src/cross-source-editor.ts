import { createCandidatePeriodStore } from './candidate-period-store.ts'
import { createEditingInputStore } from './editing-input-store.ts'
import type {
  C10Result,
  CandidateMaterial,
  CrossSourceEditor,
  EditingInputAccepted,
} from './types.ts'

export interface CrossSourceEditorOptions {
  readonly candidatePeriodLedgerPath: string
  readonly editingInputLedgerPath: string
}

export function createCrossSourceEditor(options: CrossSourceEditorOptions): CrossSourceEditor {
  const candidatePeriodStore = createCandidatePeriodStore(options.candidatePeriodLedgerPath)
  const editingInputStore = createEditingInputStore(options.editingInputLedgerPath)

  return Object.freeze({
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
  })
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
