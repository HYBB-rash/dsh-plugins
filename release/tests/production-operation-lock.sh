#!/usr/bin/env bash
set -Eeuo pipefail

case "${0##*/}" in
  node)
    test_root="${LOCK_TEST_ROOT:?}"
    state_root="${DSH_RELEASE_STATE_ROOT:?}"
    invocation_id="${LOCK_TEST_ID:?}"
    command="${2:-missing}"

    lock_state() {
      local lock_path="$1"
      if flock --exclusive --nonblock "$lock_path" true; then
        printf '%s' free
      else
        printf '%s' held
      fi
    }

    production_state="$(lock_state "$state_root/locks/production-operation.lock")"
    engine_state="$(lock_state "$state_root/locks/container-engine.lock")"
    printf '%s\t%s\t%s\t%s\n' \
      "$invocation_id" "$command" "$production_state" "$engine_state" \
      >"$test_root/observations/$invocation_id"
    : >"$test_root/started/$invocation_id"

    if [[ "${LOCK_TEST_HOLD:-0}" == 1 ]]; then
      for ((attempt = 0; attempt < 500; attempt += 1)); do
        if [[ -e "$test_root/release/$invocation_id" ]]; then
          exit "${LOCK_TEST_EXIT_CODE:-0}"
        fi
        sleep 0.01
      done
      printf 'timed out waiting to release fake node invocation %s\n' "$invocation_id" >&2
      exit 98
    fi
    exit "${LOCK_TEST_EXIT_CODE:-0}"
    ;;
  ssh|scp|docker|podman|buildah)
    printf '%s\n' "${0##*/}" >>"$LOCK_TEST_ROOT/forbidden-external-operation"
    exit 97
    ;;
esac

release_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"

cleanup() {
  local pid
  for pid in $(jobs -pr); do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  find "$test_root" -depth -delete
}
trap cleanup EXIT

mkdir -p \
  "$test_root/bin" \
  "$test_root/observations" \
  "$test_root/output" \
  "$test_root/release" \
  "$test_root/started" \
  "$test_root/state"

for forbidden_tool in ssh scp docker podman buildah; do
  ln -s "$release_root/tests/production-operation-lock.sh" "$test_root/bin/$forbidden_tool"
done

ln -s "$release_root/tests/production-operation-lock.sh" "$test_root/bin/node"

fail_test() {
  printf 'production operation lock test failed: %s\n' "$*" >&2
  exit 1
}

test -x "$release_root/dsh" || fail_test "release entrypoint is missing at $release_root/dsh"
grep -Fqx 'release_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"' \
  "${BASH_SOURCE[0]}" \
  || fail_test 'release-root resolver no longer matches the image layout release-system/tests -> release-system'

wait_for_path() {
  local path="$1"
  local label="$2"
  for ((attempt = 0; attempt < 500; attempt += 1)); do
    [[ -e "$path" ]] && return 0
    sleep 0.01
  done
  fail_test "timed out waiting for $label"
}

assert_path_absent_for_window() {
  local path="$1"
  local label="$2"
  for ((attempt = 0; attempt < 20; attempt += 1)); do
    [[ ! -e "$path" ]] || fail_test "$label entered its fake node while it should have been locked out"
    sleep 0.01
  done
}

wait_for_lock_held() {
  local lock_path="$1"
  local label="$2"
  for ((attempt = 0; attempt < 500; attempt += 1)); do
    if ! flock --exclusive --nonblock "$lock_path" true; then
      return 0
    fi
    sleep 0.01
  done
  fail_test "timed out waiting for $label"
}

