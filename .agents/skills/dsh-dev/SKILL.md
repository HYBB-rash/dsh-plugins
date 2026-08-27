---
name: dsh-dev
description: Prepare this repository for Docker-based development of runtime code, configuration, product Skills, profiles, or other inputs that enter the DSH image. Use automatically before implementing such changes, including feature work, bug fixes, refactors, runtime tests, and runtime configuration changes. Do not use for documentation-only work, read-only investigation, or production release operations.
---

# DSH development

Prepare one isolated, editable-source Docker environment before changing anything that enters the DSH runtime image. Keep production and OpenClaw untouched. Hand formal candidate construction and every production operation to `$dsh-release` after development is complete.

## Decide whether this Skill applies

Use it when the task may change any of these runtime inputs:

- `telegram-gateway`, `dsh-cron`, `dsh-assistant`, `personal-feed`, `x-feed`, or `ui-context-compactor`;
- product Skills, Profiles, runtime package topology, or code under `release/scripts` that is present in the image;
- tests or configuration needed to prove those runtime changes.

Skip it for prose-only documentation, read-only review or diagnosis, Git-only housekeeping, and a request that only operates an already-built release. Use `$dsh-release` for candidate build, release, acceptance, status, or rollback.

## Establish a task worktree

1. Read the repository `AGENTS.md` and `release/README.md` completely.
2. Inspect the current branch, worktree, status, upstream, `origin/main`, and active worktrees. Preserve unrelated work.
3. Fetch `origin` before preparing anything.
4. Work only in a dedicated task branch and worktree. When one does not already exist, run `scripts/create-worktree.sh <task-slug>` from this Skill directory and continue in the printed worktree.
5. The task branch must contain the freshly fetched `origin/main`. If it does not, rebase it immediately. Preserve dirty work with Git's autostash; if the rebase conflicts or cannot prove preservation, stop and report rather than discarding changes.
6. Never create, modify, patch, or commit a Harness worktree. Harness is read-only and fixed by `release/harness.lock.json`.

## Prepare the environment

1. Resolve the full Harness commit from `release/harness.lock.json` and the full plugin commit from the freshly fetched `origin/main`.
2. From the clean latest-main baseline, build the development base with:

   ```bash
   ./release/dsh build --purpose development --harness-ref <locked-harness-commit> --plugins-ref <origin-main-commit>
   ```

   This local image is the dependency and Harness boundary for development. Do not publish or release it merely because preparation passed.
3. Run:

   ```bash
   ./release/dsh dev prepare --source <task-worktree> --candidate <candidate.json>
   ```

4. Let the command download the latest existing consistent production snapshot. It must not stop production or create a new online snapshot. If no valid snapshot exists, report and stop; never silently substitute synthetic data.
5. Let the deterministic command mount the six packages, product Skills, Profiles, runtime topology, materializer, and image runtime scripts as editable worktree inputs, plus an isolated snapshot copy. The image root stays read-only. The command must replace credentials, empty cron work, remove production Telegram offsets and locks, block real Telegram egress, and leave production directories unmounted.
6. Do not claim readiness until the command reports `dev-source-ready`. That receipt means the mounted source completed the full six-package build, all runtime-image TypeScript and Python tests, Web health, fake Telegram polling and delivery, empty cron verification, real Telegram blocking, and common image identity checks.

## Develop inside the boundary

- Use `./release/dsh dev shell --candidate <candidate.json>` for commands that must run with the fixed Harness and image dependencies.
- Keep editable source in the task worktree. Generated `lib`, caches, and test output remain ignored and outside the image identity.
- Use focused tests during the inner loop when the affected boundary is known. Before declaring development complete, rerun the affected integration tests and any wider tests required by the change.
- Never mount production persistence, use real credentials, contact real Telegram, claim real cron work, install dependencies on production, or patch a running production container.
- A preparation failure is a development failure. Preserve the evidence and fix it locally; do not route around a failed gate.

## Recheck before handoff

1. Fetch `origin` again when preparation finishes. The task branch must still contain the latest `origin/main`; otherwise rebase immediately and rerun the affected checks.
2. Keep the task change on its independent branch, with focused commits. Push the exact intended product commit.
3. When main changes during an unfinished task, build and prepare the new development base normally. Keep the old base until the new `dev prepare` receipt passes; the command then atomically moves that worktree's lease and removes only the old unreferenced development base.
4. When the task no longer needs its local environment, stop it with `./release/dsh dev down`, then run `./release/dsh dev retire --source <task-worktree>` to remove that worktree's isolated data and unreferenced development base. Never use a global container-engine prune.
5. An accepted production release invalidates every local development environment. `accept` removes the local development containers, isolated data, leases, and unreferenced development images while preserving source worktrees. Any unfinished task must rebase onto the new main and run a fresh development build and `dev prepare` before continuing.
6. For production, explicitly invoke `$dsh-release`. Recheck and rebase onto the latest `main` again before candidate construction or release. The development-base image and its receipt are not a formal release candidate and never replace release acceptance.

## Report the result

Use concise Chinese. Report the task branch/worktree, latest-main commit, locked Harness commit, development image identity, snapshot identity, full baseline result, isolated runtime result, and whether the environment is ready. If blocked, report the single failed gate and the evidence needed to proceed.
