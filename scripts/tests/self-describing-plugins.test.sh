#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
harness_root="$repository_root/upstream/deepseek-harness"
fixture_root=$(mktemp -d /tmp/dsh-self-describing-plugins.XXXXXX)
cleanup() { rm -rf -- "$fixture_root"; }
trap cleanup EXIT

profile_dir="$fixture_root/profiles/quick-import"
mkdir -p "$profile_dir/node_modules/@deepseek-ai" "$fixture_root/bin"
cat >"$fixture_root/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$fixture_root/bin/pnpm"
ln -s "$repository_root/telegram-gateway" "$profile_dir/node_modules/@deepseek-ai/dsh-telegram-gateway"
ln -s "$repository_root/dsh-cron" "$profile_dir/node_modules/@deepseek-ai/dsh-cron"
ln -s "$repository_root/dsh-assistant" "$profile_dir/node_modules/@deepseek-ai/dsh-assistant"

cat >"$profile_dir/package.json" <<EOF
{
  "name": "dsh-profile-quick-import-test",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh-telegram-gateway": "file:$repository_root/telegram-gateway",
    "@deepseek-ai/dsh-cron": "file:$repository_root/dsh-cron",
    "@deepseek-ai/dsh-assistant": "file:$repository_root/dsh-assistant"
  },
  "dsh": {
    "profile": {
      "bundles": []
    }
  }
}
EOF
cp "$repository_root/config/web/portable.patch.yml" "$profile_dir/cordis.patch.yml"

(
  cd "$harness_root"
  PATH="$fixture_root/bin:$PATH" DSH_HOME="$fixture_root" node --import tsx apps/cli/src/bin.ts \
    plugin --profile quick-import exec true
)

python3 - "$profile_dir/package.json" <<'PY'
import json
from pathlib import Path
import sys

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
actual = manifest["dsh"]["profile"]["bundles"]
expected = [
    "@deepseek-ai/dsh-telegram-gateway",
    "@deepseek-ai/dsh-cron",
    "@deepseek-ai/dsh-assistant",
]
if actual != expected:
    raise SystemExit(f"installed plugins were not auto-registered: expected {expected!r}, got {actual!r}")
PY

(
  cd "$harness_root"
  DSH_HOME="$fixture_root" node --import tsx apps/cli/src/bin.ts \
    --profile quick-import --dump-config >"$fixture_root/effective.yml"
)

python3 - "$fixture_root/effective.yml" <<'PY'
from pathlib import Path
import re
import sys

config = Path(sys.argv[1]).read_text(encoding="utf-8")
blocks = re.split(r"(?m)(?=^[ \t]*- id:)", config)
for plugin_id in ["telegram-gateway", "dsh-cron", "dsh-cron-manager", "dsh-assistant"]:
    matching = [
        block for block in blocks
        if re.search(rf"(?m)^[ \t]*- id: {re.escape(plugin_id)}$", block)
    ]
    count = len(matching)
    if count != 1:
        raise SystemExit(f"effective profile must contain exactly one {plugin_id} row, got {count}")

expected_modes = {
    "dsh-cron": "scheduler",
    "dsh-cron-manager": "manager",
}
for plugin_id, mode in expected_modes.items():
    block = next(
        block for block in blocks
        if re.search(rf"(?m)^[ \t]*- id: {re.escape(plugin_id)}$", block)
    )
    if re.search(rf"(?m)^[ \t]+mode: {mode}$", block) is None:
        raise SystemExit(f"effective profile must configure {plugin_id} in {mode} mode")

def value_for(plugin_id, key):
    block = next(
        block for block in blocks
        if re.search(rf"(?m)^[ \t]*- id: {re.escape(plugin_id)}$", block)
    )
    match = re.search(rf"(?m)^[ \t]+{re.escape(key)}: (.+)$", block)
    if match is None:
        raise SystemExit(f"effective profile must configure {key} for {plugin_id}")
    return match.group(1)

manager_socket = value_for("dsh-cron-manager", "controlSocketPath")
assistant_socket = value_for("dsh-assistant", "cronControlSocketPath")
expected_socket = "!!js dshHomePath('storages/dsh-cron/control.sock')"
if manager_socket != expected_socket or assistant_socket != expected_socket:
    raise SystemExit(
        "cron manager and assistant must share the one DSH_HOME control socket; "
        f"got manager={manager_socket!r}, assistant={assistant_socket!r}"
    )
PY

echo 'self-describing plugin import passed'
