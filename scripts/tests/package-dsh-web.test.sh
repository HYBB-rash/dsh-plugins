#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
fixture_root=$(mktemp -d /tmp/package-dsh-web-test.XXXXXX)
cleanup() { rm -rf -- "$fixture_root"; }
trap cleanup EXIT

source_root="$fixture_root/source"
mkdir -p \
  "$source_root/scripts" \
  "$source_root/upstream/deepseek-harness/apps/cli/lib" \
  "$source_root/upstream/deepseek-harness/apps/web/dist" \
  "$source_root/upstream/deepseek-harness/node_modules/example" \
  "$source_root/upstream/deepseek-harness/packages/example" \
  "$source_root/upstream/deepseek-harness/vendor/example" \
  "$source_root/upstream/deepseek-harness/.dsh-build" \
  "$source_root/upstream/deepseek-harness/.git" \
  "$fixture_root/web-home/profiles/web/node_modules/@deepseek-ai" \
  "$fixture_root/web-home/profiles/web/node_modules/@herman" \
  "$fixture_root/forbidden-bin"

if [[ ! -x "$repository_root/scripts/package-dsh-web" ]]; then
  echo 'missing scripts/package-dsh-web' >&2
  exit 1
fi
cp "$repository_root/scripts/package-dsh-web" "$source_root/scripts/package-dsh-web"

printf 'console.log("dsh")\n' >"$source_root/upstream/deepseek-harness/apps/cli/lib/bin.js"
printf 'web\n' >"$source_root/upstream/deepseek-harness/apps/web/dist/index.html"
printf 'dependency\n' >"$source_root/upstream/deepseek-harness/node_modules/example/index.js"
printf 'workspace\n' >"$source_root/upstream/deepseek-harness/packages/example/index.js"
printf 'vendor\n' >"$source_root/upstream/deepseek-harness/vendor/example/index.js"
printf '{}\n' >"$source_root/upstream/deepseek-harness/.dsh-build/client-build-environment.json"
printf 'git data\n' >"$source_root/upstream/deepseek-harness/.git/config"
printf 'secret\n' >"$source_root/upstream/deepseek-harness/.env"
printf '[]\n' >"$fixture_root/web-home/profiles/web/cordis.patch.yml"

for package in dsh-telegram-gateway dsh-cron dsh-assistant; do
  mkdir -p "$fixture_root/web-home/profiles/web/node_modules/@deepseek-ai/$package/lib"
  printf '%s\n' "$package" >"$fixture_root/web-home/profiles/web/node_modules/@deepseek-ai/$package/lib/index.js"
done
for package in personal-feed-selector personal-feed; do
  mkdir -p "$fixture_root/web-home/profiles/web/node_modules/@herman/$package/lib"
  printf '%s\n' "$package" >"$fixture_root/web-home/profiles/web/node_modules/@herman/$package/lib/index.js"
done
mkdir -p "$fixture_root/web-home/profiles/web/node_modules/@herman/personal-feed/python"
printf 'print("personal-feed")\n' >"$fixture_root/web-home/profiles/web/node_modules/@herman/personal-feed/python/x_personal_feed_observer_cli.py"

for command in pnpm tsc tsdown; do
  cat >"$fixture_root/forbidden-bin/$command" <<EOF
#!/usr/bin/env bash
echo '$command must not run while packaging' >&2
exit 97
EOF
  chmod +x "$fixture_root/forbidden-bin/$command"
done

archive="$fixture_root/dsh-web.tar.gz"
PATH="$fixture_root/forbidden-bin:$PATH" \
  DSH_WEB_HOME="$fixture_root/web-home" \
  "$source_root/scripts/package-dsh-web" "$archive"
test -f "$archive"

tar -tzf "$archive" >"$fixture_root/files.txt"
for expected in \
  dsh-web/harness/apps/cli/lib/bin.js \
  dsh-web/harness/apps/web/dist/index.html \
  dsh-web/harness/node_modules/example/index.js \
  dsh-web/harness/packages/example/index.js \
  dsh-web/harness/vendor/example/index.js \
  dsh-web/harness/.dsh-build/client-build-environment.json \
  dsh-web/profile/web/cordis.patch.yml \
  dsh-web/profile/web/node_modules/@deepseek-ai/dsh-telegram-gateway/lib/index.js \
  dsh-web/profile/web/node_modules/@deepseek-ai/dsh-cron/lib/index.js \
  dsh-web/profile/web/node_modules/@deepseek-ai/dsh-assistant/lib/index.js \
  dsh-web/profile/web/node_modules/@herman/personal-feed-selector/lib/index.js \
  dsh-web/profile/web/node_modules/@herman/personal-feed/lib/index.js \
  dsh-web/profile/web/node_modules/@herman/personal-feed/python/x_personal_feed_observer_cli.py; do
  grep -Fxq "$expected" "$fixture_root/files.txt" || {
    echo "archive is missing $expected" >&2
    exit 1
  }
done

if grep -Eq '^dsh-web/harness/(\.git|\.env)(/|$)' "$fixture_root/files.txt"; then
  echo 'archive contains Harness Git metadata or .env' >&2
  exit 1
fi

echo 'package-dsh-web passed'
