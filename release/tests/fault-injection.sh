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
expected_image_id="${identity[1]#sha256:}"
actual_image_id="$("$engine" image inspect "$image_tag" --format '{{.Id}}')"
actual_image_id="${actual_image_id#sha256:}"
if [[ ! "$expected_image_id" =~ ^[0-9a-f]{64}$ || "$actual_image_id" != "$expected_image_id" ]]; then
  printf '%s\n' 'candidate image tag no longer resolves to the declared immutable image' >&2
  exit 1
fi

assert_no_private_output() {
  local label="$1"
  local output="$2"
  shift 2
  local private_value
  for private_value in "$@"; do
    if LC_ALL=C grep -aFq -- "$private_value" "$output"; then
      printf '%s\n' "$label leaked a private sentinel" >&2
      exit 1
    fi
  done
}

empty_tmpfs_suffix=''
if [[ "$(basename -- "$engine")" == podman ]]; then
  empty_tmpfs_suffix=',notmpcopyup'
fi
isolated_image_args=(
  run --rm --read-only --network none --user 1000:1000
  --tmpfs "/tmp:rw,nosuid,nodev${empty_tmpfs_suffix}"
  --tmpfs "/run:rw,nosuid,nodev${empty_tmpfs_suffix}"
)
isolated_rootless_mount_args=(
  run --rm --read-only --network none --user 0:0
  --tmpfs "/tmp:rw,nosuid,nodev${empty_tmpfs_suffix}"
  --tmpfs "/run:rw,nosuid,nodev${empty_tmpfs_suffix}"
)

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
"$engine" run --rm --read-only --user 0:0 \
  --tmpfs "/tmp:rw${empty_tmpfs_suffix}" --tmpfs "/run:rw${empty_tmpfs_suffix}" \
  --volume "$home:/home/herman:ro" "$image_tag" prepare >/dev/null 2>&1
mount_failure="$?"
set -e
if [[ "$mount_failure" == 0 ]]; then
  printf '%s\n' 'injected read-only data mount was not rejected' >&2
  exit 1
fi
"$engine" run --rm --read-only --user 0:0 \
  --tmpfs "/tmp:rw${empty_tmpfs_suffix}" --tmpfs "/run:rw${empty_tmpfs_suffix}" \
  --volume "$home:/home/herman:rw" "$image_tag" prepare >/dev/null
test -f "$home/.dsh/profiles/web/cordis.yml"

# Credential isolation injection: start from an isolated production-like
# snapshot containing unique sentinels, scrub only its preflight copy with the
# candidate helper, and prove the original and Workspace bytes stay unchanged.
# A second candidate container is allowed to see only the scrubbed copy.
private_token='FAULT-INJECTION-PRODUCTION-NOTION-TOKEN-7f637f7e'
private_harness='FAULT-INJECTION-PRODUCTION-HARNESS-CREDENTIAL-bc1b6d3b'
token_source="$test_root/token-source/home/herman/.dsh"
preflight_root="$test_root/token-preflight"
preflight_dsh="$preflight_root/home/herman/.dsh"
mkdir -p "$token_source/secrets" "$token_source/workspace"
printf '%s' "$private_token" >"$token_source/secrets/notion.token"
printf '%s' "$private_harness" >"$token_source/.credentials.yaml"
printf '%s\n' 'live Harness Workspace marker; release must not rewrite this file' \
  >"$token_source/workspace/release-ownership.marker"
chmod 700 "$token_source/secrets"
chmod 600 "$token_source/secrets/notion.token" "$token_source/.credentials.yaml"
source_token_sha="$(sha256sum "$token_source/secrets/notion.token" | awk '{print $1}')"
source_credentials_sha="$(sha256sum "$token_source/.credentials.yaml" | awk '{print $1}')"
workspace_sha="$(sha256sum "$token_source/workspace/release-ownership.marker" | awk '{print $1}')"
mkdir -p "$preflight_root/home/herman"
cp -a "$token_source" "$preflight_root/home/herman/.dsh"

scrub_log="$test_root/token-scrub.log"
set +e
"$engine" "${isolated_rootless_mount_args[@]}" \
  --volume "$preflight_root:/preflight:rw" \
  "$image_tag" scrub-preflight-state \
    --dsh-home /preflight/home/herman/.dsh --preflight-root /preflight \
    >"$scrub_log" 2>&1
