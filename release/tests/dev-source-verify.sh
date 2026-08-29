#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="$(mktemp -d)"
cleanup() { find "$test_root" -depth -delete; }
trap cleanup EXIT

source_root="$test_root/source"
harness_root="$test_root/harness"
fake_bin="$test_root/fake-bin"
log="$test_root/commands.log"
mkdir -p "$source_root/.git" "$source_root/x-feed/python" "$fake_bin" "$harness_root/node_modules/.bin" "$harness_root/node_modules/vitest"
printf '%s\n' '{}' >"$source_root/runtime-package-topology.json"

for package in telegram-gateway dsh-cron dsh-assistant personal-feed-selector personal-feed x-feed; do
  mkdir -p "$harness_root/local-plugins/$package/src" "$harness_root/local-plugins/$package/tests"
  printf '%s\n' '{}' >"$harness_root/local-plugins/$package/package.json"
done
mkdir -p "$harness_root/local-plugins/x-feed/python"

for tool in tsc tsdown; do
  cat >"$harness_root/node_modules/.bin/$tool" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'build tool=%s setpriv_marker=%s node_path=%s\n' \
  "$(basename "$0")" "${DSH_VERIFY_SETUID:-}" "${NODE_PATH:-unset}" >>"$MOCK_VERIFY_LOG"
EOF
  chmod +x "$harness_root/node_modules/.bin/$tool"
done

cat >"$fake_bin/setpriv" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'setpriv args=%q %q %q\n' "$1" "$2" "$3" >>"$MOCK_VERIFY_LOG"
shift 3
DSH_VERIFY_SETUID=1000 exec "$@"
EOF
cat >"$fake_bin/node" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'vitest setpriv_marker=%s home=%s npm=%s xdg=%s node_path=%s\n' \
  "${DSH_VERIFY_SETUID:-}" "$HOME" "$npm_config_cache" "$XDG_CACHE_HOME" "${NODE_PATH:-unset}" >>"$MOCK_VERIFY_LOG"
EOF
cat >"$fake_bin/python3" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'python setpriv_marker=%s home=%s data=%s pycache=%s node_path=%s args=%s\n' \
  "${DSH_VERIFY_SETUID:-}" "$HOME" "${DSH_X_FEED_DATA_DIR:-unset}" "$PYTHONPYCACHEPREFIX" "${NODE_PATH:-unset}" "$*" >>"$MOCK_VERIFY_LOG"
EOF
cat >"$fake_bin/chown" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'chown args=%s\n' "$*" >>"$MOCK_VERIFY_LOG"
EOF
chmod +x "$fake_bin/setpriv" "$fake_bin/node" "$fake_bin/python3" "$fake_bin/chown"

script="$test_root/dev-source-verify.sh"
sed \
  -e "s|^source_root=.*|source_root=$source_root|" \
  -e "s|^harness_root=.*|harness_root=$harness_root|" \
  "$repo_root/release/scripts/dev-source-verify.sh" >"$script"
chmod +x "$script"

PATH="$fake_bin:$PATH" \
NODE_PATH='/must-not-reach-test-resolver' \
MOCK_VERIFY_LOG="$log" \
  "$script" all

test "$(grep -Fc 'build tool=tsc setpriv_marker=' "$log")" = 12
test "$(grep -Fc 'build tool=tsdown setpriv_marker=' "$log")" = 6
test "$(grep -Fc 'setpriv args=--reuid=1000 --regid=1000 --init-groups' "$log")" = 8
test "$(grep -Fc 'vitest setpriv_marker=1000' "$log")" = 6
test "$(grep -Fc 'python setpriv_marker=1000' "$log")" = 3
test "$(grep -Fc 'chown args=-R 1000:1000' "$log")" = 3
grep -q 'build tool=tsc setpriv_marker= node_path=unset' "$log"
grep -q 'build tool=tsdown setpriv_marker= node_path=unset' "$log"
grep -q 'vitest setpriv_marker=1000 .*node_path=unset' "$log"
grep -q 'python setpriv_marker=1000 .*node_path=unset' "$log"
grep -q 'python setpriv_marker=1000 .*data=/tmp/dsh-editable-verify' "$log"
grep -q 'python setpriv_marker=1000 .*pycache=/tmp/dsh-editable-verify.*/python-pycache ' "$log"
grep -q 'python .*args=-m unittest discover -p test_x_\*\.py' "$log"
grep -q 'python .*args=-m unittest test_insight_engine.py' "$log"
grep -q 'python .*data=unset .*args=/opt/dsh/release-system/tests/test_workspace_migration.py' "$log"
test ! -e "$source_root/x-feed/python/__pycache__"
verify_home="$(sed -n 's/^vitest .* home=\([^ ]*\) .*/\1/p' "$log" | head -n 1)"
test -n "$verify_home"
test ! -e "$(dirname "$verify_home")"

printf 'editable verification identity-phase mock passed\n'
