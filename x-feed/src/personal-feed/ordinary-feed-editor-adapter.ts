import type {
  ContractResult,
  CrossSourceEditor,
  EditingInputClosure,
  EditingInputClosureAccepted,
  FormalEditingConclusion,
  FormalFeedContentConclusion,
  FormalFeedContentDeliveryAccepted,
  PeriodBusinessFinalizer,
  PeriodIdentity,
  RawFeedContentConclusion,
  SourceCandidateReference,
} from '@herman/personal-feed'
import {
  createOrdinaryFeedEditingProposalValidator,
  type OrdinaryFeedEditingProposalValidationResult,
} from './ordinary-feed-editing-proposal.ts'

export type OrdinaryFeedEditorInputPort = Pick<
  CrossSourceEditor,
  'listAcceptedInputs' | 'formRawFeedContentConclusion'
>

export type OrdinaryFeedEditorFinalizerPort = Pick<
  PeriodBusinessFinalizer,
  'establishEditingInputClosure'
  | 'acceptEditingConclusion'
  | 'requestFormalContentDelivery'
>

export interface OrdinaryFeedEditorAdapterOptions {
  readonly period: PeriodIdentity
  readonly editor: OrdinaryFeedEditorInputPort
  readonly finalizer: OrdinaryFeedEditorFinalizerPort
}

export type OrdinaryFeedEditorResult = ContractResult<FormalFeedContentDeliveryAccepted, unknown>

export interface OrdinaryFeedEditorAdapter {
  readonly acceptEditingProposal: (input: unknown) => OrdinaryFeedEditorResult
}

export function createOrdinaryFeedEditorAdapter(
  options: OrdinaryFeedEditorAdapterOptions,
): OrdinaryFeedEditorAdapter {
  const proposalValidator = createOrdinaryFeedEditingProposalValidator({
    period: options.period,
    editor: options.editor,
  })

  return Object.freeze({
    acceptEditingProposal: (input: unknown): OrdinaryFeedEditorResult => {
      try {
        const proposal = proposalValidator.validateProposal(input)
        if (proposal.status !== 'accepted') return preserveFailure(proposal.status, input)

        const closure: EditingInputClosure = {
          period: options.period,
          candidatesInJudgment: proposal.value.decisions.candidatesInJudgment,
        }
        const closureResult = readContractResult<EditingInputClosureAccepted>(
          options.finalizer.establishEditingInputClosure(closure),
        )
        if (closureResult.status === 'invalid') return rejected(input)
        if (closureResult.status !== 'accepted') return preserveFailure(closureResult.status, input)
        if (!sameValue(closureResult.value, { closure })) return rejected(input)

        const rawResult = readContractResult<RawFeedContentConclusion>(
          options.editor.formRawFeedContentConclusion({
            closure: closureResult.value,
            content: proposal.value.content,
            decisions: proposal.value.decisions,
          }),
        )
        if (rawResult.status === 'invalid') return rejected(input)
        if (rawResult.status !== 'accepted') return preserveFailure(rawResult.status, input)
        if (!isExactRawConclusion(rawResult.value, closureResult.value, proposal.value)) {
          return rejected(input)
        }

        const conclusionResult = readContractResult<FormalEditingConclusion>(
          options.finalizer.acceptEditingConclusion(rawResult.value),
        )
        if (conclusionResult.status === 'invalid') return rejected(input)
        if (conclusionResult.status !== 'accepted') return preserveFailure(conclusionResult.status, input)
        if (!isExactOrdinaryConclusion(conclusionResult.value, rawResult.value, proposal.value)) {
          return rejected(input)
        }

        const request = { object: conclusionResult.value.content }
        const deliveryResult = readContractResult<FormalFeedContentDeliveryAccepted>(
          options.finalizer.requestFormalContentDelivery(request),
        )
        if (deliveryResult.status === 'invalid') return rejected(input)
        if (deliveryResult.status !== 'accepted') return preserveFailure(deliveryResult.status, input)
        return sameValue(deliveryResult.value, { request })
          ? deliveryResult
          : rejected(input)
      } catch {
        return failed(input)
      }
    },
  })
}

type ValidatedProposal = Extract<
  OrdinaryFeedEditingProposalValidationResult,
  { readonly status: 'accepted' }
>['value']

function isExactRawConclusion(
  value: unknown,
  closure: RawFeedContentConclusion['closure'],
  proposal: ValidatedProposal,
): value is RawFeedContentConclusion {
  const properties = readOwnDataProperties(value)
  if (properties === undefined
    || !hasExactPropertyKeys(properties, ['conclusion', 'closure', 'content', 'decisions'])) {
    return false
  }
  const conclusion = properties.get('conclusion')
  return typeof conclusion === 'string'
    && sameValue(value, {
      conclusion,
      closure,
      content: proposal.content,
      decisions: proposal.decisions,
    })
}

