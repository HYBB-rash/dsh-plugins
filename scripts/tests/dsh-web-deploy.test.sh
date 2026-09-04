#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
fixture_root=$(mktemp -d /tmp/dsh-web-deploy-test.XXXXXX)
cleanup() { rm -rf -- "$fixture_root"; }
trap cleanup EXIT

# Deployment must package once, upload the secret archive plus checksum and the
# byte-identical remote starter, and must not execute that starter remotely.
source_root="$fixture_root/source"
remote_root="$fixture_root/remote"
mkdir -p "$source_root/scripts" "$fixture_root/deploy-bin" "$remote_root"
cp "$repository_root/scripts/dsh-web-deploy" "$source_root/scripts/dsh-web-deploy"
cp "$repository_root/scripts/dsh-web-start" "$source_root/scripts/dsh-web-start"
chmod +x "$source_root/scripts/dsh-web-deploy" "$source_root/scripts/dsh-web-start"
cat >"$source_root/scripts/package-dsh-web" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'secret archive fixture\n' >"$1"
chmod 0600 "$1"
printf '%s\n' "$1" >"$DSH_DEPLOY_PACKAGE_LOG"
EOF
chmod +x "$source_root/scripts/package-dsh-web"
cat >"$fixture_root/deploy-bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'ssh' >>"$DSH_DEPLOY_COMMAND_LOG"
printf ' %q' "$@" >>"$DSH_DEPLOY_COMMAND_LOG"
printf '\n' >>"$DSH_DEPLOY_COMMAND_LOG"
EOF
cat >"$fixture_root/deploy-bin/scp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'scp' >>"$DSH_DEPLOY_COMMAND_LOG"
printf ' %q' "$@" >>"$DSH_DEPLOY_COMMAND_LOG"
printf '\n' >>"$DSH_DEPLOY_COMMAND_LOG"
args=("$@")
source=${args[${#args[@]}-2]}
destination=${args[${#args[@]}-1]}
name=${destination##*/}
cp -p "$source" "$DSH_DEPLOY_FAKE_REMOTE/$name"
EOF
chmod +x "$fixture_root/deploy-bin/ssh" "$fixture_root/deploy-bin/scp"
export DSH_DEPLOY_PACKAGE_LOG="$fixture_root/package.log"
export DSH_DEPLOY_COMMAND_LOG="$fixture_root/commands.log"
export DSH_DEPLOY_FAKE_REMOTE="$remote_root"
PATH="$fixture_root/deploy-bin:$PATH" \
  DSH_WEB_DEPLOY_TARGET=fixture.invalid \
  DSH_WEB_REMOTE_ROOT=/home/herman/.local/share/dsh-web-package \
  "$source_root/scripts/dsh-web-deploy" >"$fixture_root/deploy.out"

test -s "$DSH_DEPLOY_PACKAGE_LOG"
test "$(wc -l <"$DSH_DEPLOY_PACKAGE_LOG")" -eq 1
cmp "$source_root/scripts/dsh-web-start" "$remote_root/dsh-web-start"
test "$(stat -c '%a' "$remote_root/dsh-web.tar.gz")" = 600
(
  cd "$remote_root"
  sha256sum -c dsh-web.tar.gz.sha256
)
grep -Fq 'fixture.invalid:/home/herman/.local/share/dsh-web-package/dsh-web.tar.gz' "$DSH_DEPLOY_COMMAND_LOG"
grep -Fq 'fixture.invalid:/home/herman/.local/share/dsh-web-package/dsh-web-start' "$DSH_DEPLOY_COMMAND_LOG"
if grep -Eq 'ssh .*dsh-web-start' "$DSH_DEPLOY_COMMAND_LOG"; then
  echo 'deployment executed the remote start script' >&2
  exit 1
fi

# The uploaded starter must verify and unpack the archive, install into the
# external DSH_HOME, then run the packaged runtime without rebuilding.
start_root="$fixture_root/start-root"
package_tree="$fixture_root/package-tree/dsh-web"
home="$fixture_root/home"
mkdir -p "$package_tree/bin" "$package_tree/harness" "$home/workspace" "$fixture_root/start-bin"
cat >"$package_tree/harness/package.json" <<'EOF'
{"packageManager":"pnpm@11.7.0"}
EOF
cat >"$package_tree/bin/install-plugins" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "$DSH_HOME" = "$DSH_START_EXPECTED_HOME"
command -v pnpm >/dev/null
pnpm --version >/dev/null
printf 'install DSH_HOME=%s\n' "$DSH_HOME" >>"$DSH_START_LOG"
EOF
cat >"$package_tree/bin/web" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "$DSH_HOME" = "$DSH_START_EXPECTED_HOME"
test "$DSH_CWD" = "$DSH_HOME/workspace"
printf 'web' >>"$DSH_START_LOG"
printf ' %q' "$@" >>"$DSH_START_LOG"
printf '\n' >>"$DSH_START_LOG"
EOF
chmod +x "$package_tree/bin/install-plugins" "$package_tree/bin/web"
mkdir -p "$start_root"
tar -czf "$start_root/dsh-web.tar.gz" -C "$fixture_root/package-tree" dsh-web
(
  cd "$start_root"
  sha256sum dsh-web.tar.gz >dsh-web.tar.gz.sha256
)
cp "$repository_root/scripts/dsh-web-start" "$start_root/dsh-web-start"
chmod +x "$start_root/dsh-web-start"
cat >"$fixture_root/start-bin/corepack" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} != pack || ${2:-} != pnpm@11.7.0 || ${3:-} != -o || -z ${4:-} ]]; then
  echo 'corepack must package pinned pnpm instead of executing it' >&2
  exit 88
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/pnpm/11.7.0/bin"
cat >"$tmp/pnpm/11.7.0/bin/pnpm.cjs" <<'JS'
const fs = require('node:fs')
fs.appendFileSync(process.env.DSH_START_LOG, `node-pnpm ${process.argv.slice(2).join(' ')}\n`)
JS
tar -czf "$4" -C "$tmp" pnpm
EOF
chmod +x "$fixture_root/start-bin/corepack"
export DSH_START_LOG="$fixture_root/start.log"
export DSH_START_EXPECTED_HOME="$home"
PATH="$fixture_root/start-bin:$PATH" \
  DSH_HOME="$home" \
  DSH_WEB_PACKAGE_ROOT="$start_root" \
  DSH_WEB_PNPM=definitely-missing-pnpm \
  "$start_root/dsh-web-start"

grep -Fq 'node-pnpm --version' "$DSH_START_LOG"
grep -Fxq "install DSH_HOME=$home" "$DSH_START_LOG"
grep -Fq 'web --host 127.0.0.1 --port 3080 --no-open' "$DSH_START_LOG"
test -L "$start_root/current"
test -x "$start_root/current/bin/web"
if grep -Fq 'package-dsh-web' "$DSH_START_LOG"; then
  echo 'remote starter rebuilt the package' >&2
  exit 1
fi

# A host without pnpm or corepack must fail before unpacking or installation.
missing_root="$fixture_root/missing-tool-root"
mkdir -p "$missing_root"
cp "$start_root/dsh-web.tar.gz" "$start_root/dsh-web.tar.gz.sha256" "$missing_root/"
cp "$repository_root/scripts/dsh-web-start" "$missing_root/dsh-web-start"
if DSH_HOME="$fixture_root/missing-home" \
  DSH_WEB_PACKAGE_ROOT="$missing_root" \
  DSH_WEB_PNPM=definitely-missing-pnpm \
  DSH_WEB_COREPACK=definitely-missing-corepack \
  "$missing_root/dsh-web-start" >"$fixture_root/missing.out" 2>"$fixture_root/missing.err"; then
  echo 'remote starter succeeded without pnpm/corepack' >&2
  exit 1
fi
grep -Fq 'pnpm' "$fixture_root/missing.err"
test ! -e "$missing_root/current"

echo 'dsh-web deployment flow passed'
