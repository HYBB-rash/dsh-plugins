#!/usr/bin/env bash
set -Eeuo pipefail

release_root=/opt/dsh/plugins-src/release
harness_bin=/opt/dsh/harness/apps/cli/lib/bin.js

case "${1:-help}" in
  prepare)
    exec "$release_root/scripts/prepare-runtime.sh"
    ;;
  self-test)
    exec "$release_root/scripts/self-test.sh"
    ;;
  validate-state)
    shift
    exec node "$release_root/scripts/validate-state.mjs" "$@"
    ;;
  fake-telegram)
    exec node "$release_root/scripts/fake-telegram.mjs"
    ;;
  web)
    shift
    test -f "${DSH_HOME:-/home/herman/.dsh}/profiles/web/package.json"
    exec node "$harness_bin" web --host 127.0.0.1 --port "${DSH_WEB_PORT:-3080}" --no-open "$@"
    ;;
  telegram)
    shift
    test -f "${DSH_HOME:-/home/herman/.dsh}/profiles/telegram/package.json"
    exec node "$harness_bin" --profile telegram "$@"
    ;;
  telegram-test)
    shift
    test -f "${DSH_HOME:-/home/herman/.dsh}/profiles/telegram-test/package.json"
    exec node "$harness_bin" --profile telegram-test "$@"
    ;;
  lan-proxy)
    exec socat TCP-LISTEN:3080,bind="${DSH_LAN_ADDRESS:-192.168.6.240}",reuseaddr,fork TCP:127.0.0.1:3080
    ;;
  shell)
    shift
    exec bash "$@"
    ;;
  help|--help|-h)
    cat <<'EOF'
Container commands: prepare, self-test, validate-state, fake-telegram,
web, telegram, telegram-test, lan-proxy, shell
EOF
    ;;
  *)
    printf 'Unknown container command: %s\n' "$1" >&2
    exit 2
    ;;
esac
