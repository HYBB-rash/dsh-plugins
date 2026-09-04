#!/usr/bin/env bash
set -Eeuo pipefail

harness_root="${1:-/opt/dsh/harness}"
expected_cordis="$harness_root/vendor/cordis"

if [[ ! -d "$expected_cordis" ]]; then
  echo "Harness workspace Cordis is missing: $expected_cordis" >&2
  exit 1
fi

expected_cordis="$(readlink -f "$expected_cordis")"

for package in telegram-gateway dsh-cron dsh-assistant; do
  package_cordis="$harness_root/local-plugins/$package/node_modules/@deepseek-ai/cordis"
  if [[ ! -e "$package_cordis" ]]; then
    echo "$package is missing @deepseek-ai/cordis" >&2
    exit 1
  fi

  actual_cordis="$(readlink -f "$package_cordis")"
  if [[ "$actual_cordis" != "$expected_cordis" ]]; then
    echo "$package resolves @deepseek-ai/cordis outside the Harness workspace" >&2
    exit 1
  fi
done
