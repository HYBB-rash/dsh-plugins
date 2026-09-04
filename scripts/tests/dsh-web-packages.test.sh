#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
fixture_root=$(mktemp -d /tmp/dsh-web-launcher-test.XXXXXX)
cleanup() { rm -rf -- "$fixture_root"; }
trap cleanup EXIT

mkdir -p \
  "$fixture_root/bin" \
  "$fixture_root/scripts" \
  "$fixture_root/config/web" \
  "$fixture_root/upstream/deepseek-harness/apps/cli/lib" \
  "$fixture_root/upstream/deepseek-harness/node_modules/.bin" \
  "$fixture_root/upstream/deepseek-harness/node_modules/@types/node" \
  "$fixture_root/upstream/deepseek-harness/node_modules/tsdown" \
  "$fixture_root/upstream/deepseek-harness/node_modules/.pnpm/node_modules/@deepseek-ai/cordis" \
  "$fixture_root/config/web/production-credentials/secrets" \
  "$fixture_root/test-bin"
cp "$repository_root/scripts/dsh-web-install-plugins" "$fixture_root/scripts/dsh-web-install-plugins"
cp "$repository_root/scripts/dsh-web-runtime" "$fixture_root/scripts/dsh-web-runtime"
cp "$repository_root/scripts/dsh-web-notify-start-url.mjs" "$fixture_root/scripts/dsh-web-notify-start-url.mjs"
if [[ ! -x "$repository_root/bin/dsh" ]]; then
  echo 'missing executable bin/dsh launcher' >&2
  exit 1
fi
cp "$repository_root/bin/dsh" "$fixture_root/bin/dsh"
cp "$repository_root/config/web/portable.patch.yml" "$fixture_root/config/web/portable.patch.yml"
printf 'console.log("dsh")\n' >"$fixture_root/upstream/deepseek-harness/apps/cli/lib/bin.js"
printf 'private source credentials\n' >"$fixture_root/config/web/production-credentials/.credentials.yaml"
printf 'private source notion token\n' >"$fixture_root/config/web/production-credentials/secrets/notion.token"

declare -A package_names=(
  [telegram-gateway]=@deepseek-ai/dsh-telegram-gateway
  [dsh-cron]=@deepseek-ai/dsh-cron
  [dsh-assistant]=@deepseek-ai/dsh-assistant
  [liangshen]=@deepseek-ai/dsh-liangshen
)
for package in telegram-gateway dsh-cron dsh-assistant liangshen; do
  mkdir -p "$fixture_root/$package"
  printf '{"name":"%s"}\n' "${package_names[$package]}" >"$fixture_root/$package/package.json"
done
printf '{"packageManager":"pnpm@11.7.0"}\n' >"$fixture_root/upstream/deepseek-harness/package.json"

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
for sibling in dsh-telegram-gateway dsh-cron dsh-assistant; do
  if [[ -e "node_modules/@deepseek-ai/$sibling" || -L "node_modules/@deepseek-ai/$sibling" ]]; then
    echo "compiler unexpectedly resolved sibling plugin $sibling" >&2
    exit 45
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
printf 'env CI=%q PWD=%q\n' "${CI-}" "$PWD" >>"$DSH_WEB_TEST_LOG"
printf 'pnpm' >>"$DSH_WEB_TEST_LOG"
printf ' %q' "$@" >>"$DSH_WEB_TEST_LOG"
printf '\n' >>"$DSH_WEB_TEST_LOG"
EOF
cat >"$fixture_root/test-bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == -p ]]; then
  exec "$DSH_WEB_TEST_REAL_NODE" "$@"
fi
if [[ " $* " == *dsh-web-notify-start-url.mjs* ]]; then
  IFS= read -r launch_url
  printf 'notify stdin=%q\n' "$launch_url" >>"$DSH_WEB_TEST_LOG"
  exit "${DSH_WEB_TEST_NOTIFY_STATUS:-0}"
