#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="$(mktemp -d)"
mutable_release_probe="$repo_root/release/.contract-mutable-probe-$$"
cleanup() { rm -f -- "$mutable_release_probe"; rm -rf -- "$test_root"; }
trap cleanup EXIT

archive="$test_root/image.tar"
latest_main="$(git -C "$repo_root" rev-parse origin/main)"
harness_head="$(git -C /home/herman/Documents/Codex/2026-08-14/deepseek-harness rev-parse HEAD)"
release_index="$test_root/release-contract.index"
cp "$(git -C "$repo_root" rev-parse --git-path index)" "$release_index"
GIT_INDEX_FILE="$release_index" git -C "$repo_root" add -A -- .
GIT_INDEX_FILE="$release_index" git -C "$repo_root" add -Af -- release
release_tree="$(GIT_INDEX_FILE="$release_index" git -C "$repo_root" write-tree)"
release_tool_commit="$(printf '%s\n' 'release contract exact worktree fixture' | \
  GIT_AUTHOR_NAME=DSH GIT_AUTHOR_EMAIL=dsh.invalid@example.invalid \
  GIT_COMMITTER_NAME=DSH GIT_COMMITTER_EMAIL=dsh.invalid@example.invalid \
  git -C "$repo_root" commit-tree "$release_tree" -p HEAD)"
fixture_sha="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
workspace_code_sha="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
workspace_manifest_sha="sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
workspace_template_sha="sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
root_instructions_sha="sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
task_skill_sha="sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
compose="$test_root/compose.production.yml"
cat >"$compose" <<'EOF'
services:
  fixture:
    image: dsh-candidate:fixture
EOF
compose_sha="sha256:$(sha256sum "$compose" | awk '{print $1}')"
mkdir -p "$test_root/archive-root"
cat >"$test_root/archive-root/fixture.json" <<EOF
{
  "config": {
    "Labels": {
      "org.opencontainers.image.revision": "$latest_main",
      "io.dsh.release.revision": "$release_tool_commit",
      "io.dsh.harness.revision": "2222222222222222222222222222222222222222",
      "io.dsh.harness.patch-sha256": "$fixture_sha",
      "io.dsh.candidate.purpose": "release",
      "io.dsh.release.compose-sha256": "$compose_sha",
      "io.dsh.workspace-migration.version": "1",
      "io.dsh.workspace-migration.id": "harness-only-workspace-v1",
      "io.dsh.workspace-migration.code-sha256": "$workspace_code_sha",
      "io.dsh.workspace-migration.manifest-sha256": "$workspace_manifest_sha",
      "io.dsh.workspace-migration.template-sha256": "$workspace_template_sha",
      "io.dsh.workspace-migration.root-instructions-sha256": "$root_instructions_sha",
      "io.dsh.workspace-migration.personal-task-list-skill-sha256": "$task_skill_sha",
      "io.dsh.business-automation.owner": "live-harness-workspace",
      "io.dsh.business-automation.included-in-candidate": "false"
    }
  }
}
EOF
printf '%s\n' '[{"Config":"fixture.json","RepoTags":["dsh-candidate:fixture"],"Layers":[]}]' >"$test_root/archive-root/manifest.json"
tar -C "$test_root/archive-root" -cf "$archive" fixture.json manifest.json
archive_sha="sha256:$(sha256sum "$archive" | awk '{print $1}')"
release_receipt="$test_root/release-image-tests.json"
cat >"$release_receipt" <<'EOF'
{"schemaVersion":1,"imageId":"sha256:fixture","startedAt":"2026-08-30T00:00:00.000Z","completedAt":"2026-08-30T00:01:00.000Z","output":"fixture self-test"}
EOF
release_receipt_sha="sha256:$(sha256sum "$release_receipt" | awk '{print $1}')"
candidate="$test_root/candidate.json"
cat >"$candidate" <<EOF
{
  "schemaVersion": 3,
  "candidateId": "fixture",
  "status": "tested",
  "purpose": "release",
  "imageId": "sha256:fixture",
  "imageTag": "dsh-candidate:fixture",
  "archivePath": "$archive",
  "archiveSha256": "$archive_sha",
  "archiveRoundTripCleanup": null,
  "composePath": "$compose",
  "composeSha256": "$compose_sha",
  "pluginsCommit": "$latest_main",
  "releaseToolCommit": "$release_tool_commit",
  "harnessCommit": "2222222222222222222222222222222222222222",
  "harnessPatchSha256": "$fixture_sha",
  "baseImage": "fixture.invalid/dsh-base",
  "baseImageDigest": "$fixture_sha",
  "builtAt": "2026-08-30T00:00:00.000Z",
  "testReceiptPath": "$release_receipt",
  "testReceiptSha256": "$release_receipt_sha",
  "workspaceMigration": {
    "version": 1,
    "migrationId": "harness-only-workspace-v1",
    "codeSha256": "$workspace_code_sha",
    "manifestSha256": "$workspace_manifest_sha",
    "templateSha256": "$workspace_template_sha",
    "rootInstructionsSha256": "$root_instructions_sha",
    "personalTaskListSkillSha256": "$task_skill_sha",
    "businessAutomation": {
      "owner": "live-harness-workspace",
      "includedInCandidate": false
    }
  }
}
EOF

