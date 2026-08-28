#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="$(mktemp -d)"
cleanup() { find "$test_root" -depth -delete; }
trap cleanup EXIT

state_root="$test_root/state"
mock_state="$test_root/mock-state"
mock_engine="$test_root/mock-engine"
mkdir -p "$state_root/dev/leases" "$state_root/dev/runtimes" "$mock_state/containers"
touch "$test_root/engine.log"

cat >"$mock_engine" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%q ' "$@" >>"$MOCK_ENGINE_LOG"
printf '\n' >>"$MOCK_ENGINE_LOG"
image_id="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
command="${1:-}"
shift || true
container_path() {
  local identity="$1" path
  path="$MOCK_ENGINE_STATE/containers/$identity.json"
  if test -f "$path"; then printf '%s\n' "$path"; return 0; fi
  for path in "$MOCK_ENGINE_STATE"/containers/*.json; do
    test -e "$path" || continue
    if node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(c.Id===process.argv[2]?0:1)' "$path" "$identity"; then
      printf '%s\n' "$path"
      return 0
    fi
  done
  return 1
}
case "$command" in
  image)
    test "${1:-}" = inspect
    if [[ "$*" == *'io.dsh.candidate.purpose'* ]]; then printf '%s\n' development; else printf '%s\n' "$image_id"; fi
    ;;
  create)
    name=''
    network=''
    labels=()
    mounts=()
    args=("$@")
    index=0
    while ((index < ${#args[@]})); do
      case "${args[$index]}" in
        --name) name="${args[$((index + 1))]}"; index=$((index + 2)) ;;
        --network) network="${args[$((index + 1))]}"; index=$((index + 2)) ;;
        --label) labels+=("${args[$((index + 1))]}"); index=$((index + 2)) ;;
        --volume) mounts+=("${args[$((index + 1))]}"); index=$((index + 2)) ;;
        *) index=$((index + 1)) ;;
      esac
    done
    test -n "$name"
    node - <<'NODE' "$MOCK_ENGINE_STATE/containers/$name.json" "$name" "$network" "$image_id" "${labels[*]}" "${mounts[*]}"
const fs = require('node:fs')
const [path, name, network, imageId, labelText, mountText] = process.argv.slice(2)
const labels = Object.fromEntries(labelText.split(' ').filter(Boolean).map((entry) => {
  const at = entry.indexOf('=')
  return [entry.slice(0, at), entry.slice(at + 1)]
}))
const mounts = mountText.split(' ').filter(Boolean).map((entry) => {
  const [source, destination] = entry.split(':')
  return { Source: source, Destination: destination }
})
const networks = network ? { [network]: {} } : {}
fs.writeFileSync(path, JSON.stringify({
  Id: `id-${name}`,
  Name: `/${name}`,
  Image: imageId,
  Config: { Image: 'localhost/dsh-development-main:fixture', Cmd: ['shell'], Labels: labels },
  Mounts: mounts,
  NetworkSettings: { Networks: networks },
}) + '\n')
NODE
    ;;
  start)
    name="${!#}"
    path="$(container_path "$name")"
    if test "${MOCK_LEAVE_SHELL:-0}" = 1; then exit 23; fi
    find "$path" -delete
    ;;
  ps)
    for path in "$MOCK_ENGINE_STATE"/containers/*.json; do
      test -e "$path" || continue
      node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).Id+"\n")' "$path"
    done
    ;;
  inspect)
    path="$(container_path "${1:-}")"
    shift
    if (($# == 0)); then printf '['; cat "$path"; printf ']\n'; else printf '%s\n' true; fi
    ;;
  stop)
    if test "${1:-}" = --time; then shift 2; fi
    for identity in "$@"; do
      path="$(container_path "$identity")"
      find "$path" -delete
    done
    ;;
  rm)
    if test "${1:-}" = --force; then shift; fi
    path="$(container_path "${1:-}")" || exit 0
    find "$path" -delete
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
  local source="$1" key suffix dev_root network
  key="$(printf '%s' "$source" | sha256sum | awk '{print $1}')"
  suffix="${key:0:12}"
  dev_root="$state_root/dev/environments/$key"
  network="dsh-dev-$suffix-internal"
  mkdir -p "$source" "$dev_root/home/herman"
  node - <<'NODE' "$dev_root/dev.json" "$state_root/dev/leases/$key.json" "$state_root/dev/runtimes/$key.json" "$source" "$dev_root" "$network" "$key" "$candidate"
const fs = require('node:fs')
const [metaPath, leasePath, runtimePath, sourcePath, devRoot, network, key, candidatePath] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'))
const runtime = { schemaVersion: 2, sourcePath, key, network, web: `dsh-dev-${key.slice(0, 12)}-web`, telegram: `dsh-dev-${key.slice(0, 12)}-telegram`, fakeTelegram: `dsh-dev-${key.slice(0, 12)}-fake-telegram`, webPort: 31000 }
fs.writeFileSync(metaPath, JSON.stringify({ schemaVersion: 2, mode: 'immutable-candidate', sourcePath, runtime }) + '\n')
fs.writeFileSync(runtimePath, JSON.stringify(runtime) + '\n')
fs.writeFileSync(leasePath, JSON.stringify({ schemaVersion: 2, sourcePath, candidateId: candidate.candidateId, candidatePath, imageId: candidate.imageId, imageTag: candidate.imageTag, devRoot, runtime }) + '\n')
NODE
}

source_a="$test_root/worktree-a"
source_b="$test_root/worktree-b"
prepare_fixture "$source_a"
prepare_fixture "$source_b"

run_dev dev shell --source "$source_a" --candidate "$candidate"
test -z "$(find "$state_root/dev/shells" -name '*.json' ! -name blocked.json -print -quit 2>/dev/null || true)"
grep -Fq 'io.dsh.dev.role=shell' "$test_root/engine.log"
grep -Fq "io.dsh.dev.source-path=$source_a" "$test_root/engine.log"

set +e
MOCK_LEAVE_SHELL=1 run_dev dev shell --source "$source_a" --candidate "$candidate" >"$test_root/shell-a.out" 2>"$test_root/shell-a.err"
status_a=$?
MOCK_LEAVE_SHELL=1 run_dev dev shell --source "$source_b" --candidate "$candidate" >"$test_root/shell-b.out" 2>"$test_root/shell-b.err"
status_b=$?
set -e
test "$status_a" = 5
test "$status_b" = 5
test "$(find "$mock_state/containers" -name '*.json' | wc -l)" = 2

key_a="$(printf '%s' "$source_a" | sha256sum | awk '{print $1}')"
find "$state_root/dev/leases/$key_a.json" "$state_root/dev/runtimes/$key_a.json" -delete
run_dev dev down --source "$source_a" >"$test_root/down-a.json"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(value.shellsStopped.length!==1) process.exit(1)' "$test_root/down-a.json"
test "$(find "$mock_state/containers" -name '*.json' | wc -l)" = 1
grep -Eq '^stop --time 30 ' "$test_root/engine.log"
! grep -Eq '^rm --force .*shell' "$test_root/engine.log"

run_dev dev retire --source "$source_a" >"$test_root/retire-a.json"
test ! -e "$state_root/dev/environments/$key_a"
test ! -e "$state_root/dev/shells/$key_a"

run_dev dev retire --source "$source_b" >"$test_root/retire-b.json"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(value.shellsStopped.length!==1) process.exit(1)' "$test_root/retire-b.json"
test -z "$(find "$mock_state/containers" -name '*.json' -print -quit)"

printf 'owned development shell lifecycle contract passed\n'