fi
printf 'env DSH_HOME=%q DSH_CWD=%q PWD=%q\n' "$DSH_HOME" "${DSH_CWD-}" "$PWD" >>"$DSH_WEB_TEST_LOG"
printf 'node' >>"$DSH_WEB_TEST_LOG"
printf ' %q' "$@" >>"$DSH_WEB_TEST_LOG"
printf '\n' >>"$DSH_WEB_TEST_LOG"
if [[ "${DSH_WEB_TEST_EMIT_LAUNCH_URL:-}" == 1 && " $* " == *apps/cli/lib/bin.js* ]]; then
  printf '%s\n' 'dsh web: http://127.0.0.1:3080/?token=local-launch-secret'
  printf '%s\n' 'dsh web: http://127.0.0.1:3080/?token=ignored-second-secret'
fi
if [[ " $* " == *'--profile web'* && " $* " == *'--patch'* ]]; then
  printf 'dsh path=%q\n' "$(command -v dsh)" >>"$DSH_WEB_TEST_LOG"
  dsh --version
fi
EOF
chmod +x \
  "$fixture_root/test-bin/pnpm" \
  "$fixture_root/test-bin/node"

export DSH_WEB_TEST_LOG="$fixture_root/commands.log"
export DSH_WEB_TEST_REAL_NODE
DSH_WEB_TEST_REAL_NODE=$(command -v node)
for package in telegram-gateway dsh-cron dsh-assistant liangshen; do
  ln -s "$fixture_root/$package" \
    "$fixture_root/upstream/deepseek-harness/node_modules/.pnpm/node_modules/@deepseek-ai/${package_names[$package]#@deepseek-ai/}"
done
install_status=0
PATH="$fixture_root/test-bin:$PATH" \
  DSH_WEB_HOME="$fixture_root/home" \
  "$fixture_root/scripts/dsh-web-install-plugins" || install_status=$?
if [[ $install_status -ne 0 ]]; then
  echo "source installer failed to expose the complete dependency view" >&2
fi
if [[ $install_status -ne 0 ]]; then
  exit "$install_status"
fi

for package in telegram-gateway dsh-cron dsh-assistant liangshen; do
  test -f "$fixture_root/$package/lib/index.js" || {
    echo "installer did not build $package" >&2
    exit 1
  }
  test "$(readlink "$fixture_root/$package/node_modules")" = "$fixture_root/upstream/deepseek-harness/node_modules/.pnpm/node_modules" || {
    echo "installer did not reuse the Harness virtual dependency view for $package" >&2
    exit 1
  }
  if [[ -e "$fixture_root/upstream/deepseek-harness/node_modules/.pnpm/node_modules/@deepseek-ai/${package_names[$package]#@deepseek-ai/}" \
      || -L "$fixture_root/upstream/deepseek-harness/node_modules/.pnpm/node_modules/@deepseek-ai/${package_names[$package]#@deepseek-ai/}" ]]; then
    echo "installer left a sibling plugin link in the Harness virtual dependency view" >&2
    exit 1
  fi
  grep -Fq "file:$fixture_root/$package" "$DSH_WEB_TEST_LOG" || {
    echo "installer did not add $package to the Web profile" >&2
    exit 1
  }
done

grep -Fq 'env CI=true' "$DSH_WEB_TEST_LOG"
grep -Fq 'pnpm install --frozen-lockfile' "$DSH_WEB_TEST_LOG"
grep -Fq 'pnpm run build' "$DSH_WEB_TEST_LOG"
if grep -F 'pnpm install' "$DSH_WEB_TEST_LOG" | grep -Fq -- '--ignore-scripts'; then
  echo 'source installer bypassed Harness dependency lifecycle scripts' >&2
  exit 1
fi
if [[ -e "$fixture_root/.dsh-plugin-node_modules" ]]; then
  echo 'source installer recreated the retired synthetic dependency tree' >&2
  exit 1
