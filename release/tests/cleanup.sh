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
    printf '%s\n' "$image_id" >"$MOCK_ENGINE_STATE/images/$key.id"
    : >"$MOCK_ENGINE_STATE/images/$key.present"
    printf '%s\n' "$(( $(cat "$MOCK_ENGINE_STATE/build-count" 2>/dev/null || printf 0) + 1 ))" >"$MOCK_ENGINE_STATE/build-count"
    ;;
  image)
    action="$1"
    tag="$2"
    shift 2
    key="$(tag_key "$tag")"
    if ! test -f "$MOCK_ENGINE_STATE/images/$key.present"; then
      id_file="$(grep -lFx -- "$tag" "$MOCK_ENGINE_STATE"/images/*.id 2>/dev/null | head -n 1 || true)"
      test -n "$id_file" && key="$(basename -- "$id_file" .id)"
    fi
    case "$action" in
      inspect)
        test -f "$MOCK_ENGINE_STATE/images/$key.present"
        if [[ "$*" == *'io.dsh.candidate.purpose'* ]]; then
          python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["io.dsh.candidate.purpose"])' "$MOCK_ENGINE_STATE/images/$key.labels"
        elif [[ "$*" == *'.Config.Labels'* ]]; then
          cat "$MOCK_ENGINE_STATE/images/$key.labels"
        elif [[ "$*" == *'.Id'* ]]; then
          printf '%s' "$(cat "$MOCK_ENGINE_STATE/images/$key.id")"
          [[ "$*" == *'.Size'* ]] && printf '|4096'
          printf '\n'
        fi
        ;;
      rm)
        if test -f "$MOCK_ENGINE_STATE/formal-saved" && ! test -f "$MOCK_ENGINE_STATE/external-residue-removed"; then
          printf '%s\n' 'Error: image used by 41eb7fd26a0295dd3194a16cfd67c40bc17d7f9a1146b093390e1b977ee07669: image is in use by a container' >&2
          exit 2
        fi
        if ! test -f "$MOCK_ENGINE_STATE/images/$key.present"; then
          printf 'Error: %s: image not known\n' "$tag" >&2
          exit 125
        fi
        find "$MOCK_ENGINE_STATE/images/$key.present" "$MOCK_ENGINE_STATE/images/$key.labels" "$MOCK_ENGINE_STATE/images/$key.tag" "$MOCK_ENGINE_STATE/images/$key.id" -delete
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
    printf '%s\n' "$image_id" >"$MOCK_ENGINE_STATE/images/$key.id"
    : >"$MOCK_ENGINE_STATE/images/$key.present"
    ;;
  inspect)
    if [[ "${1:-}" == referencing-container && "${*: -1}" == '{{.Image}}' && -n "${MOCK_REFERENCED_IMAGE_ID:-}" ]]; then
      printf '%s\n' "$MOCK_REFERENCED_IMAGE_ID"
      exit 0
    fi
    exit 1
    ;;
  ps)
    if [[ " $* " == *' --external '* ]]; then
      printf '%s\t%s\t%s\t%s\t%s\n' \
        '41eb7fd26a0295dd3194a16cfd67c40bc17d7f9a1146b093390e1b977ee07669' \
        "$image_id" "${MOCK_EXTERNAL_COMMAND:-buildah}" "${MOCK_EXTERNAL_STATUS:-storage}" \
        "${MOCK_EXTERNAL_CREATED_AT:-2026-08-29T00:00:02.000Z}"
    elif [[ " $* " == *' --all '* && " $* " == *' --quiet '* && -n "${MOCK_REFERENCED_IMAGE_ID:-}" ]]; then
      printf '%s\n' referencing-container
    fi
    ;;
  rm)
    if [[ "${1:-}" == --force && "${2:-}" == 41eb7fd26a0295dd3194a16cfd67c40bc17d7f9a1146b093390e1b977ee07669 && $# == 2 ]]; then
      : >"$MOCK_ENGINE_STATE/external-residue-removed"
      saved_tag="$(cat "$MOCK_ENGINE_STATE/saved-tag")"
      saved_key="$(tag_key "$saved_tag")"
      find "$MOCK_ENGINE_STATE/images/$saved_key.present" "$MOCK_ENGINE_STATE/images/$saved_key.labels" "$MOCK_ENGINE_STATE/images/$saved_key.tag" "$MOCK_ENGINE_STATE/images/$saved_key.id" -delete
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

write_development_lease() {
  node -e '
    const fs = require("fs")
    const [leasePath, sourcePath, candidateId, devRoot, key] = process.argv.slice(1)
    const suffix = key.slice(0, 12)
    const runtime = {
      schemaVersion: 3,
      sourcePath,
      key,
      network: `dsh-dev-${suffix}-internal`,
      toolbox: `dsh-dev-${suffix}-toolbox`,
      fakeTelegram: `dsh-dev-${suffix}-fake-telegram`,
      fakeNotion: `dsh-dev-${suffix}-fake-notion`,
      telegram: `dsh-dev-${suffix}-telegram`,
      web: `dsh-dev-${suffix}-web`,
      webPort: 13080,
    }
    fs.writeFileSync(leasePath, `${JSON.stringify({schemaVersion: 2, sourcePath, candidateId, devRoot, runtime}, null, 2)}\n`)
  ' "$1" "$2" "$3" "$4" "$5"
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
  MOCK_EXTERNAL_CREATED_AT="${MOCK_EXTERNAL_CREATED_AT:-}" \
  MOCK_REFERENCED_IMAGE_ID="${MOCK_REFERENCED_IMAGE_ID:-}" \
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
write_development_lease \
  "$state_root/dev/leases/$lease_key.json" "$source_fixture" "$candidate_id" "$dev_root" "$lease_key"

DSH_RELEASE_STATE_ROOT="$state_root" DSH_CONTAINER_ENGINE="$mock_engine" \
MOCK_ENGINE_STATE="$mock_state" MOCK_ENGINE_LOG="$test_root/engine.log" \
  "$repo_root/release/dsh" dev retire --source "$source_fixture" >"$test_root/retire.json"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (value.cleanup.result !== "development-environment-cleaned" || value.cleanup.sharedMainImage !== "kept") process.exit(1)' "$test_root/retire.json"
test ! -e "$dev_root"
test -e "$candidate_path"
test -e "$state_root/dev/main-candidate.json"

# A stale development image and its worktree environment are removed when the
# current main base is admitted again. Small candidate/test evidence and source
# worktrees remain.
stale_id="development-1111111111111111111111111111111111111111"
stale_dir="$state_root/candidates/$stale_id"
stale_tag="localhost/dsh-development-main:1111111111111111111111111111111111111111"
mkdir -p "$stale_dir" "$source_fixture/stale"
node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[2], "utf8")); c.candidateId=process.argv[3]; c.pluginsCommit="1111111111111111111111111111111111111111"; c.imageTag=process.argv[4]; fs.writeFileSync(process.argv[1], JSON.stringify(c, null, 2)+"\n")' \
  "$stale_dir/candidate.json" "$candidate_path" "$stale_id" "$stale_tag"
stale_key="$(printf '%s' "$source_fixture/stale" | sha256sum | awk '{print $1}')"
stale_dev="$state_root/dev/environments/$stale_key"
mkdir -p "$stale_dev"
write_development_lease \
  "$state_root/dev/leases/$stale_key.json" "$source_fixture/stale" "$stale_id" "$stale_dev" "$stale_key"
stale_engine_key="$(printf '%s' "$stale_tag" | sha256sum | awk '{print $1}')"
cp "$(find "$mock_state/images" -name '*.labels' -print -quit)" "$mock_state/images/$stale_engine_key.labels"
printf '%s\n' "$stale_tag" >"$mock_state/images/$stale_engine_key.tag"
printf '%s\n' 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' >"$mock_state/images/$stale_engine_key.id"
: >"$mock_state/images/$stale_engine_key.present"

run_build >"$test_root/reused-clean.json"
test -e "$stale_dir/candidate.json"
test "$(json_field "$stale_dir/candidate.json" status)" = retired
test ! -e "$stale_dev"
test -d "$source_fixture/stale"

stale_build="$state_root/builds/20260829T000000000Z-111111111111"
mkdir -p "$stale_build/context"
touch "$stale_build/harness.tar" "$stale_build/plugins.tar" "$stale_build/release-system.tar"

run_build release >"$test_root/formal-build.json"
formal_candidate_path="$(json_field "$test_root/formal-build.json" candidatePath)"
test -f "$(json_field "$formal_candidate_path" archivePath)"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const cleanup=value.archiveRoundTripCleanup; if (cleanup.removedExternalContainers.length !== 1 || cleanup.removedStaleBuildRoots.length !== 1 || cleanup.staleBuildEvidenceIds[0] !== "20260829T000000000Z-111111111111") process.exit(1)' "$formal_candidate_path"
test ! -e "$stale_build"
grep -Eq '^save ' "$test_root/engine.log"
grep -Eq '^load ' "$test_root/engine.log"
grep -Eq '^image rm ' "$test_root/engine.log"
test "$(grep -Ec '^image rm ' "$test_root/engine.log")" -ge 2
grep -Eq '^ps --all --external --no-trunc --filter id=' "$test_root/engine.log"
! grep -Eq '^ps .*--filter ancestor=' "$test_root/engine.log"
grep -Eq '^rm --force 41eb7fd26a0295dd3194a16cfd67c40bc17d7f9a1146b093390e1b977ee07669 ' "$test_root/engine.log"
! grep -Eq '^(system prune|rm .* (--all|--volumes)( |$))' "$test_root/engine.log"

# Once the physical stale build root is gone, its tested candidate cleanup
# receipt remains bounded evidence for another exact residue from that build.
find "$mock_state/external-residue-removed" -delete
run_build release >"$test_root/receipt-backed-build.json"
receipt_backed_candidate_path="$(json_field "$test_root/receipt-backed-build.json" candidatePath)"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const cleanup=value.archiveRoundTripCleanup; if (cleanup.removedExternalContainers.length !== 1 || cleanup.removedStaleBuildRoots.length !== 0 || cleanup.staleBuildEvidenceIds[0] !== "20260829T000000000Z-111111111111") process.exit(1)' "$receipt_backed_candidate_path"
test ! -e "$stale_build"

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

# A storage residue outside every live or recorded build window is unrelated
# and must not be deleted even when all other fields look like Buildah output.
find "$mock_state/external-residue-removed" -delete
forced_removals_before="$(grep -Ec '^rm --force ' "$test_root/engine.log")"
set +e
MOCK_EXTERNAL_CREATED_AT=2026-08-30T00:00:00.000Z run_build release >"$test_root/unrelated-build.json" 2>"$test_root/unrelated-build.err"
unrelated_status=$?
set -e
test "$unrelated_status" = 5
grep -Fq '创建时间不属于已确认的中断正式构建' "$test_root/unrelated-build.err"
test "$(grep -Ec '^rm --force ' "$test_root/engine.log")" = "$forced_removals_before"
test -d "$stale_build"
: >"$mock_state/external-residue-removed"

# Accepted production invalidates the current development base while preserving
# task source and all small candidate/test evidence.
mkdir -p "$dev_root" "$state_root/dev/leases" "$state_root/releases/accepted"
write_development_lease \
  "$state_root/dev/leases/$lease_key.json" "$source_fixture" "$candidate_id" "$dev_root" "$lease_key"

# Add one exact failed/historical formal candidate with a distinct Podman image
# so archive and image cleanup are both observable.
historical_id="20260829T000100000Z-111111111111"
historical_dir="$state_root/candidates/$historical_id"
historical_tag="localhost/dsh-candidate:historical"
historical_image="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
mkdir -p "$historical_dir"
printf '%s\n' historical-archive >"$historical_dir/image.tar"
printf '%s\n' '{"result":"historical-test-receipt"}' >"$historical_dir/image-tests.json"
node - <<'NODE' "$formal_candidate_path" "$historical_dir/candidate.json" "$historical_id" "$historical_tag" "$historical_image"
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const [sourcePath, outputPath, candidateId, imageTag, imageId] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
const directory = path.dirname(outputPath)
const sha = (value) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(value)).digest('hex')}`
Object.assign(candidate, {
  candidateId,
  imageTag,
  imageId,
  archivePath: path.join(directory, 'image.tar'),
  archiveSha256: sha(path.join(directory, 'image.tar')),
  testReceiptPath: path.join(directory, 'image-tests.json'),
  testReceiptSha256: sha(path.join(directory, 'image-tests.json')),
})
fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`)
NODE
historical_engine_key="$(printf '%s' "$historical_tag" | sha256sum | awk '{print $1}')"
cp "$(find "$mock_state/images" -name '*.labels' -print -quit)" "$mock_state/images/$historical_engine_key.labels"
printf '%s\n' "$historical_tag" >"$mock_state/images/$historical_engine_key.tag"
printf '%s\n' "$historical_image" >"$mock_state/images/$historical_engine_key.id"
: >"$mock_state/images/$historical_engine_key.present"