scrub_status="$?"
set -e
assert_no_private_output 'preflight credential scrub' "$scrub_log" \
  "$private_token" "$private_harness" Authorization Bearer
if [[ "$scrub_status" != 0 ]] || ! grep -Fq '"status":"scrubbed"' "$scrub_log"; then
  cat "$scrub_log" >&2
  printf '%s\n' 'candidate preflight credential scrub did not complete' >&2
  exit 1
fi
test "$(sha256sum "$token_source/secrets/notion.token" | awk '{print $1}')" = "$source_token_sha"
test "$(sha256sum "$token_source/.credentials.yaml" | awk '{print $1}')" = "$source_credentials_sha"
test "$(sha256sum "$preflight_dsh/workspace/release-ownership.marker" | awk '{print $1}')" = "$workspace_sha"
test "$(<"$preflight_dsh/secrets/notion.token")" = 'dsh-fake-notion-token-v1'
if LC_ALL=C grep -aFRq -- "$private_token" "$preflight_root" \
  || LC_ALL=C grep -aFRq -- "$private_harness" "$preflight_root"; then
  printf '%s\n' 'production credential sentinel survived in the scrubbed preflight copy' >&2
  exit 1
fi

scrubbed_runtime_log="$test_root/token-runtime.log"
set +e
"$engine" "${isolated_rootless_mount_args[@]}" \
  --env NOTION_TOKEN_FILE=/home/herman/.dsh/secrets/notion.token \
  --volume "$preflight_dsh:/home/herman/.dsh:ro" \
  --entrypoint /bin/sh "$image_tag" -eu -c '
    test "$NOTION_TOKEN_FILE" = /home/herman/.dsh/secrets/notion.token
    test "$(cat "$NOTION_TOKEN_FILE")" = dsh-fake-notion-token-v1
    ! env | grep -Eq "^NOTION_(TOKEN|AUTHORIZATION)="
  ' >"$scrubbed_runtime_log" 2>&1
scrubbed_runtime_status="$?"
set -e
assert_no_private_output 'scrubbed preflight runtime' "$scrubbed_runtime_log" \
  "$private_token" "$private_harness" Authorization Bearer
if [[ "$scrubbed_runtime_status" != 0 ]]; then
  cat "$scrubbed_runtime_log" >&2
  printf '%s\n' 'preflight runtime did not consume only the scrubbed credential copy' >&2
  exit 1
fi

# Notion authorization injection: the image's exact checker fixture starts a
# loopback-only fake Notion endpoint, receives 401, asserts exit 4, preserves
# the credential inode/bytes, and checks every captured stream is redacted.
notion_401_log="$test_root/notion-401.log"
set +e
"$engine" "${isolated_image_args[@]}" --entrypoint python3 "$image_tag" \
  /opt/dsh/release-system/tests/notion-page-check.py \
  NotionPageCheckTests.test_401_is_redacted_and_does_not_touch_credential \
  >"$notion_401_log" 2>&1
notion_401_status="$?"
set -e
assert_no_private_output 'Notion 401 gate' "$notion_401_log" \
  fixture-checker-token 'private checker fixture' Authorization Bearer
if [[ "$notion_401_status" != 0 ]] || ! grep -Fq 'Ran 1 test' "$notion_401_log"; then
  cat "$notion_401_log" >&2
  printf '%s\n' 'Notion 401 did not fail closed inside the immutable candidate' >&2
  exit 1
fi

# Workspace drift injection: the exact migration/health fixture first applies
# the manifest, then changes AGENTS.md and proves both gates return 4 without
# repairing any state byte.
workspace_drift_log="$test_root/workspace-drift.log"
set +e
"$engine" "${isolated_image_args[@]}" --entrypoint python3 "$image_tag" \
  /opt/dsh/release-system/tests/test_workspace_migration.py \
  WorkspaceMigrationTests.test_applied_receipt_rejects_agents_drift_without_repairing_it \
  >"$workspace_drift_log" 2>&1
workspace_drift_status="$?"
set -e
assert_no_private_output 'workspace drift gate' "$workspace_drift_log" \
  'likes tea' 'lives in Shanghai' 'outside-a' 'outside-b'
if [[ "$workspace_drift_status" != 0 ]] || ! grep -Fq 'Ran 1 test' "$workspace_drift_log"; then
  cat "$workspace_drift_log" >&2
  printf '%s\n' 'workspace drift did not stop the immutable candidate gates' >&2
  exit 1