last_pid=''
start_command() {
  local invocation_id="$1"
  local command="$2"
  local hold="${3:-0}"
  local exit_code="${4:-0}"
  local -a arguments=("$command")
  case "$command" in
    harness-approved) arguments=(harness notion-automation --approved) ;;
    harness-preview) arguments=(harness notion-automation) ;;
    harness-status) arguments=(harness notion-automation --status) ;;
  esac
  PATH="$test_root/bin:$PATH" \
    DSH_RELEASE_STATE_ROOT="$test_root/state" \
    LOCK_TEST_ROOT="$test_root" \
    LOCK_TEST_ID="$invocation_id" \
    LOCK_TEST_HOLD="$hold" \
    LOCK_TEST_EXIT_CODE="$exit_code" \
    "$release_root/dsh" "${arguments[@]}" \
    >"$test_root/output/$invocation_id.stdout" \
    2>"$test_root/output/$invocation_id.stderr" &
  last_pid=$!
}

wait_for_status() {
  local pid="$1"
  local expected="$2"
  local label="$3"
  local actual
  set +e
  wait "$pid"
  actual=$?
  set -e
  [[ "$actual" == "$expected" ]] || fail_test "$label exited $actual, expected $expected"
}

release_command() {
  local invocation_id="$1"
  : >"$test_root/release/$invocation_id"
}

assert_observation() {
  local invocation_id="$1"
  local expected_command="$2"
  local expected_production="$3"
  local expected_engine="$4"
  local observed_id observed_command observed_production observed_engine
  IFS=$'\t' read -r observed_id observed_command observed_production observed_engine \
    <"$test_root/observations/$invocation_id"
  [[ "$observed_id" == "$invocation_id" ]] || fail_test "$invocation_id observation identity drifted"
  [[ "$observed_command" == "$expected_command" ]] || fail_test "$invocation_id observed command $observed_command"
  [[ "$observed_production" == "$expected_production" ]] \
    || fail_test "$invocation_id production lock was $observed_production, expected $expected_production"
  [[ "$observed_engine" == "$expected_engine" ]] \
    || fail_test "$invocation_id engine lock was $observed_engine, expected $expected_engine"
}

# A credential holder must exclude every production operation.  Each contender
# is then observed again after admission, proving that it uses the same lock
# rather than merely waiting on an unrelated resource.
for command in credential release rollback harness-approved accept; do
  expected_command="${command%-approved}"
  holder_id="holder-$command"
  contender_id="contender-$command"

  start_command "$holder_id" credential 1
  holder_pid="$last_pid"
  wait_for_path "$test_root/started/$holder_id" "$holder_id"
  assert_observation "$holder_id" credential held free

  start_command "$contender_id" "$command"
  contender_pid="$last_pid"
  assert_path_absent_for_window "$test_root/started/$contender_id" "$contender_id"

  release_command "$holder_id"
  wait_for_status "$holder_pid" 0 "$holder_id"
  wait_for_path "$test_root/started/$contender_id" "$contender_id"
  wait_for_status "$contender_pid" 0 "$contender_id"
  if [[ "$command" == accept ]]; then
    assert_observation "$contender_id" "$expected_command" held held
  else
    assert_observation "$contender_id" "$expected_command" held free
  fi
done

# Preview bypasses the lock completely.  Two status readers both hold a shared
# production lock and may enter together.
start_command harness-preview-standalone harness-preview
preview_pid="$last_pid"
wait_for_path "$test_root/started/harness-preview-standalone" harness-preview-standalone
wait_for_status "$preview_pid" 0 harness-preview-standalone
assert_observation harness-preview-standalone harness free free

start_command status-shared-one harness-status 1
status_one_pid="$last_pid"
wait_for_path "$test_root/started/status-shared-one" status-shared-one
start_command status-shared-two harness-status 1
status_two_pid="$last_pid"
wait_for_path "$test_root/started/status-shared-two" status-shared-two
assert_observation status-shared-one harness held free
assert_observation status-shared-two harness held free
release_command status-shared-one
release_command status-shared-two
wait_for_status "$status_one_pid" 0 status-shared-one
wait_for_status "$status_two_pid" 0 status-shared-two

