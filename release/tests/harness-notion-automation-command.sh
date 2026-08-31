#!/usr/bin/env bash
set -Eeuo pipefail

case "${0##*/}" in
  ssh)
    : >"$DSH_TEST_SSH_MARKER"
    if [[ "${DSH_TEST_SSH_MODE:-}" == status ]]; then
      if env | grep -Eq '^(NOTION_|AUTHORIZATION_)'; then
        : >"$DSH_TEST_CREDENTIAL_MARKER"
      fi
      printf '%s\n' "$*" >"$DSH_TEST_SSH_ARGS"
      tee "$DSH_TEST_STATUS_INPUT" >/dev/null
      if [[ "${DSH_TEST_STATUS_FAIL:-0}" == 1 ]]; then
        printf '%s\n' 'PRIVATE REMOTE FAILURE BODY' >&2
        exit 9
      fi
      exec cat -- "$DSH_TEST_STATUS_RECEIPT"
    fi
    exit 97
    ;;
  git)
    printf '%s\n' "$*" >>"$DSH_TEST_GIT_LOG"
    if [[ "$*" == *' fetch '* || "$*" == *' fetch' ]]; then
      : >"$DSH_TEST_FETCH_MARKER"
      exit 98
    fi
    if [[ "$*" == *'rev-parse --verify HEAD^{commit}'* ]]; then
      printf '%s\n' "$DSH_TEST_STATUS_COMMIT"
      exit 0
    fi
    if [[ "$*" == *' show '* \
      && "${*: -1}" == "$DSH_TEST_STATUS_COMMIT:release/scripts/harness-notion-automation-status.py" ]]; then
      exec cat -- "$DSH_TEST_STATUS_HELPER"
    fi
    exit 97
    ;;
esac

release_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
cleanup() { rm -rf -- "$test_root"; }
trap cleanup EXIT

mkdir -p -- "$test_root/bin"
# Formal image self-test mounts /tmp noexec.  Execute the tracked 0755 test
# inode through temporary command-name symlinks instead of executing temp files.
ln -s -- "$release_root/tests/harness-notion-automation-command.sh" "$test_root/bin/ssh"

run_case() {
  local expected_status="$1"
  shift
  rm -rf -- "$test_root/state"
  rm -f -- "$test_root/ssh-called"
  set +e
  PATH="$test_root/bin:$PATH" \
    DSH_RELEASE_STATE_ROOT="$test_root/state" \
    DSH_TEST_SSH_MARKER="$test_root/ssh-called" \
    "$release_root/dsh" "$@" >"$test_root/stdout" 2>"$test_root/stderr"
  local status=$?
  set -e
  test "$status" = "$expected_status"
  test ! -e "$test_root/ssh-called"
  test ! -e "$test_root/state"
}

run_case 3 harness notion-automation
python3 - "$test_root/stdout" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
assert value == {
    "status": "waiting-for-harness-notion-automation-authorization",
    "target": "herman.hermes:/home/herman/.dsh/workspace/automations/notion",
    "preimage": "must-be-absent-create-only",
    "execution": "accepted-immutable-image-one-shot-local-authoring",
    "network": "none-local-authoring",
    "productionWrite": False,
    "next": "./release/dsh harness notion-automation --approved",
}
PY

set +e
PATH="$test_root/bin:$PATH" \
  DSH_RELEASE_STATE_ROOT="$test_root/state" \
  DSH_DEPLOY_TARGET=unexpected.invalid \
  DSH_TEST_SSH_MARKER="$test_root/ssh-called" \
  "$release_root/dsh" harness notion-automation >"$test_root/stdout" 2>"$test_root/stderr"
status=$?
set -e
test "$status" = 3
grep -Fq 'unexpected.invalid:/home/herman/.dsh/workspace/automations/notion' "$test_root/stdout"
test ! -e "$test_root/ssh-called"
test ! -e "$test_root/state"

run_case 2 harness --approved notion-automation
run_case 2 harness notion-automation --approved --approved
run_case 2 harness --status notion-automation
run_case 2 harness notion-automation --status --status
run_case 2 harness notion-automation --status extra
run_case 2 harness notion-automation --status=1

set +e
PATH="$test_root/bin:$PATH" \
  DSH_RELEASE_STATE_ROOT="$test_root/state" \
  DSH_DEPLOY_TARGET=unexpected.invalid \
  DSH_TEST_SSH_MARKER="$test_root/ssh-called" \
  "$release_root/dsh" harness notion-automation --status >"$test_root/stdout" 2>"$test_root/stderr"
