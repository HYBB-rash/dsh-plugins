#!/usr/bin/env bash
set -Eeuo pipefail

test "$(id -u)" = 1000
test "$(id -g)" = 1000
test -f /opt/dsh/harness/apps/cli/lib/bin.js
for package in dsh-assistant dsh-cron telegram-gateway ui-context-compactor x-feed personal-feed; do
  test -d "/opt/dsh/harness/local-plugins/$package/lib"
done

for executable in bash bluetoothctl curl git node openssl python3 rg socat ssh; do
  command -v "$executable" >/dev/null
done

python3 - <<'PY'
import bleak
import paho.mqtt.client
import websocket
PY

if rg -n 'link:/home/herman|/home/herman/Documents/Codex/.*/deepseek-harness|/home/herman/Projects/dsh-plugins' \
  /opt/dsh/harness/local-profiles; then
  printf '%s\n' 'profile contains a forbidden host source link' >&2
  exit 1
fi

tmp_home="$(mktemp -d)"
web_pid=""
cleanup() {
  if [[ -n "$web_pid" ]]; then kill "$web_pid" 2>/dev/null || true; fi
  rm -rf -- "$tmp_home"
}
trap cleanup EXIT
DSH_HOME="$tmp_home/.dsh" /opt/dsh/release-system/scripts/prepare-runtime.sh >/dev/null
DSH_HOME="$tmp_home/.dsh" node /opt/dsh/harness/apps/cli/lib/bin.js --profile web --dump-config >/dev/null
DSH_HOME="$tmp_home/.dsh" node /opt/dsh/harness/apps/cli/lib/bin.js --profile telegram --dump-config >/dev/null
DSH_HOME="$tmp_home/.dsh" node /opt/dsh/harness/apps/cli/lib/bin.js --profile telegram-test --dump-config >/dev/null

cat >"$tmp_home/.dsh/.credentials.yaml" <<'EOF'
version: 1
refs:
  DEEPSEEK_API_KEY: test-key
  TELEGRAM_BOT_TOKEN: test-token
  TELEGRAM_ALLOWED_CHAT_ID: "1"
EOF
chmod 600 "$tmp_home/.dsh/.credentials.yaml"
DSH_HOME="$tmp_home/.dsh" DSH_CWD="$tmp_home/.dsh/workspace" \
  node --expose-internals /opt/dsh/harness/apps/cli/lib/bin.js web \
    --host 127.0.0.1 --port 13081 --no-open >"$tmp_home/web.log" 2>&1 &
web_pid="$!"
web_ready=false
for _ in $(seq 1 20); do
  if curl --fail --silent --max-time 1 http://127.0.0.1:13081/ >/dev/null; then
    web_ready=true
    break
  fi
  if ! kill -0 "$web_pid" 2>/dev/null; then break; fi
  sleep 0.25
done
if [[ "$web_ready" != true ]]; then
  cat "$tmp_home/web.log" >&2
  printf '%s\n' 'real Web profile failed to boot' >&2
  exit 1
fi
kill "$web_pid"
wait "$web_pid" 2>/dev/null || true
web_pid=""

if touch /opt/dsh/.write-probe 2>/dev/null; then
  rm -f -- /opt/dsh/.write-probe
  printf '%s\n' '/opt/dsh unexpectedly writable' >&2
  exit 1
fi

printf '%s\n' 'container self-test passed'
