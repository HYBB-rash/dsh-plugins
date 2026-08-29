# Technical Debt

## Quality Gate

Clean-code score: **9/10**. Required score: **8/10**.

| Dimension | Score | Evidence |
|---|---:|---|
| Names reveal intent | 9 | The public vocabulary is input, judgment, selection, empty, and failure. |
| Functions stay focused | 9 | Validation, model adaptation, and runtime installation have separate reasons to change. |
| Failure handling is explicit | 10 | Discriminated results separate genuine empty from invalid input, provider failure, timeout, abort, and invalid output. |
| Comments explain contracts | 9 | Comments identify boundaries and invariants; they do not narrate statements. |
| Tests protect behavior | 9 | 41 focused tests cover core, adapter, scope, and release seams. |
| Dependency surface is minimal | 9 | The unused system-prompt dependency and redundant type assertion were removed. |

## Smell Inventory

| Smell | Location | Decision | Status |
|---|---|---|---|
| Escaped port exception | `selectAttention` | Contain it at the use-case boundary and preserve abort. | resolved by test |
| Implicit successful stream termination | DSH model adapter | Require an observed terminal `finish` chunk. | resolved by test |
| Redundant type assertion | Plugin composition root | Apply **Remove Redundant Type Assertion**. | resolved |
| Dead package dependency | Package manifest | Apply **Remove Dead Dependency**. | resolved |

No long method, duplicated business rule, primitive obsession, speculative abstraction, or framework dependency in the core justified another refactoring. Under the Rule of Three, the two small exact-key helpers remain local to their distinct trust boundaries.

## Refactoring Log

| Date | Named refactoring | Behavior change | Verification |
|---|---|---|---|
| 2026-08-29 | Remove Redundant Type Assertion | none | focused type/build/test gate |
| 2026-08-29 | Remove Dead Dependency | none | focused type/build/test gate |

## Complexity Review

The module exposes one deep public operation: supply personal context and candidate material; receive one supplied URL, an honest empty, or an explicit failure. Strict shape validation, prompt isolation, route selection, stream assembly, and index-to-URL mapping remain hidden.

The implementation intentionally does not introduce repositories, domain services, ranking objects, acquisition pipelines, profile storage, summary types, or provider-specific public interfaces. Each would add a concept without enabling the first delivery requirement.

## Debt Ledger

| Item | Impact | Decision |
|---|---|---|
| Phase 6 habit/process rollout | No candidate behavior impact. | Deferred by explicit scope; revisit only after this slice is accepted. |
| Real-model judgment acceptance | Candidate contracts can pass while semantic quality remains unverified. | Gate on availability of an isolated non-production model credential; never substitute production credentials. |

There is no unrecorded known code debt at the candidate boundary.
