import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BackgroundCandidateFormation, CandidateBasisFreshnessReviewer, CandidateContentReviewer, bindCurrentCanonicalGeneration, renderCandidateBackground, type CandidateAssemblySnapshot, type CandidatePreparationSnapshot, type FixedH1CandidateBudgetProof, type RollingCandidateRuntimeEvidence } from '../src/candidate.ts'
import { CandidateQualificationAuthority, type CandidateQualificationIssue, type C28Result } from '../src/candidate-qualification.ts'
import type { ActionFactBoundary } from '../src/action-boundary.ts'
import type { EvidenceConclusionSet } from '../src/fact-resolution.ts'
import type { ChatRef, FocusDecision } from '../src/focus.ts'
import type { CanonicalBackgroundState } from '../src/state-transaction.ts'

const chat = 'session-context-manager-focus-canary-a' as ChatRef
const otherChat = 'session-context-manager-focus-canary-b' as ChatRef

function frozen<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}

function basis(tag: string, target = chat) {
  const fact = `fact:${tag}`
  const conclusion = { kind: 'direct_fact', fact, meaning: `version:${tag}`, source: `source:${tag}`, degree: 'established' }
  return frozen({
    focus: { kind: 'focus_established', ref: `focus:${tag}`, chat: target, currentMatter: `matter:${tag}`, latestCorrections: `correction:${tag}` },
    action: { kind: 'actionable', ref: `action:${tag}`, chat: target, requiredFacts: { ref: `needs:${tag}`, requirements: [{ fact, neededFor: [`next:${tag}`] }] }, usableFacts: [conclusion], unresolvedFacts: [], preciselyBlockedActions: [], safelyContinuableActions: [`next:${tag}`] },
    evidence: { ref: `evidence:${tag}`, chat: target, conclusions: [conclusion] },
  }) as unknown as { readonly focus: Extract<FocusDecision, { readonly kind: 'focus_established' }>; readonly action: ActionFactBoundary; readonly evidence: EvidenceConclusionSet }
}

function withoutChat<Value extends { readonly chat: ChatRef }>(value: Value): Omit<Value, 'chat'> {
  const { chat: _chat, ...rest } = value
  return frozen(structuredClone(rest))
}

function runtime(input: ReturnType<typeof basis>, tag: string, overBudget = false): RollingCandidateRuntimeEvidence {
  const body = renderCandidateBackground({ target: input.focus.chat, focus: withoutChat(input.focus), action: withoutChat(input.action), evidence: withoutChat(input.evidence), knownFutureCriticalPoints: Object.freeze([]) })
  const origin = Object.freeze({ messageId: `direct:${tag}`, hash: `hash:${tag}` })
  const assembly = Object.freeze({ fingerprint: `assembly:${tag}`, provider: 'test', model: 'test', headerFingerprint: `header:${tag}`, contextFingerprint: `context:${tag}`, revision: 1, directMessageId: origin.messageId, directHash: origin.hash, directText: `action:${tag}`, directChat: input.focus.chat, baseInputTokens: 100 }) as CandidateAssemblySnapshot
  const preparation = Object.freeze({ fingerprint: `prepare:${tag}`, provider: 'test', model: 'test', contextWindow: 1_000, outputTokens: 100 }) as CandidatePreparationSnapshot
  const proof = Object.freeze({ kind: 'fixed_h1_known_envelope', firstAssembly: assembly, secondAssembly: Object.freeze({ ...assembly }), firstPreparation: preparation, secondPreparation: Object.freeze({ ...preparation }), bodyHash: createHash('sha256').update(body).digest('hex'), bodyTokens: overBudget ? 900 : 100, safeUpdateMarginTokens: 10 }) as FixedH1CandidateBudgetProof
  return frozen({ chat: input.focus.chat, origin, budget: proof })
}

function current(input: ReturnType<typeof basis>): CanonicalBackgroundState {
  const state = frozen({ kind: 'background', ref: 'canonical:1', target: input.focus.chat, candidateRef: 'candidate:prior', focus: input.focus, boundary: input.action }) as CanonicalBackgroundState
  bindCurrentCanonicalGeneration(state, 1)
  return state
}

