#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
fixture_root=$(mktemp -d /tmp/dsh-web-launcher-test.XXXXXX)
cleanup() { rm -rf -- "$fixture_root"; }
trap cleanup EXIT

mkdir -p \
  "$fixture_root/scripts" \
  "$fixture_root/config/web" \
  "$fixture_root/upstream/deepseek-harness/apps/cli/lib" \
  "$fixture_root/upstream/deepseek-harness/node_modules/.bin" \
  "$fixture_root/upstream/deepseek-harness/node_modules/@types/node" \
  "$fixture_root/upstream/deepseek-harness/node_modules/tsdown" \
  "$fixture_root/upstream/deepseek-harness/node_modules/.pnpm/node_modules/@deepseek-ai/cordis" \
  "$fixture_root/upstream/deepseek-harness/node_modules/.pnpm/fs-ext@2.1.1/node_modules/fs-ext/build/Release" \
  "$fixture_root/config/web/production-credentials/secrets" \
  "$fixture_root/test-bin"
cp "$repository_root/scripts/dsh-web-install-plugins" "$fixture_root/scripts/dsh-web-install-plugins"
cp "$repository_root/scripts/dsh-web-runtime" "$fixture_root/scripts/dsh-web-runtime"
cp "$repository_root/config/web/portable.patch.yml" "$fixture_root/config/web/portable.patch.yml"
printf 'console.log("dsh")\n' >"$fixture_root/upstream/deepseek-harness/apps/cli/lib/bin.js"
printf 'private source credentials\n' >"$fixture_root/config/web/production-credentials/.credentials.yaml"
printf 'private source notion token\n' >"$fixture_root/config/web/production-credentials/secrets/notion.token"

declare -A package_names=(
  [telegram-gateway]=@deepseek-ai/dsh-telegram-gateway
  [dsh-cron]=@deepseek-ai/dsh-cron
  [dsh-assistant]=@deepseek-ai/dsh-assistant
)
for package in telegram-gateway dsh-cron dsh-assistant; do
  mkdir -p "$fixture_root/$package"
  printf '{"name":"%s"}\n' "${package_names[$package]}" >"$fixture_root/$package/package.json"
done
printf '{"packageManager":"pnpm@11.7.0"}\n' >"$fixture_root/upstream/deepseek-harness/package.json"
fs_ext_root="$fixture_root/upstream/deepseek-harness/node_modules/.pnpm/fs-ext@2.1.1/node_modules/fs-ext"
printf '{"name":"fs-ext","scripts":{"install":"node-gyp configure build"}}\n' >"$fs_ext_root/package.json"

for compiler in tsc tsdown; do
  cat >"$fixture_root/upstream/deepseek-harness/node_modules/.bin/$compiler" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for dependency in @types/node @deepseek-ai/cordis tsdown; do
  if [[ ! -e "node_modules/$dependency" ]]; then
    echo "compiler cannot resolve $dependency from $PWD/node_modules" >&2
    exit 42
  fi
done
mkdir -p lib/types
: >lib/index.js
EOF
  chmod +x "$fixture_root/upstream/deepseek-harness/node_modules/.bin/$compiler"
done

cat >"$fixture_root/test-bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo 'nested Harness build used PATH pnpm 11.22 instead of declared pnpm 11.7.0' >&2
exit 43
EOF
cat >"$fixture_root/test-bin/pnpm-declared" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm' >>"$DSH_WEB_TEST_LOG"
printf ' %q' "$@" >>"$DSH_WEB_TEST_LOG"
printf '\n' >>"$DSH_WEB_TEST_LOG"
if [[ "${1:-}" == run && "${2:-}" == build ]]; then
  pnpm --filter @deepseek-ai/dsh-web-frontend run build
fi
EOF
cat >"$fixture_root/test-bin/corepack" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == pnpm || "${1:-}" == pnpm@11.7.0 ]]; then
  shift
  exec pnpm-declared "$@"