snapshot_id="snapshot-current"
snapshot_dir="$state_root/snapshots/$snapshot_id"
mkdir -p "$snapshot_dir" "$state_root/snapshots/snapshot-old"
printf '%s\n' current-production-snapshot >"$snapshot_dir/home.tar.zst"
printf '%s\n' old-production-snapshot >"$state_root/snapshots/snapshot-old/home.tar.zst"
snapshot_sha="sha256:$(sha256sum "$snapshot_dir/home.tar.zst" | awk '{print $1}')"
old_snapshot_sha="sha256:$(sha256sum "$state_root/snapshots/snapshot-old/home.tar.zst" | awk '{print $1}')"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({schemaVersion:1,snapshotId:process.argv[2],archivePath:process.argv[3],archiveSha256:process.argv[4],remoteArchivePath:"/home/herman/.local/share/dsh-container/snapshots/snapshot-current.tar.zst"}, null, 2)+"\n")' \
  "$state_root/snapshots/latest.json" "$snapshot_id" "$snapshot_dir/home.tar.zst" "$snapshot_sha"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({schemaVersion:1,snapshotId:"snapshot-old",archivePath:process.argv[2],archiveSha256:process.argv[3]}, null, 2)+"\n")' \
  "$state_root/snapshots/snapshot-old/snapshot.json" "$state_root/snapshots/snapshot-old/home.tar.zst" "$old_snapshot_sha"

