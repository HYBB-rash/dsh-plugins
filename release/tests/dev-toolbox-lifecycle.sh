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
    if [[ "$*" == *'/opt/dsh/release-system/scripts/dev-source-verify.sh'* ]] && [[ "${MOCK_VERIFY_EXIT:-0}" != 0 ]]; then
      exit "$MOCK_VERIFY_EXIT"
    fi
    if [[ "$*" == *'/opt/dsh/release-system/scripts/dev-source-verify.sh'* ]] && [[ -n "${MOCK_VERIFY_SIGNAL:-}" ]]; then
      kill -s "$MOCK_VERIFY_SIGNAL" "$$"
    fi
    if [[ "$*" == *'/opt/dsh/release-system/scripts/dev-source-verify.sh'* ]] && [[ -n "${MOCK_MUTATE_SOURCE:-}" ]]; then
      printf '%s\n' 'changed-during-verify' >"$MOCK_MUTATE_SOURCE"
    fi
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
latest_main="$(git -C "$repo_root" rev-parse origin/main)"
receipt="$test_root/image-tests.json"
cat >"$receipt" <<'EOF'
{
  "schemaVersion": 1,
  "imageId": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
  "harnessCommit": "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
  "pluginsCommit": "$latest_main",
  "releaseToolCommit": "$latest_main",
  "testReceiptPath": "$receipt",
  "testReceiptSha256": "$receipt_sha"
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
  local source="$1" key suffix dev_root toolbox fake_notion network
  key="$(printf '%s' "$source" | sha256sum | awk '{print $1}')"
  suffix="${key:0:12}"
  dev_root="$state_root/dev/environments/$key"
  toolbox="dsh-dev-$suffix-toolbox"
  fake_notion="dsh-dev-$suffix-fake-notion"
  network="dsh-dev-$suffix-internal"
  mkdir -p "$source" "$dev_root/home/herman"
  : >"$mock_state/running/$toolbox"
  : >"$mock_state/running/$fake_notion"
  node - <<'NODE' "$dev_root/dev.json" "$state_root/dev/leases/$key.json" "$state_root/dev/runtimes/$key.json" "$source" "$dev_root" "$network" "$key" "$candidate"
const fs = require('node:fs')
const [metaPath, leasePath, runtimePath, sourcePath, devRoot, network, key, candidatePath] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'))
const runtime = { schemaVersion: 3, sourcePath, key, network, toolbox: `dsh-dev-${key.slice(0, 12)}-toolbox`, web: `dsh-dev-${key.slice(0, 12)}-web`, telegram: `dsh-dev-${key.slice(0, 12)}-telegram`, fakeTelegram: `dsh-dev-${key.slice(0, 12)}-fake-telegram`, fakeNotion: `dsh-dev-${key.slice(0, 12)}-fake-notion`, webPort: 31000 }
fs.writeFileSync(metaPath, JSON.stringify({ schemaVersion: 2, mode: 'editable-source', sourcePath, runtime }) + '\n')
fs.writeFileSync(runtimePath, JSON.stringify(runtime) + '\n')
fs.writeFileSync(leasePath, JSON.stringify({ schemaVersion: 2, sourcePath, candidateId: candidate.candidateId, candidatePath, imageId: candidate.imageId, imageTag: candidate.imageTag, devRoot, runtime }) + '\n')
NODE
}

source_a="$repo_root"
source_b="$test_root/worktree-b"
prepare_fixture "$source_a"
prepare_fixture "$source_b"

run_dev dev shell --source "$source_a" --candidate "$candidate"
run_dev dev shell --source "$source_a" --candidate "$candidate"

key_a="$(printf '%s' "$source_a" | sha256sum | awk '{print $1}')"
key_b="$(printf '%s' "$source_b" | sha256sum | awk '{print $1}')"
toolbox_a="dsh-dev-${key_a:0:12}-toolbox"
toolbox_b="dsh-dev-${key_b:0:12}-toolbox"
fake_notion_a="dsh-dev-${key_a:0:12}-fake-notion"
fake_notion_b="dsh-dev-${key_b:0:12}-fake-notion"

test "$(grep -Fc "exec --interactive --tty --workdir /workspace/dsh-plugins $toolbox_a bash" "$test_root/engine.log")" = 2
run_dev dev verify --source "$source_a" --candidate "$candidate" >"$test_root/verify-all.json"
run_dev dev verify --source "$source_a" --candidate "$candidate" --package telegram-gateway >"$test_root/verify-telegram-gateway.json"
node - <<'NODE' "$test_root/verify-all.json" "$test_root/verify-telegram-gateway.json" "$latest_main"
const fs = require('node:fs')
const [allPath, focusedPath, latestMain] = process.argv.slice(2)
const all = JSON.parse(fs.readFileSync(allPath, 'utf8'))
const focused = JSON.parse(fs.readFileSync(focusedPath, 'utf8'))
if (all.result !== 'dev-source-verified') throw new Error('missing editable verification receipt')
if (all.receipt.baseline.pluginsCommit !== latestMain) throw new Error('missing shared-main baseline receipt')
if (all.receipt.editableSource.scope !== 'all') throw new Error('wrong full verification scope')
if (focused.receipt.editableSource.scope !== 'telegram-gateway') throw new Error('wrong focused verification scope')
if (all.tests.python !== 'release-system-suites') throw new Error('full verification must include release-system Python suites')
if (focused.tests.python !== 'not-applicable') throw new Error('focused package verification must not claim Python suites')
if (!all.receipt.editableSource.sourceFingerprint) throw new Error('missing stable source fingerprint')
NODE
grep -Fq "exec --workdir /workspace/dsh-plugins $toolbox_a bash /opt/dsh/release-system/scripts/dev-source-verify.sh all" "$test_root/engine.log"
grep -Fq "exec --workdir /workspace/dsh-plugins $toolbox_a bash /opt/dsh/release-system/scripts/dev-source-verify.sh telegram-gateway" "$test_root/engine.log"
set +e
MOCK_VERIFY_EXIT=23 \
  DSH_RELEASE_STATE_ROOT="$state_root" \
  DSH_CONTAINER_ENGINE="$mock_engine" \
  MOCK_ENGINE_STATE="$mock_state" \
  MOCK_ENGINE_LOG="$test_root/engine.log" \
    "$repo_root/release/dsh" dev verify --source "$source_a" --candidate "$candidate" >"$test_root/verify-fail.stdout" 2>"$test_root/verify-fail.stderr"