fi
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
mkdir -p "$fixture_root/home/profiles/web/node_modules/@linxin666/dsh-liangshen"
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
grep -F 'plugin --profile web remove' "$DSH_WEB_TEST_LOG" | grep -Fq '@linxin666/dsh-liangshen'
remove_line=$(grep -Fn 'plugin --profile web remove' "$DSH_WEB_TEST_LOG" | cut -d: -f1)
add_line=$(grep -Fn 'plugin --profile web add' "$DSH_WEB_TEST_LOG" | cut -d: -f1)
if [[ "$remove_line" -ge "$add_line" ]]; then
  echo 'source installer did not remove stale local plugin copies before adding them' >&2
  exit 1
fi

blocked_link="$fixture_root/upstream/deepseek-harness/node_modules/.pnpm/node_modules/@deepseek-ai/dsh-cron"
mkdir -p "$blocked_link"
blocked_stderr="$fixture_root/non-symlink.stderr"
if PATH="$fixture_root/test-bin:$PATH" \
  DSH_WEB_HOME="$fixture_root/home" \
  "$fixture_root/scripts/dsh-web-install-plugins" 2>"$blocked_stderr"; then
  echo 'source installer overwrote a non-symlink sibling package entry' >&2
  exit 1
fi
grep -Fq "$blocked_link is not a symlink; refusing to overwrite" "$blocked_stderr"
rm -rf "$blocked_link"

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
grep -Fq "dsh path=$fixture_root/bin/dsh" "$DSH_WEB_TEST_LOG"
grep -Fq "node --expose-internals $fixture_root/upstream/deepseek-harness/apps/cli/lib/bin.js --version" "$DSH_WEB_TEST_LOG"
if grep -Fq -- '--port 5080' "$DSH_WEB_TEST_LOG"; then
  echo 'source Web runtime ignored an explicit port override' >&2
  exit 1
fi
grep -Fq "env DSH_HOME=$fixture_root/home DSH_CWD=$fixture_root/home/workspace PWD=$fixture_root/home/workspace" "$DSH_WEB_TEST_LOG"
test -d "$fixture_root/home/workspace"
if grep -Fq 'notify stdin=' "$DSH_WEB_TEST_LOG"; then
  echo 'Web runtime notified Telegram without an explicit opt-in' >&2
  exit 1
fi
if grep -Fq 'pnpm' "$DSH_WEB_TEST_LOG"; then
  echo 'Web runtime rebuilt or installed packages' >&2
  exit 1
fi

: >"$DSH_WEB_TEST_LOG"
notify_stdout="$fixture_root/notify.stdout"
notify_stderr="$fixture_root/notify.stderr"
notify_status=0
PATH="$fixture_root/test-bin:$PATH" \
  DSH_WEB_HOME="$fixture_root/home" \
  DSH_WEB_NOTIFY_START_URL=1 \
  DSH_WEB_PUBLIC_ORIGIN=http://127.0.0.1:3080 \
  DSH_WEB_TEST_EMIT_LAUNCH_URL=1 \
  DSH_WEB_TEST_NOTIFY_STATUS=9 \
  "$fixture_root/scripts/dsh-web-runtime" --host 127.0.0.1 --port 3080 --no-open \
  >"$notify_stdout" 2>"$notify_stderr" || notify_status=$?
if [[ $notify_status -ne 0 ]]; then
  echo 'Telegram notification failure terminated the Web runtime' >&2
  exit 1
fi
grep -Fq 'dsh web: http://127.0.0.1:3080/?token=local-launch-secret' "$notify_stdout"
test "$(grep -Fc 'notify stdin=http://127.0.0.1:3080/\?token=local-launch-secret' "$DSH_WEB_TEST_LOG")" -eq 1 || {
  echo 'Web runtime did not notify exactly once with its first startup URL' >&2
  exit 1
}
grep -Fq 'dsh web: Telegram startup URL notification failed' "$notify_stderr"

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