production_sentinel="$test_root/production-data"
mkdir -p "$production_sentinel" "$source_fixture"
printf '%s\n' production-unchanged >"$production_sentinel/data"
printf '%s\n' source-unchanged >"$source_fixture/source"
sentinel_before="$(sha256sum "$production_sentinel/data" "$source_fixture/source")"

remote_current_image="sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
remote_historical_image="sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
remote_failed_image="sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

node - <<'NODE' "$state_root/releases/accepted/release.json" "$formal_candidate_path" "$state_root/snapshots/latest.json" "$remote_current_image"
const fs = require('node:fs')
const [releasePath, candidatePath, snapshotPath, remoteCurrentImage] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'))
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
fs.writeFileSync(releasePath, `${JSON.stringify({
  schemaVersion: 1,
  releaseId: 'accepted',
  status: 'awaiting-user-acceptance',
  candidatePath,
  candidate,
  snapshot,
  previous: {mode: 'docker', releaseId: 'previous', remoteDir: '/home/herman/.local/share/dsh-container/releases/previous', candidate: {imageId: 'sha256:old', imageTag: 'dsh-candidate:old'}, engineImageId: 'sha256:old'},
  production: {engineImageId: remoteCurrentImage},
  userAcceptance: null,
  cleanup: null,
}, null, 2)}\n`)
NODE