fi

# Reanchor conflict injection: exercise the release read-only inspection port
# against migration_conflict and a result drift.  The fixture also verifies no
# ledger byte is written and private ledger/evidence bodies are never echoed.
reanchor_conflict_log="$test_root/reanchor-conflict.log"
set +e
"$engine" "${isolated_image_args[@]}" --entrypoint node "$image_tag" \
  --test /opt/dsh/release-system/tests/inspect-cron-reanchor.mjs \
  >"$reanchor_conflict_log" 2>&1
reanchor_conflict_status="$?"
set -e
assert_no_private_output 'schedule reanchor conflict gate' "$reanchor_conflict_log" \
  PRIVATE-LEDGER-BODY PRIVATE-EVIDENCE-BODY PRIVATE-BROKEN-JSON
if [[ "$reanchor_conflict_status" != 0 ]] \
  || ! grep -Fq 'fails closed on an inspection error or a result that differs from accepted evidence' \
    "$reanchor_conflict_log"; then
  cat "$reanchor_conflict_log" >&2
  printf '%s\n' 'schedule reanchor conflict did not stop the immutable candidate gate' >&2
  exit 1
fi

# Assistant socket disconnection injection: use a normally prepared isolated
# Telegram profile, deliberately omit the manager socket, and require the real
# candidate health command to stop before any control request.
test ! -e "$home/.dsh/storages/dsh-cron/control.sock"
mkdir -p "$home/.openclaw" "$home/task-inbox-workflow"
printf '%s\n' 'FAULT-OPENCLAW-PARENT-SENTINEL' >"$home/.openclaw/private-sentinel"
printf '%s\n' 'FAULT-LEGACY-INBOX-PARENT-SENTINEL' >"$home/task-inbox-workflow/private-sentinel"
legacy_parent_before="$(sha256sum "$home/.openclaw/private-sentinel" "$home/task-inbox-workflow/private-sentinel")"
assistant_socket_log="$test_root/assistant-socket-disconnected.log"
set +e
"$engine" "${isolated_rootless_mount_args[@]}" \
  --env DSH_HOME=/home/herman/.dsh \
  --env DSH_CWD=/home/herman/.dsh/workspace \
  --volume "$home:/home/herman:rw" \
  --tmpfs "/home/herman/.openclaw:rw,nosuid,nodev,noexec${empty_tmpfs_suffix}" \
  --tmpfs "/home/herman/task-inbox-workflow:rw,nosuid,nodev,noexec${empty_tmpfs_suffix}" \
  --entrypoint /bin/sh "$image_tag" -eu -c '
    test ! -e /home/herman/.openclaw/private-sentinel
    test ! -e /home/herman/task-inbox-workflow/private-sentinel
    exec /opt/dsh/release-system/scripts/entrypoint.sh assistant-cron-health
  ' >"$assistant_socket_log" 2>&1
assistant_socket_status="$?"
set -e
test "$legacy_parent_before" = "$(sha256sum "$home/.openclaw/private-sentinel" "$home/task-inbox-workflow/private-sentinel")"
assert_no_private_output 'Assistant socket disconnection gate' "$assistant_socket_log" \
  test-key test-token Authorization Bearer
if [[ "$assistant_socket_status" != 1 ]] \
  || ! grep -Fq 'assistant Cron control socket is missing' "$assistant_socket_log"; then
  cat "$assistant_socket_log" >&2
  printf '%s\n' 'disconnected Assistant control socket did not stop the immutable candidate gate' >&2
  exit 1
fi

# Development-error injection: create a temporary, exact Git commit with an
# invalid plugin source.  The normal build command must stop at the image test
# gate (exit 5) and must not emit a candidate.  No production command runs.
real_origin_url="$(git -C "$repo_root" remote get-url origin)"
git clone --quiet --local --no-hardlinks "$repo_root" "$test_root/bad-repo"
git -C "$test_root/bad-repo" remote set-url origin "$real_origin_url"
git -C "$test_root/bad-repo" fetch --quiet --no-tags origin \
  +refs/heads/main:refs/remotes/origin/main
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

printf '%s\n' \
  'fault injection passed: mount recovery; credential isolation; Notion 401; workspace drift; reanchor conflict; Assistant socket disconnect; invalid source blocked'
