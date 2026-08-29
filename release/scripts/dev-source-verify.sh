#!/usr/bin/env bash
set -Eeuo pipefail

source_root=/workspace/dsh-plugins
harness_root=/opt/dsh/harness
packages=(telegram-gateway dsh-cron dsh-assistant personal-feed-selector personal-feed x-feed)
requested_package="${1:-all}"

case "$requested_package" in
  all) selected_packages=("${packages[@]}") ;;
  telegram-gateway|dsh-cron|dsh-assistant|personal-feed-selector|personal-feed|x-feed)
    selected_packages=("$requested_package")
    ;;
  *)
    printf '%s\n' "unknown editable-source verification package: $requested_package" >&2
    exit 2
    ;;
esac

test -d "$source_root/.git" -o -f "$source_root/.git"
test -f "$source_root/runtime-package-topology.json"
unset NODE_PATH

# Verify the source currently mounted in the existing toolbox, not the lib
# outputs left by its earlier `dev prepare`.
for package in "${selected_packages[@]}"; do
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

# The fixed local toolbox is intentionally rootless uid 0, which maps to the
# invoking host user.  Keep type/build/bundle in that identity so editable
# mounts retain the local ownership semantics.  The formal image runs its
# tests as 1000:1000, though, and permission tests must keep that meaning.
# Its HOME is a production-snapshot copy, so make an isolated tmpfs home for
# the test phase, hand it only to 1000:1000, then remove it afterwards.
verify_root="$(mktemp -d /tmp/dsh-editable-verify.XXXXXX)"
cleanup() { rm -rf -- "$verify_root"; }
trap cleanup EXIT
mkdir -p "$verify_root/home" "$verify_root/cache/npm" "$verify_root/cache/xdg"
chown -R 1000:1000 "$verify_root"
chmod 700 "$verify_root" "$verify_root/home" "$verify_root/cache" "$verify_root/cache/npm" "$verify_root/cache/xdg"

for package in "${selected_packages[@]}"; do
  package_root="$harness_root/local-plugins/$package"
  if [ -d "$package_root/tests" ]; then
    config=vitest.config.ts
    if [ ! -f "$package_root/$config" ]; then config="$harness_root/vitest.external.config.ts"; fi
    (
      cd "$package_root"
      setpriv --reuid=1000 --regid=1000 --init-groups \
        env HOME="$verify_root/home" npm_config_cache="$verify_root/cache/npm" \
        XDG_CACHE_HOME="$verify_root/cache/xdg" DSH_HARNESS_ROOT="$harness_root" \
        node "$harness_root/node_modules/vitest/vitest.mjs" run \
          --config "$config" --configLoader runner \
          --maxWorkers=1 --no-file-parallelism
    )
  fi
done

if [[ " ${selected_packages[*]} " == *' x-feed '* ]]; then
  python_data="$verify_root/python-data"
  python_pycache="$verify_root/python-pycache"
  mkdir -p "$python_data" "$python_pycache"
  chown -R 1000:1000 "$python_data" "$python_pycache"
  chmod 700 "$python_data" "$python_pycache"
  (
    cd "$harness_root/local-plugins/x-feed/python"
    setpriv --reuid=1000 --regid=1000 --init-groups \
      env HOME="$verify_root/home" npm_config_cache="$verify_root/cache/npm" \
      XDG_CACHE_HOME="$verify_root/cache/xdg" DSH_X_FEED_DATA_DIR="$python_data" \
      PYTHONPYCACHEPREFIX="$python_pycache" PYTHONWARNINGS=ignore \
      bash -c "python3 -m unittest discover -p 'test_x_*.py' && python3 -m unittest test_insight_engine.py"
  )
fi

if [[ "$requested_package" == all ]]; then
  workspace_test_root="$verify_root/workspace-migration"
  mkdir -p "$workspace_test_root" "$verify_root/python-pycache"
  chown -R 1000:1000 "$workspace_test_root" "$verify_root/python-pycache"
  chmod 700 "$workspace_test_root" "$verify_root/python-pycache"
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" PYTHONPYCACHEPREFIX="$verify_root/python-pycache" \
    python3 /opt/dsh/release-system/tests/test_workspace_migration.py
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" PYTHONPYCACHEPREFIX="$verify_root/python-pycache" \
    python3 /opt/dsh/release-system/tests/credential-notion.py
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" PYTHONPYCACHEPREFIX="$verify_root/python-pycache" \
    python3 /opt/dsh/release-system/tests/notion-page-check.py
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" PYTHONPYCACHEPREFIX="$verify_root/python-pycache" \
    python3 /opt/dsh/release-system/tests/notion-automation-entrypoint.py
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" PYTHONPYCACHEPREFIX="$verify_root/python-pycache" \
    python3 /opt/dsh/release-system/tests/harness-notion-automation-probe.py
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" PYTHONPYCACHEPREFIX="$verify_root/python-pycache" \
    python3 /opt/dsh/release-system/tests/harness-notion-automation-runner.py
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" PYTHONPYCACHEPREFIX="$verify_root/python-pycache" \
    python3 /opt/dsh/release-system/tests/harness-notion-automation-bridge.py
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" PYTHONPYCACHEPREFIX="$verify_root/python-pycache" \
    python3 /opt/dsh/release-system/tests/harness-notion-automation-status.py
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" \
    bash /opt/dsh/release-system/tests/harness-notion-automation-command.sh
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" \
    bash /opt/dsh/release-system/tests/engine-lock.sh
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" \
    bash /opt/dsh/release-system/tests/production-operation-lock.sh
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" PYTHONPYCACHEPREFIX="$verify_root/python-pycache" \
    python3 /opt/dsh/release-system/tests/notion-inbox-init.py
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" PYTHONPYCACHEPREFIX="$verify_root/python-pycache" \
    python3 /opt/dsh/release-system/tests/test_scrub_preflight_state.py
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" PYTHONPYCACHEPREFIX="$verify_root/python-pycache" \
    python3 /opt/dsh/release-system/tests/test_workspace_migration_content.py
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" npm_config_cache="$verify_root/cache/npm" \
    XDG_CACHE_HOME="$verify_root/cache/xdg" \
    node --test /opt/dsh/release-system/tests/assistant-cron-health.mjs
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" npm_config_cache="$verify_root/cache/npm" \
    XDG_CACHE_HOME="$verify_root/cache/xdg" \
    node --test /opt/dsh/release-system/tests/fake-notion.mjs
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" npm_config_cache="$verify_root/cache/npm" \
    XDG_CACHE_HOME="$verify_root/cache/xdg" \
    node --test /opt/dsh/release-system/tests/notion-retry-binding.mjs
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" npm_config_cache="$verify_root/cache/npm" \
    XDG_CACHE_HOME="$verify_root/cache/xdg" \
    node --test /opt/dsh/release-system/tests/inspect-cron-reanchor.mjs
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env HOME="$verify_root/home" npm_config_cache="$verify_root/cache/npm" \
    XDG_CACHE_HOME="$verify_root/cache/xdg" NODE_NO_WARNINGS=1 \
    node /opt/dsh/release-system/tests/validate-assistant-state.mjs
fi

printf '%s\n' "editable source verification passed; scope=$requested_package; build-identity=rootless-toolbox-uid-0; test-identity=1000:1000; cache=tmpfs"