remote_before="$test_root/remote-before.json"
remote_after="$test_root/remote-after.json"
node - <<'NODE' "$formal_candidate_path" "$remote_before" "$remote_after" "$remote_current_image" "$remote_historical_image" "$remote_failed_image"
const fs = require('node:fs')
const [candidatePath, beforePath, afterPath, currentDockerImage, historicalDockerImage, failedDockerImage] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'))
const root = '/home/herman/.local/share/dsh-container'
const currentDir = `${root}/releases/accepted`
const snapshotPath = `${root}/snapshots/snapshot-current.tar.zst`
const currentRelease = {schemaVersion:1,releaseId:'accepted',status:'accepted',candidate,production:{engineImageId:currentDockerImage},rollbackBoundary:{status:'retired-at-accept'}}
const item = (name, value, current = false, engineImageId = null) => ({
  name,
  dir:`${root}/releases/${name}`,
  release: current ? currentRelease : {schemaVersion:1,releaseId:name,status:name === 'failed' ? 'failed' : 'accepted',candidate:value,production:{engineImageId}},
  releaseError:null,
  candidate:value,
  candidateError:null,
  archive:{path:`${root}/releases/${name}/image.tar`,bytes:current ? 1000 : 800,...(current ? {sha256:candidate.archiveSha256} : {})},
  compose:{path:`${root}/releases/${name}/compose.production.yml`,bytes:100},
  candidateFile:{path:`${root}/releases/${name}/candidate.json`,bytes:100},
})
const historical = {...candidate,candidateId:'remote-previous',imageId:'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',imageTag:'localhost/dsh-candidate:remote-previous'}
const failed = {...candidate,candidateId:'remote-failed',imageId:'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',imageTag:'localhost/dsh-candidate:remote-failed'}
const base = {
  root,
  currentPath:currentDir,
  lastGoodPath:currentDir,
  latestSnapshot:{schemaVersion:1,snapshotId:'snapshot-current',archivePath:snapshotPath,archiveSha256:'sha256:remote-snapshot'},
  latestSnapshotError:null,
  latestSnapshotArchive:{path:snapshotPath,bytes:2000,sha256:'sha256:remote-snapshot'},
  containersComplete:true,
  containerImages:[],
  errors:[],
}
const before = {...base,
  releases:[item('accepted', candidate, true),item('previous', historical, false, historicalDockerImage),item('failed', failed, false, failedDockerImage)],
  snapshotArchives:[
    {path:snapshotPath,bytes:2000,metadataValid:true},
    {path:`${root}/snapshots/snapshot-old.tar.zst`,bytes:1800,metadataValid:true,metadata:{snapshotId:'snapshot-old',archivePath:`${root}/snapshots/snapshot-old.tar.zst`,archiveSha256:'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'}},
  ],
  images:{
    [candidate.imageTag]:{id:currentDockerImage,size:5000},
    [historical.imageTag]:{id:historicalDockerImage,size:4000},
    [failed.imageTag]:{id:failedDockerImage,size:3000},
  },
}
const after = {...base,
  releases:[item('accepted', candidate, true)],
  snapshotArchives:[{path:snapshotPath,bytes:2000,metadataValid:true}],
  images:{[candidate.imageTag]:{id:currentDockerImage,size:5000}},
}
fs.writeFileSync(beforePath, `${JSON.stringify(before)}\n`)
fs.writeFileSync(afterPath, `${JSON.stringify(after)}\n`)
NODE