stale_candidate="$test_root/stale-candidate.json"
sed "s/$latest_main/1111111111111111111111111111111111111111/" "$candidate" >"$stale_candidate"
development_candidate="$test_root/development-candidate.json"
development_receipt="$test_root/development-image-tests.json"
cat >"$development_receipt" <<'EOF'
{
  "schemaVersion": 1,
  "imageId": "sha256:fixture",
  "output": "fixture self-test"
}
EOF
development_receipt_sha="sha256:$(sha256sum "$development_receipt" | awk '{print $1}')"
node - <<'NODE' "$candidate" "$development_candidate" "$development_receipt" "$development_receipt_sha"
const fs = require('node:fs')
const [candidatePath, outputPath, receiptPath, receiptSha] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'))
candidate.purpose = 'development'
candidate.schemaVersion = 2
delete candidate.workspaceMigration
delete candidate.composePath
delete candidate.composeSha256
candidate.testReceiptPath = receiptPath
candidate.testReceiptSha256 = receiptSha
fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`)
NODE
stale_development_candidate="$test_root/stale-development-candidate.json"
sed "s/$latest_main/1111111111111111111111111111111111111111/" "$development_candidate" >"$stale_development_candidate"

mkdir -p "$test_root/fake-bin"
cat >"$test_root/fake-bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ " $* " == *' git-upload-pack '* ]]; then
  exec /usr/bin/ssh "$@"
fi
payload="$(cat)"
arguments=" $* "
if [[ "${DSH_TEST_REJECT_SPECIALIZED_BINDING_GATE:-}" == 1 ]] && grep -Fq 'check-notion-retry-binding.mjs' <<<"$payload"; then
  printf '%s\n' 'release must rely on generic cron readiness, not the specialized Notion binding helper' >&2
  exit 71
fi
if [[ "$arguments" == *'check-notion-automation-entrypoint.py'* ]] || grep -Fq 'check-notion-automation-entrypoint.py' <<<"$payload"; then
  printf '%s\n' automation >>"$DSH_TEST_SSH_LOG"
  if [[ "${DSH_TEST_AUTOMATION_MISSING:-}" == 1 ]]; then
    printf '%s\n' 'Harness-owned Notion automation missing' >&2
    exit 51
  fi
  printf '%s\n' '{"status":"ready","owner":"live-harness-workspace","path":"workspace/automations/notion/notion_inbox_sync.py","handoffPath":"workspace/automations/notion/notion_inbox_sync.handoff.json","interfaceVersion":1,"artifactContract":{"interfaceVersion":1,"state":{"role":"state","path":"storages/task-inbox/sync-state.json","mode":"0600"},"fingerprint":{"role":"fingerprint","path":"storages/task-inbox/notion-fingerprint.json","mode":"0600"}},"size":12345,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","handoffSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","testReceiptSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","testedAt":"2026-08-30T00:00:00Z"}'
elif grep -Fq 'rollback-boundary-verified' <<<"$payload"; then
  printf '%s\n' rollback-boundary >>"$DSH_TEST_SSH_LOG"
  if [[ "${DSH_TEST_ROLLBACK_DRIFT:-}" == 1 ]]; then
    printf '%s\n' 'rollback remote identity drift' >&2
    exit 61
  fi
  printf '%s\n' rollback-boundary-verified
elif grep -Fq 'failed-dsh-' <<<"$payload"; then
  printf '%s\n' rollback-restore >>"$DSH_TEST_SSH_LOG"
  printf '%s\n' rollback-restored
elif grep -Fq 'down --timeout 30' <<<"$payload"; then
  printf '%s\n' stop-writers >>"$DSH_TEST_SSH_LOG"
  printf '%s\n' stopped
else
  printf '%s\n' credential >>"$DSH_TEST_SSH_LOG"
  printf '%s\n' '{"target":"/home/herman/.dsh/secrets/notion.token","time":"2026-08-30T00:00:00Z","permissions":{"directory":"0700","file":"0600","ownerUid":1000,"ownerGid":1000},"pageReadable":true,"bodyLength":17,"bodySha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
fi
EOF
chmod +x "$test_root/fake-bin/ssh"
cat >"$test_root/fake-bin/scp" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' scp >>"$DSH_TEST_SCP_LOG"
EOF
chmod +x "$test_root/fake-bin/scp"
ssh_log="$test_root/ssh.log"
scp_log="$test_root/scp.log"

run_expect() {
  local expected="$1"
  shift
  set +e
  PATH="$test_root/fake-bin:$PATH" GIT_SSH_COMMAND=/usr/bin/ssh \
  DSH_TEST_SSH_LOG="$ssh_log" DSH_RELEASE_STATE_ROOT="$test_root/state" \
  DSH_TEST_SCP_LOG="$scp_log" \
    "$repo_root/release/dsh" "$@" >"$test_root/stdout" 2>"$test_root/stderr"
  local actual="$?"
  set -e
  if [[ "$actual" != "$expected" ]]; then
    printf 'expected exit %s, got %s: %s\n' "$expected" "$actual" "$*" >&2
    cat "$test_root/stdout" "$test_root/stderr" >&2
    exit 1
  fi
}

assert_ssh_calls() {
  local expected="$1"
  local actual=0
  if [[ -e "$ssh_log" ]]; then
    actual="$(wc -l <"$ssh_log")"
  fi
  if [[ "$actual" != "$expected" ]]; then
    printf 'expected %s SSH calls, got %s\n' "$expected" "$actual" >&2
    exit 1
  fi
}

run_expect 3 credential notion
grep -q 'waiting-for-production-credential-authorization' "$test_root/stdout"
grep -q '/home/herman/.dsh/secrets/notion.token' "$test_root/stdout"
test ! -e "$ssh_log"

# The unapproved inspection form must return without consuming an open stdin.
python3 - "$repo_root" "$test_root" <<'PY'
import os, pathlib, subprocess, sys
repo, root = map(pathlib.Path, sys.argv[1:])
read_end, write_end = os.pipe()
environment = dict(os.environ)
environment.update({
    'DSH_RELEASE_STATE_ROOT': str(root / 'state'),
    'PATH': f"{root / 'fake-bin'}:{environment['PATH']}",
    'GIT_SSH_COMMAND': '/usr/bin/ssh',
    'DSH_TEST_SSH_LOG': str(root / 'ssh.log'),
})
process = subprocess.Popen(
    [str(repo / 'release/dsh'), 'credential', 'notion'],
    stdin=read_end, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment,
)
os.close(read_end)
try:
    stdout, stderr = process.communicate(timeout=2)
finally:
    os.close(write_end)
assert process.returncode == 3, (process.returncode, stdout, stderr)
assert stderr == b''
assert not (root / 'ssh.log').exists()
PY

printf '%s\n' drift >"$mutable_release_probe"
if grep -Fq "requireExactReleaseTree(releaseToolCommit, '正式候选 build 编排')" "$repo_root/release/cli.mjs"; then
  run_expect 4 build --purpose release --harness-ref "$harness_head" --plugins-ref "$latest_main"
  grep -q '正式候选 build 编排' "$test_root/stderr"
  test ! -e "$test_root/state/builds"
fi
run_expect 4 release --candidate "$candidate"
grep -Eq '生产 release 编排.*绑定 commit' "$test_root/stderr"
test ! -e "$ssh_log"
rm -f -- "$mutable_release_probe"

DSH_TEST_AUTOMATION_MISSING=1 run_expect 6 release --candidate "$candidate" --approved-stop
grep -q 'Harness-owned Notion automation missing' "$test_root/stderr"
assert_ssh_calls 2
! grep -q 'stop-writers' "$ssh_log"
rm -f -- "$ssh_log"

run_expect 3 release --candidate "$candidate"
grep -q 'waiting-for-downtime-authorization' "$test_root/stdout"
grep -q -- '--approved-stop' "$test_root/stdout"
grep -q 'notionCredential' "$test_root/stdout"
grep -q 'notionAutomation' "$test_root/stdout"
assert_ssh_calls 2

missing_release_receipt_candidate="$test_root/missing-release-receipt-candidate.json"
node - <<'NODE' "$candidate" "$missing_release_receipt_candidate" "$test_root/missing-image-tests.json"
const fs = require('node:fs')
const [inputPath, outputPath, missingReceiptPath] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
candidate.testReceiptPath = missingReceiptPath
fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`)
NODE
run_expect 4 release --candidate "$missing_release_receipt_candidate"
grep -q '正式 candidate 镜像测试回执 不存在' "$test_root/stderr"
assert_ssh_calls 2

drifted_release_receipt="$test_root/drifted-release-image-tests.json"
cat >"$drifted_release_receipt" <<'EOF'
{"schemaVersion":1,"imageId":"sha256:fixture","startedAt":"2026-08-30T00:00:00.000Z","completedAt":"2026-08-30T00:01:00.000Z","output":"drifted self-test output"}
EOF
drifted_release_receipt_candidate="$test_root/drifted-release-receipt-candidate.json"
node - <<'NODE' "$candidate" "$drifted_release_receipt_candidate" "$drifted_release_receipt"
const fs = require('node:fs')
const [inputPath, outputPath, receiptPath] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
candidate.testReceiptPath = receiptPath
fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`)
NODE
run_expect 4 release --candidate "$drifted_release_receipt_candidate"
grep -q '正式 candidate 镜像测试回执摘要不匹配' "$test_root/stderr"
assert_ssh_calls 2

wrong_image_release_receipt="$test_root/wrong-image-release-image-tests.json"
cat >"$wrong_image_release_receipt" <<'EOF'
{"schemaVersion":1,"imageId":"sha256:different","startedAt":"2026-08-30T00:00:00.000Z","completedAt":"2026-08-30T00:01:00.000Z","output":"fixture self-test"}
EOF
wrong_image_release_receipt_sha="sha256:$(sha256sum "$wrong_image_release_receipt" | awk '{print $1}')"
wrong_image_release_receipt_candidate="$test_root/wrong-image-release-receipt-candidate.json"
node - <<'NODE' "$candidate" "$wrong_image_release_receipt_candidate" "$wrong_image_release_receipt" "$wrong_image_release_receipt_sha"
const fs = require('node:fs')
const [inputPath, outputPath, receiptPath, receiptSha256] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
candidate.testReceiptPath = receiptPath
candidate.testReceiptSha256 = receiptSha256
fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`)
NODE
run_expect 4 release --candidate "$wrong_image_release_receipt_candidate"
grep -q '正式 candidate 镜像测试回执未精确绑定候选镜像' "$test_root/stderr"
assert_ssh_calls 2

