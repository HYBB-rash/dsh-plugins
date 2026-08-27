#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="$(mktemp -d)"
cleanup() { rm -rf -- "$test_root"; }
trap cleanup EXIT

archive="$test_root/image.tar"
mkdir -p "$test_root/archive-root"
printf '%s\n' '{}' >"$test_root/archive-root/fixture.json"
printf '%s\n' '[{"Config":"fixture.json","RepoTags":["dsh-candidate:fixture"],"Layers":[]}]' >"$test_root/archive-root/manifest.json"
tar -C "$test_root/archive-root" -cf "$archive" fixture.json manifest.json
archive_sha="sha256:$(sha256sum "$archive" | awk '{print $1}')"
candidate="$test_root/candidate.json"
cat >"$candidate" <<EOF
{
  "schemaVersion": 1,
  "candidateId": "fixture",
  "status": "tested",
  "imageId": "sha256:fixture",
  "imageTag": "dsh-candidate:fixture",
  "archivePath": "$archive",
  "archiveSha256": "$archive_sha",
  "pluginsCommit": "1111111111111111111111111111111111111111",
  "releaseToolCommit": "3333333333333333333333333333333333333333",
  "harnessCommit": "2222222222222222222222222222222222222222"
}
EOF

run_expect() {
  local expected="$1"
  shift
  set +e
  DSH_RELEASE_STATE_ROOT="$test_root/state" "$repo_root/release/dsh" "$@" >"$test_root/stdout" 2>"$test_root/stderr"
  local actual="$?"
  set -e
  if [[ "$actual" != "$expected" ]]; then
    printf 'expected exit %s, got %s: %s\n' "$expected" "$actual" "$*" >&2
    cat "$test_root/stdout" "$test_root/stderr" >&2
    exit 1
  fi
}

run_expect 3 release --candidate "$candidate"
grep -q 'waiting-for-downtime-authorization' "$test_root/stdout"
grep -q -- '--approved-stop' "$test_root/stdout"

release_dir="$test_root/state/releases/fixture"
mkdir -p "$release_dir"
cat >"$release_dir/release.json" <<EOF
{
  "schemaVersion": 1,
  "releaseId": "fixture",
  "status": "awaiting-user-acceptance",
  "candidate": $(cat "$candidate"),
  "snapshot": {"archivePath": "$test_root/snapshot.tar.zst"},
  "previous": {"mode": "legacy-systemd"}
}
EOF

run_expect 3 rollback --release fixture
grep -q 'waiting-for-rollback-authorization' "$test_root/stdout"

run_expect 2 accept --release fixture
grep -q -- '--evidence' "$test_root/stderr"

cat >"$release_dir/release.json" <<EOF
{
  "schemaVersion": 1,
  "releaseId": "fixture",
  "status": "accepted",
  "candidate": $(cat "$candidate"),
  "snapshot": {"archivePath": "$test_root/snapshot.tar.zst"},
  "previous": {"mode": "legacy-systemd"}
}
EOF

run_expect 3 retire-legacy --release fixture
grep -q 'waiting-for-destructive-cleanup-authorization' "$test_root/stdout"

run_expect 2 build --harness-ref main --plugins-ref main
grep -q '40 位 Git commit' "$test_root/stderr"

node --check "$repo_root/release/cli.mjs"
bash -n "$repo_root/release/dsh" "$repo_root"/release/scripts/*.sh
printf 'release command contract passed\n'
