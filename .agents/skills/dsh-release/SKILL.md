---
name: dsh-release
description: Operate this repository's Docker release workflow for herman.hermes. Use only when explicitly invoked as $dsh-release to inspect release status, build a candidate, prepare or perform a production release, record user acceptance, or prepare and perform a rollback.
---

# DSH release

Treat this Skill as the release controller. Keep every production mutation behind the repository's deterministic `release/dsh` safety gates.

## Establish the boundary

1. Resolve the repository root with `git rev-parse --show-toplevel` and work from it.
2. Require `AGENTS.md`, `release/README.md`, and executable `release/dsh`. Stop if any is missing.
3. Read `AGENTS.md` and `release/README.md` completely before choosing a command.
4. Keep OpenClaw out of scope. Do not stop, restart, configure, or take over any of its state.
5. Use only `./release/dsh` for build, development runtime, production status, release, acceptance, and rollback. Do not replace it with direct SSH, Docker, systemd, source-sync, selector, or dependency-install commands.

## Fix identities before building

- Inspect the branch, worktree, upstream, and remote refs. Never include uncommitted files in a candidate or silently choose which changes to commit.
- Fetch `origin` immediately before candidate construction. The release branch and intended product commit must contain the latest `origin/main`; otherwise rebase immediately, preserve unrelated work, and rerun the affected development checks before building.
- Require full Git commits for Harness and plugins. Confirm the product commit is pushed and is the intended release target.
- Build exactly once with `./release/dsh build --purpose release --harness-ref <commit> --plugins-ref <commit>`.
- Preserve the resulting `candidate.json`, Docker archive, image identity, archive checksum, and test receipt. Test, transfer, and production must use that exact candidate; never rebuild or patch its container.
- Treat build or image-test failure as a development failure. Do not continue to production.

## Operate by explicit phase

### Inspect

Run `./release/dsh status` for a read-only status request. Report current and last-good identities, container health, and any unavailable evidence without changing production.

### Prepare a release

1. Fetch `origin` again. If the candidate's product or release-tool commit no longer contains the latest `origin/main`, stop, rebase, rebuild, and revalidate instead of releasing a stale candidate.
2. Run `./release/dsh release --candidate <candidate.json>` without `--approved-stop`.
3. Report the exact candidate and image identity, target, writers to stop, snapshot destination, rollback boundary, and expected outage work.
4. Stop at the authorization gate. An initial request to “release” or “上线” expresses intent but is not the post-plan authorization to stop production.

### Execute an authorized release

1. After the user explicitly approves the reported candidate and stop window, rerun the same command with `--approved-stop`.
2. Do not rebuild or substitute the candidate after approval.
3. Let `release/dsh` stop all DSH writers, snapshot data, test an isolated copy, transfer the same archive, start production, and write evidence.
4. If the command reaches `awaiting-user-acceptance`, report that production is running but the release is not complete.
5. Ask the user to verify the real Telegram/Web behavior relevant to the change. Never infer user acceptance from containers, HTTP, logs, or exit code alone.

### Accept

Run `./release/dsh accept --release <release-id> --evidence <evidence>` only after the user explicitly says the real acceptance passed for that release. Confirm it becomes `current` and `last-good`. Acceptance also invalidates and removes every local development environment and unreferenced development image while preserving source worktrees; report that cleanup receipt with the final evidence.

### Prepare and execute rollback

1. First run `./release/dsh rollback --release <release-id>` without `--approved` and report the exact old image, compatible snapshot, configuration boundary, and impact.
2. Stop at the rollback authorization gate. Never infer approval from the original release request or from a failure.
3. Only after the user approves that plan, rerun with `--approved`.
4. Verify the restored services, data, and real entry points. A successful rollback command alone is not completion.

## Classify release failures

- Fix in the current stop window only when the cause is clear, release-specific, small, reversible, and changes neither product behavior nor data semantics. The total on-site repair window is thirty minutes, followed by the affected checks and full production acceptance.
- Treat every unclear issue, product-code change, data-semantic change, expanded scope, or over-thirty-minute repair as a development problem. Stop online experimentation, preserve evidence, report the current service/data state and rollback plan, and wait for rollback authorization.
- When compatibility, data-loss risk, authorization, or system scope is uncertain, stop and report instead of guessing.

## Report the terminal state

Use plain Chinese and keep the default user-facing progress or final report within eight bullets unless the user asks for full evidence. Retain exact evidence for:

- Harness, plugin, and release-tool commits;
- candidate ID, release ID, image identity, and archive checksum;
- snapshot and rollback boundary;
- image tests and pre-release data-copy tests;
- production service, data, and affected real-business acceptance;
- OpenClaw invariants;
- final state: waiting for authorization, awaiting user acceptance, accepted, failed, or rolled back.

Do not call the task complete before the production release is `accepted`, or before an authorized rollback has restored and revalidated the previous version.
