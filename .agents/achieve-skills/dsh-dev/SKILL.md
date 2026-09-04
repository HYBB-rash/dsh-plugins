---
name: dsh-dev
description: Prepare this repository for Docker-based development of runtime code, configuration, product Skills, profiles, or other inputs that enter the DSH image. Use automatically before implementing such changes, including feature work, bug fixes, refactors, runtime tests, and runtime configuration changes. Do not use for documentation-only work, read-only investigation, or production release operations.
---

# DSH development

Prepare one isolated, editable-source Docker environment before changing anything that enters the DSH runtime image. Keep production and OpenClaw untouched. Hand formal candidate construction and every production operation to `$dsh-release` after development is complete.

## Decide whether this Skill applies

Use it when the task may change any of these runtime inputs:

- `telegram-gateway`, `dsh-cron`, or `dsh-assistant`;
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
2. Request the one shared development base for the freshly fetched `origin/main`:

   ```bash
   ./release/dsh build --purpose development --harness-ref <locked-harness-commit> --plugins-ref <origin-main-commit>
   ```

   The command is safe to repeat. Under one repository-managed engine lock it reuses the already-tested image when the full main commit is unchanged; only the first request after main advances performs a real build and the full three-package TypeScript/Python test gate. Development bases do not create or reload Docker archives and cannot be published as release candidates.
3. Run:

   ```bash
   ./release/dsh dev prepare --source <task-worktree>
   ```

4. Let the command download the latest existing consistent production snapshot. It must not stop production or create a new online snapshot. If no valid snapshot exists, report and stop; never silently substitute synthetic data.
5. Let the deterministic command create one worktree-owned environment: a fixed toolbox plus Web, Telegram, fake Telegram, an internal network, an isolated data copy, and a Web port. Every container carries the same worktree identity. It mounts the three packages, product Skills, Profiles, runtime topology, materializer, and image runtime scripts as editable worktree inputs, plus an isolated snapshot copy. The image root stays read-only. The command must replace credentials, empty cron work, remove production Telegram offsets and locks, block real Telegram egress, and leave production directories unmounted. Other worktrees may prepare and run at the same time.
6. Do not claim readiness until the command reports `dev-source-ready`. Editable mounts hide the image's prebuilt `lib`, so preparation recompiles the three mounted packages, but it does not repeat their test suites. The receipt means that compilation, Web health, fake Telegram polling and delivery, empty cron verification, real Telegram blocking, and common image identity checks passed. The full TypeScript/Python baseline belongs to the shared main image's build receipt.

## Develop inside the boundary

- Use `./release/dsh dev shell` for commands that must run with the fixed Harness and image dependencies. It only execs Bash inside this worktree's already-running fixed toolbox; it does not create a shell container or maintain shell-specific state. Multiple terminals may enter the same toolbox. Do not replace it with a direct container-engine command.
- To formally validate mounted, including dirty, source, use `./release/dsh dev verify --source <task-worktree>`. It only execs the same fixed toolbox, repeats type/build/bundle and the mounted package tests, and prints a separate editable-source receipt beside the shared-main image receipt. It does not turn `dev prepare` back into a full test gate or create verification lifecycle state. Use `--package <one-mounted-package>` only for a focused inner loop.
- Do not hand-assemble `setpriv`, `HOME`, `NODE_PATH`, cache directories, dependency symlinks, or a direct engine command for this verification. The command keeps type/build/bundle in the local rootless toolbox identity, then runs TypeScript/Python tests as the Containerfile's 1000:1000 with per-run tmpfs HOME/npm/XDG/data directories; its default Node resolution intentionally matches the Containerfile gate.
- Keep editable source in the task worktree. Generated `lib`, caches, and test output remain ignored and outside the image identity.
- Use focused tests during the inner loop when the affected boundary is known. Before declaring development complete, rerun the affected integration tests and any wider tests required by the change.
- Never mount production persistence, use real credentials, contact real Telegram, claim real cron work, install dependencies on production, or patch a running production container.
- A preparation failure means the isolated environment is not ready. Preserve the evidence and fix it locally; do not route around the failed environment gate.

## Recheck before handoff

1. Fetch `origin` again when preparation finishes. The task branch must still contain the latest `origin/main`; otherwise rebase immediately and rerun the affected checks.
2. Keep the task change on its independent branch, with focused commits. Push the exact intended product commit.
3. When main changes, the first build request constructs and self-tests the new shared base, then invalidates every environment tied to the previous main and removes all older development images. An unfinished task keeps its source worktree, rebases onto the new main, and runs `dev prepare` again. Do not retain an older development image or try to keep an old container alive.
4. When the task no longer needs its local environment, stop it with `./release/dsh dev down`, then run `./release/dsh dev retire --source <task-worktree>` to remove only that worktree's toolbox, service containers, network, port reservation, lease, and isolated data. The worktree environment is the only lifecycle unit; there is no separate shell lifecycle or orphan-shell registry. The current shared main image remains available for other tasks. Never use direct Podman cleanup, an artificial quiet window, or a global container-engine prune.
5. An accepted production release invalidates every local development environment. `accept` removes all development containers, isolated data, leases, runtime reservations, and the shared development image while preserving source worktrees. Any unfinished task must rebase onto the new main, request the new single main image, and run `dev prepare` before continuing.
6. For production, explicitly invoke `$dsh-release`. Recheck and rebase onto the latest `main` again before candidate construction or release. The development-base image and its receipt are not a formal release candidate and never replace release acceptance.

## Report the result

Use concise Chinese. Report the task branch/worktree, latest-main commit, locked Harness commit, whether the shared development image was built or reused, its identity and test receipt, the worktree-specific runtime identity, snapshot identity, editable-source compilation result, isolated runtime result, and whether the environment is ready. If blocked, report the single failed gate and the evidence needed to proceed.
