#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="$(mktemp -d)"
cleanup() { find "$test_root" -depth -delete; }
trap cleanup EXIT

mkdir -p "$test_root/bin" "$test_root/state"
cat >"$test_root/bin/node" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if ! mkdir "$LOCK_TEST_ROOT/active" 2>/dev/null; then
  : >"$LOCK_TEST_ROOT/overlap"
fi
printf '%s\n' "${2:-missing}" >>"$LOCK_TEST_ROOT/invocations"
sleep 0.4
rmdir "$LOCK_TEST_ROOT/active" 2>/dev/null || true
EOF
chmod +x "$test_root/bin/node"

PATH="$test_root/bin:$PATH" LOCK_TEST_ROOT="$test_root" DSH_RELEASE_STATE_ROOT="$test_root/state" \
  "$repo_root/release/dsh" build >"$test_root/one.out" 2>"$test_root/one.err" &
first_pid=$!
PATH="$test_root/bin:$PATH" LOCK_TEST_ROOT="$test_root" DSH_RELEASE_STATE_ROOT="$test_root/state" \
  "$repo_root/release/dsh" build >"$test_root/two.out" 2>"$test_root/two.err" &
second_pid=$!
wait "$first_pid" "$second_pid"

test ! -e "$test_root/overlap"
test "$(wc -l <"$test_root/invocations")" = 2
test -f "$test_root/state/locks/container-engine.lock"

printf 'shared container-engine mutation lock contract passed\n'
