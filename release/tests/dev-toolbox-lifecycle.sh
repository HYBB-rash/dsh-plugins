#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="$(mktemp -d)"
cleanup() { find "$test_root" -depth -delete; }
trap cleanup EXIT

state_root="$test_root/state"
mock_state="$test_root/mock-state"
mock_engine="$test_root/mock-engine"
mkdir -p "$state_root/dev/leases" "$state_root/dev/runtimes" "$mock_state/running"
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
    if [[ "$*" == *'io.dsh.candidate.purpose'* ]]; then printf '%s\n' development; else printf '%s\n' "$image_id"; fi
    ;;
  inspect)
    name="$1"
    shift
    test -f "$MOCK_ENGINE_STATE/running/$name"
    if [[ "$*" == *'.State.Running'* ]]; then printf '%s\n' true; else printf '%s|true\n' "$image_id"; fi
    ;;
  exec)
    exit 0
    ;;
  rm)
    if test "${1:-}" = --force; then shift; fi
    find "$MOCK_ENGINE_STATE/running/${1:-missing}" -delete
    ;;
  network) exit 0 ;;
  *) exit 64 ;;
esac
EOF
chmod +x "$mock_engine"

candidate="$test_root/candidate.json"
cat >"$candidate" <<'EOF'
{
  "schemaVersion": 2,
  "candidateId": "development-main-fixture",
  "status": "tested",
  "purpose": "development",
  "imageId": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "imageTag": "localhost/dsh-development-main:fixture",
  "harnessCommit": "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
  "pluginsCommit": "1111111111111111111111111111111111111111",
  "releaseToolCommit": "1111111111111111111111111111111111111111"
}
EOF

run_dev() {
  DSH_RELEASE_STATE_ROOT="$state_root" \
  DSH_CONTAINER_ENGINE="$mock_engine" \
  MOCK_ENGINE_STATE="$mock_state" \
  MOCK_ENGINE_LOG="$test_root/engine.log" \
    "$repo_root/release/dsh" "$@"
}

prepare_fixture() {
  local source="$1" key suffix dev_root toolbox network
  key="$(printf '%s' "$source" | sha256sum | awk '{print $1}')"
  suffix="${key:0:12}"
  dev_root="$state_root/dev/environments/$key"
  toolbox="dsh-dev-$suffix-toolbox"
  network="dsh-dev-$suffix-internal"
  mkdir -p "$source" "$dev_root/home/herman"
  : >"$mock_state/running/$toolbox"
  node - <<'NODE' "$dev_root/dev.json" "$state_root/dev/leases/$key.json" "$state_root/dev/runtimes/$key.json" "$source" "$dev_root" "$network" "$key" "$candidate"
const fs = require('node:fs')
const [metaPath, leasePath, runtimePath, sourcePath, devRoot, network, key, candidatePath] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'))
const runtime = { schemaVersion: 2, sourcePath, key, network, web: `dsh-dev-${key.slice(0, 12)}-web`, telegram: `dsh-dev-${key.slice(0, 12)}-telegram`, fakeTelegram: `dsh-dev-${key.slice(0, 12)}-fake-telegram`, webPort: 31000 }
fs.writeFileSync(metaPath, JSON.stringify({ schemaVersion: 2, mode: 'editable-source', sourcePath, runtime }) + '\n')
fs.writeFileSync(runtimePath, JSON.stringify(runtime) + '\n')
fs.writeFileSync(leasePath, JSON.stringify({ schemaVersion: 2, sourcePath, candidateId: candidate.candidateId, candidatePath, imageId: candidate.imageId, imageTag: candidate.imageTag, devRoot, runtime }) + '\n')
NODE
}

source_a="$test_root/worktree-a"
source_b="$test_root/worktree-b"
prepare_fixture "$source_a"
prepare_fixture "$source_b"

run_dev dev shell --source "$source_a" --candidate "$candidate"
run_dev dev shell --source "$source_a" --candidate "$candidate"

key_a="$(printf '%s' "$source_a" | sha256sum | awk '{print $1}')"
key_b="$(printf '%s' "$source_b" | sha256sum | awk '{print $1}')"
toolbox_a="dsh-dev-${key_a:0:12}-toolbox"
toolbox_b="dsh-dev-${key_b:0:12}-toolbox"

test "$(grep -Fc "exec --interactive --tty --workdir /workspace/dsh-plugins $toolbox_a bash" "$test_root/engine.log")" = 2
! grep -Eq '^(create|start) ' "$test_root/engine.log"
test ! -e "$state_root/dev/shells"

node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(r.schemaVersion!==3 || r.toolbox!==process.argv[2]) process.exit(1)' \
  "$state_root/dev/runtimes/$key_a.json" "$toolbox_a"

run_dev dev down --source "$source_a" >"$test_root/down-a.json"
test ! -e "$mock_state/running/$toolbox_a"
test -e "$mock_state/running/$toolbox_b"

run_dev dev retire --source "$source_a" >"$test_root/retire-a.json"
test ! -e "$state_root/dev/environments/$key_a"
test ! -e "$state_root/dev/leases/$key_a.json"
test ! -e "$state_root/dev/runtimes/$key_a.json"

run_dev dev retire --source "$source_b" >"$test_root/retire-b.json"
test ! -e "$mock_state/running/$toolbox_b"

printf 'fixed per-worktree development toolbox lifecycle contract passed\n'
