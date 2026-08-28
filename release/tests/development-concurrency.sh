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
    while (($#)); do
      case "$1" in
        --name) name="$2"; shift 2 ;;
        --detach) detached=true; shift ;;
        *) shift ;;
      esac
    done
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
    else
      printf '%s|true\n' "$image_id"
    fi
    ;;
  exec)
    name="$1"
    shift
    if [[ "$name" == *-telegram && "$*" == *'https://api.telegram.org'* ]]; then exit 7; fi
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
  network) exit 0 ;;
  *) exit 64 ;;
esac
EOF
chmod +x "$mock_engine"

printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$fake_bin/curl"
chmod +x "$fake_bin/curl"

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
mkdir -p "$source_a" "$source_b"

run_dev() {
  PATH="$fake_bin:$PATH" \
  DSH_RELEASE_STATE_ROOT="$state_root" \
  DSH_CONTAINER_ENGINE="$mock_engine" \
  MOCK_ENGINE_STATE="$mock_state" \
  MOCK_ENGINE_LOG="$test_root/engine.log" \
    "$repo_root/release/dsh" "$@"
}

run_dev dev up --source "$source_a" --snapshot synthetic --candidate "$candidate" >"$test_root/a.json"
run_dev dev up --source "$source_b" --snapshot synthetic --candidate "$candidate" >"$test_root/b.json"

node - <<'NODE' "$test_root/a.json" "$test_root/b.json"
const fs = require('node:fs')
const a = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const b = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
for (const key of ['network', 'toolbox', 'fakeTelegram', 'telegram', 'web', 'webPort']) {
  if (a.runtime[key] === b.runtime[key]) throw new Error(`runtime field collided: ${key}`)
}
if (a.homePath === b.homePath || a.leasePath === b.leasePath) throw new Error('development data or lease collided')
NODE

runtime_a_web="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runtime.web)' "$test_root/a.json")"
runtime_b_web="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runtime.web)' "$test_root/b.json")"
runtime_a_toolbox="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runtime.toolbox)' "$test_root/a.json")"
runtime_b_toolbox="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runtime.toolbox)' "$test_root/b.json")"
test -f "$mock_state/running/$runtime_a_web"
test -f "$mock_state/running/$runtime_b_web"
test -f "$mock_state/running/$runtime_a_toolbox"
test -f "$mock_state/running/$runtime_b_toolbox"
grep -Fq "io.dsh.dev.source-path=$source_a" "$test_root/engine.log"
grep -Fq 'io.dsh.dev.role=toolbox' "$test_root/engine.log"

run_dev dev down --source "$source_a" >"$test_root/down-a.json"
test ! -e "$mock_state/running/$runtime_a_web"
test ! -e "$mock_state/running/$runtime_a_toolbox"
test -e "$mock_state/running/$runtime_b_web"
test -e "$mock_state/running/$runtime_b_toolbox"

run_dev dev down --source "$source_b" >"$test_root/down-b.json"
run_dev dev retire --source "$source_a" >"$test_root/retire-a.json"
run_dev dev retire --source "$source_b" >"$test_root/retire-b.json"
test -z "$(find "$state_root/dev/environments" -mindepth 1 -print -quit 2>/dev/null || true)"
test -z "$(find "$state_root/dev/leases" -mindepth 1 -print -quit 2>/dev/null || true)"
test -z "$(find "$state_root/dev/runtimes" -mindepth 1 -print -quit 2>/dev/null || true)"
test -f "$candidate"

printf 'parallel per-worktree development runtime contract passed\n'