fake_bin="$test_root/fake-bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
body="$(cat)"
if [[ "$body" == *DSH_ACCEPT_CLEANUP_INVENTORY_V1* ]]; then
  printf '%s\n' inventory >>"$MOCK_REMOTE_LOG"
  cat "$MOCK_REMOTE_INVENTORY"
elif [[ "$body" == *DSH_ACCEPT_CLEANUP_REMOVE_FILE_V1* ]]; then
  printf 'remove-file %s\n' "$body" >>"$MOCK_REMOTE_LOG"
elif [[ "$body" == *DSH_ACCEPT_CLEANUP_REMOVE_IMAGE_V1* ]]; then
  printf 'remove-image %s\n' "$body" >>"$MOCK_REMOTE_LOG"
else
  if [[ "$body" == *containers-and-web-healthy* ]]; then
    printf '%s\n' acceptance-health >>"$MOCK_REMOTE_LOG"
    printf '%s\n' containers-and-web-healthy
  else
    printf '%s\n' accepted-pointers >>"$MOCK_REMOTE_LOG"
  fi
fi
EOF
cat >"$fake_bin/scp" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
destination="${!#}"
printf 'scp %s\n' "$destination" >>"$MOCK_REMOTE_LOG"
if [[ -n "${MOCK_FAIL_CLEANUP_RECEIPT_ONCE:-}" && "$destination" == *'/cleanup-'* && ! -e "$MOCK_FAIL_CLEANUP_RECEIPT_ONCE" ]]; then
  : >"$MOCK_FAIL_CLEANUP_RECEIPT_ONCE"
  exit 1