fi
echo "unexpected corepack command: $*" >&2
exit 2
EOF
cat >"$fixture_root/test-bin/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'npm' >>"$DSH_WEB_TEST_LOG"
printf ' %q' "$@" >>"$DSH_WEB_TEST_LOG"
printf '\n' >>"$DSH_WEB_TEST_LOG"
if [[ "$PWD" != "$DSH_WEB_TEST_FS_EXT" || "${1:-}" != run || "${2:-}" != install ]]; then
  echo "unexpected npm command in $PWD: $*" >&2
  exit 44
fi
mkdir -p build/Release
: >build/Release/fs_ext.node
EOF
cat >"$fixture_root/test-bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == -p ]]; then
  exec "$DSH_WEB_TEST_REAL_NODE" "$@"
fi
printf 'env DSH_HOME=%q DSH_CWD=%q PWD=%q\n' "$DSH_HOME" "${DSH_CWD-}" "$PWD" >>"$DSH_WEB_TEST_LOG"
printf 'node' >>"$DSH_WEB_TEST_LOG"
printf ' %q' "$@" >>"$DSH_WEB_TEST_LOG"
printf '\n' >>"$DSH_WEB_TEST_LOG"
EOF
chmod +x \
  "$fixture_root/test-bin/pnpm" \
  "$fixture_root/test-bin/pnpm-declared" \
  "$fixture_root/test-bin/corepack" \
  "$fixture_root/test-bin/npm" \
  "$fixture_root/test-bin/node"

export DSH_WEB_TEST_LOG="$fixture_root/commands.log"
export DSH_WEB_TEST_REAL_NODE DSH_WEB_TEST_FS_EXT
DSH_WEB_TEST_REAL_NODE=$(command -v node)
DSH_WEB_TEST_FS_EXT=$fs_ext_root
install_status=0
PATH="$fixture_root/test-bin:$PATH" \
  DSH_WEB_HOME="$fixture_root/home" \
  "$fixture_root/scripts/dsh-web-install-plugins" || install_status=$?
if [[ $install_status -ne 0 ]]; then
  echo "source installer failed to expose the complete dependency view" >&2
fi
if [[ ! -f "$fixture_root/upstream/deepseek-harness/node_modules/.pnpm/fs-ext@2.1.1/node_modules/fs-ext/build/Release/fs_ext.node" ]]; then
  echo 'source installer did not build the allowlisted fs-ext native addon' >&2
  install_status=1
fi
if [[ $install_status -ne 0 ]]; then
  exit "$install_status"
fi

for package in telegram-gateway dsh-cron dsh-assistant; do
  test -f "$fixture_root/$package/lib/index.js" || {
    echo "installer did not build $package" >&2
    exit 1
  }
  test "$(readlink "$fixture_root/$package/node_modules/@deepseek-ai/${package_names[$package]#@deepseek-ai/}")" = "$fixture_root/$package" || {
    echo "installer did not link ${package_names[$package]} into the plugin build view" >&2
    exit 1
  }
  grep -Fq "file:$fixture_root/$package" "$DSH_WEB_TEST_LOG" || {
    echo "installer did not add $package to the Web profile" >&2
    exit 1
  }
done

grep -Fq 'pnpm install --ignore-scripts' "$DSH_WEB_TEST_LOG"
grep -Fq 'npm run install' "$DSH_WEB_TEST_LOG"
grep -Fq 'pnpm run build' "$DSH_WEB_TEST_LOG"
grep -Fq 'plugin --profile web add --ignore-scripts --force' "$DSH_WEB_TEST_LOG"
if grep -Fq 'plugin --profile web remove' "$DSH_WEB_TEST_LOG"; then
  echo 'source installer tried to remove plugins from a fresh profile' >&2
  exit 1
fi
if [[ -e "$fixture_root/home/.credentials.yaml" || -e "$fixture_root/home/secrets/notion.token" ]]; then
  echo 'source installer copied production credentials into the development profile' >&2
  exit 1
fi
if grep -Fq -- '--patch' "$DSH_WEB_TEST_LOG"; then
  echo 'plugin installer also started the Web runtime' >&2
  exit 1