function pipeline(input: ReturnType<typeof basis>) {
  const c28: C28Result[] = []
  const issues: CandidateQualificationIssue[] = []
  const qualification = new CandidateQualificationAuthority({
    observer: { acceptCandidateQualification(decision): C28Result { const report = frozen({ kind: 'business_result', identity: { contract: 'C28', call: `C28:${decision.candidate.ref}`, subject: { kind: 'candidate', candidate: decision.candidate } }, value: { kind: 'accepted_for_contract', value: decision } }) as C28Result; c28.push(report); return report } },
    userAdvice: { acceptCandidateQualificationIssue(issue) { issues.push(issue); return frozen({ kind: 'business_result', identity: { contract: 'C42', call: 'C42:test', subject: issue.subject }, value: { kind: 'accepted_for_contract', value: issue } }) as never } },
  })
  const content = new CandidateContentReviewer({ qualification })
  const freshness = new CandidateBasisFreshnessReviewer({ qualification })
  const formation = new BackgroundCandidateFormation({ qualification, contentReview: content, freshnessReview: freshness, runtimeEvidence: { takeExplicitUpdateEvidence: () => undefined } })
  formation.acceptFocusBasis(input.focus); formation.acceptActionFactBoundary(input.action); formation.acceptEvidenceConclusions(input.evidence)
  content.acceptRequiredFocus(input.focus); content.acceptRequiredActionFacts(input.action); content.acceptEvidenceConclusions(input.evidence)
  freshness.acceptCurrentFocus(input.focus); freshness.acceptCurrentActionFacts(input.action); freshness.acceptCurrentEvidence(input.evidence)
  return { formation, c28, issues }
}

describe('F01-T4 rolling and identical candidate qualification', () => {
  it('P1 rolls a completed web-evidence action into generation two before its final request', () => {
    const input = basis('web'); const run = pipeline(input); run.formation.acceptCurrentCanonicalState(current(input))
    expect(run.formation.requestRollingCandidate({ chat, generation: 1, runtimeEvidence: runtime(input, 'web') })).toBe(true); expect(run.c28).toHaveLength(1)
  })
  it('P2 rolls an authenticated completed tool-progress action with its next limitation', () => {
    const input = basis('tool'); const run = pipeline(input); run.formation.acceptCurrentCanonicalState(current(input))
    run.formation.requestRollingCandidate({ chat, generation: 1, runtimeEvidence: runtime(input, 'tool') }); expect(run.c28[0]?.value.kind).toBe('accepted_for_contract')
  })
  it('P3 emits an identical qualified reference only after body and projection equality', () => {
    const input = basis('identical'); const run = pipeline(input); run.formation.acceptCurrentCanonicalState(current(input)); run.formation.requestRollingCandidate({ chat, generation: 1, runtimeEvidence: runtime(input, 'identical') })
    const candidate = run.c28[0]?.kind === 'business_result' ? run.c28[0].value.value.candidate : undefined
    expect(candidate?.background).toBe(renderCandidateBackground({ target: chat, focus: withoutChat(input.focus), action: withoutChat(input.action), evidence: withoutChat(input.evidence), knownFutureCriticalPoints: Object.freeze([]) }))
  })
  it('N1 ignores assistant-only completion claims without C14/C15', () => { const input = basis('assistant'); const run = pipeline(input); expect(run.formation.requestRollingCandidate({ chat, generation: 1, runtimeEvidence: runtime(input, 'assistant') })).toBe(false); expect(run.c28).toHaveLength(0) })
  it('N2 rejects C41 and C14/C15 from different chats or generations', () => { const input = basis('chat'); const run = pipeline(input); run.formation.acceptCurrentCanonicalState(current(input)); expect(run.formation.requestRollingCandidate({ chat: otherChat, generation: 1, runtimeEvidence: runtime(basis('other', otherChat), 'other') })).toBe(false); expect(run.formation.requestRollingCandidate({ chat, generation: 2, runtimeEvidence: runtime(input, 'generation') })).toBe(false) })
  it('N3 reports C42 when a future-critical point is omitted', () => { const input = basis('missing'); const run = pipeline(input); run.formation.acceptCurrentCanonicalState(current(input)); run.formation.requestRollingCandidate({ chat, generation: 1, runtimeEvidence: { ...runtime(input, 'missing'), futureCriticalPoints: { kind: 'unavailable', auxiliaryCalls: 0 } } }); expect(run.issues).toHaveLength(1) })
  it('N4 reports C42 without truncation when mandatory material exceeds budget', () => { const input = basis('budget'); const run = pipeline(input); run.formation.acceptCurrentCanonicalState(current(input)); run.formation.requestRollingCandidate({ chat, generation: 1, runtimeEvidence: runtime(input, 'budget', true) }); expect(run.issues).toHaveLength(1); expect(run.c28).toHaveLength(0) })
  it('N5 never accepts an identical marker when only the body matches', () => { const input = basis('projection'); const run = pipeline(input); run.formation.acceptCurrentCanonicalState(current(input)); run.formation.requestRollingCandidate({ chat, generation: 1, runtimeEvidence: runtime(input, 'projection') }); expect(run.c28[0]?.identity.subject.kind).toBe('candidate') })
  it('N6 leaves provider calls at zero for invalid rolling material', () => { const input = basis('invalid'); const run = pipeline(input); expect(run.formation.requestRollingCandidate({ chat, generation: 1, runtimeEvidence: runtime(input, 'invalid') })).toBe(false); expect(run.c28).toHaveLength(0); expect(run.issues).toHaveLength(0) })
})
