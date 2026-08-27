#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="$(mktemp -d)"
cleanup() { find "$test_root" -depth -delete; }
trap cleanup EXIT

mock_engine="$test_root/mock-engine"
cat >"$mock_engine" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%q ' "$@" >>"$MOCK_ENGINE_LOG"
printf '\n' >>"$MOCK_ENGINE_LOG"
image_id="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
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
        --tag)
          tag="$2"
          shift 2
          ;;
        *) shift ;;
      esac
    done
    printf '%s\n' "$labels" >"$MOCK_ENGINE_STATE/labels.json"
    printf '%s\n' "$tag" >"$MOCK_ENGINE_STATE/tag"
    : >"$MOCK_ENGINE_STATE/image-present"
    ;;
  image)
    action="$1"
    shift
    case "$action" in
      inspect)
        test -f "$MOCK_ENGINE_STATE/image-present"
        if [[ "$*" == *'.Config.Labels'* ]]; then
          cat "$MOCK_ENGINE_STATE/labels.json"
        elif [[ "$*" == *'.Id'* ]]; then
          printf '%s\n' "$image_id"
        fi
        ;;
      rm)
        if [[ "${MOCK_FAIL_ON:-}" == image-rm ]]; then exit 18; fi
        find "$MOCK_ENGINE_STATE/image-present" -delete
        ;;
      *) exit 64 ;;
    esac
    ;;
  run)
    printf '%s\n' '{"selfTest":"passed"}'
    ;;
  save)
    output=''
    tag="$(cat "$MOCK_ENGINE_STATE/tag")"
    while (($#)); do
      if [[ "$1" == --output ]]; then output="$2"; shift 2; else shift; fi
    done
    mkdir -p "$(dirname -- "$output")"
    printf 'partial\n' >"$output"
    if [[ "${MOCK_FAIL_ON:-}" == save ]]; then exit 17; fi
    archive_root="$MOCK_ENGINE_STATE/archive"
    mkdir -p "$archive_root"
    config="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"
    printf '%s\n' '{}' >"$archive_root/$config"
    python3 -c 'import json,sys; print(json.dumps([{"Config":sys.argv[1],"RepoTags":[sys.argv[2]],"Layers":[]}]))' "$config" "$tag" >"$archive_root/manifest.json"
    tar -C "$archive_root" -cf "$output" "$config" manifest.json
    ;;
  load)
    : >"$MOCK_ENGINE_STATE/image-present"
    ;;
  *) exit 64 ;;
esac
EOF
chmod +x "$mock_engine"

state_root="$test_root/state"
staging_root="$test_root/staging"
mock_state="$test_root/mock-state"
mkdir -p "$mock_state" "$staging_root"
touch "$test_root/engine.log"
harness_commit="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).commit)' "$repo_root/release/harness.lock.json")"
plugins_commit="$(git -C "$repo_root" rev-parse HEAD)"

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
  MOCK_FAIL_ON="${MOCK_FAIL_ON:-}" \
    "$repo_root/release/dsh" build --purpose "$purpose" \
      --harness-ref "$harness_commit" --plugins-ref "$plugins_commit"
}

run_build >"$test_root/build.json"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (value.result !== "candidate-built" || value.purpose !== "development") process.exit(1)' "$test_root/build.json"
test -z "$(find "$state_root/builds" -mindepth 1 -print -quit)"
test -z "$(find "$staging_root" -mindepth 1 -print -quit)"
successful_candidate_count="$(find "$state_root/candidates" -mindepth 1 -maxdepth 1 -type d | wc -l)"
test "$successful_candidate_count" = 1

set +e
MOCK_FAIL_ON=save run_build >"$test_root/failed-build.out" 2>"$test_root/failed-build.err"
failed_status="$?"
set -e
test "$failed_status" = 5
test -z "$(find "$state_root/builds" -mindepth 1 -print -quit)"
test -z "$(find "$staging_root" -mindepth 1 -print -quit)"
test "$(find "$state_root/candidates" -mindepth 1 -maxdepth 1 -type d | wc -l)" = "$successful_candidate_count"

candidate_path="$(json_field "$test_root/build.json" candidatePath)"
candidate_id="$(json_field "$candidate_path" candidateId)"
dev_root="$state_root/dev/$candidate_id"
mkdir -p "$dev_root/home/herman" "$state_root/dev/leases"
printf '%s\n' fixture >"$dev_root/home/herman/data"
lease_key="$(printf '%s' "$repo_root" | sha256sum | awk '{print $1}')"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({schemaVersion:1,sourcePath:process.argv[2],candidateId:process.argv[3],devRoot:process.argv[4]}, null, 2)+"\n")' \
  "$state_root/dev/leases/$lease_key.json" "$repo_root" "$candidate_id" "$dev_root"