status=$?
set -e
test "$status" = 4
grep -Fq '状态只允许读取 herman.hermes' "$test_root/stderr"
test ! -e "$test_root/ssh-called"
test ! -e "$test_root/state"

set +e
PATH="$test_root/bin:$PATH" \
  DSH_RELEASE_STATE_ROOT="$test_root/state" \
  DSH_DEPLOY_TARGET=unexpected.invalid \
  DSH_TEST_SSH_MARKER="$test_root/ssh-called" \
  "$release_root/dsh" harness notion-automation --approved >"$test_root/stdout" 2>"$test_root/stderr"
status=$?
set -e
test "$status" = 4
test ! -e "$test_root/ssh-called"

status_commit="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
status_sha256="$(sha256sum "$release_root/scripts/harness-notion-automation-status.py" | awk '{print $1}')"
mkdir -p -- "$test_root/status-bin"
ln -s -- "$release_root/tests/harness-notion-automation-command.sh" "$test_root/status-bin/git"

python3 - "$test_root/status-receipt.json" "$status_commit" "$status_sha256" <<'PY'
import json, sys
path, commit, sha256 = sys.argv[1:]
engine = "sha256:" + "e" * 64
def container(name, running, status, health):
    return {
        "name": name,
        "imageMatchesAccepted": True,
        "composeLabelsMatch": True,
        "running": running,
        "status": status,
        "exitCode": 0,
        "oomKilled": False,
        "dead": False,
        "restarting": False,
        "restartCount": 0,
        "health": health,
    }
value = {
    "schemaVersion": 1,
    "status": "accepted-production-boundary",
    "statusSource": {"commit": commit, "sha256": f"sha256:{sha256}"},
    "target": {"presence": "absent", "type": "absent"},
    "harnessTasks": {"childCount": 0},
    "oneShotResources": {
        "ownerLabel": "io.dsh.owner=harness-notion-automation",
        "containerCount": 0,
        "networkCount": 0,
    },
    "release": {
        "currentEqualsLastGood": True,
        "releaseId": "20260830T120000000Z-cccccccccccc",
        "engineImageId": engine,
        "imageTag": "localhost/dsh-candidate:accepted",
        "pluginsCommit": "b" * 40,
        "releaseToolCommit": "c" * 40,
        "harnessCommit": "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
        "harnessPatchSha256": "sha256:df85af4402b238a666bc7117092e559ae843df55c850ea6b711c1c8f3a292e0b",
    },
    "containers": {
        "web": container("dsh-web", True, "running", "healthy"),
        "telegram": container("dsh-telegram", True, "running", "none"),
        "lan": container("dsh-lan-proxy", True, "running", "none"),
        "prepare": container("dsh-prepare", False, "exited", "none"),
    },
}
with open(path, "w", encoding="utf-8") as output:
    json.dump(value, output, sort_keys=True, separators=(",", ":"))
    output.write("\n")
PY

run_status() {
  local receipt="$1"
  shift
  rm -rf -- "$test_root/state"
  mkdir -p -- "$test_root/state/locks"
  : >"$test_root/state/locks/production-operation.lock"
  chmod 644 "$test_root/state/locks/production-operation.lock"
  local lock_identity
  lock_identity="$(stat -c '%d:%i:%f:%u:%g:%s:%Y:%Z' "$test_root/state/locks/production-operation.lock")"
  rm -f -- "$test_root/ssh-called" "$test_root/status-input" \
    "$test_root/credential-leaked" "$test_root/fetch-called" "$test_root/git.log"
  set +e
  PATH="$test_root/status-bin:$test_root/bin:$PATH" \
    DSH_RELEASE_STATE_ROOT="$test_root/state" \
    DSH_TEST_SSH_MARKER="$test_root/ssh-called" \
    DSH_TEST_SSH_MODE=status \
    DSH_TEST_SSH_ARGS="$test_root/ssh-args" \
    DSH_TEST_STATUS_INPUT="$test_root/status-input" \
    DSH_TEST_STATUS_RECEIPT="$receipt" \
    DSH_TEST_CREDENTIAL_MARKER="$test_root/credential-leaked" \
    DSH_TEST_GIT_LOG="$test_root/git.log" \
    DSH_TEST_FETCH_MARKER="$test_root/fetch-called" \
    DSH_TEST_STATUS_COMMIT="$status_commit" \
    DSH_TEST_STATUS_HELPER="$release_root/scripts/harness-notion-automation-status.py" \
    NOTION_TOKEN='PRIVATE LOCAL NOTION TOKEN' \
    AUTHORIZATION_SECRET='PRIVATE LOCAL AUTHORIZATION' \
    "$release_root/dsh" harness notion-automation --status \
    >"$test_root/stdout" 2>"$test_root/stderr"
  status=$?
  set -e
  if [[ "$status" != "$1" ]]; then
    printf 'status command exited %s, expected %s: ' "$status" "$1" >&2
    cat "$test_root/stderr" >&2
    test ! -e "$test_root/git.log" || sed 's/^/git: /' "$test_root/git.log" >&2
    return 1
  fi
  test "$(stat -c '%d:%i:%f:%u:%g:%s:%Y:%Z' "$test_root/state/locks/production-operation.lock")" = "$lock_identity"
  test "$(find "$test_root/state" -type f -printf '%P\n')" = 'locks/production-operation.lock'
}

