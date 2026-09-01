#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="$(mktemp -d)"
cleanup() { find "$test_root" -depth -delete; }
trap cleanup EXIT

state_root="$test_root/state"
mock_state="$test_root/mock-state"
mock_engine="$test_root/mock-engine"
fake_bin="$test_root/fake-bin"
mkdir -p "$state_root" "$mock_state/running" "$fake_bin"
touch "$test_root/engine.log"

cat >"$mock_engine" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%q ' "$@" >>"$MOCK_ENGINE_LOG"
printf '\n' >>"$MOCK_ENGINE_LOG"
image_id="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
command="${1:-}"
shift || true
case "$command" in
  image)
    test "${1:-}" = inspect
    if [[ "$*" == *'io.dsh.candidate.purpose'* ]]; then
      printf '%s\n' development
    else
      printf '%s\n' "$image_id"
    fi
    ;;
  run)
    name=''
    detached=false
    home_path=''
    telegram_test=false
    while (($#)); do
      case "$1" in
        --name) name="$2"; shift 2 ;;
        --detach) detached=true; shift ;;
        --volume)
          if [[ "$2" == *:/home/herman:rw ]]; then home_path="${2%:/home/herman:rw}"; fi
          shift 2
          ;;
        telegram-test) telegram_test=true; shift ;;
        *) shift ;;
      esac
    done
    if $telegram_test; then
      mkdir -p "$home_path/.dsh/storages/dsh-cron"
      printf '%s\n' '{"op":"create","externalRef":"dsh:notion-task-inbox:retry:v1"}' \
        >>"$home_path/.dsh/storages/dsh-cron/jobs.jsonl"
    fi
    if $detached; then
      : >"$MOCK_ENGINE_STATE/running/$name"
    fi
    ;;
  inspect)
    name="$1"
    shift
    test -f "$MOCK_ENGINE_STATE/running/$name"
    if (($# == 0)); then
      printf '[{"Id":"%s","Name":"/%s","Config":{"Cmd":["runtime"],"Labels":{}},"Mounts":[],"NetworkSettings":{"Networks":{}}}]\n' "$name" "$name"
    elif [[ "$*" == *'.State.Running'* ]]; then
      printf '%s\n' true
    elif [[ "$*" == *'.NetworkSettings.Networks'* ]]; then
      if [[ "$name" == *-fake-notion ]]; then
        printf '{"%s":{}}\n' "${name%-fake-notion}-internal"
      elif [[ "$name" == *-fake-telegram ]]; then
        printf '{"%s":{}}\n' "${name%-fake-telegram}-internal"
      else
        printf '{"%s":{}}\n' "${name%-*}-internal"
      fi
    else
      printf '%s|true\n' "$image_id"
    fi
    ;;
  exec)
    name="$1"
    shift
    if [[ "$name" == *-telegram && "$*" == *'https://api.telegram.org'* ]]; then exit 7; fi
    if [[ "$name" == *-web && "$*" == *'https://api.notion.com'* ]]; then exit 7; fi
    if [[ "$name" == *-web && "$*" == *'printenv NOTION_API_BASE'* ]]; then
      printf '%s\n' 'http://fake-notion:8081/v1'
    fi
    if [[ "$name" == *-fake-notion && "$*" == *'request-count'* ]]; then
      printf '%s\n' '{"schemaVersion":1,"successfulGetCount":0,"rejectedGetCount":0,"mutationRequestCount":0,"otherApiRequestCount":0,"fixtureLength":17,"fixtureSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
    fi
    if [[ "$*" == *'check-assistant-cron-ready.mjs'* ]]; then
      printf '%s\n' '{"state":"ready","protocolVersion":1}'
    fi
    if [[ "$*" == *getRequests* ]]; then
      printf '%s\n' '/getMe /getUpdates /sendMessage'
    fi
    ;;
  logs) exit 0 ;;
  rm)
    if [[ "${1:-}" == --force ]]; then shift; fi
    find "$MOCK_ENGINE_STATE/running/${1:-missing}" -delete
    ;;
  stop)
    if [[ "${1:-}" == --time ]]; then shift 2; fi
    find "$MOCK_ENGINE_STATE/running/${1:-missing}" -delete
    ;;
  ps)
    find "$MOCK_ENGINE_STATE/running" -mindepth 1 -maxdepth 1 -printf '%f\n'
    ;;
  network)
    if [[ "${1:-}" == inspect ]]; then printf '%s\n' true; fi
    exit 0
    ;;
  *) exit 64 ;;
esac
EOF
chmod +x "$mock_engine"

printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$fake_bin/curl"
chmod +x "$fake_bin/curl"