missing_compose_candidate="$test_root/missing-compose-candidate.json"
node - <<'NODE' "$candidate" "$missing_compose_candidate" "$test_root/missing-compose.production.yml"
const fs = require('node:fs')
const [inputPath, outputPath, missingComposePath] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
candidate.composePath = missingComposePath
fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`)
NODE
run_expect 4 release --candidate "$missing_compose_candidate"
grep -q '正式 candidate Compose 不存在' "$test_root/stderr"
assert_ssh_calls 2

drifted_compose="$test_root/drifted-compose.production.yml"
cp "$compose" "$drifted_compose"
printf '%s\n' '# drift' >>"$drifted_compose"
drifted_compose_candidate="$test_root/drifted-compose-candidate.json"
node - <<'NODE' "$candidate" "$drifted_compose_candidate" "$drifted_compose"
const fs = require('node:fs')
const [inputPath, outputPath, composePath] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
candidate.composePath = composePath
fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`)
NODE
run_expect 4 release --candidate "$drifted_compose_candidate"
grep -q '正式 candidate Compose 摘要不匹配' "$test_root/stderr"
assert_ssh_calls 2

invalid_workspace_candidate="$test_root/invalid-workspace-candidate.json"
node - <<'NODE' "$candidate" "$invalid_workspace_candidate"
const fs = require('node:fs')
const [inputPath, outputPath] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
candidate.workspaceMigration['notion' + 'ScriptSha256'] = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`)
NODE
run_expect 4 release --candidate "$invalid_workspace_candidate"
grep -q 'candidate.workspaceMigration 字段不完整' "$test_root/stderr"

invalid_formal_schema_candidate="$test_root/invalid-formal-schema-candidate.json"
node - <<'NODE' "$candidate" "$invalid_formal_schema_candidate"
const fs = require('node:fs')
const [inputPath, outputPath] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
candidate['notion' + 'ScriptSha256'] = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`)
NODE
run_expect 4 release --candidate "$invalid_formal_schema_candidate"
grep -q '正式 candidate schema 必须是字段精确的 v3' "$test_root/stderr"

