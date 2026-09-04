#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
fixture_root=$(mktemp -d /tmp/dsh-web-launcher-test.XXXXXX)
cleanup() { rm -rf -- "$fixture_root"; }
trap cleanup EXIT

mkdir -p \
  "$fixture_root/scripts" \
  "$fixture_root/config/web" \
  "$fixture_root/home/profiles/web" \
  "$fixture_root/upstream/deepseek-harness/node_modules/.bin" \
  "$fixture_root/upstream/deepseek-harness/node_modules/.pnpm/node_modules/@deepseek-ai" \
  "$fixture_root/upstream/deepseek-harness/node_modules/.pnpm/node_modules/@herman" \
  "$fixture_root/test-bin"
cp "$repository_root/scripts/dsh-web" "$fixture_root/scripts/dsh-web"
cp "$repository_root/config/web/cordis.patch.yml" "$fixture_root/config/web/cordis.patch.yml"

for package in telegram-gateway dsh-cron dsh-assistant personal-feed-selector personal-feed x-feed; do
  mkdir -p "$fixture_root/$package"
done

for compiler in tsc tsdown; do
  cat >"$fixture_root/upstream/deepseek-harness/node_modules/.bin/$compiler" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p lib/types
: >lib/index.js
EOF
  chmod +x "$fixture_root/upstream/deepseek-harness/node_modules/.bin/$compiler"
done

cat >"$fixture_root/test-bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm' >>"$DSH_WEB_TEST_LOG"
printf ' %q' "$@" >>"$DSH_WEB_TEST_LOG"
printf '\n' >>"$DSH_WEB_TEST_LOG"
EOF
cat >"$fixture_root/test-bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'node' >>"$DSH_WEB_TEST_LOG"
printf ' %q' "$@" >>"$DSH_WEB_TEST_LOG"
printf '\n' >>"$DSH_WEB_TEST_LOG"
EOF
chmod +x "$fixture_root/test-bin/pnpm" "$fixture_root/test-bin/node"

export DSH_WEB_TEST_LOG="$fixture_root/commands.log"
PATH="$fixture_root/test-bin:$PATH" \
  DSH_WEB_HOME="$fixture_root/home" \
  "$fixture_root/scripts/dsh-web" --host 127.0.0.1 --port 3080 --no-open

for package in telegram-gateway dsh-cron dsh-assistant personal-feed-selector personal-feed x-feed; do
  test -f "$fixture_root/$package/lib/index.js" || {
    echo "launcher did not build $package" >&2
    exit 1
  }
  case "$package" in
    personal-feed-selector|personal-feed|x-feed) scope=@herman ;;
    *) scope=@deepseek-ai ;;
  esac
  test "$(readlink "$fixture_root/upstream/deepseek-harness/node_modules/.pnpm/node_modules/$scope/$package")" = "$fixture_root/$package" || {
    echo "launcher did not link $package into the Harness workspace" >&2
    exit 1
  }
  grep -Fq "file:$fixture_root/$package" "$DSH_WEB_TEST_LOG" || {
    echo "launcher did not install $package into the Web profile" >&2
    exit 1
  }
done

python3 - "$fixture_root/home/profiles/web/cordis.patch.yml" <<'PY'
from pathlib import Path
import re
import sys

config = Path(sys.argv[1]).read_text(encoding="utf-8")
contracts = {
    "Telegram standard Agent preset": r"id: telegram-gateway[\s\S]*?agentPreset: standard",
    "Personal Feed Telegram extension": r"id: telegram-gateway[\s\S]*?modulePath: '@herman/x-feed'",
    "Telegram selector mode": r"id: personal-feed-selector[\s\S]*?mode: telegram",
    "Telegram cron scheduler": r"id: dsh-cron[\s\S]*?mode: scheduler",
    "Telegram assistant delivery": r"id: dsh-assistant[\s\S]*?mode: telegram",
}
for name, pattern in contracts.items():
    if re.search(pattern, config) is None:
        raise SystemExit(f"launcher runtime config is missing {name}")
PY

echo 'dsh-web package composition passed'
