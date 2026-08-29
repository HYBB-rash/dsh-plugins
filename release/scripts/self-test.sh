#!/usr/bin/env bash
set -Eeuo pipefail

test "$(id -u)" = 1000
test "$(id -g)" = 1000
test "$(id -un)" = herman
test "$(id -gn)" = herman
test "$(getent passwd "$(id -u)" | cut -d: -f6)" = /home/herman
test "$HOME" = /home/herman

ssh_known_hosts="$(ssh -G git@github.com 2>/dev/null \
  | awk 'tolower($1) == "userknownhostsfile" { print $2; exit }')"
test "$ssh_known_hosts" = /home/herman/.ssh/known_hosts

test -f /opt/dsh/harness/apps/cli/lib/bin.js
for package in dsh-assistant dsh-cron telegram-gateway x-feed personal-feed-selector personal-feed; do
  test -d "/opt/dsh/harness/local-plugins/$package/lib"
done
test ! -e /opt/dsh/harness/local-plugins/dsh-assistant/lib/migrate-cli.js
test ! -e /opt/dsh/harness/local-plugins/dsh-assistant/lib/historical-recovery.js
test ! -e /opt/dsh/harness/local-plugins/ui-context-compactor
test ! -e /opt/dsh/automations
for script in \
  check-assistant-cron-ready.mjs check-harness-only-state.py \
  check-notion-automation-entrypoint.py check-notion-page.py \
  check-notion-retry-binding.mjs fake-notion.mjs \
  harness-notion-automation-bridge.mjs harness-notion-automation-remote.py \
  inspect-cron-reanchor.mjs migrate-workspace-state.py notion-credential-remote.py \
  reanchor-cron-schedules.mjs run-notion-inbox-init.py \
  scrub-preflight-state.py verify-harness-notion-automation.py \
  verify-workspace-migration-content.py; do
  test -f "/opt/dsh/release-system/scripts/$script"
done
test -f /opt/dsh/release-system/scripts/harness-notion-automation-task.md
test -f /opt/dsh/release-system/scripts/harness-notion-automation.patch.yml
test -f /opt/dsh/release-system/workspace-migrations/harness-only-v1/manifest.json
test -f /opt/dsh/release-system/notion.production.json

for executable in bash bluetoothctl curl gatttool git node openssl python3 rg socat ssh; do
  command -v "$executable" >/dev/null
done

python3 - <<'PY'
import bleak
import paho.mqtt.client
import pexpect
import websocket
PY

python3 - <<'PY'
import json
from pathlib import Path

path = Path('/opt/dsh/release-system/notion.production.json')
value = json.loads(path.read_bytes())
expected = {
    'schemaVersion', 'apiBase', 'apiVersion', 'pageId',
    'credentialPath', 'inboxPath',
}
assert set(value) == expected
assert value['schemaVersion'] == 1
assert value['apiBase'] == 'https://api.notion.com/v1'
assert value['apiVersion'] == '2026-03-11'
assert value['pageId'] == '3b059c119f80803cb8ace3ead7eefc81'
assert value['credentialPath'] == '/home/herman/.dsh/secrets/notion.token'
assert value['inboxPath'] == '/home/herman/.dsh/storages/task-inbox/inbox.md'
PY

entrypoint_help="$("/opt/dsh/release-system/scripts/entrypoint.sh" help)"
for command in \
  workspace-migrate workspace-migration-verify harness-only-health \
  scrub-preflight-state cron-reanchor cron-reanchor-inspect assistant-cron-health \
  notion-page-check notion-automation-health notion-inbox-init \
  notion-credential-install notion-retry-health fake-notion; do
  grep -Fq "$command" <<<"$entrypoint_help"
done

PYTHONDONTWRITEBYTECODE=1 \
  python3 /opt/dsh/release-system/tests/test_workspace_migration.py
PYTHONDONTWRITEBYTECODE=1 \
  python3 /opt/dsh/release-system/tests/credential-notion.py
PYTHONDONTWRITEBYTECODE=1 \
  python3 /opt/dsh/release-system/tests/notion-page-check.py
PYTHONDONTWRITEBYTECODE=1 \
  python3 /opt/dsh/release-system/tests/notion-automation-entrypoint.py