workspace_label_drift_candidate="$test_root/workspace-label-drift-candidate.json"
node - <<'NODE' "$candidate" "$workspace_label_drift_candidate"
const fs = require('node:fs')
const [inputPath, outputPath] = process.argv.slice(2)
const candidate = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
candidate.workspaceMigration.codeSha256 = 'sha256:1111111111111111111111111111111111111111111111111111111111111111'
fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`)
NODE
run_expect 4 release --candidate "$workspace_label_drift_candidate"
grep -q 'candidate archive 镜像标签 io.dsh.workspace-migration.code-sha256 不匹配' "$test_root/stderr"

run_expect 4 release --candidate "$stale_candidate"
grep -q 'candidate archive 镜像标签 org.opencontainers.image.revision 不匹配' "$test_root/stderr"

run_expect 4 release --candidate "$development_candidate"
grep -q 'development 候选不能发布' "$test_root/stderr"

release_id="20260830T000000000Z-aaaaaaaaaaaa"
previous_release_id="20260829T000000000Z-bbbbbbbbbbbb"
release_dir="$test_root/state/releases/$release_id"
mkdir -p "$release_dir"
snapshot="$test_root/state/snapshots/$release_id/home.tar.zst"
mkdir -p "$(dirname "$snapshot")"
printf '%s\n' 'isolated snapshot fixture' >"$snapshot"
snapshot_sha="sha256:$(sha256sum "$snapshot" | awk '{print $1}')"
cat >"$release_dir/release.json" <<EOF
{
  "schemaVersion": 1,
  "releaseId": "$release_id",
  "status": "waiting-for-release-authorization",
  "currentStage": "waiting-for-release-authorization",
  "candidatePath": "$candidate",
  "candidate": $(cat "$candidate"),
  "snapshot": {
    "schemaVersion": 1,
    "snapshotId": "$release_id",
    "archivePath": "$snapshot",
    "archiveSha256": "$snapshot_sha",
    "remoteArchivePath": "/home/herman/.local/share/dsh-container/snapshots/$release_id.tar.zst",
    "createdAt": "2026-08-30T00:02:00.000Z"
  },
  "previous": {
    "mode": "docker",
    "releaseId": "$previous_release_id",
    "remoteDir": "/home/herman/.local/share/dsh-container/releases/$previous_release_id",
    "candidate": {"imageId": "sha256:old", "imageTag": "dsh-candidate:old"},
    "engineImageId": "sha256:engine-old"
  },
  "preflight": {
    "remote": "docker-ready",
    "notionCredential": {"target":"/home/herman/.dsh/secrets/notion.token","time":"2026-08-30T00:00:00Z","permissions":{"directory":"0700","file":"0600","ownerUid":1000,"ownerGid":1000},"pageReadable":true,"bodyLength":17,"bodySha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
    "notionAutomation": {"status":"ready","owner":"live-harness-workspace","path":"workspace/automations/notion/notion_inbox_sync.py","handoffPath":"workspace/automations/notion/notion_inbox_sync.handoff.json","interfaceVersion":1,"artifactContract":{"interfaceVersion":1,"state":{"role":"state","path":"storages/task-inbox/sync-state.json","mode":"0600"},"fingerprint":{"role":"fingerprint","path":"storages/task-inbox/notion-fingerprint.json","mode":"0600"}},"size":12345,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","handoffSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","testReceiptSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","testedAt":"2026-08-30T00:00:00Z"},
    "reanchorRequest": {"required":true,"migrationVersion":1,"migrationId":"dsh-cron-shanghai-reanchor-v1","fromTimeZone":"Etc/UTC","toTimeZone":"Asia/Shanghai","cutoverAt":"2026-08-30T00:02:00.000Z","reanchoredAt":"2026-08-30T00:02:00.000Z"}
  },
  "production": null,
  "createdAt": "2026-08-30T00:00:00.000Z",
  "userAcceptance": null,
  "rollbackBoundary": {"status":"production-stopped-snapshot-available","previousReleaseId":"$previous_release_id","snapshotId":"$release_id","snapshotArchiveSha256":"$snapshot_sha"},
  "cleanup": null
}
EOF

rm -f -- "$ssh_log"
run_expect 3 rollback --release "$release_id"
grep -q 'waiting-for-rollback-authorization' "$test_root/stdout"
test ! -e "$ssh_log"

printf '%s\n' drift >>"$snapshot"
run_expect 4 rollback --release "$release_id" --approved
grep -q '本地停机快照摘要已经漂移' "$test_root/stderr"
test ! -e "$ssh_log"
printf '%s\n' 'isolated snapshot fixture' >"$snapshot"

DSH_TEST_ROLLBACK_DRIFT=1 run_expect 6 rollback --release "$release_id" --approved
grep -q 'rollback remote identity drift' "$test_root/stderr"
assert_ssh_calls 1
! grep -q 'rollback-restore' "$ssh_log"
rm -f -- "$ssh_log"

run_expect 0 rollback --release "$release_id" --approved
grep -q 'rolled-back' "$test_root/stdout"
grep -qx 'rollback-boundary' <(sed -n '1p' "$ssh_log")
grep -qx 'rollback-restore' <(sed -n '2p' "$ssh_log")

accepted_id="20260830T005000000Z-dddddddddddd"
accepted_dir="$test_root/state/releases/$accepted_id"
mkdir -p "$accepted_dir"
node - <<'NODE' "$release_dir/release.json" "$accepted_dir/release.json" "$accepted_id"
const fs = require('node:fs')
const [inputPath, outputPath, releaseId] = process.argv.slice(2)
const release = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
release.releaseId = releaseId
release.status = 'accepted'
fs.writeFileSync(outputPath, `${JSON.stringify(release, null, 2)}\n`)
NODE
accepted_release="$accepted_dir/release.json"
run_expect 4 rollback --release "$accepted_release"
grep -q '回退边界已在 accept 退休' "$test_root/stderr"

accept_id="20260830T010000000Z-cccccccccccc"
accept_dir="$test_root/state/releases/$accept_id"
mkdir -p "$accept_dir"
node - <<'NODE' "$release_dir/release.json" "$accept_dir/release.json" "$accept_id"
const fs = require('node:fs')
const [inputPath, outputPath, releaseId] = process.argv.slice(2)
const release = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
release.releaseId = releaseId
release.status = 'awaiting-user-acceptance'
delete release.currentStage
delete release.rolledBackAt
release.snapshot.snapshotId = releaseId
release.snapshot.archivePath = `${process.env.DSH_TEST_STATE_ROOT ?? ''}/unused`
release.snapshot.remoteArchivePath = `/home/herman/.local/share/dsh-container/snapshots/${releaseId}.tar.zst`
release.rollbackBoundary.status = 'available-before-accept'
release.rollbackBoundary.snapshotId = releaseId
release.production = {engineImageId: 'sha256:fixture-engine'}
fs.writeFileSync(outputPath, `${JSON.stringify(release, null, 2)}\n`)
NODE
# accept does not use the snapshot path, but its release remains rooted in the
# controlled local releases directory and exact candidate.
run_expect 2 accept --release "$accept_id"
grep -q -- '--evidence' "$test_root/stderr"

node - <<'NODE' "$test_root"
const fs = require('node:fs')
const root = process.argv[2]
const checks = {
  telegramWebTaskQuery: true,
  notionReversibleTask: true,
  temporaryMonitorLifecycle: true,
  shanghaiReminder: true,
  dailyCronNextRuns: true,
  existingMemoryFact: true,
  noLegacyPathEacces: true,
  assistantSqliteIntegrity: true,
}
const write = (name, value) => fs.writeFileSync(`${root}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`)
write('accept-valid', {schemaVersion: 1, checks})
const missing = {...checks}
delete missing.assistantSqliteIntegrity
write('accept-missing', {schemaVersion: 1, checks: missing})
write('accept-false', {schemaVersion: 1, checks: {...checks, shanghaiReminder: false}})
write('accept-extra', {schemaVersion: 1, checks, unexpected: true})
write('accept-private-body', {schemaVersion: 1, checks, body: 'PRIVATE ACCEPTANCE BODY'})
NODE

rm -f -- "$ssh_log"
run_expect 2 accept --release "$accept_id" --evidence "$test_root/accept-missing.json"
grep -q '固定 8 项 checks' "$test_root/stderr"
run_expect 2 accept --release "$accept_id" --evidence "$test_root/accept-false.json"
grep -q '必须逐项为 true' "$test_root/stderr"
run_expect 2 accept --release "$accept_id" --evidence "$test_root/accept-extra.json"
grep -q '不得夹带正文或额外字段' "$test_root/stderr"
run_expect 2 accept --release "$accept_id" --evidence "$test_root/accept-private-body.json"
grep -q '不得夹带正文或额外字段' "$test_root/stderr"
test ! -e "$ssh_log"

DSH_TEST_REJECT_SPECIALIZED_BINDING_GATE=1 run_expect 6 accept --release "$accept_id" --evidence "$test_root/accept-valid.json"
if ! grep -q 'accepted-cleanup-incomplete' "$test_root/stdout"; then
  printf '%s\n' 'accept did not complete without the specialized Notion binding helper' >&2
  cat "$test_root/stdout" "$test_root/stderr" >&2
  exit 1
fi
node - <<'NODE' "$accept_dir/release.json" "$test_root/accept-valid.json"
const fs = require('node:fs')
const [releasePath, evidencePath] = process.argv.slice(2)
const crypto = require('node:crypto')
const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'))
const input = JSON.parse(fs.readFileSync(evidencePath, 'utf8'))
const normalized = JSON.stringify({schemaVersion: 1, checks: input.checks})
const receipt = release.userAcceptance.evidence
if (release.status !== 'accepted' || release.rollbackBoundary.status !== 'retired-at-accept') process.exit(1)
if (receipt.summary !== 'all-required-acceptance-checks-passed'
  || receipt.requiredCount !== 8 || receipt.passedCount !== 8 || receipt.checklist.length !== 8
  || receipt.length !== Buffer.byteLength(normalized)
  || receipt.sha256 !== `sha256:${crypto.createHash('sha256').update(normalized).digest('hex')}`) process.exit(1)
const serialized = JSON.stringify(release.userAcceptance)
if (serialized.includes('PRIVATE ACCEPTANCE BODY') || serialized.includes('telegramWebTaskQuery":true')) process.exit(1)
NODE

# An accepted cleanup retry reuses only the exact redacted receipt.  Drift in
# that receipt fails before any remote cleanup or acceptance-health action.
ssh_calls_before="$(wc -l <"$ssh_log")"
run_expect 2 accept --release "$accept_id" --evidence "$test_root/accept-valid.json"
grep -q 'cleanup retry 只接受 --release' "$test_root/stderr"
test "$(wc -l <"$ssh_log")" = "$ssh_calls_before"
node - <<'NODE' "$accept_dir/release.json"
const fs = require('node:fs')
const path = process.argv[2]
const release = JSON.parse(fs.readFileSync(path, 'utf8'))
release.userAcceptance.evidence.privateBody = 'PRIVATE RETRY BODY'
fs.writeFileSync(path, `${JSON.stringify(release, null, 2)}\n`)
NODE
run_expect 4 accept --release "$accept_id"
grep -q 'accept evidence receipt 不符合脱敏固定 schema' "$test_root/stderr"
test "$(wc -l <"$ssh_log")" = "$ssh_calls_before"

run_expect 2 build --harness-ref main --plugins-ref main
grep -q '40 位 Git commit' "$test_root/stderr"

run_expect 2 dev prepare --candidate "$development_candidate"
grep -q -- '--source' "$test_root/stderr"

run_expect 2 dev up
grep -q 'dsh dev prepare' "$test_root/stderr"

# A development base must be built from the freshly fetched origin/main.  The
# fixture candidate is intentionally pinned elsewhere, so this stops before
# snapshot download or any container mutation.
run_expect 4 dev prepare --source "$repo_root" --candidate "$stale_development_candidate"
grep -q '开发基础镜像不是最新 main' "$test_root/stderr"

node --check "$repo_root/release/cli.mjs"
bash -n "$repo_root/release/dsh" "$repo_root"/release/scripts/*.sh
test ! -d "$repo_root/release/scripts/__pycache__"
test ! -d "$repo_root/release/tests/__pycache__"
PYTHONDONTWRITEBYTECODE=1 python3 "$repo_root/release/tests/notion-automation-entrypoint.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$repo_root/release/tests/notion-inbox-init.py"
PYTHONDONTWRITEBYTECODE=1 python3 - "$repo_root/release/scripts/scrub-preflight-state.py" \
  "$repo_root/release/tests/fault-injection.sh" <<'PY'
import ast, pathlib, sys

scrubber_path, fault_path = map(pathlib.Path, sys.argv[1:])
module = ast.parse(scrubber_path.read_text(encoding='utf-8'))
assignments = {
    target.id: node.value.value
    for node in module.body
    if isinstance(node, ast.Assign)
    and len(node.targets) == 1
    and isinstance((target := node.targets[0]), ast.Name)
    and isinstance(node.value, ast.Constant)
}
sentinel = assignments.get('FAKE_NOTION_TOKEN')
assert isinstance(sentinel, bytes) and sentinel, sentinel
fault_source = fault_path.read_text(encoding='utf-8')
assert fault_source.count(sentinel.decode('ascii')) == 2
assert 'isolated-preflight-notion-token' not in fault_source
origin_url = 'real_origin_url="$(git -C "$repo_root" remote get-url origin)"'
clone = 'git clone --quiet --local --no-hardlinks "$repo_root" "$test_root/bad-repo"'
set_origin = 'git -C "$test_root/bad-repo" remote set-url origin "$real_origin_url"'
fetch_main = '+refs/heads/main:refs/remotes/origin/main'
invalid_commit = 'commit --quiet -m \'test: inject invalid business source\''
invalid_build = '"$test_root/bad-repo/release/dsh" build'
positions = [fault_source.index(value) for value in (
    origin_url, clone, set_origin, fetch_main, invalid_commit, invalid_build,
)]
assert positions == sorted(positions), positions
assert 'if [[ "$business_failure" != 5 ]]' in fault_source
for value in (
    "empty_tmpfs_suffix=',notmpcopyup'",
    'test ! -e /home/herman/.openclaw/private-sentinel',
    'test ! -e /home/herman/task-inbox-workflow/private-sentinel',
    'test "$legacy_parent_before" = "$(sha256sum',
):
    assert value in fault_source, value
PY
test ! -d "$repo_root/release/scripts/__pycache__"
test ! -d "$repo_root/release/tests/__pycache__"

# Full product tests qualify the one shared main image.  Per-worktree prepare
# may rebuild editable outputs hidden by mounts, but must not repeat test suites.
test ! -e "$repo_root/release/scripts/dev-source-check.sh"
grep -q "'dev-source-build'" "$repo_root/release/cli.mjs"
! grep -q "'dev-source-check'" "$repo_root/release/cli.mjs"
grep -q "productTests: 'shared-main-image-build'" "$repo_root/release/cli.mjs"
! grep -Eq 'vitest|unittest' "$repo_root/release/scripts/dev-source-build.sh"
test -x "$repo_root/release/scripts/dev-source-verify.sh"
test -x "$repo_root/release/tests/dev-source-verify.sh"
grep -q "dev verify" "$repo_root/release/cli.mjs"
grep -q "dev-source-verify.sh" "$repo_root/release/cli.mjs"
grep -q 'runPreflightRuntime' "$repo_root/release/cli.mjs"
! grep -Fq "action === 'up'" "$repo_root/release/cli.mjs"
! grep -Fq 'immutable-candidate' "$repo_root/release/cli.mjs"
! grep -Fq 'makeSyntheticHome' "$repo_root/release/cli.mjs"
! grep -Fq 'dev up' "$repo_root/release/README.md"
grep -q 'unset NODE_PATH' "$repo_root/release/scripts/dev-source-verify.sh"
grep -q 'mktemp -d /tmp/dsh-editable-verify' "$repo_root/release/scripts/dev-source-verify.sh"
grep -q 'setpriv --reuid=1000 --regid=1000 --init-groups' "$repo_root/release/scripts/dev-source-verify.sh"
grep -q 'PYTHONPYCACHEPREFIX="$python_pycache"' "$repo_root/release/scripts/dev-source-verify.sh"
grep -q "python3 -m unittest test_insight_engine.py" "$repo_root/release/scripts/dev-source-verify.sh"
grep -q 'build-identity=rootless-toolbox-uid-0; test-identity=1000:1000' "$repo_root/release/scripts/dev-source-verify.sh"
"$repo_root/release/tests/dev-source-verify.sh"
"$repo_root/release/tests/runtime-module-identity.sh"
grep -q 'vitest/vitest.mjs' "$repo_root/release/Containerfile"
grep -q "unittest discover" "$repo_root/release/Containerfile"
grep -Fq 'check-runtime-module-identity.sh /opt/dsh/harness' "$repo_root/release/Containerfile"
grep -Fq 'check-runtime-module-identity.sh /opt/dsh/harness' "$repo_root/release/scripts/self-test.sh"
grep -Fq '/opt/dsh/harness/local-plugins/personal-feed' "$repo_root/release/Containerfile"
grep -Fq 'plugins/personal-feed/package.json' "$repo_root/release/Containerfile"
grep -Fq '"@herman/personal-feed"' "$repo_root/release/profiles/telegram/package.json"
grep -Fq '"@herman/personal-feed"' "$repo_root/release/profiles/telegram-test/package.json"
! grep -Fq '"@herman/personal-feed"' "$repo_root/release/profiles/web/package.json"
grep -Fq 'personal-feed' "$repo_root/release/scripts/self-test.sh"
! grep -Eq '(^|[^[:alnum:]_-])personal-feed([^[:alnum:]_-]|$)' "$repo_root/release/scripts/check-runtime-module-identity.sh"
! rg -Fq 'createCronEnvironmentExtension' "$repo_root/x-feed/src"
! grep -Eq '(^|[^[:alnum:]_-])personal-feed([^[:alnum:]_-]|$)' "$repo_root/dsh-cron/src/environment-modules.ts"
python3 - "$repo_root/release/profiles/telegram/cordis.patch.yml" "$repo_root/release/profiles/telegram-test/cordis.patch.yml" <<'PY'
import pathlib, sys

for path_string in sys.argv[1:]:
    text = pathlib.Path(path_string).read_text(encoding='utf-8')
    for legacy in ('cronJobId', 'personalFeedRequiredSources', 'candidateReportingWindowMs',
                   'sourceCandidateReport', 'periodBusinessFinalizer', 'createCrossSourceEditor',
                   'createCurrentContextProjection', 'createMechanicalAdmission',
                   'createCandidateMaterialProjection', 'createDeliveryAndReceipt'):
        assert legacy not in text, (path_string, legacy)
PY
python3 - "$repo_root/runtime-package-topology.json" "$repo_root/release/profiles/telegram/cordis.patch.yml" <<'PY'
import json, pathlib, sys
topology = json.loads(pathlib.Path(sys.argv[1]).read_text())
personal_feed = next(target for target in topology['targets'] if target['name'] == '@herman/personal-feed')
assert personal_feed['kind'] == 'release'
assert personal_feed['releaseDirectory'] == 'personal-feed'
assert '@herman/x-feed' in personal_feed.get('requiredBy', [])
profile = pathlib.Path(sys.argv[2]).read_text()
cron = profile.split('    - id: dsh-cron\n', 1)[1].split('\n    - id:', 1)[0]
gateway = profile.split('    - id: telegram-gateway\n', 1)[1].split('\n    - id:', 1)[0]
assert "modulePath: '@herman/x-feed'" not in cron
assert "modulePath: '@herman/x-feed'" in gateway
PY
grep -q 'runtime.toolbox' "$repo_root/release/cli.mjs"
grep -q "'toolbox'" "$repo_root/release/cli.mjs"
grep -q 'exec sleep infinity' "$repo_root/release/scripts/entrypoint.sh"
test -f "$repo_root/release/harness-automation-instructions.md"
grep -q "release/harness-automation-instructions.md" "$repo_root/release/cli.mjs"
grep -Fq "release/tests')}:/opt/dsh/release-system/tests:ro" "$repo_root/release/cli.mjs"
grep -Fq "release/notion.production.json')}:/opt/dsh/release-system/notion.production.json:ro" "$repo_root/release/cli.mjs"
grep -q 'harness-automation-instructions.md' "$repo_root/release/scripts/prepare-runtime.sh"
grep -q '"\$dsh_home/AGENTS.md"' "$repo_root/release/scripts/prepare-runtime.sh"
grep -q 'harness-automation-instructions.md' "$repo_root/release/scripts/self-test.sh"
grep -q "deleted.has(relativePath)" "$repo_root/release/cli.mjs"
test ! -d "$repo_root/automations"
test -f "$repo_root/release/workspace-migrations/harness-only-v1/manifest.json"
test -f "$repo_root/release/workspace-migrations/harness-only-v1/AGENTS.md"
test -x "$repo_root/release/scripts/migrate-workspace-state.py"
test -x "$repo_root/release/scripts/check-harness-only-state.py"
test -f "$repo_root/skills/personal-task-list/SKILL.md"
test -f "$repo_root/skills/personal-task-list/agents/openai.yaml"
grep -Fq 'personal-task-list' "$repo_root/release/scripts/prepare-runtime.sh"
grep -Fq 'test_workspace_migration.py' "$repo_root/release/scripts/dev-source-verify.sh"
grep -Fq 'test_workspace_migration.py' "$repo_root/release/Containerfile"
test ! -e "$repo_root/release/scripts/check-notion-retry-binding.mjs"
test ! -e "$repo_root/release/tests/notion-retry-binding.mjs"
! grep -Fq 'notionRetryBinding' "$repo_root/release/cli.mjs"
! grep -Fq 'notion-retry-health' "$repo_root/release/scripts/entrypoint.sh"
grep -Fq 'inspect-cron-reanchor.mjs' "$repo_root/release/Containerfile"
grep -Fq 'cron-reanchor-inspect' "$repo_root/release/scripts/entrypoint.sh"
node --test "$repo_root/release/tests/inspect-cron-reanchor.mjs"
grep -Fq 'schemaVersion: purpose === '\''release'\'' ? 3 : 2' "$repo_root/release/cli.mjs"
grep -Fq 'workspaceMigrationFromArchives(releaseTarget, pluginsTarget)' "$repo_root/release/cli.mjs"
grep -Fq 'io.dsh.release.compose-sha256' "$repo_root/release/cli.mjs"
grep -Fq "if (!options['approved-stop'])" "$repo_root/release/cli.mjs"
grep -Fq "if (options['approved-stop'] && options['approved-release'])" "$repo_root/release/cli.mjs"
grep -Fq "if (options['approved-release'])" "$repo_root/release/cli.mjs"
grep -Fq "if (!options.release || options.candidate)" "$repo_root/release/cli.mjs"
grep -Fq "if (options.release) fail('--release 只用于独立的 --approved-release continuation'" "$repo_root/release/cli.mjs"
grep -Fq "requireExactReleaseTree(candidate.releaseToolCommit, '生产 release 编排')" "$repo_root/release/cli.mjs"
grep -Fq "requireExactReleaseTree(waiting.candidate.releaseToolCommit, '生产 approved-release 编排')" "$repo_root/release/cli.mjs"
grep -Fq "requireExactReleaseTree(candidateArtifact.candidate.releaseToolCommit, '生产 accept 编排')" "$repo_root/release/cli.mjs"
grep -Fq "requireExactReleaseTree(candidate.releaseToolCommit, '生产 rollback 编排')" "$repo_root/release/cli.mjs"
grep -Fq "const credentialReleaseCommit = requireCurrentHeadReleaseTree('生产 credential 编排')" "$repo_root/release/cli.mjs"
grep -Fq "requireLatestMainAncestor(credentialReleaseCommit, '生产 credential 编排 commit')" "$repo_root/release/cli.mjs"
grep -Fq 'waiting-for-downtime-authorization' "$repo_root/release/cli.mjs"
grep -Fq 'waiting-for-release-authorization' "$repo_root/release/cli.mjs"
grep -Fq "['waiting-for-release-authorization', 'awaiting-user-acceptance', 'failed']" "$repo_root/release/cli.mjs"
grep -Eq '\./release/dsh release --release <[^>]+> --approved-release' "$repo_root/release/cli.mjs"
! grep -Eq 'docker compose .* down .*\|\| true' "$repo_root/release/cli.mjs"
grep -Fq "systemctl --user list-units --no-legend --plain --state=running --type=service 'dsh*'" "$repo_root/release/cli.mjs"
grep -Fq 'copyFileSync(candidate.composePath, admittedComposePath)' "$repo_root/release/cli.mjs"
grep -Fq 'docker load --input "$release_dir/image.tar" >/dev/null' "$repo_root/release/cli.mjs"
grep -Fq 'if (sha256File(admittedComposePath) !== candidate.composeSha256)' "$repo_root/release/cli.mjs"
grep -Fq "run('scp', ['-p', admittedComposePath," "$repo_root/release/cli.mjs"
grep -Fq 'writeJson(admittedCandidatePath, candidate)' "$repo_root/release/cli.mjs"
grep -Fq "run('scp', ['-p', admittedCandidatePath," "$repo_root/release/cli.mjs"
! grep -Fq "run('scp', ['-p', composePath," "$repo_root/release/cli.mjs"
! grep -Fq "runtimeReceipt = commandDev({ _: ['up'], source: preflightSourcePath, snapshot: snapshotMetaPath" "$repo_root/release/cli.mjs"
grep -Fq "owner: 'live-harness-workspace'" "$repo_root/release/cli.mjs"
grep -Fq 'includedInCandidate: false' "$repo_root/release/cli.mjs"
grep -Fq 'io.dsh.workspace-migration.personal-task-list-skill-sha256' "$repo_root/release/cli.mjs"
grep -Fq 'io.dsh.business-automation.included-in-candidate' "$repo_root/release/cli.mjs"
! grep -Fq 'notionScriptSha256' "$repo_root/release/cli.mjs"
python3 - "$repo_root/release/cli.mjs" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')
production = source[source.index('# State transitions run while every DSH writer remains stopped.'):
                    source.index("  let productionReceipt", source.index('# State transitions run while every DSH writer remains stopped.'))]
ordered = [
    'prepare workspace-migrate',
    'prepare notion-page-check',
    'prepare notion-inbox-init',
    '${remoteReanchorStep}',
    'compose up -d prepare web',
    'compose up -d telegram lan-proxy',
    'check-assistant-cron-ready.mjs',
]
positions = [production.index(token) for token in ordered]
assert positions == sorted(positions), list(zip(ordered, positions))
assert 'compose_run() { compose run --rm --no-deps --interactive=false --no-TTY "$@"; }' in source
assert source.count('compose run --rm --no-deps') == 1
assert source.count('compose_run ') == 7
release_command = source[source.index('function commandRelease'):source.index('function validateWaitingReanchorRequest')]
assert release_command.index('verifyProductionNotionAutomation(candidate)') < release_command.index("if (!options['approved-stop'])")
PY
python3 - "$repo_root/release/profiles/web/cordis.patch.yml" <<'PY'
import pathlib, sys
profile = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')
required = [
    'managedCommandBindings:',
    'externalRef: dsh:notion-task-inbox:retry:v1',
    'kind: interval',
    'minutes: 5',
    '- /usr/bin/python3',
    '- /home/herman/.dsh/workspace/automations/notion/notion_inbox_sync.py',
    '- --retry-pending',
    '- --json',
    'timeoutSeconds: 120',
    'outputMaxBytes: 4096',
    'deliver: silent',
    'cwd: /home/herman/.dsh/workspace',
]
assert all(token in profile for token in required), [token for token in required if token not in profile]
PY
grep -Fq "'cron-reanchor-inspect'" "$repo_root/release/cli.mjs"
grep -Fq 'validateReanchorInspectionReceipt' "$repo_root/release/cli.mjs"
grep -Fq "'evidence': evidence" "$repo_root/release/cli.mjs"
! grep -Fq "status: 'inherited', migrationId" "$repo_root/release/cli.mjs"
grep -Fq 'DSH_EXPECTED_WORKSPACE_MIGRATION_CODE_SHA256=' "$repo_root/release/cli.mjs"
grep -Fq 'DSH_EXPECTED_WORKSPACE_MIGRATION_MANIFEST_SHA256=' "$repo_root/release/cli.mjs"
grep -Fq 'DSH_EXPECTED_WORKSPACE_MIGRATION_TEMPLATE_SHA256=' "$repo_root/release/cli.mjs"
grep -Fq 'DSH_EXPECTED_WORKSPACE_MIGRATION_ROOT_INSTRUCTIONS_SHA256=' "$repo_root/release/cli.mjs"
grep -Fq 'DSH_EXPECTED_WORKSPACE_MIGRATION_PERSONAL_TASK_LIST_SKILL_SHA256=' "$repo_root/release/cli.mjs"
grep -Fq '"credentialPath": "/home/herman/.dsh/secrets/notion.token"' "$repo_root/release/notion.production.json"
grep -Fq '"inboxPath": "/home/herman/.dsh/storages/task-inbox/inbox.md"' "$repo_root/release/notion.production.json"
grep -Fq '"apiBase": "https://api.notion.com/v1"' "$repo_root/release/notion.production.json"
grep -Fq 'PYTHONPATH: /opt/dsh/release-system/scripts/notion-https-compat' "$repo_root/release/compose.production.yml"
test -f "$repo_root/release/scripts/notion-https-compat/sitecustomize.py"
test -f "$repo_root/release/tests/notion-https-compat.py"
grep -Fq 'python3 /opt/dsh/release-system/tests/notion-https-compat.py' "$repo_root/release/Containerfile"
grep -Fq 'python3 /opt/dsh/release-system/tests/notion-https-compat.py' "$repo_root/release/scripts/self-test.sh"
grep -Fq 'python3 /opt/dsh/release-system/tests/notion-https-compat.py' "$repo_root/release/scripts/dev-source-verify.sh"
grep -Fq '"pageId": "3b059c119f80803cb8ace3ead7eefc81"' "$repo_root/release/notion.production.json"
! grep -Fq '.openclaw' "$repo_root/release/harness-automation-instructions.md"
! grep -Fq '/home/herman/task-inbox-workflow:/home/herman/task-inbox-workflow:ro' "$repo_root/release/compose.production.yml"
grep -Fq '/home/herman/task-inbox-workflow:rw,noexec,nosuid,size=1m' "$repo_root/release/compose.production.yml"
! grep -Fq 'notmpcopyup' "$repo_root/release/compose.production.yml"
grep -Fq "const mountOptions = basename(engine) === 'podman' ? \`\${options},notmpcopyup\` : options" "$repo_root/release/cli.mjs"
grep -Fq "emptyTmpfsSpec('/home/herman/.openclaw', 'rw,noexec,nosuid,size=1m')" "$repo_root/release/cli.mjs"
grep -Fq "emptyTmpfsSpec('/home/herman/task-inbox-workflow', 'rw,noexec,nosuid,size=1m')" "$repo_root/release/cli.mjs"
grep -Fq "emptyTmpfsSpec('/tmp', 'rw,noexec,nosuid,size=16m')" "$repo_root/release/cli.mjs"
test -f "$repo_root/release/workspace-runtime-requirements.lock"
! grep -Eq 'jobs[.]production|reconcile_production_jobs|bzp_|mywechat|deepseek_daily|Rita|rita_|wechat-oom' "$repo_root/release/cli.mjs"
! grep -Fq 'reconcile-cron-preflight' "$repo_root/release/scripts/entrypoint.sh"
! grep -Fq 'COPY automations/' "$repo_root/release/Containerfile"
! grep -Fq 'release-system/automations' "$repo_root/release/Containerfile"
grep -Fq 'test ! -e /opt/dsh/automations' "$repo_root/release/scripts/self-test.sh"
grep -Fq 'wait_http http://127.0.0.1:3080/' "$repo_root/release/cli.mjs"
grep -Fq 'wait_http http://192.168.6.240:3080/' "$repo_root/release/cli.mjs"
! grep -Fq -- "--network', 'host'" "$repo_root/release/cli.mjs"
grep -Fq "runStatus(engine, ['exec', runtime.web, 'curl'" "$repo_root/release/cli.mjs"
grep -Fq "runtime.web, '--network', runtime.network" "$repo_root/release/cli.mjs"
grep -Fq "['network', 'inspect', runtime.network, '--format', '{{.Internal}}']" "$repo_root/release/cli.mjs"
grep -Fq "'{{json .NetworkSettings.Networks}}'" "$repo_root/release/cli.mjs"
grep -Fq "webAccess: 'container-exec/internal-no-external-route'" "$repo_root/release/cli.mjs"
grep -Fq "['run', '--rm', '--network', 'none', ...containerBaseArgs(homePath), ...sourceArgs" "$repo_root/release/cli.mjs"
grep -Fq "fakeNotion: runtime.fakeNotion ??" "$repo_root/release/cli.mjs"
grep -Fq "runtime.fakeTelegram, runtime.fakeNotion, runtime.web" "$repo_root/release/cli.mjs"
grep -Fq "runtime.telegram, runtime.fakeTelegram, runtime.fakeNotion" "$repo_root/release/cli.mjs"
! grep -Fq 'function legacyDevelopmentRuntime()' "$repo_root/release/cli.mjs"
! grep -Eq "'dsh-dev-(internal|fake-telegram|fake-notion|telegram|web)'" "$repo_root/release/cli.mjs"
grep -Fq "notionApiBase = 'http://fake-notion:8081/v1'" "$repo_root/release/cli.mjs"
grep -Fq "notionPageId = '00000000000000000000000000000001'" "$repo_root/release/cli.mjs"
! grep -Fq 'pageRequestCount' "$repo_root/release/cli.mjs"
python3 - "$repo_root/release/cli.mjs" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')
preflight = source[source.index('function runPreflightRuntime'):source.index('function commandBuild')]
development_admission = source[source.index('function admitDevelopmentCandidate'):
                               source.index('function cleanupAcceptedDevelopmentState')]
automation_parser = source[source.index('function parseNotionAutomationReceipt'):
                           source.index('function validateNotionInboxInitReceipt')]
init_validator = source[source.index('function validateNotionInboxInitReceipt'):
                        source.index('const remoteAutomationCheckerLoader')]
assert "notionApiBase: 'http://fake-notion:8081/v1'" in preflight
assert 'fake-notion.invalid' not in preflight
assert 'candidates/latest.json' not in development_admission
assert 'legacyLatest' not in development_admission
assert preflight.index('startFakeNotion(candidate, runtime') < preflight.index("runtime.web, '--network', runtime.network")
assert "'status', 'owner', 'path', 'handoffPath', 'interfaceVersion', 'artifactContract'" in automation_parser
assert '!isExactNotionArtifactContract(receipt.artifactContract)' in automation_parser
assert "'artifacts', 'remoteMethod'" in init_validator
assert "hasExactKeys(receipt?.artifacts, ['mirror', 'state', 'fingerprint'])" in init_validator
assert "mirror: { role: 'mirror', path: 'storages/task-inbox/inbox.md', mode: '0600' }" in init_validator
assert "state: notionAutomation?.artifactContract?.state" in init_validator
assert "fingerprint: notionAutomation?.artifactContract?.fingerprint" in init_validator
assert "hasExactKeys(artifact, ['role', 'path', 'mode', 'length', 'sha256'])" in init_validator
build = source[source.index('function commandBuild'):source.index('function commandDev')]
guard = "requireExactReleaseTree(releaseToolCommit, '正式候选 build 编排')"
assert guard in build
assert build.index(guard) < build.index('const buildId =')
snapshot = source[source.index("stage('snapshot-copy-tests'"):source.index("stage('transfer-and-start')")]
assert 'runPreflightRuntime(candidate, testHome, preflightSourcePath, notionAutomation)' in snapshot
stop_start = source.index('if (resumeEvidence === null) {', source.index('function performProductionReleaseUnsafe'))
first_stop_preflight = source.index("preflight = ssh(`set -Eeuo pipefail", stop_start)
stop = source[stop_start:source.index("preflight = ssh(`set -Eeuo pipefail", first_stop_preflight + 1)]
assert stop.index("sha256File(localSnapshot) !== stopMeta.archiveSha256") < stop.index('recoverReanchorRequestFromSnapshot(')
assert stop.index('recoverReanchorRequestFromSnapshot(') < stop.index("stage('waiting-for-release-authorization'")
recovery = source[source.index('function recoverReanchorRequestFromSnapshot'):
                  source.index('function cronReanchorArgs')]
