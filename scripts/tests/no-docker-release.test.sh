#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repository_root"

for retired_path in \
  release \
  runtime-package-topology.json \
  scripts/materialize-runtime-topology.mjs \
  .agents/achieve-skills/dsh-dev \
  .agents/achieve-skills/dsh-release; do
  if [[ -e "$retired_path" || -L "$retired_path" ]]; then
    echo "retired Docker release path remains: $retired_path" >&2
    exit 1
  fi
done

for active_document in README.md README.en.md AGENTS.md \
  .agents/skills/dsh-web-dev/SKILL.md \
  .agents/skills/dsh-web-deploy/SKILL.md \
  docs/dsh-web-portable-deployment.md; do
  if grep -Eq '(\./release/dsh|release/README\.md)' "$active_document"; then
    echo "active documentation still directs users to Docker release: $active_document" >&2
    exit 1
  fi
done

grep -Fq './scripts/dsh-web-deploy' README.md
grep -Fq './scripts/dsh-web-deploy' README.en.md
grep -Fq '$dsh-web-deploy' AGENTS.md

if grep -Eq '\b(podman|docker|compose)\b' flake.nix; then
  echo 'retired container tooling remains in the development shell' >&2
  exit 1
fi

if grep -Eq '^release/\.(artifacts|runtime)/$' .gitignore; then
  echo 'retired release state ignores remain' >&2
  exit 1
fi

echo 'Docker release system is retired'