fi

: >"$DSH_WEB_TEST_LOG"
for package in dsh-telegram-gateway dsh-cron dsh-assistant; do
  mkdir -p "$fixture_root/home/profiles/web/node_modules/@deepseek-ai/$package"
done
PATH="$fixture_root/test-bin:$PATH" \
  DSH_WEB_HOME="$fixture_root/home" \
  "$fixture_root/scripts/dsh-web-install-plugins"

if ! grep -Fq 'plugin --profile web remove @deepseek-ai/dsh-telegram-gateway @deepseek-ai/dsh-cron @deepseek-ai/dsh-assistant' "$DSH_WEB_TEST_LOG"; then
  echo 'source installer did not remove stale local plugin copies before adding them' >&2
  exit 1
fi
grep -Fq 'plugin --profile web add --ignore-scripts --force' "$DSH_WEB_TEST_LOG"
remove_line=$(grep -Fn 'plugin --profile web remove' "$DSH_WEB_TEST_LOG" | cut -d: -f1)
add_line=$(grep -Fn 'plugin --profile web add' "$DSH_WEB_TEST_LOG" | cut -d: -f1)
if [[ "$remove_line" -ge "$add_line" ]]; then
  echo 'source installer did not remove stale local plugin copies before adding them' >&2
  exit 1
fi

: >"$DSH_WEB_TEST_LOG"
PATH="$fixture_root/test-bin:$PATH" \
  DSH_WEB_HOME="$fixture_root/home" \
  "$fixture_root/scripts/dsh-web-runtime"

grep -Fq -- '--port 5080' "$DSH_WEB_TEST_LOG" || {
  echo 'source Web runtime did not default to port 5080' >&2
  exit 1
}

: >"$DSH_WEB_TEST_LOG"
PATH="$fixture_root/test-bin:$PATH" \
  DSH_WEB_HOME="$fixture_root/home" \
  "$fixture_root/scripts/dsh-web-runtime" --dump-config

grep -Fq -- '--dump-config' "$DSH_WEB_TEST_LOG"
if grep -Fq -- '--port 5080' "$DSH_WEB_TEST_LOG"; then
  echo 'source Web runtime passed its default port to a config dump' >&2
  exit 1
fi

: >"$DSH_WEB_TEST_LOG"
PATH="$fixture_root/test-bin:$PATH" \
  DSH_WEB_HOME="$fixture_root/home" \
  "$fixture_root/scripts/dsh-web-runtime" --host 127.0.0.1 --port 3080 --no-open

grep -Fq -- 'node --expose-internals' "$DSH_WEB_TEST_LOG"
grep -Fq -- '--profile web --patch' "$DSH_WEB_TEST_LOG"
grep -Fq "$fixture_root/config/web/portable.patch.yml" "$DSH_WEB_TEST_LOG"
grep -Fq -- '--host 127.0.0.1 --port 3080 --no-open' "$DSH_WEB_TEST_LOG"
if grep -Fq -- '--port 5080' "$DSH_WEB_TEST_LOG"; then
  echo 'source Web runtime ignored an explicit port override' >&2
  exit 1
fi
grep -Fq "env DSH_HOME=$fixture_root/home DSH_CWD=$fixture_root/home/workspace PWD=$fixture_root/home/workspace" "$DSH_WEB_TEST_LOG"
test -d "$fixture_root/home/workspace"
if grep -Fq 'pnpm' "$DSH_WEB_TEST_LOG"; then
  echo 'Web runtime rebuilt or installed packages' >&2
  exit 1
fi

for retired in scripts/dsh-web config/web/cordis.patch.yml; do
  if [[ -e "$repository_root/$retired" ]]; then
    echo "retired Web launcher artifact still exists: $retired" >&2
    exit 1
  fi
done
if grep -Fq 'scripts/dsh-web"' "$repository_root/.vscode/tasks.json"; then
  echo 'VS Code still launches the retired combined Web script' >&2
  exit 1
fi

echo 'dsh-web split development flow passed'
