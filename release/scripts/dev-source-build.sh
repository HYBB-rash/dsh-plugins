#!/usr/bin/env bash
set -Eeuo pipefail

source_root=/workspace/dsh-plugins
harness_root=/opt/dsh/harness
packages=(telegram-gateway dsh-cron dsh-assistant personal-feed-selector personal-feed x-feed)

test -d "$source_root/.git" -o -f "$source_root/.git"
test -f "$source_root/runtime-package-topology.json"

# Editable package mounts hide the immutable image's prebuilt lib directories.
# Rebuild those outputs for the worktree, but do not repeat the test suite that
# already qualified the shared main image during `dsh build --purpose development`.
for package in "${packages[@]}"; do
  package_root="$harness_root/local-plugins/$package"
  test -f "$package_root/package.json"
  test -d "$package_root/src"
  rm -rf -- "$package_root/lib" "$package_root/tsconfig.tsbuildinfo"
  (
    cd "$package_root"
    "$harness_root/node_modules/.bin/tsc" -b
    "$harness_root/node_modules/.bin/tsdown"
    "$harness_root/node_modules/.bin/tsc" -b
  )
done

printf '%s\n' 'editable source build passed; tests retained at shared main image build'