fi
EOF
chmod +x "$fake_bin/ssh" "$fake_bin/scp"
touch "$test_root/remote.log"

run_accept() {
  PATH="$fake_bin:$PATH" \
  DSH_RELEASE_STATE_ROOT="$state_root" DSH_CONTAINER_ENGINE="$mock_engine" \
  MOCK_ENGINE_STATE="$mock_state" MOCK_ENGINE_LOG="$test_root/engine.log" \
  MOCK_REFERENCED_IMAGE_ID="${MOCK_REFERENCED_IMAGE_ID:-}" \
  MOCK_REMOTE_LOG="$test_root/remote.log" MOCK_REMOTE_INVENTORY="$MOCK_REMOTE_INVENTORY" \
  MOCK_FAIL_CLEANUP_RECEIPT_ONCE="${MOCK_FAIL_CLEANUP_RECEIPT_ONCE:-}" \
    "$repo_root/release/dsh" accept --release accepted "$@"
}

acceptance_evidence="$test_root/acceptance-evidence.json"
cat >"$acceptance_evidence" <<'EOF'
{
  "schemaVersion": 1,
  "checks": {
    "telegramWebTaskQuery": true,
    "notionReversibleTask": true,
    "temporaryMonitorLifecycle": true,
    "shanghaiReminder": true,
    "dailyCronNextRuns": true,
    "existingMemoryFact": true,
    "noLegacyPathEacces": true,
    "assistantSqliteIntegrity": true
  }
}
EOF

# A partial cleanup-receipt transfer leaves production accepted, reports exit
# 6, and preserves a retryable incomplete receipt instead of rolling back.
set +e
MOCK_REMOTE_INVENTORY="$remote_before" MOCK_FAIL_CLEANUP_RECEIPT_ONCE="$test_root/fail-receipt-once" \
  run_accept --evidence "$acceptance_evidence" >"$test_root/accept-incomplete.json"
accept_status=$?
set -e
test "$accept_status" = 6
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (value.result !== "accepted-cleanup-incomplete" || value.cleanup.status !== "incomplete" || value.cleanup.development.result !== "accepted-release-invalidated-development") process.exit(1)' "$test_root/accept-incomplete.json"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (value.status !== "accepted" || value.rollbackBoundary.status !== "retired-at-accept" || value.cleanup.status !== "incomplete") process.exit(1)' "$state_root/releases/accepted/release.json"