cat >"$fake_bin/git" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
source_path=''
if [[ "${1:-}" == -C ]]; then source_path="$2"; shift 2; fi
case "${1:-} ${2:-}" in
  'rev-parse --show-toplevel') printf '%s\n' "$source_path" ;;
  'branch --show-current') printf '%s\n' codex/fixture ;;
  'fetch origin') ;;
  'rev-parse HEAD'|'rev-parse origin/main') printf '%s\n' "$MOCK_GIT_COMMIT" ;;
  'merge-base --is-ancestor') ;;
  *) printf 'unexpected git fixture call: %q\n' "$*" >&2; exit 64 ;;
esac
EOF
chmod +x "$fake_bin/git"

cat >"$fake_bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$*" == *' test -f '* ]]; then exit 0; fi
if [[ "$*" == *' cat '* ]]; then
  printf '{"schemaVersion":1,"snapshotId":"fixture","archivePath":"%s","archiveSha256":"%s","remoteArchivePath":"%s","createdAt":"2026-08-31T00:00:00.000Z"}\n' \
    "$MOCK_REMOTE_SNAPSHOT" "$MOCK_SNAPSHOT_SHA" "$MOCK_REMOTE_SNAPSHOT"
  exit 0
fi
printf 'unexpected ssh fixture call: %q\n' "$*" >&2
exit 64
EOF
chmod +x "$fake_bin/ssh"

cat >"$fake_bin/scp" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
destination="${!#}"
cp "$MOCK_SNAPSHOT_ARCHIVE" "$destination"
EOF
chmod +x "$fake_bin/scp"

snapshot_root="$test_root/snapshot-root"
snapshot_archive="$test_root/snapshot.tar"
remote_snapshot='/home/herman/.local/share/dsh-container/snapshots/fixture.tar.zst'
mkdir -p "$snapshot_root/.dsh/storages/dsh-cron" "$snapshot_root/.dsh/workspace"
touch "$snapshot_root/.dsh/storages/dsh-cron/jobs.jsonl"
tar -C "$snapshot_root" -cf "$snapshot_archive" .dsh
snapshot_sha="sha256:$(sha256sum "$snapshot_archive" | awk '{print $1}')"

candidate="$test_root/candidate.json"
receipt="$test_root/image-tests.json"
image_id="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
cat >"$receipt" <<EOF
{
  "schemaVersion": 1,
  "imageId": "$image_id",
  "output": "fixture self-test"
}
EOF
receipt_sha="sha256:$(sha256sum "$receipt" | awk '{print $1}')"
cat >"$candidate" <<EOF
{
  "schemaVersion": 2,
  "candidateId": "development-main-fixture",
  "status": "tested",
  "purpose": "development",
  "imageId": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "imageTag": "localhost/dsh-development-main:fixture",
  "archivePath": null,
  "archiveSha256": null,
  "harnessCommit": "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
  "pluginsCommit": "1111111111111111111111111111111111111111",
  "releaseToolCommit": "1111111111111111111111111111111111111111",
  "testReceiptPath": "$receipt",
  "testReceiptSha256": "$receipt_sha"
}
EOF

source_a="$test_root/worktree-a"
source_b="$test_root/worktree-b"
prepare_source() {
  local source="$1" package profile
  for package in telegram-gateway dsh-cron dsh-assistant personal-feed-selector personal-feed x-feed; do
    mkdir -p "$source/$package"
    printf '%s\n' '{}' >"$source/$package/package.json"
  done
  mkdir -p "$source/release/scripts" "$source/release/tests" "$source/release/workspace-migrations" "$source/skills" "$source/scripts"
  touch "$source/release/cli.mjs" "$source/release/dsh" "$source/release/notion.production.json"
  touch "$source/release/harness-automation-instructions.md" "$source/release/vitest.external.config.ts"
  touch "$source/runtime-package-topology.json" "$source/scripts/materialize-runtime-topology.mjs"
  for profile in web telegram telegram-test; do
    mkdir -p "$source/release/profiles/$profile"
    touch "$source/release/profiles/$profile/package.json" "$source/release/profiles/$profile/cordis.patch.yml"
  done
}
prepare_source "$source_a"
prepare_source "$source_b"

run_dev() {
  PATH="$fake_bin:$PATH" \
  DSH_RELEASE_STATE_ROOT="$state_root" \
  DSH_CONTAINER_ENGINE="$mock_engine" \
  MOCK_ENGINE_STATE="$mock_state" \
  MOCK_ENGINE_LOG="$test_root/engine.log" \
  MOCK_GIT_COMMIT="1111111111111111111111111111111111111111" \
  MOCK_SNAPSHOT_ARCHIVE="$snapshot_archive" \
  MOCK_SNAPSHOT_SHA="$snapshot_sha" \
  MOCK_REMOTE_SNAPSHOT="$remote_snapshot" \
    "$repo_root/release/dsh" "$@"
}