verify_exit="$?"
set -e
test "$verify_exit" = 5
test -f "$mock_state/running/$toolbox_a"
test -f "$state_root/dev/leases/$key_a.json"

make_candidate_variant() {
  local kind="$1" output="$2"
  node - <<'NODE' "$candidate" "$output" "$kind" "$test_root"
const crypto = require('node:crypto')
const fs = require('node:fs')
const [candidatePath, outputPath, kind, root] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'))
if (kind === 'missing') candidate.testReceiptPath = `${root}/missing-image-tests.json`
if (kind === 'bad-sha') candidate.testReceiptSha256 = `sha256:${'0'.repeat(64)}`
if (kind === 'wrong-image') {
  const receiptPath = `${root}/wrong-image-tests.json`
  fs.writeFileSync(receiptPath, JSON.stringify({ schemaVersion: 1, imageId: `sha256:${'b'.repeat(64)}` }) + '\n')
  candidate.testReceiptPath = receiptPath
  candidate.testReceiptSha256 = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex')}`
}
fs.writeFileSync(outputPath, JSON.stringify(candidate) + '\n')
NODE
}

for receipt_case in missing bad-sha wrong-image; do
  bad_candidate="$test_root/candidate-$receipt_case.json"
  make_candidate_variant "$receipt_case" "$bad_candidate"
  set +e
  run_dev dev verify --source "$source_a" --candidate "$bad_candidate" >"$test_root/verify-$receipt_case.stdout" 2>"$test_root/verify-$receipt_case.stderr"
  receipt_exit="$?"
  set -e
  test "$receipt_exit" = 4
  test -f "$mock_state/running/$toolbox_a"
  test -f "$state_root/dev/leases/$key_a.json"
done

mutation_path="$repo_root/release/tests/.dev-verify-source-mutation-fixture"
test ! -e "$mutation_path"
set +e
MOCK_MUTATE_SOURCE="$mutation_path" run_dev dev verify --source "$source_a" --candidate "$candidate" >"$test_root/verify-mutated.stdout" 2>"$test_root/verify-mutated.stderr"
mutation_exit="$?"
set -e
test "$mutation_exit" = 4
grep -q 'editable source 已变化' "$test_root/verify-mutated.stderr"
! grep -q 'dev-source-verified' "$test_root/verify-mutated.stdout"
test -f "$mock_state/running/$toolbox_a"
test -f "$state_root/dev/leases/$key_a.json"
find "$mutation_path" -maxdepth 0 -type f -delete
test ! -e "$mutation_path"

set +e
MOCK_VERIFY_SIGNAL=TERM run_dev dev verify --source "$source_a" --candidate "$candidate" >"$test_root/verify-cancelled.stdout" 2>"$test_root/verify-cancelled.stderr"
cancel_exit="$?"
set -e
test "$cancel_exit" = 143
grep -q 'dev verify 已取消（SIGTERM）' "$test_root/verify-cancelled.stderr"
! grep -q 'dev-source-verified' "$test_root/verify-cancelled.stdout"
test -f "$mock_state/running/$toolbox_a"
test -f "$state_root/dev/leases/$key_a.json"
! grep -Eq '^(create|start) ' "$test_root/engine.log"
! grep -Eq '^run ' "$test_root/engine.log"
test ! -e "$state_root/dev/shells"

node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(r.schemaVersion!==3 || r.toolbox!==process.argv[2] || r.fakeNotion!==process.argv[3]) process.exit(1)' \
  "$state_root/dev/runtimes/$key_a.json" "$toolbox_a" "$fake_notion_a"

run_dev dev down --source "$source_a" >"$test_root/down-a.json"
test ! -e "$mock_state/running/$toolbox_a"
test ! -e "$mock_state/running/$fake_notion_a"
test -e "$mock_state/running/$toolbox_b"
test -e "$mock_state/running/$fake_notion_b"

run_dev dev retire --source "$source_a" >"$test_root/retire-a.json"
test ! -e "$state_root/dev/environments/$key_a"
test ! -e "$state_root/dev/leases/$key_a.json"
test ! -e "$state_root/dev/runtimes/$key_a.json"

run_dev dev retire --source "$source_b" >"$test_root/retire-b.json"
test ! -e "$mock_state/running/$toolbox_b"
test ! -e "$mock_state/running/$fake_notion_b"

printf 'fixed per-worktree development toolbox lifecycle and editable verification contract passed\n'