run_status "$test_root/status-receipt.json" 0
python3 - "$test_root/stdout" "$test_root/status-receipt.json" <<'PY'
import json, sys
assert json.load(open(sys.argv[1], encoding="utf-8")) == json.load(open(sys.argv[2], encoding="utf-8"))
PY
test -e "$test_root/ssh-called"
test ! -e "$test_root/credential-leaked"
test ! -e "$test_root/fetch-called"
test "$(wc -l <"$test_root/git.log")" = 2
grep -Fq 'rev-parse --verify HEAD^{commit}' "$test_root/git.log"
grep -Fq "show $status_commit:release/scripts/harness-notion-automation-status.py" "$test_root/git.log"
base64 --decode "$test_root/status-input" >"$test_root/status-helper-decoded.py"
cmp "$test_root/status-helper-decoded.py" "$release_root/scripts/harness-notion-automation-status.py"
grep -Fq "python3" "$test_root/ssh-args"
grep -Fq "$status_commit" "$test_root/ssh-args"
grep -Fq "$status_sha256" "$test_root/ssh-args"

python3 - "$test_root/status-receipt.json" "$test_root/status-extra.json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
value["privateBody"] = "PRIVATE MALICIOUS RECEIPT BODY"
json.dump(value, open(sys.argv[2], "w", encoding="utf-8"))
PY
run_status "$test_root/status-extra.json" 6
test "$(cat "$test_root/stderr")" = '错误：Harness Notion automation 生产状态不可确认'
! grep -Fq 'PRIVATE MALICIOUS' "$test_root/stderr"

rm -rf -- "$test_root/state"
mkdir -p -- "$test_root/state/locks"
rm -f -- "$test_root/ssh-called"
set +e
PATH="$test_root/status-bin:$test_root/bin:$PATH" \
  DSH_RELEASE_STATE_ROOT="$test_root/state" \
  DSH_TEST_SSH_MARKER="$test_root/ssh-called" \
  "$release_root/dsh" harness notion-automation --status >"$test_root/stdout" 2>"$test_root/stderr"
status=$?
set -e
test "$status" = 6
test "$(cat "$test_root/stderr")" = '错误：Harness Notion automation 本机生产锁不可用'
test ! -e "$test_root/state/locks/production-operation.lock"
test ! -e "$test_root/ssh-called"

printf '' >"$test_root/state/locks/unsafe-lock"
chmod 644 "$test_root/state/locks/unsafe-lock"
ln "$test_root/state/locks/unsafe-lock" "$test_root/state/locks/production-operation.lock"
set +e
PATH="$test_root/status-bin:$test_root/bin:$PATH" \
  DSH_RELEASE_STATE_ROOT="$test_root/state" \
  DSH_TEST_SSH_MARKER="$test_root/ssh-called" \
  "$release_root/dsh" harness notion-automation --status >"$test_root/stdout" 2>"$test_root/stderr"
status=$?
set -e
test "$status" = 6
test "$(cat "$test_root/stderr")" = '错误：Harness Notion automation 本机生产锁不可用'
test ! -e "$test_root/ssh-called"