function isExactOrdinaryConclusion(
  value: unknown,
  raw: RawFeedContentConclusion,
  proposal: ValidatedProposal,
): value is FormalFeedContentConclusion {
  const properties = readOwnDataProperties(value)
  if (properties === undefined
    || !hasExactPropertyKeys(properties, ['period', 'original', 'content', 'decisions'])) {
    return false
  }
  const original = properties.get('original')
  if (typeof original !== 'string'
    || original !== raw.conclusion
    || !sameValue(properties.get('period'), raw.closure.closure.period)
    || !sameValue(properties.get('decisions'), proposal.decisions)) return false

  const content = properties.get('content')
  const contentProperties = readOwnDataProperties(content)
  if (contentProperties === undefined
    || !hasExactPropertyKeys(contentProperties, ['object', 'period', 'original', 'content', 'selected'])) {
    return false
  }
  if (typeof contentProperties.get('object') !== 'string'
    || contentProperties.get('original') !== raw.conclusion
    || !sameValue(contentProperties.get('period'), raw.closure.closure.period)
    || !sameValue(contentProperties.get('content'), proposal.content)) return false

  const selected = readOwnDataProperties(contentProperties.get('selected'))
  if (selected === undefined || !hasExactPropertyKeys(selected, ['candidates'])) {
    return false
  }
  const selectedCandidates = readDenseArray(selected.get('candidates'))
  if (selectedCandidates === undefined || selectedCandidates.length === 0) return false
  const expectedSelected = proposal.decisions.decisions
    .filter(decision => decision.kind === 'selected')
    .map(decision => decision.candidate)
  return sameCandidateReferences(selectedCandidates, expectedSelected)
}

function sameCandidateReferences(
  left: readonly unknown[],
  right: readonly SourceCandidateReference[],
): boolean {
  return left.length === right.length
    && left.every((candidate, index) => sameValue(candidate, right[index]))
}

function preserveFailure(
  status: 'rejected' | 'failed' | 'unknown',
  input: unknown,
): OrdinaryFeedEditorResult {
  if (status === 'rejected') return rejected(input)
  if (status === 'unknown') return { status: 'unknown', input }
  return failed(input)
}

function rejected(input: unknown): OrdinaryFeedEditorResult {
  return { status: 'rejected', input }
}

function failed(input: unknown): OrdinaryFeedEditorResult {
  return { status: 'failed', input }
}

type ReadContractResult<Accepted> =
  | { readonly status: 'accepted'; readonly value: Accepted }
  | { readonly status: 'rejected' | 'failed' | 'unknown'; readonly input: unknown }
  | { readonly status: 'invalid' }

function readContractResult<Accepted>(value: unknown): ReadContractResult<Accepted> {
  const properties = readOwnDataProperties(value)
  if (properties === undefined) return { status: 'invalid' }
  const status = properties.get('status')
  if (status === 'accepted' && hasExactPropertyKeys(properties, ['status', 'value'])) {
    return { status, value: properties.get('value') as Accepted }
  }
  if ((status === 'rejected' || status === 'failed' || status === 'unknown')
    && hasExactPropertyKeys(properties, ['status', 'input'])) {
    return { status, input: properties.get('input') }
  }
  return { status: 'invalid' }
}

function readOwnDataProperties(value: unknown): ReadonlyMap<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string')) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const properties = new Map<string, unknown>()
  for (const key of keys) {
    if (typeof key !== 'string') return undefined
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined
    properties.set(key, descriptor.value)
  }
  return properties
}

function hasExactPropertyKeys(
  value: ReadonlyMap<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = [...value.keys()].sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function sameValue(
  left: unknown,
  right: unknown,
  seen: WeakMap<object, WeakSet<object>> = new WeakMap(),
): boolean {
  if (!isObject(left) || !isObject(right)) return Object.is(left, right)
  if (Array.isArray(left) || Array.isArray(right)) {
    const leftValues = readDenseArray(left)
    const rightValues = readDenseArray(right)
    if (leftValues === undefined || rightValues === undefined || leftValues.length !== rightValues.length) {
      return false
    }
    if (hasSeenPair(seen, left, right)) return false
    rememberPair(seen, left, right)
    const equal = leftValues.every((value, index) => sameValue(value, rightValues[index], seen))
    forgetPair(seen, left, right)
    return equal
  }
  const leftProperties = readOwnDataProperties(left)
  const rightProperties = readOwnDataProperties(right)
  if (leftProperties === undefined || rightProperties === undefined) return false
  if (hasSeenPair(seen, left, right)) return false
  rememberPair(seen, left, right)
  const leftKeys = [...leftProperties.keys()].sort()
  const rightKeys = [...rightProperties.keys()].sort()
  const equal = leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameValue(leftProperties.get(key), rightProperties.get(key), seen))
  forgetPair(seen, left, right)
  return equal
}

function readDenseArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string')) return undefined
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  const length = lengthDescriptor !== undefined && 'value' in lengthDescriptor
    ? lengthDescriptor.value as unknown
    : undefined
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0
    || keys.length !== length + 1) return undefined
  const items: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined
    items.push(descriptor.value)
  }
  return items
}

function hasSeenPair(seen: WeakMap<object, WeakSet<object>>, left: object, right: object): boolean {
  return seen.get(left)?.has(right) === true
}

function rememberPair(seen: WeakMap<object, WeakSet<object>>, left: object, right: object): void {
  const rights = seen.get(left) ?? new WeakSet<object>()
  rights.add(right)
  seen.set(left, rights)
}

function forgetPair(seen: WeakMap<object, WeakSet<object>>, left: object, right: object): void {
  seen.get(left)?.delete(right)
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}
