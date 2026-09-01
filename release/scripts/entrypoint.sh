#!/usr/bin/env bash
set -Eeuo pipefail

release_root=/opt/dsh/release-system
harness_bin=/opt/dsh/harness/apps/cli/lib/bin.js
dsh_home="${DSH_HOME:-/home/herman/.dsh}"
workspace_manifest="$release_root/workspace-migrations/harness-only-v1/manifest.json"
product_skills_root=/opt/dsh/plugins-src/skills
notion_public_config="$release_root/notion.production.json"

require_no_args() {
  if [[ "$#" != 0 ]]; then
    printf '%s\n' 'This container command does not accept arguments.' >&2
    exit 2
  fi
}

case "${1:-help}" in
  prepare)
    exec "$release_root/scripts/prepare-runtime.sh"
    ;;
  self-test)
    exec "$release_root/scripts/self-test.sh"
    ;;
  dev-source-build)
    exec "$release_root/scripts/dev-source-build.sh"
    ;;
  validate-state)
    shift
    exec node "$release_root/scripts/validate-state.mjs" "$@"
    ;;
  workspace-migrate)
    shift
    require_no_args "$@"
    exec python3 "$release_root/scripts/migrate-workspace-state.py" \
      --dsh-home "$dsh_home" --manifest "$workspace_manifest" --json
    ;;
  workspace-migration-verify)
    shift
    require_no_args "$@"
    exec python3 "$release_root/scripts/verify-workspace-migration-content.py" \
      --release-root "$release_root" --plugins-root /opt/dsh/plugins-src
    ;;
  harness-only-health)
    shift
    require_no_args "$@"
    exec python3 "$release_root/scripts/check-harness-only-state.py" \
      --dsh-home "$dsh_home" --manifest "$workspace_manifest" \
      --product-skills-root "$product_skills_root" --json
    ;;
  scrub-preflight-state)
    shift
    exec python3 "$release_root/scripts/scrub-preflight-state.py" "$@"
    ;;
  cron-reanchor)
    shift
    exec node "$release_root/scripts/reanchor-cron-schedules.mjs" "$@"
    ;;
  cron-reanchor-inspect)
    shift
    exec node "$release_root/scripts/inspect-cron-reanchor.mjs" "$@"
    ;;
  assistant-cron-health)
    shift
    require_no_args "$@"
    exec node "$release_root/scripts/check-assistant-cron-ready.mjs"
    ;;
  notion-page-check)
    shift
    config="$notion_public_config"
    if [[ "$#" == 2 && "$1" == --config ]]; then
      config="$2"
    elif [[ "$#" != 0 ]]; then
      printf '%s\n' 'notion-page-check accepts only an optional --config path.' >&2
      exit 2
    fi
    exec python3 "$release_root/scripts/check-notion-page.py" \
      --config "$config" --owner-uid "$(id -u)" --owner-gid "$(id -g)"
    ;;
  notion-automation-health)
    shift
    require_no_args "$@"
    probe_sha256="$(sha256sum "$release_root/scripts/verify-harness-notion-automation.py" | awk '{print $1}')"
    exec python3 "$release_root/scripts/check-notion-automation-entrypoint.py" \
      --dsh-home "$dsh_home" --owner-uid "$(id -u)" --owner-gid "$(id -g)" \
      --expected-probe-sha256 "$probe_sha256"
    ;;
  notion-inbox-init)
    shift
    require_no_args "$@"
    probe_sha256="$(sha256sum "$release_root/scripts/verify-harness-notion-automation.py" | awk '{print $1}')"
    exec python3 "$release_root/scripts/run-notion-inbox-init.py" \
      --dsh-home "$dsh_home" --owner-uid "$(id -u)" --owner-gid "$(id -g)" \
      --expected-probe-sha256 "$probe_sha256"
    ;;
  notion-credential-install)
    shift
    replace=()
    if [[ "$#" == 1 && "$1" == --replace ]]; then
      replace=(--replace)
    elif [[ "$#" != 0 ]]; then
      printf '%s\n' 'notion-credential-install accepts only --replace.' >&2
      exit 2
    fi
    test -f "$notion_public_config"
    target="$(jq -er '.credentialPath | select(type == "string" and length > 0)' "$notion_public_config")"
    api_base="$(jq -er '.apiBase | select(type == "string" and length > 0)' "$notion_public_config")"
    page_id="$(jq -er '.pageId | select(type == "string" and length > 0)' "$notion_public_config")"
    api_version="$(jq -er '.apiVersion | select(type == "string" and length > 0)' "$notion_public_config")"
    exec python3 "$release_root/scripts/notion-credential-remote.py" \
      --target "$target" --api-base "$api_base" --page-id "$page_id" \
      --api-version "$api_version" --owner-uid "$(id -u)" --owner-gid "$(id -g)" \
      --state-root /home/herman/.local/share/dsh-container --docker /usr/bin/docker \
      "${replace[@]}"
    ;;
  fake-telegram)
    exec node "$release_root/scripts/fake-telegram.mjs"
    ;;
  fake-notion)
    exec node "$release_root/scripts/fake-notion.mjs"
    ;;
  web)
    shift
    test -f "${DSH_HOME:-/home/herman/.dsh}/profiles/web/package.json"
    exec node --expose-internals "$harness_bin" web --host "${DSH_WEB_HOST:-127.0.0.1}" --port "${DSH_WEB_PORT:-3080}" --no-open "$@"
    ;;
  telegram)
    shift
    test -f "${DSH_HOME:-/home/herman/.dsh}/profiles/telegram/package.json"
    exec node --expose-internals "$harness_bin" --profile telegram "$@"
    ;;
  telegram-test)
    shift
    test -f "${DSH_HOME:-/home/herman/.dsh}/profiles/telegram-test/package.json"
    exec node --expose-internals "$harness_bin" --profile telegram-test "$@"
    ;;
  lan-proxy)
    exec socat TCP-LISTEN:3080,bind="${DSH_LAN_ADDRESS:-192.168.6.240}",reuseaddr,fork TCP:127.0.0.1:3080
    ;;
  toolbox)
    exec sleep infinity
    ;;
  help|--help|-h)
    cat <<'EOF'
Container commands: prepare, self-test, dev-source-build, validate-state,
workspace-migrate, workspace-migration-verify, harness-only-health,
scrub-preflight-state, cron-reanchor, cron-reanchor-inspect,
assistant-cron-health, notion-page-check, notion-automation-health, notion-inbox-init,
notion-credential-install,
fake-telegram, fake-notion, web, telegram, telegram-test, lan-proxy, toolbox
EOF
    ;;
  *)
    printf 'Unknown container command: %s\n' "$1" >&2
    exit 2
    ;;
esac