rm -f -- "$test_root/state/locks/production-operation.lock" "$test_root/state/locks/unsafe-lock"
: >"$test_root/state/locks/production-operation.lock"
chmod 644 "$test_root/state/locks/production-operation.lock"
exec {exclusive_fd}>"$test_root/state/locks/production-operation.lock"
flock --exclusive "$exclusive_fd"
set +e
PATH="$test_root/status-bin:$test_root/bin:$PATH" \
  DSH_RELEASE_STATE_ROOT="$test_root/state" \
  DSH_TEST_SSH_MARKER="$test_root/ssh-called" \
  "$release_root/dsh" harness notion-automation --status >"$test_root/stdout" 2>"$test_root/stderr"
status=$?
set -e
flock --unlock "$exclusive_fd"
exec {exclusive_fd}>&-
test "$status" = 6
test "$(cat "$test_root/stderr")" = '错误：Harness Notion automation 本机生产锁不可用'
test ! -e "$test_root/ssh-called"

rm -rf -- "$test_root/state"
mkdir -p -- "$test_root/state/locks"
: >"$test_root/state/locks/production-operation.lock"
chmod 644 "$test_root/state/locks/production-operation.lock"
set +e
PATH="$test_root/status-bin:$test_root/bin:$PATH" \
  DSH_RELEASE_STATE_ROOT="$test_root/state" \
  DSH_TEST_SSH_MARKER="$test_root/ssh-called" \
  DSH_TEST_SSH_MODE=status \
  DSH_TEST_STATUS_FAIL=1 \
  DSH_TEST_SSH_ARGS="$test_root/ssh-args" \
  DSH_TEST_STATUS_INPUT="$test_root/status-input" \
  DSH_TEST_STATUS_RECEIPT="$test_root/status-receipt.json" \
  DSH_TEST_CREDENTIAL_MARKER="$test_root/credential-leaked" \
  DSH_TEST_GIT_LOG="$test_root/git.log" \
  DSH_TEST_FETCH_MARKER="$test_root/fetch-called" \
  DSH_TEST_STATUS_COMMIT="$status_commit" \
  DSH_TEST_STATUS_HELPER="$release_root/scripts/harness-notion-automation-status.py" \
  "$release_root/dsh" harness notion-automation --status >"$test_root/stdout" 2>"$test_root/stderr"
status=$?
set -e
test "$status" = 6
test "$(cat "$test_root/stderr")" = '错误：Harness Notion automation 生产状态不可确认'
! grep -Fq 'PRIVATE REMOTE' "$test_root/stderr"
test "$(find "$test_root/state" -type f -printf '%P\n')" = 'locks/production-operation.lock'

grep -Fq 'requireCurrentHeadReleaseTree' "$release_root/cli.mjs"
grep -Fq 'requireLatestMainAncestor' "$release_root/cli.mjs"
grep -Fq 'remoteHarnessNotionLoader' "$release_root/cli.mjs"

python3 - "$release_root/cli.mjs" <<'PY'
import base64
import hashlib
import json
import re
import subprocess
import sys

source = open(sys.argv[1], encoding="utf-8").read()
match = re.search(
    r"const remoteHarnessNotionLoader = `\n(?P<loader>.*?)\n`\n\nconst remoteHarnessNotionStatusLoader",
    source,
    re.DOTALL,
)
assert match is not None
loader = match.group("loader")
compile(loader, "remote-harness-notion-loader.py", "exec")
assert "assert " not in loader

invalid = subprocess.run(
    [sys.executable, "-c", loader],
    input=b"{}\n",
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=False,
)
assert invalid.returncode == 4
assert invalid.stdout == b""
assert invalid.stderr == b""

runner = b"raise SystemExit(0)\n"
assets = {}
for name in ("bridge", "patch", "prompt", "checker", "probe"):
    content = ("synthetic-" + name).encode()
    assets[name] = {
        "content": base64.b64encode(content).decode(),
        "sha256": hashlib.sha256(content).hexdigest(),
    }
payload = {
    "runner": base64.b64encode(runner).decode(),
    "runnerSha256": hashlib.sha256(runner).hexdigest(),
    "orchestrationCommit": "a" * 40,
    "assets": assets,
}
valid = subprocess.run(
    [sys.executable, "-c", loader],
    input=(json.dumps(payload) + "\n").encode(),
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=False,
)
assert valid.returncode == 0
assert valid.stdout == b""
assert valid.stderr == b""
PY
