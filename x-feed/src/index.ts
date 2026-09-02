/**
 * X feed business runtime.
 *
 * This package deliberately has no Cordis plugin entry. dsh-cron and the
 * Telegram gateway own their lifecycles and load the two business adapters
 * exported here through generic extension ports.
 */

import {
  createPersonalFeedXStartupFromPackageEntry as createStartupFromPackageEntry,
  runPersonalFeedXStartupSelfTestFromPackageEntry as runStartupSelfTestFromPackageEntry,
} from './personal-feed/x-startup.ts'

export {
  parseXFeedRuntimeConfig,
  resolveDataDir,
  resolvePipelinePath,
  type ResolvedXFeedRuntimeConfig,
  type XFeedRuntimeConfig,
} from './config.ts'

export {
  createTrustedFactNavigation,
  installTelegramExtension,
  X_FEED_CONTRACT,
} from './telegram-extension.ts'

export {
  createXFeedCronEnvironmentProvider,
  X_CRON_AGENT_ENVIRONMENT_MARKER,
  X_CRON_ENVIRONMENT_REQUIREMENTS,
  type XFeedCronProviderOptions,
} from './x-cron/provider.ts'

/** Compose the production Personal Feed X runtime from this package entry. */
export function createPersonalFeedXStartup(runtimeConfig: unknown): Readonly<{
  readonly observe: (input: unknown) => Promise<unknown>
  readonly shutdown: () => Promise<void>
}> {
  if (arguments.length !== 1) throw new Error('Unable to create personal-feed X startup')
  return createStartupFromPackageEntry(import.meta.url, runtimeConfig)
}

/** Verify the shipped Personal Feed X Python child without touching business data. */
export function runPersonalFeedXStartupSelfTest(): Promise<unknown> {
  if (arguments.length !== 0) return Promise.reject(new Error('Unable to run personal-feed X startup self-test'))
  return runStartupSelfTestFromPackageEntry(import.meta.url)
}

export {
  NAVIGATION_SCHEMA_VERSION,
  RebuildTrustedFactNavigation,
  TrustedFactNavigationProjector,
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
} from './trusted-facts/index.ts'

export {
  createFactProjectionPreflight,
  createBoundFactProjectionPreflight,
  preflightFactProjectionWithAssessmentBinder,
  candidateFingerprint,
  fingerprintCandidate,
  type ApplicationLevel,
  type AssessmentEssentiality,
  type AssessmentRelevance,
  type AssessmentReadinessProbe,
  type AssessmentSnapshotBinder,
  type CandidateDescriptor,
  type CandidateFactAssessment,
  type CandidateFactAssessmentAudit,
  type CandidateFactAssessmentDecision,
  type CandidateFactAssessmentPort,
  type CandidateFactAssessmentRequest,
  type FactProjectionPreflightResult,
  type FactProjectionAssessmentBinderInput,
  type LookupFailure,
  type LookupResult,
  type LookupSuccess,
  type LookupTicket,
  type NavigationSegment,
  type NeutralNavigationInput,
  type ProjectedTrustedFact,
  type ProjectionBudget,
  type ProjectionFailure,
  type ProjectionNotReady,
  type ProjectionView,
  type ReadyFactProjectionSession,
} from './fact-projection/index.ts'