assert "'.dsh/storages/dsh-cron/jobs.jsonl'" in recovery
assert "'.dsh/storages/dsh-cron/runs.jsonl'" in recovery
assert "'run', '--rm', '--network', 'none'" in recovery
assert "'--recover-migration-id', 'dsh-cron-shanghai-reanchor-v1'" in recovery
assert "rmSync(recoveryRoot, { recursive: true, force: true })" in recovery
assert 'if (receipt.status === \'absent\') return newReanchorRequest()' in recovery
assert 'migration_conflict' not in recovery
first = preflight.index("'notion-inbox-init'")
second = preflight.index("'notion-inbox-init'", first + 1)
assert first < second
assert "allowedStatuses: ['initialized']" in preflight[first:second]
assert "allowedStatuses: ['already-initialized']" in preflight[second:]
for field, expected in (
    ('successfulGetCount', '1'),
    ('rejectedGetCount', '0'),
    ('mutationRequestCount', '0'),
    ('otherApiRequestCount', '0'),
):
    assert f'firstRequestCount.{field} !== {expected}' in preflight
assert 'notionFirst.artifacts.mirror.length !== firstRequestCount.fixtureLength' in preflight
assert 'notionFirst.artifacts.mirror.sha256 !== firstRequestCount.fixtureSha256' in preflight
assert 'JSON.stringify(secondRequestCount) !== JSON.stringify(firstRequestCount)' in preflight
assert preflight.count('requestCounts:') == 2
assert preflight.count('artifacts: notion') == 2
assert 'JSON.stringify(notionSecond.artifacts) !== JSON.stringify(notionFirst.artifacts)' in preflight
assert "receipt.status === 'initialized' && receipt.remoteMethod !== 'GET'" in source
assert "receipt.status === 'already-initialized' && receipt.remoteMethod !== 'none'" in source
for field in ('entrypointSha256', 'handoffSha256', 'testReceiptSha256'):
    assert preflight.count(field) >= 2, field