test ! -e "$state_root/dev/main-candidate.json"
test -e "$candidate_path"
test "$(json_field "$candidate_path" status)" = retired
test -e "$formal_candidate_path"
test -e "$(json_field "$formal_candidate_path" archivePath)"
test -e "$(json_field "$formal_candidate_path" testReceiptPath)"
test -e "$historical_dir/candidate.json"
test -e "$historical_dir/image-tests.json"
test ! -e "$historical_dir/image.tar"
test ! -e "$state_root/candidates/latest.json"
test -e "$snapshot_dir/home.tar.zst"
test ! -e "$state_root/snapshots/snapshot-old/home.tar.zst"
test -d "$source_fixture"
test "$sentinel_before" = "$(sha256sum "$production_sentinel/data" "$source_fixture/source")"
grep -q '/releases/previous/image.tar' "$test_root/remote.log"
grep -q '/releases/failed/image.tar' "$test_root/remote.log"
grep -q '/snapshots/snapshot-old.tar.zst' "$test_root/remote.log"
grep -q 'remote-previous' "$test_root/remote.log"
grep -q 'remote-failed' "$test_root/remote.log"
! grep -Eq 'system prune|image prune|volume prune' "$test_root/engine.log" "$test_root/remote.log"
! grep -Eq 'remove-file .*release.json|remove-file .*candidate.json|remove-file .*compose.production.yml|remove-file .*image-tests.json' "$test_root/remote.log"

# Retry the same accepted release without evidence. It must not repeat business
# acceptance and converges idempotently once the receipt transfer succeeds.
MOCK_REMOTE_INVENTORY="$remote_after" run_accept >"$test_root/accept-retry.json"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (value.result !== "accepted" || value.cleanup.status !== "complete" || !value.cleanup.completedAt) process.exit(1)' "$test_root/accept-retry.json"
test "$(grep -c '^acceptance-health$' "$test_root/remote.log")" = 1

# Corrupt latest-snapshot metadata: no formal archive may be deleted.
printf '%s\n' '{"schemaVersion":1,"snapshotId":"broken"}' >"$state_root/snapshots/latest.json"
printf '%s\n' must-remain >"$historical_dir/image.tar"
node -e 'const fs=require("fs"); const p=process.argv[1]; const value=JSON.parse(fs.readFileSync(p,"utf8")); value.cleanup.status="incomplete"; fs.writeFileSync(p,JSON.stringify(value,null,2)+"\n")' "$state_root/releases/accepted/release.json"
set +e
MOCK_REMOTE_INVENTORY="$remote_after" run_accept >"$test_root/broken-snapshot.json"
broken_snapshot_status=$?
set -e
test "$broken_snapshot_status" = 6
test -e "$historical_dir/image.tar"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (!value.cleanup.errors.some((error)=>error.code==="latest-snapshot-incomplete")) process.exit(1)' "$test_root/broken-snapshot.json"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({schemaVersion:1,snapshotId:process.argv[2],archivePath:process.argv[3],archiveSha256:process.argv[4],remoteArchivePath:"/home/herman/.local/share/dsh-container/snapshots/snapshot-current.tar.zst"}, null, 2)+"\n")' \
  "$state_root/snapshots/latest.json" "$snapshot_id" "$snapshot_dir/home.tar.zst" "$snapshot_sha"

# Corrupt current/last-good inventory pointers: again, formal material remains.
remote_bad_pointer="$test_root/remote-bad-pointer.json"
node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); value.currentPath="/home/herman/.local/share/dsh-container/releases/other"; fs.writeFileSync(process.argv[2],JSON.stringify(value)+"\n")' "$remote_after" "$remote_bad_pointer"
set +e
MOCK_REMOTE_INVENTORY="$remote_bad_pointer" run_accept >"$test_root/broken-pointer.json"
broken_pointer_status=$?
set -e
test "$broken_pointer_status" = 6
test -e "$historical_dir/image.tar"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (!value.cleanup.errors.some((error)=>error.code==="release-pointers-incomplete")) process.exit(1)' "$test_root/broken-pointer.json"