extract_ready_receipt() {
  awk '
    /^\{$/ { block = $0 ORS; next }
    { block = block $0 ORS }
    /^\}$/ {
      if (block ~ /"result": "dev-source-ready"/) { printf "%s", block; exit }
      block = ""
    }
  ' "$1" >"$2"
}

run_dev dev prepare --source "$source_a" --candidate "$candidate" >"$test_root/a.log"
run_dev dev prepare --source "$source_b" --candidate "$candidate" >"$test_root/b.log"
extract_ready_receipt "$test_root/a.log" "$test_root/a.json"
extract_ready_receipt "$test_root/b.log" "$test_root/b.json"

node - <<'NODE' "$test_root/a.json" "$test_root/b.json"
const fs = require('node:fs')
const a = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const b = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
for (const key of ['network', 'toolbox', 'fakeTelegram', 'fakeNotion', 'telegram', 'web', 'webPort']) {
  if (a.runtime[key] === b.runtime[key]) throw new Error(`runtime field collided: ${key}`)
}
if (a.homePath === b.homePath || a.leasePath === b.leasePath) throw new Error('development data or lease collided')
NODE

runtime_a_web="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runtime.web)' "$test_root/a.json")"
runtime_b_web="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runtime.web)' "$test_root/b.json")"
runtime_a_toolbox="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runtime.toolbox)' "$test_root/a.json")"
runtime_b_toolbox="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runtime.toolbox)' "$test_root/b.json")"
runtime_a_fake_notion="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runtime.fakeNotion)' "$test_root/a.json")"
runtime_b_fake_notion="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runtime.fakeNotion)' "$test_root/b.json")"
test -f "$mock_state/running/$runtime_a_web"
test -f "$mock_state/running/$runtime_b_web"
test -f "$mock_state/running/$runtime_a_toolbox"
test -f "$mock_state/running/$runtime_b_toolbox"
test -f "$mock_state/running/$runtime_a_fake_notion"
test -f "$mock_state/running/$runtime_b_fake_notion"
grep -Fq "io.dsh.dev.source-path=$source_a" "$test_root/engine.log"
grep -Fq 'io.dsh.dev.role=toolbox' "$test_root/engine.log"
grep -Fq 'io.dsh.dev.role=fake-notion' "$test_root/engine.log"
grep -Fq -- "--name $runtime_a_fake_notion --network dsh-dev-" "$test_root/engine.log"
grep -Fq -- "--name $runtime_a_web --network dsh-dev-" "$test_root/engine.log"
grep -Fq 'NOTION_API_BASE=http://fake-notion:8081/v1' "$test_root/engine.log"
grep -Fq 'NOTION_PAGE_ID=00000000000000000000000000000001' "$test_root/engine.log"

for source in "$source_a" "$source_b"; do
  grep -Fq "$source/personal-feed:/opt/dsh/harness/local-plugins/personal-feed:rw" "$test_root/engine.log"
  grep -Fq "$source/personal-feed:/opt/dsh/harness/local-plugins/node_modules/@herman/personal-feed:ro" "$test_root/engine.log"
done
! grep -Eq '/opt/dsh/harness/node_modules/\.pnpm/node_modules/@herman/personal-feed:(ro|rw)([^[:alnum:]_-]|$)' "$test_root/engine.log"

python3 - "$test_root/engine.log" "$source_a" "$source_b" <<'PY'
import pathlib, sys

log, source_a, source_b = map(pathlib.Path, sys.argv[1:])
for line in log.read_text(encoding='utf-8').splitlines():
    if str(source_a) in line and str(source_b) in line:
        raise SystemExit(f"crossed worktree source mounts: {line}")
    if '/opt/dsh/harness/local-profiles/' in line and '/node_modules/@herman/personal-feed:' in line:
        raise SystemExit(f"unexpected profile Personal Feed mount: {line}")
PY

run_dev dev down --source "$source_a" >"$test_root/down-a.json"
test ! -e "$mock_state/running/$runtime_a_web"
test ! -e "$mock_state/running/$runtime_a_toolbox"
test ! -e "$mock_state/running/$runtime_a_fake_notion"
test -e "$mock_state/running/$runtime_b_web"
test -e "$mock_state/running/$runtime_b_toolbox"
test -e "$mock_state/running/$runtime_b_fake_notion"

run_dev dev down --source "$source_b" >"$test_root/down-b.json"
run_dev dev retire --source "$source_a" >"$test_root/retire-a.json"
run_dev dev retire --source "$source_b" >"$test_root/retire-b.json"
test -z "$(find "$state_root/dev/environments" -mindepth 1 -print -quit 2>/dev/null || true)"
test -z "$(find "$state_root/dev/leases" -mindepth 1 -print -quit 2>/dev/null || true)"
test -z "$(find "$state_root/dev/runtimes" -mindepth 1 -print -quit 2>/dev/null || true)"
test -f "$candidate"

printf 'parallel per-worktree dev prepare contract passed\n'