production = source[source.index("  const notionInit = validateNotionInboxInitReceipt("):
                    source.index("  const release = {", source.index("  const notionInit = validateNotionInboxInitReceipt("))]
assert 'productionReceipt?.notionInboxInit' in production
assert "label: '生产 Notion task mirror 初始化'" in production
assert 'code: exitCodes.production' in production
PY

# The Web HTTP endpoint may become healthy before the cron manager has created
# its control socket.  Exercise the exact remote release gate with a transient
# readiness failure and with a permanently unavailable manager.
cron_wait_script="$test_root/cron-control-ready-wait.sh"
python3 - "$repo_root/release/cli.mjs" "$cron_wait_script" <<'PY'
import pathlib, sys

source_path, output_path = map(pathlib.Path, sys.argv[1:])
source = source_path.read_text(encoding='utf-8')
manager_start = source.index('# Start the manager first;')
telegram_start = source.index('compose up -d telegram lan-proxy', manager_start)
manager_gate = source[manager_start:telegram_start]
start = manager_gate.index('cron_control_ready=false')
terminal = 'test "$cron_control_ready" = true'
end = manager_gate.index(terminal, start) + len(terminal)
wait_script = manager_gate[start:end]
assert 'for attempt in $(seq 1 24); do' in wait_script
assert wait_script.count('check-cron-control-ready.cjs') == 1
assert 'sleep 5' in wait_script
output_path.write_text(wait_script + '\n', encoding='utf-8')
PY

