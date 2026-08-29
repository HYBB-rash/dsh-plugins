# Testing

## Safety Net Map

| Behavior or seam | Test level | Evidence | Failure protected against |
|---|---|---|---|
| Strict input shape, X-only HTTPS URLs, and 40,000-character bound | Unit | `tests/core.spec.ts` | Invalid or unbounded material reaches the model. |
| Genuine empty, exact supplied URL, and explicit execution failure | Unit | `tests/core.spec.ts` | Failure is presented as “nothing qualifies”, or the system invents a URL. |
| Provider route, timeout, abort, stream completion, and exact JSON protocol | Adapter unit | `tests/model-adapter.spec.ts` | Partial, malformed, injected, or failed model output becomes a selection. |
| Web/Telegram root scope and child/cron exclusion | Plugin unit | `tests/plugin.spec.ts` | The operation leaks into an unapproved runtime scope. |
| Package, profile, topology, and Skill installation declarations | Contract | `tests/release-contract.spec.ts` | A candidate builds but omits the selector from a delivery surface. |
| Type check, bundle, and all package tests in the repository image | Build gate | `./release/dsh dev verify --source <worktree>` | Editable-source behavior differs from the archived release input. |
| Web and Telegram profile startup with fake external transport | Runtime gate | `./release/dsh dev prepare --source <worktree>` | Composition is valid on paper but fails to boot. |
| Immutable image build and image self-tests | Candidate gate | `./release/dsh build --purpose release ...` | The tested source cannot become a reproducible candidate. |

## Test Strategy

New behavior was developed RED–GREEN. Existing release and profile seams were characterized before they were extended. The core tests use a fake `SemanticJudge`; the adapter tests use a synthetic model stream. This keeps business-empty, provider failure, malformed output, timeout, and abort deterministic and independently testable.

The highest-risk invariant is negative: only a URL from the caller's candidate list may be returned, and a failed judgment must remain a failure. Those checks live in the framework-free use case so every delivery surface shares them.

## Test Data

Fixtures contain synthetic X URLs and synthetic post text. They do not read the archived Feed implementation, production state, user credentials, Telegram, or external content. Candidate text is deliberately treated as untrusted prompt material.

## Required Gates

Before committing a behavior or structural change:

1. Run the focused package verification.
2. Keep all previously green tests green.
3. Commit behavior changes separately from structural refactoring.

Before producing a release candidate:

1. Rebase on the latest `origin/main`.
2. Run full editable-source verification for all packages.
3. Validate the product Skill.
4. Boot the isolated Web and Telegram-test compositions.
5. Build one immutable release candidate from the clean commit.

## Acceptance Boundary

A unit or fake-adapter pass proves contracts and failure semantics, not the quality of a real model's judgment. Real-model acceptance therefore requires an isolated non-production credential and synthetic fixtures. Production credentials, Telegram delivery, and production state are outside this task. If no isolated credential is available, the candidate can be built but the real-model gate remains explicitly unverified.
