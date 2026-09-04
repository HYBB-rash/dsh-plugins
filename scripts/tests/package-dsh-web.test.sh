#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
fixture_root=$(mktemp -d /tmp/package-dsh-web-test.XXXXXX)
cleanup() { rm -rf -- "$fixture_root"; }
trap cleanup EXIT

source_root="$fixture_root/source"
mkdir -p \
  "$source_root/scripts" \
  "$source_root/config/web" \
  "$source_root/upstream/deepseek-harness/apps/cli/lib" \
  "$source_root/upstream/deepseek-harness/apps/web/dist" \
  "$source_root/upstream/deepseek-harness/node_modules/example" \
  "$source_root/upstream/deepseek-harness/packages/example" \
  "$source_root/upstream/deepseek-harness/vendor/example" \
  "$source_root/upstream/deepseek-harness/.dsh-build" \
  "$source_root/upstream/deepseek-harness/.git" \
  "$fixture_root/forbidden-bin"

if [[ ! -x "$repository_root/scripts/package-dsh-web" ]]; then
  echo 'missing scripts/package-dsh-web' >&2
  exit 1
fi
cp "$repository_root/scripts/package-dsh-web" "$source_root/scripts/package-dsh-web"
for helper in dsh-web-install-plugins dsh-web-runtime; do
  if [[ -f "$repository_root/scripts/$helper" ]]; then
    cp "$repository_root/scripts/$helper" "$source_root/scripts/$helper"
    chmod +x "$source_root/scripts/$helper"
  fi
done

printf 'console.log("dsh")\n' >"$source_root/upstream/deepseek-harness/apps/cli/lib/bin.js"
printf 'web\n' >"$source_root/upstream/deepseek-harness/apps/web/dist/index.html"
printf 'dependency\n' >"$source_root/upstream/deepseek-harness/node_modules/example/index.js"
printf 'workspace\n' >"$source_root/upstream/deepseek-harness/packages/example/index.js"
printf 'vendor\n' >"$source_root/upstream/deepseek-harness/vendor/example/index.js"
printf '{}\n' >"$source_root/upstream/deepseek-harness/.dsh-build/client-build-environment.json"
printf 'git data\n' >"$source_root/upstream/deepseek-harness/.git/config"
printf 'secret\n' >"$source_root/upstream/deepseek-harness/.env"
cat >"$source_root/config/web/portable.patch.yml" <<'EOF'
- id: dsh-cron
  config:
    mode: scheduler
EOF

for specification in \
  'telegram-gateway|@deepseek-ai/dsh-telegram-gateway|0.1.0' \
  'dsh-cron|@deepseek-ai/dsh-cron|0.2.0' \
  'dsh-assistant|@deepseek-ai/dsh-assistant|0.3.0'; do
  IFS='|' read -r directory package_name version <<<"$specification"
  mkdir -p "$source_root/$directory/lib"
  printf '%s\n' "$directory" >"$source_root/$directory/lib/index.js"
  cat >"$source_root/$directory/cordis.patch.yml" <<EOF
- insert:
    - id: $directory
      name: '$package_name'
EOF
  cat >"$source_root/$directory/package.json" <<EOF
{
  "name": "$package_name",
  "version": "$version",
  "files": ["lib/index.js", "cordis.patch.yml"],
  "dsh": {"bundle": {"patch": "./cordis.patch.yml"}}
}
EOF
done

for command in tsc tsdown; do
  cat >"$fixture_root/forbidden-bin/$command" <<EOF
#!/usr/bin/env bash
echo '$command must not run while packaging' >&2
exit 97
EOF
  chmod +x "$fixture_root/forbidden-bin/$command"
done

archive="$fixture_root/dsh-web.tar.gz"
PATH="$fixture_root/forbidden-bin:$PATH" \
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
  dsh-web/plugins/deepseek-ai-dsh-telegram-gateway-0.1.0.tgz \
  dsh-web/plugins/deepseek-ai-dsh-cron-0.2.0.tgz \
  dsh-web/plugins/deepseek-ai-dsh-assistant-0.3.0.tgz \
  dsh-web/config/web.patch.yml \
  dsh-web/bin/install-plugins \
  dsh-web/bin/web; do
  grep -Fxq "$expected" "$fixture_root/files.txt" || {
    echo "archive is missing $expected" >&2
    exit 1
  }
done

if grep -Eq '^dsh-web/(profile|harness/(\.git|\.env)(/|$))' "$fixture_root/files.txt"; then
  echo 'archive contains a prebuilt profile, Harness Git metadata, or .env' >&2
  exit 1
fi

unpacked="$fixture_root/unpacked"
mkdir -p "$unpacked"
tar -xzf "$archive" -C "$unpacked"
for plugin_archive in "$unpacked/dsh-web/plugins"/*.tgz; do
  contents=$(tar -tzf "$plugin_archive")
  for expected in package/package.json package/cordis.patch.yml package/lib/index.js; do
    grep -Fxq "$expected" <<<"$contents" || {
      echo "plugin archive $(basename "$plugin_archive") is missing $expected" >&2
      exit 1
    }
  done
done

mkdir -p "$fixture_root/runtime-bin" "$fixture_root/home"
cat >"$fixture_root/runtime-bin/node" <<'EOF'
#!/usr/bin/env bash
printf 'node' >"$DSH_RUNTIME_TEST_LOG"
printf ' %q' "$@" >>"$DSH_RUNTIME_TEST_LOG"
printf '\n' >>"$DSH_RUNTIME_TEST_LOG"
EOF
chmod +x "$fixture_root/runtime-bin/node"
export DSH_RUNTIME_TEST_LOG="$fixture_root/runtime.log"
PATH="$fixture_root/runtime-bin:$PATH" DSH_HOME="$fixture_root/home" \
  "$unpacked/dsh-web/bin/install-plugins"
grep -Fq 'plugin --profile web add --ignore-scripts' "$DSH_RUNTIME_TEST_LOG"
for plugin_archive in "$unpacked/dsh-web/plugins"/*.tgz; do
  grep -Fq "$plugin_archive" "$DSH_RUNTIME_TEST_LOG"
done
PATH="$fixture_root/runtime-bin:$PATH" DSH_HOME="$fixture_root/home" \
  "$unpacked/dsh-web/bin/web" --host 127.0.0.1 --port 3080 --no-open
grep -Fq -- '--profile web --patch' "$DSH_RUNTIME_TEST_LOG"
grep -Fq "$unpacked/dsh-web/config/web.patch.yml" "$DSH_RUNTIME_TEST_LOG"
grep -Fq -- '--host 127.0.0.1 --port 3080 --no-open' "$DSH_RUNTIME_TEST_LOG"

echo 'package-dsh-web passed'
