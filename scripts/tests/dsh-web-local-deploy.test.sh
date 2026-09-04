#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
deploy_script="$repository_root/scripts/dsh-web-local-deploy"
if [[ ! -x "$deploy_script" ]]; then
  echo 'missing executable scripts/dsh-web-local-deploy' >&2
  exit 1
fi

fixture_root=$(mktemp -d /tmp/dsh-web-local-deploy-test.XXXXXX)
cleanup() { rm -rf -- "$fixture_root"; }
trap cleanup EXIT
source_root="$fixture_root/source"
target_root="$fixture_root/target"
test_bin="$fixture_root/bin"
mkdir -p "$source_root/scripts" "$target_root/scripts" "$test_bin" "$fixture_root/home"
cp "$deploy_script" "$source_root/scripts/dsh-web-local-deploy"
cp "$deploy_script" "$target_root/scripts/dsh-web-local-deploy"
chmod +x "$source_root/scripts/dsh-web-local-deploy" "$target_root/scripts/dsh-web-local-deploy"

cat >"$test_bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
directory=$PWD
if [[ "${1:-}" == -C ]]; then
  directory=$2
  shift 2
fi
case "${1:-} ${2:-}" in
  'rev-parse --show-toplevel') printf '%s\n' "$directory" ;;
  'rev-parse --git-common-dir') printf '%s\n' "$DSH_TEST_COMMON_GIT_DIR" ;;
  'rev-parse --abbrev-ref')
    [[ "${3:-}" == HEAD ]]
    if [[ "$directory" == "$DSH_TEST_TARGET" ]]; then printf 'main\n'; else printf 'feature\n'; fi
    ;;
  'rev-parse HEAD')
    if [[ "$directory" == "$DSH_TEST_TARGET" ]]; then printf '%s\n' "$DSH_TEST_TARGET_HEAD"; else printf '%s\n' "$DSH_TEST_SOURCE_HEAD"; fi
    ;;
  'status --porcelain')
    if [[ "$directory" == "$DSH_TEST_SOURCE" && "${DSH_TEST_DIRTY_SOURCE:-0}" == 1 ]]; then printf '?? dirty\n'; fi
    if [[ "$directory" == "$DSH_TEST_TARGET" && "${DSH_TEST_DIRTY_TARGET:-0}" == 1 ]]; then printf ' M dirty\n'; fi
    ;;
  'merge-base --is-ancestor') [[ "${DSH_TEST_FAST_FORWARD:-1}" == 1 ]] ;;
  'reset --hard')
    printf 'reset %s\n' "${3:-}" >>"$DSH_TEST_LOG"
    ;;
  'submodule update') printf 'submodule-update\n' >>"$DSH_TEST_LOG" ;;
  *) printf 'unexpected git command in %s: %q\n' "$directory" "$*" >&2; exit 91 ;;
esac
EOF

cat >"$test_bin/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  '--user show dsh-web-local.service -p ExecStart --value')
    printf '{ path=%s/scripts/dsh-web-runtime ; argv[]=%s/scripts/dsh-web-runtime --host 127.0.0.1 --port 3080 --no-open ; }\n' "$DSH_TEST_TARGET" "$DSH_TEST_TARGET"
    ;;
  '--user stop dsh-web-local.service') printf 'stop\n' >>"$DSH_TEST_LOG" ;;
  '--user start dsh-web-local.service') printf 'start\n' >>"$DSH_TEST_LOG"; : >"$DSH_TEST_STARTED" ;;
  '--user is-active --quiet dsh-web-local.service') test -f "$DSH_TEST_STARTED" ;;
  *) printf 'unexpected systemctl command: %q\n' "$*" >&2; exit 92 ;;
esac
EOF

cat >"$test_bin/nix" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == develop && "${2:-}" == -c ]]
shift 2
printf 'nix %s\n' "${1:-}" >>"$DSH_TEST_LOG"
exec "$@"
EOF

cat >"$test_bin/ss" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'State Recv-Q Send-Q Local Address:Port Peer Address:Port' 'LISTEN 0 511 127.0.0.1:3080 0.0.0.0:*'
if [[ "${DSH_TEST_LAN_LISTEN:-0}" == 1 ]]; then
  printf '%s\n' 'LISTEN 0 511 0.0.0.0:3080 0.0.0.0:*'
fi
EOF

chmod +x "$test_bin/git" "$test_bin/systemctl" "$test_bin/nix" "$test_bin/ss"

cat >"$target_root/scripts/dsh-web-install-plugins" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'install\n' >>"$DSH_TEST_LOG"
if [[ "${DSH_TEST_INSTALL_FAIL:-0}" == 1 ]]; then exit 93; fi
mkdir -p "$DSH_WEB_HOME/profiles/web"
cat >"$DSH_WEB_HOME/profiles/web/package.json" <<JSON
{"dependencies":{"gateway":"file:$DSH_TEST_TARGET/telegram-gateway","cron":"file:$DSH_TEST_TARGET/dsh-cron","assistant":"file:$DSH_TEST_TARGET/dsh-assistant"}}
JSON
EOF
chmod +x "$target_root/scripts/dsh-web-install-plugins"

cat >"$target_root/scripts/dsh-web-runtime" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'dump-config\n' >>"$DSH_TEST_LOG"
printf '%s\n' '- id: telegram-gateway' '- id: dsh-cron' '- id: dsh-assistant'
if [[ "${DSH_TEST_BAD_DUMP:-0}" == 1 ]]; then printf '%s\n' '- id: dsh-cron'; fi
EOF
chmod +x "$target_root/scripts/dsh-web-runtime"

