#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
candidate="$(realpath -- "${1:?用法: fault-injection.sh <candidate.json>}")"
engine="${DSH_CONTAINER_ENGINE:-podman}"
harness_repo="${DSH_HARNESS_REPO:-/home/herman/Documents/Codex/2026-08-14/deepseek-harness}"
test_root="$(mktemp -d)"
cleanup() { rm -rf -- "$test_root"; }
trap cleanup EXIT

readarray -t identity < <(node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  console.log(value.imageTag); console.log(value.imageId);
' "$candidate")
image_tag="${identity[0]}"

# Deployment-detail injection: the immutable image is healthy, but the data
# mount is read-only.  Preparation must fail; correcting only the mount must
# make the exact same image succeed.
home="$test_root/home/herman"
mkdir -p "$home/.dsh/storages/dsh-cron" "$home/.dsh/workspace"
: >"$home/.dsh/storages/dsh-cron/jobs.jsonl"
cat >"$home/.dsh/.credentials.yaml" <<'EOF'
version: 1
refs:
  DEEPSEEK_API_KEY: test-key
  TELEGRAM_BOT_TOKEN: test-token
  TELEGRAM_ALLOWED_CHAT_ID: "1"
EOF
chmod 600 "$home/.dsh/.credentials.yaml"

set +e
"$engine" run --rm --read-only --user 0:0 --tmpfs /tmp:rw --tmpfs /run:rw \
  --volume "$home:/home/herman:ro" "$image_tag" prepare >/dev/null 2>&1
mount_failure="$?"
set -e
if [[ "$mount_failure" == 0 ]]; then
  printf '%s\n' 'injected read-only data mount was not rejected' >&2
  exit 1
fi
"$engine" run --rm --read-only --user 0:0 --tmpfs /tmp:rw --tmpfs /run:rw \
  --volume "$home:/home/herman:rw" "$image_tag" prepare >/dev/null
test -f "$home/.dsh/profiles/web/cordis.yml"

# Development-error injection: create a temporary, exact Git commit with an
# invalid plugin source.  The normal build command must stop at the image test
# gate (exit 5) and must not emit a candidate.  No production command runs.
git clone --quiet --local --no-hardlinks "$repo_root" "$test_root/bad-repo"
printf '\nthis is deliberately invalid TypeScript !!!\n' >>"$test_root/bad-repo/dsh-assistant/src/index.ts"
git -C "$test_root/bad-repo" add dsh-assistant/src/index.ts
git -C "$test_root/bad-repo" \
  -c user.name='DSH fault injection' -c user.email='fault-injection@invalid' \
  commit --quiet -m 'test: inject invalid business source'
bad_commit="$(git -C "$test_root/bad-repo" rev-parse HEAD)"
harness_commit="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).harnessCommit)' "$candidate")"
set +e
DSH_RELEASE_STATE_ROOT="$test_root/bad-state" \
DSH_HARNESS_REPO="$harness_repo" DSH_CONTAINER_ENGINE="$engine" \
  "$test_root/bad-repo/release/dsh" build \
    --harness-ref "$harness_commit" --plugins-ref "$bad_commit" \
    >"$test_root/bad-build.log" 2>&1
business_failure="$?"
set -e
if [[ "$business_failure" != 5 ]]; then
  cat "$test_root/bad-build.log" >&2
  printf 'injected business error returned %s instead of 5\n' "$business_failure" >&2
  exit 1
fi
test ! -e "$test_root/bad-state/candidates/latest.json"

printf '%s\n' 'fault injection passed: mount error recoverable; business error blocked before release'