PYTHONDONTWRITEBYTECODE=1 \
  python3 /opt/dsh/release-system/tests/harness-notion-automation-probe.py
PYTHONDONTWRITEBYTECODE=1 \
  python3 /opt/dsh/release-system/tests/harness-notion-automation-runner.py
PYTHONDONTWRITEBYTECODE=1 \
  python3 /opt/dsh/release-system/tests/harness-notion-automation-bridge.py
PYTHONDONTWRITEBYTECODE=1 \
  python3 /opt/dsh/release-system/tests/harness-notion-automation-status.py
bash /opt/dsh/release-system/tests/harness-notion-automation-command.sh
bash /opt/dsh/release-system/tests/engine-lock.sh
bash /opt/dsh/release-system/tests/production-operation-lock.sh
PYTHONDONTWRITEBYTECODE=1 \
  python3 /opt/dsh/release-system/tests/notion-inbox-init.py
PYTHONDONTWRITEBYTECODE=1 \
  python3 /opt/dsh/release-system/tests/test_scrub_preflight_state.py
PYTHONDONTWRITEBYTECODE=1 \
  python3 /opt/dsh/release-system/tests/test_workspace_migration_content.py
PYTHONDONTWRITEBYTECODE=1 \
  python3 /opt/dsh/release-system/scripts/verify-workspace-migration-content.py >/dev/null
node --test /opt/dsh/release-system/tests/assistant-cron-health.mjs
node --test /opt/dsh/release-system/tests/fake-notion.mjs
node --test /opt/dsh/release-system/tests/notion-retry-binding.mjs
node --test /opt/dsh/release-system/tests/inspect-cron-reanchor.mjs
NODE_NO_WARNINGS=1 node /opt/dsh/release-system/tests/validate-assistant-state.mjs
test ! -e /opt/dsh/automations

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
cmp -s \
  /opt/dsh/release-system/harness-automation-instructions.md \
  "$tmp_home/.dsh/AGENTS.md"
rg --fixed-strings '$DSH_HOME/workspace/automations/' "$tmp_home/.dsh/AGENTS.md" >/dev/null
rg --fixed-strings '产品仓库、镜像和 release migration 不安装' "$tmp_home/.dsh/AGENTS.md" >/dev/null
rg --fixed-strings '$DSH_HOME/workspace/MEMORY.md' "$tmp_home/.dsh/AGENTS.md" >/dev/null
if rg --fixed-strings '/opt/dsh/automations' "$tmp_home/.dsh/AGENTS.md"; then
  printf '%s\n' 'workspace instructions still advertise repository-owned automations' >&2
  exit 1
fi
for skill in explore-opportunity personal-feed-selector personal-task-list x-feed; do
  test -L "$tmp_home/.dsh/skills/$skill"
  test "$(readlink "$tmp_home/.dsh/skills/$skill")" = "/opt/dsh/plugins-src/skills/$skill"
done
for profile in web telegram telegram-test; do
  DSH_HOME="$tmp_home/.dsh" node /opt/dsh/harness/apps/cli/lib/bin.js \
    --profile "$profile" --dump-config >"$tmp_home/$profile.config.yml"
done
python3 - "$tmp_home" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
socket_path = "/home/herman/.dsh/storages/dsh-cron/control.sock"

def assistant_block(profile: str) -> str:
    lines = (root / f"{profile}.config.yml").read_text(encoding="utf-8").splitlines()
    try:
        start = lines.index("- id: dsh-assistant")
    except ValueError as error:
        raise SystemExit(f"{profile}: effective dsh-assistant config is missing") from error
    end = next(
        (index for index in range(start + 1, len(lines)) if lines[index].startswith("- id: ")),
        len(lines),
    )
    return "\n".join(lines[start:end])

for profile in ("telegram", "telegram-test"):
    block = assistant_block(profile)
    expected = f"cronControlSocketPath: {socket_path}"
    if block.count(expected) != 1:
        raise SystemExit(f"{profile}: dsh-assistant cron control socket is not exact")

if "cronControlSocketPath:" in assistant_block("web"):
    raise SystemExit("web: dsh-assistant must not receive a cron control socket")
PY

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
