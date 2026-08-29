# Improve Code Quality Plan

## Context

- Started: 2026-08-29.
- Product slice: select exactly one attention-worthy X post for a person's long-term interests and existing understanding, or return an honest empty result.
- Worst failure: treating an execution failure as “nothing is worth reading”, or selecting a URL the caller did not supply.
- Starting module: the new `personal-feed-selector` package plus the existing release/profile seams required to load it.
- Stack: TypeScript, Vitest, Cordis, DSH Agent/LLM/Tools; stateless, with no storage boundary.
- Existing tests: the baseline is green at `origin/main`; this new package starts with TDD tests. Existing release seams are characterized before modification.
- Journey scope: phases 1–5 now; phase 6 is deferred. The user approved this plan before implementation.

## Phase Status

| Phase | Skill | Status | Artifact | Date |
|---|---|---|---|---|
| 1 — Build the safety net | working-with-legacy-code | done | TESTING.md + TECH-DEBT.md (GATE) | 2026-08-29 |
| 2 — Make the code readable | clean-code | done | TECH-DEBT.md | 2026-08-29 |
| 3 — Apply named refactorings | refactoring-patterns | done | TECH-DEBT.md | 2026-08-29 |
| 4 — Reduce complexity | software-design-philosophy | done | TECH-DEBT.md | 2026-08-29 |
| 5 — Draw the architecture boundary | clean-architecture | done | ARCHITECTURE.md | 2026-08-29 |
| 6 — Lock in the habits | pragmatic-programmer | deferred: explicitly outside this delivery | TECH-DEBT.md | 2026-08-29 |
| Optional — Domain language | domain-driven-design | skipped: the single use case does not need a richer domain model | ARCHITECTURE.md | 2026-08-29 |

Statuses: pending · in-progress · awaiting-evidence · done · deferred: reason · skipped: reason

## Key Decisions

| Date | Phase | Decision | Rationale |
|---|---|---|---|
| 2026-08-29 | Intake | Start from a new independent package and product Skill. | The old Feed packages are frozen evidence, not a safe implementation base. |
| 2026-08-29 | 1 | Use TDD RED tests for new behavior and characterization tests for release/profile seams. | New behavior has nothing legitimate to characterize; existing integration behavior does. |
| 2026-08-29 | 1 | Pin and record defects found in old release seams; do not repair them in this task. | Prevent silent scope expansion and preserve observed behavior. |
| 2026-08-29 | 2 | Require clean-code score of at least 8/10. | This is the agreed quality gate. |
| 2026-08-29 | 2 | Use explicit discriminated results; never use exceptions or empty output to blur business-empty and failure. | The caller must be able to distinguish “nothing qualifies” from “judgment failed”. |
| 2026-08-29 | 5 | Keep business rules framework-free behind a use-case-owned `SemanticJudge` port. | Cordis and DSH LLM are replaceable outer details. |
| 2026-08-29 | 3 | Apply Remove Redundant Type Assertion and Remove Dead Dependency only. | The audit found no behavior-preserving extraction that would make the code simpler. |
| 2026-08-29 | 4 | Keep one operation rather than split validation, judgment, and result mapping into public services. | The single public operation is a deep module; more interfaces would expose mechanics. |

## Next Actions

- [x] Add the Phase 1 RED tests and characterize all release/profile seams that will change.
- [x] Implement only behavior pinned in the Safety Net Map.
- [x] Complete the clean-code, refactoring, deep-module, and dependency-rule audits.
- [ ] Build and report an immutable release candidate; stop before production release (Codex, delivery endpoint).
