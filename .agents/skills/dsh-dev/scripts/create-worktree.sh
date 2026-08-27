#!/usr/bin/env bash
set -Eeuo pipefail

task_slug="${1:-}"
if [[ ! "$task_slug" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  printf '%s\n' 'usage: create-worktree.sh <lowercase-task-slug>' >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel)"
repo_parent="$(dirname -- "$repo_root")"
repo_name="$(basename -- "$repo_root")"
branch="codex/$task_slug"
worktree="$repo_parent/$repo_name-$task_slug"

git -C "$repo_root" fetch origin
origin_main="$(git -C "$repo_root" rev-parse origin/main)"

if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
  printf 'branch already exists: %s\n' "$branch" >&2
  exit 4
fi
if [[ -e "$worktree" ]]; then
  printf 'worktree path already exists: %s\n' "$worktree" >&2
  exit 4
fi

git -C "$repo_root" worktree add -b "$branch" "$worktree" "$origin_main"
printf 'branch=%s\nworktree=%s\norigin_main=%s\n' "$branch" "$worktree" "$origin_main"
