export {
  createTrustedFact,
  isTrustedFact,
  type ApplicationLevel,
  type FactDimension,
  type FactEvidence,
  type FactEvidenceInput,
  type FactTarget,
  type TrustedFact,
  type TrustedFactInput,
  type TrustedFactResult,
} from './model.ts'

export {
  reduceFeedback,
  type FeedbackDecision,
  type FeedbackEffect,
  type FeedbackSignal,
  type FeedbackState,
} from './feedback-session.ts'

export {
  evaluateScopePolicy,
  type ScopeCandidate,
  type ScopePolicyRequest,
  type ScopePolicyResult,
} from './scope-policy.ts'

export {
  NAVIGATION_SCHEMA_VERSION,
  type LocatedTrustedFact,
  type LocatedTrustedFactReader,
  type LocatedTrustedFactSnapshot,
  type NavigationDerivation,
  type NavigationHintDeriver,
  type NavigationHints,
  type NavigationItem,
  type NavigationRelation,
  type NavigationSnapshot,
  type NavigationSnapshotWriter,
  type NavigationTargetRef,
  type Sha256Digest,
  type TrustedFactLocator,
} from './navigation-contract.ts'

export { TrustedFactNavigationProjector } from './navigation-projector.ts'
export { RebuildTrustedFactNavigation } from './rebuild-navigation.ts'
