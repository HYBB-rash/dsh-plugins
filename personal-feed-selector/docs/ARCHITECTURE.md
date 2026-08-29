# Architecture

## System Responsibility

The selector answers one question: among caller-supplied X candidates, is there exactly one item worth one of this person's scarce attention slots because it matches their long-term interests and adds enough information to update understanding, improve a judgment, or open a new direction?

It returns the original supplied URL, an honest empty result, or an explicit execution failure. It does not acquire content, summarize, rank, explain, persist a profile, or import the archived Feed implementation.

## Layer Map and Dependency Rule

| Layer | Code | Responsibility | May depend on |
|---|---|---|---|
| Business/use case | `src/core.ts` | Validate input, define selection semantics, map a selected index to the exact supplied URL, preserve failures. | Web platform primitives and the use-case-owned `SemanticJudge` port only. |
| Model adapter | `src/dsh-semantic-judge.ts` | Translate the port to the current DSH model route and enforce the strict output protocol. | Core contracts plus DSH Agent/LLM/Session. |
| Composition/delivery | `src/plugin.ts` | Register the operation on approved Web and Telegram roots. | Core, adapter, Cordis, DSH Tools, Schemastery. |
| Product policy | `skills/personal-feed-selector/SKILL.md` | Tell the agent when to call the operation and how to present selected, empty, and failed results. | Stable public tool contract only. |
| Release wiring | profiles, topology, release scripts | Put the package and Skill into reproducible runtime images. | Built package and repository release conventions. |

Dependencies point inward toward `core.ts`. The core does not import Cordis, DSH, a model provider, a profile, a release script, or the Skill. The `SemanticJudge` interface is owned by the use case, so the external model mechanism adapts to the business need.

## Stable Contracts

- Input contains non-empty long-term interests, non-empty existing understanding, and zero or more X candidates with HTTPS URLs and content.
- Input has an exact shape and a total character limit.
- Success is either one exact caller-supplied URL or genuine empty.
- Failure is never converted to empty.
- Model output identifies only a candidate index; it cannot supply the returned URL.
- Candidate material is untrusted and cannot change the output protocol.
- The operation appears only on interactive Web roots and the configured Telegram root, never on cron or child agents.

## Information Hidden Behind the Operation

Callers do not know which provider/model route is active, how streaming blocks are assembled, how timeouts are implemented, how candidate indices are encoded, or how Cordis registrations are replaced and disposed. Those mechanics can change without changing the public selection contract.

## Data and Storage Decisions

The first delivery is stateless. Personal context and candidate content are supplied per call and are not written by this component. There is no database, cache, migration, background worker, content acquisition state, or dependency on the archived Feed data.

## Failure Isolation

Invalid or oversized input is rejected before a model call. Provider absence, exceptions, timeout, abort, missing stream termination, mixed/non-text blocks, malformed JSON, extra output fields, and invalid candidate indices return distinct failures. Only a completed semantic empty becomes an empty business result.

## Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-08-29 | Build a new package and Skill without importing `personal-feed`, `x-feed`, or `skills/x-feed`. | The archived system is evidence and a recovery boundary, not the implementation base. |
| 2026-08-29 | Keep selection stateless. | Long-term profile maintenance and acquisition are not part of the first functional slice. |
| 2026-08-29 | Make the core return discriminated results instead of throwing. | Business-empty and execution failure must be impossible to confuse. |
| 2026-08-29 | Let the model return only a candidate index. | The deterministic core must own the invariant that returned URLs came from the caller. |
| 2026-08-29 | Use a product Skill for presentation policy. | Calling and presentation require agent judgment; the hard selection invariant remains in code. |
