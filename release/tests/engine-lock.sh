#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${0##*/}" == node ]]; then
  if ! mkdir "$LOCK_TEST_ROOT/active" 2>/dev/null; then
    : >"$LOCK_TEST_ROOT/overlap"
  fi
  printf '%s\n' "${2:-missing}" >>"$LOCK_TEST_ROOT/invocations"
  sleep 0.4
  rmdir "$LOCK_TEST_ROOT/active" 2>/dev/null || true
  exit 0
fi

release_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
cleanup() { find "$test_root" -depth -delete; }
trap cleanup EXIT

mkdir -p "$test_root/bin" "$test_root/state"
ln -s "$release_root/tests/engine-lock.sh" "$test_root/bin/node"

PATH="$test_root/bin:$PATH" LOCK_TEST_ROOT="$test_root" DSH_RELEASE_STATE_ROOT="$test_root/state" \
  "$release_root/dsh" build >"$test_root/one.out" 2>"$test_root/one.err" &
first_pid=$!
PATH="$test_root/bin:$PATH" LOCK_TEST_ROOT="$test_root" DSH_RELEASE_STATE_ROOT="$test_root/state" \
  "$release_root/dsh" build >"$test_root/two.out" 2>"$test_root/two.err" &
second_pid=$!
wait "$first_pid" "$second_pid"

test ! -e "$test_root/overlap"
test "$(wc -l <"$test_root/invocations")" = 2
test -f "$test_root/state/locks/container-engine.lock"

mkdir -p "$test_root/state/locks"

assert_blocked_by_lock() {
  local lock_name="$1"
  shift
  : >"$test_root/invocations"
  local held_fd
  exec {held_fd}>"$test_root/state/locks/$lock_name"
  flock --exclusive "$held_fd"
  PATH="$test_root/bin:$PATH" LOCK_TEST_ROOT="$test_root" DSH_RELEASE_STATE_ROOT="$test_root/state" \
    "$release_root/dsh" "$@" >"$test_root/blocked.out" 2>"$test_root/blocked.err" &
  local child=$!
  sleep 0.15
  test ! -s "$test_root/invocations"
  flock --unlock "$held_fd"
  exec {held_fd}>&-
  wait "$child"
  test "$(wc -l <"$test_root/invocations")" = 1
}

assert_reaches_through_lock() {
  local lock_name="$1"
  shift
  : >"$test_root/invocations"
  local held_fd
  exec {held_fd}>"$test_root/state/locks/$lock_name"
  flock --exclusive "$held_fd"
  PATH="$test_root/bin:$PATH" LOCK_TEST_ROOT="$test_root" DSH_RELEASE_STATE_ROOT="$test_root/state" \
    "$release_root/dsh" "$@" >"$test_root/parallel.out" 2>"$test_root/parallel.err" &
  local child=$!
  for _attempt in $(seq 1 30); do
    test -s "$test_root/invocations" && break
    sleep 0.02
  done
  test -s "$test_root/invocations"
  flock --unlock "$held_fd"
  exec {held_fd}>&-
  wait "$child"
}

for production_command in credential release rollback harness accept; do
  if [[ "$production_command" == harness ]]; then
    assert_blocked_by_lock production-operation.lock harness notion-automation --approved
  else
    assert_blocked_by_lock production-operation.lock "$production_command"
  fi
done
assert_blocked_by_lock container-engine.lock build
assert_blocked_by_lock container-engine.lock accept
assert_reaches_through_lock production-operation.lock build
assert_reaches_through_lock production-operation.lock dev
assert_reaches_through_lock production-operation.lock harness notion-automation

printf 'shared production-operation and container-engine lock matrix passed\n'