# A missing remote Docker engine identity must never fall back to the local
# Podman candidate identity or delete any formal material.
remote_missing_engine_id="$test_root/remote-missing-engine-id.json"
node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); delete value.releases[0].release.production.engineImageId; fs.writeFileSync(process.argv[2],JSON.stringify(value)+"\n")' "$remote_after" "$remote_missing_engine_id"
set +e
MOCK_REMOTE_INVENTORY="$remote_missing_engine_id" run_accept >"$test_root/missing-engine-id.json"
missing_engine_id_status=$?
set -e
test "$missing_engine_id_status" = 6
test -e "$historical_dir/image.tar"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (!value.cleanup.errors.some((error)=>error.code==="current-release-incomplete")) process.exit(1)' "$test_root/missing-engine-id.json"

# Exact local/remote container references keep only those images and report
# incomplete; the matching archives may still be removed safely.
cp "$(find "$mock_state/images" -name '*.labels' -print -quit)" "$mock_state/images/$historical_engine_key.labels"
printf '%s\n' "$historical_tag" >"$mock_state/images/$historical_engine_key.tag"
printf '%s\n' "$historical_image" >"$mock_state/images/$historical_engine_key.id"
: >"$mock_state/images/$historical_engine_key.present"
remote_referenced="$test_root/remote-referenced.json"
node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); value.containerImages=[process.argv[3]]; fs.writeFileSync(process.argv[2],JSON.stringify(value)+"\n")' "$remote_before" "$remote_referenced" "$remote_historical_image"
set +e
MOCK_REFERENCED_IMAGE_ID="$historical_image" MOCK_REMOTE_INVENTORY="$remote_referenced" run_accept >"$test_root/referenced-image.json"
referenced_status=$?
set -e
test "$referenced_status" = 6
test ! -e "$historical_dir/image.tar"
test -e "$mock_state/images/$historical_engine_key.present"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (value.cleanup.status!=="incomplete" || !value.cleanup.errors.some((error)=>error.code==="image-referenced")) process.exit(1)' "$test_root/referenced-image.json"

# Status exposes the incomplete residual, then a reference-free retry removes
# the exact image and clears the residual without repeating acceptance.
PATH="$fake_bin:$PATH" DSH_RELEASE_STATE_ROOT="$state_root" MOCK_REMOTE_LOG="$test_root/remote.log" \
  "$repo_root/release/dsh" status >"$test_root/status-incomplete.json"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (value.local.cleanup.status!=="incomplete" || value.local.cleanup.residuals.length<1) process.exit(1)' "$test_root/status-incomplete.json"
MOCK_REMOTE_INVENTORY="$remote_after" run_accept >"$test_root/reference-free-retry.json"
test ! -e "$mock_state/images/$historical_engine_key.present"
node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (value.result!=="accepted" || value.cleanup.status!=="complete") process.exit(1)' "$test_root/reference-free-retry.json"

# Accepted rollback is rejected before any SSH/restoration activity.
remote_calls_before="$(wc -l <"$test_root/remote.log")"
set +e
PATH="$fake_bin:$PATH" DSH_RELEASE_STATE_ROOT="$state_root" "$repo_root/release/dsh" rollback --release accepted --approved >"$test_root/rollback.out" 2>"$test_root/rollback.err"
rollback_status=$?
set -e
test "$rollback_status" = 4
grep -q '回退边界已在 accept 退休' "$test_root/rollback.err"
test "$remote_calls_before" = "$(wc -l <"$test_root/remote.log")"
test "$sentinel_before" = "$(sha256sum "$production_sentinel/data" "$source_fixture/source")"

printf 'release cleanup and single-main development image contract passed\n'