export DSH_TEST_SOURCE="$source_root"
export DSH_TEST_TARGET="$target_root"
export DSH_TEST_COMMON_GIT_DIR="$fixture_root/common.git"
export DSH_TEST_SOURCE_HEAD=bbbbbbbb
export DSH_TEST_TARGET_HEAD=aaaaaaaa
export DSH_TEST_LOG="$fixture_root/deploy.log"
export DSH_TEST_STARTED="$fixture_root/started"
export DSH_WEB_HOME="$fixture_root/home"
export PATH="$test_bin:$PATH"

reset_fixture() {
  : >"$DSH_TEST_LOG"
  rm -f "$DSH_TEST_STARTED"
  rm -rf "$DSH_WEB_HOME/profiles"
  unset DSH_TEST_DIRTY_SOURCE DSH_TEST_DIRTY_TARGET DSH_TEST_FAST_FORWARD
  unset DSH_TEST_INSTALL_FAIL DSH_TEST_BAD_DUMP DSH_TEST_LAN_LISTEN
}
assert_not_called() {
  local action=$1
  if grep -Fqx "$action" "$DSH_TEST_LOG"; then
    echo "unexpected deployment action: $action" >&2
    exit 1
  fi
}

reset_fixture
DSH_TEST_DIRTY_SOURCE=1 "$source_root/scripts/dsh-web-local-deploy" >"$fixture_root/dirty.out" 2>"$fixture_root/dirty.err" && {
  echo 'dirty source deployment unexpectedly succeeded' >&2
  exit 1
}
assert_not_called stop
grep -Fq 'source worktree must be clean' "$fixture_root/dirty.err"

reset_fixture
DSH_TEST_FAST_FORWARD=0 "$source_root/scripts/dsh-web-local-deploy" >"$fixture_root/nonff.out" 2>"$fixture_root/nonff.err" && {
  echo 'non-fast-forward deployment unexpectedly succeeded' >&2
  exit 1
}
assert_not_called stop
assert_not_called reset
grep -Fq 'must fast-forward' "$fixture_root/nonff.err"

reset_fixture
DSH_TEST_DIRTY_TARGET=1 "$source_root/scripts/dsh-web-local-deploy" >"$fixture_root/target-dirty.out" 2>"$fixture_root/target-dirty.err" && {
  echo 'dirty service checkout deployment unexpectedly succeeded' >&2
  exit 1
}
assert_not_called stop
grep -Fq 'service checkout must be clean' "$fixture_root/target-dirty.err"

reset_fixture
DSH_TEST_INSTALL_FAIL=1 "$source_root/scripts/dsh-web-local-deploy" >"$fixture_root/install.out" 2>"$fixture_root/install.err" && {
  echo 'failed installation deployment unexpectedly succeeded' >&2
  exit 1
}
grep -Fqx stop "$DSH_TEST_LOG" || {
  echo 'failed installation did not stop the service first' >&2
  cat "$fixture_root/install.err" >&2
  exit 1
}
grep -Fqx install "$DSH_TEST_LOG" || {
  echo 'failed installation did not invoke the installer' >&2
  cat "$fixture_root/install.err" >&2
  exit 1
}
assert_not_called start

reset_fixture
DSH_TEST_BAD_DUMP=1 "$source_root/scripts/dsh-web-local-deploy" >"$fixture_root/dump.out" 2>"$fixture_root/dump.err" && {
  echo 'invalid effective config deployment unexpectedly succeeded' >&2
  exit 1
}
grep -Fqx dump-config "$DSH_TEST_LOG"
assert_not_called start

reset_fixture
DSH_TEST_LAN_LISTEN=1 "$source_root/scripts/dsh-web-local-deploy" >"$fixture_root/lan.out" 2>"$fixture_root/lan.err" && {
  echo 'deployment accepted a non-loopback listener' >&2
  exit 1
}
grep -Fqx start "$DSH_TEST_LOG"
test "$(grep -Fcx stop "$DSH_TEST_LOG")" -eq 2 || {
  echo 'deployment did not stop the service after detecting a non-loopback listener' >&2
  exit 1
}
grep -Fq 'listening beyond loopback' "$fixture_root/lan.err"

reset_fixture
"$source_root/scripts/dsh-web-local-deploy" >"$fixture_root/success.out" 2>"$fixture_root/success.err"
expected=(stop "reset $DSH_TEST_SOURCE_HEAD" submodule-update "nix ./scripts/dsh-web-install-plugins" install "nix ./scripts/dsh-web-runtime" dump-config start)
for ((index = 0; index < ${#expected[@]}; index++)); do
  actual=$(sed -n "$((index + 1))p" "$DSH_TEST_LOG")
  if [[ "$actual" != "${expected[$index]}" ]]; then
    echo "deployment order mismatch at $index: expected '${expected[$index]}', got '$actual'" >&2
    exit 1
  fi
done
grep -Fq 'DSH local Web deployment passed' "$fixture_root/success.out"

reset_fixture
DSH_TEST_SOURCE="$target_root" DSH_TEST_SOURCE_HEAD="$DSH_TEST_TARGET_HEAD" \
  "$target_root/scripts/dsh-web-local-deploy" >"$fixture_root/same.out" 2>"$fixture_root/same.err"
assert_not_called reset
assert_not_called submodule-update
grep -Fqx stop "$DSH_TEST_LOG"
grep -Fqx start "$DSH_TEST_LOG"

if grep -Fq 'dsh-web-start' "$deploy_script"; then
  echo 'local deploy entry invokes the production Web starter' >&2
  exit 1
fi

echo 'local Web deploy flow passed'
