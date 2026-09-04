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
  "$fixture_root/upstream/deepseek-harness/node_modules/.pnpm/node_modules/@deepseek-ai" \
  "$fixture_root/test-bin"
cp "$repository_root/scripts/dsh-web-install-plugins" "$fixture_root/scripts/dsh-web-install-plugins"
cp "$repository_root/scripts/dsh-web-runtime" "$fixture_root/scripts/dsh-web-runtime"
cp "$repository_root/config/web/portable.patch.yml" "$fixture_root/config/web/portable.patch.yml"
printf 'console.log("dsh")\n' >"$fixture_root/upstream/deepseek-harness/apps/cli/lib/bin.js"

for package in telegram-gateway dsh-cron dsh-assistant; do
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
  "$fixture_root/scripts/dsh-web-install-plugins"

for package in telegram-gateway dsh-cron dsh-assistant; do
  test -f "$fixture_root/$package/lib/index.js" || {
    echo "installer did not build $package" >&2
    exit 1
  }
  test "$(readlink "$fixture_root/upstream/deepseek-harness/node_modules/.pnpm/node_modules/@deepseek-ai/$package")" = "$fixture_root/$package" || {
    echo "installer did not link $package into the Harness workspace" >&2
    exit 1
  }
  grep -Fq "file:$fixture_root/$package" "$DSH_WEB_TEST_LOG" || {
    echo "installer did not add $package to the Web profile" >&2
    exit 1
  }
done

grep -Fq 'pnpm install --ignore-scripts' "$DSH_WEB_TEST_LOG"
grep -Fq 'pnpm run build' "$DSH_WEB_TEST_LOG"
grep -Fq 'plugin --profile web add --ignore-scripts --force' "$DSH_WEB_TEST_LOG"
if grep -Fq -- '--patch' "$DSH_WEB_TEST_LOG"; then
  echo 'plugin installer also started the Web runtime' >&2
  exit 1
fi

: >"$DSH_WEB_TEST_LOG"
PATH="$fixture_root/test-bin:$PATH" \
  DSH_WEB_HOME="$fixture_root/home" \
  "$fixture_root/scripts/dsh-web-runtime" --host 127.0.0.1 --port 3080 --no-open

grep -Fq -- '--profile web --patch' "$DSH_WEB_TEST_LOG"
grep -Fq "$fixture_root/config/web/portable.patch.yml" "$DSH_WEB_TEST_LOG"
grep -Fq -- '--host 127.0.0.1 --port 3080 --no-open' "$DSH_WEB_TEST_LOG"
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
