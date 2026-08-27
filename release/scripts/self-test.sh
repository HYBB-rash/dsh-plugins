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
cleanup() { rm -rf -- "$tmp_home"; }
trap cleanup EXIT
DSH_HOME="$tmp_home/.dsh" /opt/dsh/plugins-src/release/scripts/prepare-runtime.sh >/dev/null
DSH_HOME="$tmp_home/.dsh" node /opt/dsh/harness/apps/cli/lib/bin.js --profile web --dump-config >/dev/null
DSH_HOME="$tmp_home/.dsh" node /opt/dsh/harness/apps/cli/lib/bin.js --profile telegram --dump-config >/dev/null
DSH_HOME="$tmp_home/.dsh" node /opt/dsh/harness/apps/cli/lib/bin.js --profile telegram-test --dump-config >/dev/null

printf '%s\n' 'container self-test passed'
