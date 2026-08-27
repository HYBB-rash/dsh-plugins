#!/usr/bin/env bash
set -Eeuo pipefail

source_root=/workspace/dsh-plugins
harness_root=/opt/dsh/harness
packages=(telegram-gateway dsh-cron dsh-assistant personal-feed x-feed ui-context-compactor)

test -d "$source_root/.git" -o -f "$source_root/.git"
test -f "$source_root/runtime-package-topology.json"

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

for package in "${packages[@]}"; do
  package_root="$harness_root/local-plugins/$package"
  if [[ -d "$package_root/tests" ]]; then
    (
      cd "$package_root"
      config=vitest.config.ts
      if [[ ! -f "$config" ]]; then config="$harness_root/vitest.external.config.ts"; fi
      DSH_HARNESS_ROOT="$harness_root" \
        npm_config_cache="/tmp/npm-cache-$package" \
        XDG_CACHE_HOME="/tmp/xdg-cache-$package" \
        setpriv --reuid=1000 --regid=1000 --keep-groups \
          node "$harness_root/node_modules/vitest/vitest.mjs" run \
          --config "$config" --configLoader runner \
          --maxWorkers=1 --no-file-parallelism
    )
  fi
done

python_data="$(mktemp -d)"
cleanup() { rm -rf -- "$python_data"; }
trap cleanup EXIT
chown 1000:1000 "$python_data"
(
  cd "$harness_root/local-plugins/x-feed/python"
  DSH_X_FEED_DATA_DIR="$python_data" PYTHONWARNINGS=ignore \
    setpriv --reuid=1000 --regid=1000 --keep-groups \
      python3 -m unittest discover -p 'test_x_*.py'
)

printf '%s\n' 'editable source full build and test baseline passed'
