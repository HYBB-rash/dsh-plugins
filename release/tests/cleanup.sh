#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="$(mktemp -d)"
cleanup() { find "$test_root" -depth -delete; }
trap cleanup EXIT

mock_engine="$test_root/podman"
state_root="$test_root/state"
staging_root="$test_root/staging"
mock_state="$test_root/mock-state"
mkdir -p "$mock_state/images" "$staging_root"
touch "$test_root/engine.log"

cat >"$mock_engine" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%q ' "$@" >>"$MOCK_ENGINE_LOG"
printf '\n' >>"$MOCK_ENGINE_LOG"
image_id="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
tag_key() { printf '%s' "$1" | sha256sum | awk '{print $1}'; }
command="${1:-}"
shift || true
case "$command" in
  build)
    labels='{}'
    tag=''
    while (($#)); do
      case "$1" in
        --label)
          pair="$2"
          key="${pair%%=*}"
          value="${pair#*=}"
          labels="$(python3 -c 'import json,sys; value=json.load(sys.stdin); value[sys.argv[1]]=sys.argv[2]; print(json.dumps(value))' "$key" "$value" <<<"$labels")"
          shift 2
          ;;
        --tag) tag="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    key="$(tag_key "$tag")"
    printf '%s\n' "$labels" >"$MOCK_ENGINE_STATE/images/$key.labels"
    printf '%s\n' "$tag" >"$MOCK_ENGINE_STATE/images/$key.tag"
    : >"$MOCK_ENGINE_STATE/images/$key.present"
    printf '%s\n' "$(( $(cat "$MOCK_ENGINE_STATE/build-count" 2>/dev/null || printf 0) + 1 ))" >"$MOCK_ENGINE_STATE/build-count"
    ;;
  image)
    action="$1"
    tag="$2"
    shift 2
    key="$(tag_key "$tag")"
    case "$action" in
      inspect)
        test -f "$MOCK_ENGINE_STATE/images/$key.present"
        if [[ "$*" == *'io.dsh.candidate.purpose'* ]]; then
          python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["io.dsh.candidate.purpose"])' "$MOCK_ENGINE_STATE/images/$key.labels"
        elif [[ "$*" == *'.Config.Labels'* ]]; then
          cat "$MOCK_ENGINE_STATE/images/$key.labels"
        elif [[ "$*" == *'.Id'* ]]; then
          printf '%s\n' "$image_id"
        fi
        ;;
      rm)
        if test -f "$MOCK_ENGINE_STATE/formal-saved" && ! test -f "$MOCK_ENGINE_STATE/external-residue-removed"; then
          printf '%s\n' 'Error: image used by 41eb7fd26a0295dd3194a16cfd67c40bc17d7f9a1146b093390e1b977ee07669: image is in use by a container' >&2
          exit 2
        fi
        find "$MOCK_ENGINE_STATE/images/$key.present" "$MOCK_ENGINE_STATE/images/$key.labels" "$MOCK_ENGINE_STATE/images/$key.tag" -delete
        ;;
      *) exit 64 ;;
    esac
    ;;
  run)
    printf '%s\n' '{"selfTest":"passed"}'
    ;;
  save)
    output=''
    tag="${!#}"
    while (($#)); do
      if [[ "$1" == --output ]]; then output="$2"; shift 2; else shift; fi
    done
    key="$(tag_key "$tag")"
    printf '%s\n' "$tag" >"$MOCK_ENGINE_STATE/saved-tag"
    cp "$MOCK_ENGINE_STATE/images/$key.labels" "$MOCK_ENGINE_STATE/saved-labels"
    archive_root="$MOCK_ENGINE_STATE/archive"
    mkdir -p "$archive_root" "$(dirname -- "$output")"
    config="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"
    printf '%s\n' '{}' >"$archive_root/$config"
    python3 -c 'import json,sys; print(json.dumps([{"Config":sys.argv[1],"RepoTags":[sys.argv[2]],"Layers":[]}]))' "$config" "$tag" >"$archive_root/manifest.json"
    tar -C "$archive_root" -cf "$output" "$config" manifest.json
    : >"$MOCK_ENGINE_STATE/formal-saved"
    ;;
  load)
    tag="$(cat "$MOCK_ENGINE_STATE/saved-tag")"
    key="$(tag_key "$tag")"
    printf '%s\n' "$tag" >"$MOCK_ENGINE_STATE/images/$key.tag"
    cp "$MOCK_ENGINE_STATE/saved-labels" "$MOCK_ENGINE_STATE/images/$key.labels"
    : >"$MOCK_ENGINE_STATE/images/$key.present"
    ;;
  inspect) exit 1 ;;
  ps)
    if [[ " $* " == *' --external '* ]]; then
      printf '%s\t%s\t%s\t%s\n' \
        '41eb7fd26a0295dd3194a16cfd67c40bc17d7f9a1146b093390e1b977ee07669' \
        "$image_id" "${MOCK_EXTERNAL_COMMAND:-buildah}" "${MOCK_EXTERNAL_STATUS:-storage}"
    fi
    ;;
  rm)
    if [[ "${1:-}" == --force && "${2:-}" == 41eb7fd26a0295dd3194a16cfd67c40bc17d7f9a1146b093390e1b977ee07669 && $# == 2 ]]; then
      : >"$MOCK_ENGINE_STATE/external-residue-removed"
      exit 0
    fi
    exit 64
    ;;
  network) exit 0 ;;
  *) exit 64 ;;