# Standalone observations prove build owns only the engine lock and dev owns
# neither global operation lock.
start_command build-standalone build
build_pid="$last_pid"
wait_for_path "$test_root/started/build-standalone" build-standalone
wait_for_status "$build_pid" 0 build-standalone
assert_observation build-standalone build free held

start_command dev-standalone dev
dev_pid="$last_pid"
wait_for_path "$test_root/started/dev-standalone" dev-standalone
wait_for_status "$dev_pid" 0 dev-standalone
assert_observation dev-standalone dev free free

# Build and dev must both enter while a production-only command remains live.
# Build waits inside fake node while holding only engine; dev holds neither.
start_command production-parallel credential 1
production_parallel_pid="$last_pid"
wait_for_path "$test_root/started/production-parallel" production-parallel

start_command build-parallel build 1
build_parallel_pid="$last_pid"
start_command dev-parallel dev 1
dev_parallel_pid="$last_pid"
wait_for_path "$test_root/started/build-parallel" build-parallel
wait_for_path "$test_root/started/dev-parallel" dev-parallel
kill -0 "$production_parallel_pid" 2>/dev/null \
  || fail_test 'production-only holder exited before build/dev parallel admission'

release_command build-parallel
release_command dev-parallel
release_command production-parallel
wait_for_status "$build_parallel_pid" 0 build-parallel
wait_for_status "$dev_parallel_pid" 0 dev-parallel
wait_for_status "$production_parallel_pid" 0 production-parallel

# Accept must acquire production before it waits for engine.  Hold engine with
# build, start accept, and wait until production becomes unavailable.  A new
# credential command must then remain blocked both before and after accept
# reaches its fake node.
start_command order-engine-holder build 1
order_engine_pid="$last_pid"
wait_for_path "$test_root/started/order-engine-holder" order-engine-holder

start_command order-accept accept 1
order_accept_pid="$last_pid"
wait_for_lock_held "$test_root/state/locks/production-operation.lock" 'accept production lock acquisition'
[[ ! -e "$test_root/started/order-accept" ]] \
  || fail_test 'accept reached fake node while the engine lock was still held'

start_command order-credential credential
order_credential_pid="$last_pid"
assert_path_absent_for_window "$test_root/started/order-credential" order-credential

release_command order-engine-holder
wait_for_status "$order_engine_pid" 0 order-engine-holder
wait_for_path "$test_root/started/order-accept" order-accept
assert_path_absent_for_window "$test_root/started/order-credential" order-credential
assert_observation order-accept accept held held

release_command order-accept
wait_for_status "$order_accept_pid" 0 order-accept
wait_for_path "$test_root/started/order-credential" order-credential
wait_for_status "$order_credential_pid" 0 order-credential
assert_observation order-credential credential held free

# A non-zero child exit must release both locks.  Credential and build can
# immediately enter afterward, proving no stale flock survives the failed
# accept invocation.
start_command abnormal-accept accept 0 37
abnormal_accept_pid="$last_pid"
wait_for_path "$test_root/started/abnormal-accept" abnormal-accept
wait_for_status "$abnormal_accept_pid" 37 abnormal-accept
assert_observation abnormal-accept accept held held

start_command after-abnormal-credential credential
after_credential_pid="$last_pid"
wait_for_path "$test_root/started/after-abnormal-credential" after-abnormal-credential
wait_for_status "$after_credential_pid" 0 after-abnormal-credential
assert_observation after-abnormal-credential credential held free

start_command after-abnormal-build build
after_build_pid="$last_pid"
wait_for_path "$test_root/started/after-abnormal-build" after-abnormal-build
wait_for_status "$after_build_pid" 0 after-abnormal-build
assert_observation after-abnormal-build build free held

test -f "$test_root/state/locks/production-operation.lock"
test -f "$test_root/state/locks/container-engine.lock"
test ! -e "$test_root/forbidden-external-operation"

printf 'production operation lock contract passed\n'