attempts_log="$test_root/cron-ready-attempts.log"
run_cron_wait_fixture() {
  local succeed_at="$1"
  : >"$attempts_log"
  ATTEMPTS_LOG="$attempts_log" SUCCESS_AT="$succeed_at" bash -c '
    docker() {
      printf "%s\n" attempt >>"$ATTEMPTS_LOG"
      local count
      count="$(wc -l <"$ATTEMPTS_LOG")"
      test "$count" -ge "$SUCCESS_AT"
    }
    sleep() { test "$1" = 5; }
    source "$1"
  ' _ "$cron_wait_script"
}

run_cron_wait_fixture 3
test "$(wc -l <"$attempts_log")" = 3
set +e
run_cron_wait_fixture 25
cron_wait_status="$?"
set -e
test "$cron_wait_status" = 1
test "$(wc -l <"$attempts_log")" = 24

grep -Fq 'acceptanceChecklist' "$repo_root/release/cli.mjs"
grep -Fq 'requiredCount: acceptanceChecklist.length' "$repo_root/release/cli.mjs"
grep -Fq 'sha256: sha256Text(normalized)' "$repo_root/release/cli.mjs"
grep -Fq 'passedCount: acceptanceChecklist.length' "$repo_root/release/cli.mjs"
grep -Fq "acceptanceEvidenceSummary = 'all-required-acceptance-checks-passed'" "$repo_root/release/cli.mjs"
! grep -Fq 'release.userAcceptance = { evidence: evidenceText' "$repo_root/release/cli.mjs"
test -x "$repo_root/release/tests/dev-toolbox-lifecycle.sh"
grep -Fxq 'pexpect==4.9.0' "$repo_root/release/workspace-runtime-requirements.lock"
grep -Fxq 'import pexpect' "$repo_root/release/scripts/self-test.sh"
test ! -e "$repo_root/release/tests/dev-shell-lifecycle.sh"
! grep -Eq 'developmentShell|dev/shells|engineContainerInspections|stopCandidateDevelopmentShells' "$repo_root/release/cli.mjs"
printf 'release command contract passed\n'