esac
EOF
chmod +x "$mock_engine"

harness_commit="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).commit)' "$repo_root/release/harness.lock.json")"
plugins_commit="$(git -C "$repo_root" rev-parse origin/main)"

json_field() {
  node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(value[process.argv[2]]))' "$1" "$2"
}

run_build() {
  local purpose="${1:-development}"
  DSH_RELEASE_STATE_ROOT="$state_root" \
  DSH_RELEASE_ARCHIVE_STAGING_ROOT="$staging_root" \
  DSH_CONTAINER_ENGINE="$mock_engine" \
  MOCK_ENGINE_STATE="$mock_state" \
  MOCK_ENGINE_LOG="$test_root/engine.log" \
  MOCK_EXTERNAL_COMMAND="${MOCK_EXTERNAL_COMMAND:-}" \
  MOCK_EXTERNAL_STATUS="${MOCK_EXTERNAL_STATUS:-}" \
    "$repo_root/release/dsh" build --purpose "$purpose" \
      --harness-ref "$harness_commit" --plugins-ref "$plugins_commit"
}

run_build >"$test_root/build.json"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (value.result !== "candidate-built" || value.purpose !== "development" || value.archivePath !== null || value.archiveSha256 !== null) process.exit(1)' "$test_root/build.json"
test "$(cat "$mock_state/build-count")" = 1
test -z "$(find "$state_root/builds" -mindepth 1 -print -quit)"
test -z "$(find "$staging_root" -mindepth 1 -print -quit)"
! grep -Eq '^save |^load |^image rm ' "$test_root/engine.log"

run_build >"$test_root/reused.json"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (value.result !== "development-base-reused") process.exit(1)' "$test_root/reused.json"
test "$(cat "$mock_state/build-count")" = 1

candidate_path="$(json_field "$test_root/build.json" candidatePath)"
candidate_id="$(json_field "$candidate_path" candidateId)"
source_fixture="$test_root/source-worktree"
lease_key="$(printf '%s' "$source_fixture" | sha256sum | awk '{print $1}')"
dev_root="$state_root/dev/environments/$lease_key"
mkdir -p "$dev_root/home/herman" "$state_root/dev/leases"
printf '%s\n' fixture >"$dev_root/home/herman/data"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({schemaVersion:2,sourcePath:process.argv[2],candidateId:process.argv[3],devRoot:process.argv[4]}, null, 2)+"\n")' \
  "$state_root/dev/leases/$lease_key.json" "$source_fixture" "$candidate_id" "$dev_root"

DSH_RELEASE_STATE_ROOT="$state_root" DSH_CONTAINER_ENGINE="$mock_engine" \
MOCK_ENGINE_STATE="$mock_state" MOCK_ENGINE_LOG="$test_root/engine.log" \
  "$repo_root/release/dsh" dev retire --source "$source_fixture" >"$test_root/retire.json"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (value.cleanup.result !== "development-environment-cleaned" || value.cleanup.sharedMainImage !== "kept") process.exit(1)' "$test_root/retire.json"
test ! -e "$dev_root"
test -e "$candidate_path"
test -e "$state_root/dev/main-candidate.json"

# A stale development base and its worktree environment are removed when the
# current main base is admitted again. Source worktrees themselves remain.
stale_id="development-1111111111111111111111111111111111111111"
stale_dir="$state_root/candidates/$stale_id"
stale_tag="localhost/dsh-development-main:1111111111111111111111111111111111111111"
mkdir -p "$stale_dir" "$source_fixture/stale"
node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[2], "utf8")); c.candidateId=process.argv[3]; c.pluginsCommit="1111111111111111111111111111111111111111"; c.imageTag=process.argv[4]; fs.writeFileSync(process.argv[1], JSON.stringify(c, null, 2)+"\n")' \
  "$stale_dir/candidate.json" "$candidate_path" "$stale_id" "$stale_tag"
stale_key="$(printf '%s' "$source_fixture/stale" | sha256sum | awk '{print $1}')"
stale_dev="$state_root/dev/environments/$stale_key"
mkdir -p "$stale_dev"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({schemaVersion:2,sourcePath:process.argv[2],candidateId:process.argv[3],devRoot:process.argv[4]}, null, 2)+"\n")' \
  "$state_root/dev/leases/$stale_key.json" "$source_fixture/stale" "$stale_id" "$stale_dev"