DSH_RELEASE_STATE_ROOT="$state_root" DSH_CONTAINER_ENGINE="$mock_engine" \
MOCK_ENGINE_STATE="$mock_state" MOCK_ENGINE_LOG="$test_root/engine.log" \
  "$repo_root/release/dsh" dev retire --source "$repo_root" >"$test_root/retire.json"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (value.cleanup.result !== "development-base-cleaned") process.exit(1)' "$test_root/retire.json"
test ! -e "$dev_root"
test ! -e "$(dirname -- "$candidate_path")"
test ! -e "$state_root/candidates/latest.json"

run_build >"$test_root/protected-build.json"
protected_candidate_path="$(json_field "$test_root/protected-build.json" candidatePath)"
protected_candidate_id="$(json_field "$protected_candidate_path" candidateId)"
protected_dev_root="$state_root/dev/$protected_candidate_id"
mkdir -p "$protected_dev_root/home/herman" "$state_root/dev/leases" "$state_root/releases/protected"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({schemaVersion:1,sourcePath:process.argv[2],candidateId:process.argv[3],devRoot:process.argv[4]}, null, 2)+"\n")' \
  "$state_root/dev/leases/$lease_key.json" "$repo_root" "$protected_candidate_id" "$protected_dev_root"
node -e 'const fs=require("fs"); const candidate=JSON.parse(fs.readFileSync(process.argv[2], "utf8")); fs.writeFileSync(process.argv[1], JSON.stringify({schemaVersion:1,releaseId:"protected",status:"awaiting-user-acceptance",candidate}, null, 2)+"\n")' \
  "$state_root/releases/protected/release.json" "$protected_candidate_path"

DSH_RELEASE_STATE_ROOT="$state_root" DSH_CONTAINER_ENGINE="$mock_engine" \
MOCK_ENGINE_STATE="$mock_state" MOCK_ENGINE_LOG="$test_root/engine.log" \
  "$repo_root/release/dsh" dev retire --source "$repo_root" >"$test_root/protected-retire.json"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (value.cleanup.candidate !== "kept-referenced") process.exit(1)' "$test_root/protected-retire.json"
test ! -e "$protected_dev_root"
test -e "$protected_candidate_path"

run_build release >"$test_root/formal-build.json"
formal_candidate_path="$(json_field "$test_root/formal-build.json" candidatePath)"
formal_candidate_id="$(json_field "$formal_candidate_path" candidateId)"
run_build development >"$test_root/accepted-stale-development-build.json"
stale_development_path="$(json_field "$test_root/accepted-stale-development-build.json" candidatePath)"
stale_development_id="$(json_field "$stale_development_path" candidateId)"
stale_dev_root="$state_root/dev/$stale_development_id"
mkdir -p "$stale_dev_root/home/herman" "$state_root/dev/leases" "$state_root/releases/accepted"
source_fixture="$test_root/source-worktree"
mkdir -p "$source_fixture"
printf '%s\n' preserved-source >"$source_fixture/source-file"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({schemaVersion:1,sourcePath:process.argv[2],candidateId:process.argv[3],devRoot:process.argv[4]}, null, 2)+"\n")' \
  "$state_root/dev/leases/$lease_key.json" "$source_fixture" "$stale_development_id" "$stale_dev_root"
node -e 'const fs=require("fs"); const candidate=JSON.parse(fs.readFileSync(process.argv[2], "utf8")); fs.writeFileSync(process.argv[1], JSON.stringify({schemaVersion:1,releaseId:"accepted",status:"awaiting-user-acceptance",candidate,production:{engineImageId:candidate.imageId}}, null, 2)+"\n")' \
  "$state_root/releases/accepted/release.json" "$formal_candidate_path"

fake_bin="$test_root/fake-bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/ssh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf '%s\n' 'containers-and-web-healthy'
EOF
cat >"$fake_bin/scp" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$fake_bin/ssh" "$fake_bin/scp"
PATH="$fake_bin:$PATH" DSH_RELEASE_STATE_ROOT="$state_root" DSH_CONTAINER_ENGINE="$mock_engine" \
MOCK_ENGINE_STATE="$mock_state" MOCK_ENGINE_LOG="$test_root/engine.log" \
  "$repo_root/release/dsh" accept --release accepted --evidence passed >"$test_root/accept.json"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (value.result !== "accepted" || value.developmentCleanup.result !== "accepted-release-invalidated-development") process.exit(1)' "$test_root/accept.json"
test ! -e "$stale_dev_root"
test ! -e "$stale_development_path"
test -e "$formal_candidate_path"
test -e "$source_fixture/source-file"

printf 'release cleanup contract passed\n'
