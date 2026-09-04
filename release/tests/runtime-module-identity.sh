#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
checker="$repo_root/release/scripts/check-runtime-module-identity.sh"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

if [[ ! -x "$checker" ]]; then
  echo 'FAIL: runtime module identity checker is missing' >&2
  exit 1
fi

harness_root="$test_root/harness"
mkdir -p "$harness_root/vendor/cordis"

for package in telegram-gateway dsh-cron dsh-assistant personal-feed-selector personal-feed; do
  package_modules="$harness_root/local-plugins/$package/node_modules/@deepseek-ai"
  mkdir -p "$package_modules"
  ln -s "$harness_root/vendor/cordis" "$package_modules/cordis"
done

"$checker" "$harness_root"

wrong_cordis="$test_root/registry-cordis"
mkdir -p "$wrong_cordis"
rm "$harness_root/local-plugins/telegram-gateway/node_modules/@deepseek-ai/cordis"
ln -s "$wrong_cordis" \
  "$harness_root/local-plugins/telegram-gateway/node_modules/@deepseek-ai/cordis"

if "$checker" "$harness_root" >"$test_root/stdout" 2>"$test_root/stderr"; then
  echo 'FAIL: checker accepted a registry Cordis beside the Harness workspace Cordis' >&2
  exit 1
fi

grep -Fq \
  'telegram-gateway resolves @deepseek-ai/cordis outside the Harness workspace' \
  "$test_root/stderr"