stale_engine_key="$(printf '%s' "$stale_tag" | sha256sum | awk '{print $1}')"
cp "$(find "$mock_state/images" -name '*.labels' -print -quit)" "$mock_state/images/$stale_engine_key.labels"
printf '%s\n' "$stale_tag" >"$mock_state/images/$stale_engine_key.tag"
: >"$mock_state/images/$stale_engine_key.present"

run_build >"$test_root/reused-clean.json"
test ! -e "$stale_dir"
test ! -e "$stale_dev"
test -d "$source_fixture/stale"

stale_build="$state_root/builds/20260829T000000000Z-${plugins_commit:0:12}"
mkdir -p "$stale_build/context"
touch "$stale_build/harness.tar" "$stale_build/plugins.tar" "$stale_build/release-system.tar"

run_build release >"$test_root/formal-build.json"
formal_candidate_path="$(json_field "$test_root/formal-build.json" candidatePath)"
test -f "$(json_field "$formal_candidate_path" archivePath)"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const cleanup=value.archiveRoundTripCleanup; if (cleanup.removedExternalContainers.length !== 1 || cleanup.removedStaleBuildRoots.length !== 1) process.exit(1)' "$formal_candidate_path"
test ! -e "$stale_build"
grep -Eq '^save ' "$test_root/engine.log"
grep -Eq '^load ' "$test_root/engine.log"
grep -Eq '^image rm ' "$test_root/engine.log"
test "$(grep -Ec '^image rm ' "$test_root/engine.log")" -ge 2
grep -Eq '^ps --all --external --no-trunc ' "$test_root/engine.log"
grep -Eq '^rm --force 41eb7fd26a0295dd3194a16cfd67c40bc17d7f9a1146b093390e1b977ee07669 ' "$test_root/engine.log"
! grep -Eq '^(system prune|rm .* (--all|--volumes)( |$))' "$test_root/engine.log"

# The same image-removal error must remain a hard stop when the blocker is an
# ordinary/running container rather than an external Buildah storage residue.
mkdir -p "$stale_build/context"
touch "$stale_build/harness.tar" "$stale_build/plugins.tar" "$stale_build/release-system.tar"
find "$mock_state/external-residue-removed" -delete
forced_removals_before="$(grep -Ec '^rm --force ' "$test_root/engine.log")"
set +e
MOCK_EXTERNAL_STATUS=running run_build release >"$test_root/unsafe-build.json" 2>"$test_root/unsafe-build.err"
unsafe_status=$?
set -e
test "$unsafe_status" = 5
grep -Fq '不是可确认的 Buildah 外部存储残留' "$test_root/unsafe-build.err"
test "$(grep -Ec '^rm --force ' "$test_root/engine.log")" = "$forced_removals_before"
test -d "$stale_build"
: >"$mock_state/external-residue-removed"

# Accepted production invalidates and removes the current development base
# while preserving task source and formal release evidence.
mkdir -p "$dev_root" "$state_root/dev/leases" "$state_root/releases/accepted"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({schemaVersion:2,sourcePath:process.argv[2],candidateId:process.argv[3],devRoot:process.argv[4]}, null, 2)+"\n")' \
  "$state_root/dev/leases/$lease_key.json" "$source_fixture" "$candidate_id" "$dev_root"
node -e 'const fs=require("fs"); const candidate=JSON.parse(fs.readFileSync(process.argv[2], "utf8")); fs.writeFileSync(process.argv[1], JSON.stringify({schemaVersion:1,releaseId:"accepted",status:"awaiting-user-acceptance",candidate,production:{engineImageId:candidate.imageId}}, null, 2)+"\n")' \
  "$state_root/releases/accepted/release.json" "$formal_candidate_path"

fake_bin="$test_root/fake-bin"
mkdir -p "$fake_bin"
printf '%s\n' '#!/usr/bin/env bash' 'cat >/dev/null' "printf '%s\\n' containers-and-web-healthy" >"$fake_bin/ssh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$fake_bin/scp"
chmod +x "$fake_bin/ssh" "$fake_bin/scp"
PATH="$fake_bin:$PATH" DSH_RELEASE_STATE_ROOT="$state_root" DSH_CONTAINER_ENGINE="$mock_engine" \
MOCK_ENGINE_STATE="$mock_state" MOCK_ENGINE_LOG="$test_root/engine.log" \
  "$repo_root/release/dsh" accept --release accepted --evidence passed >"$test_root/accept.json"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (value.result !== "accepted" || value.developmentCleanup.result !== "accepted-release-invalidated-development") process.exit(1)' "$test_root/accept.json"
test ! -e "$candidate_path"
test ! -e "$state_root/dev/main-candidate.json"
test -e "$formal_candidate_path"
test -d "$source_fixture"

printf 'release cleanup and single-main development image contract passed\n'
