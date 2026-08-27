#!/usr/bin/env bash
set -Eeuo pipefail

IFS=$'\n\t'

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_home="${1:?temporary DSH_HOME is required}"
module_root="${2:?read-only profile node_modules root is required}"
credentials_source="${3:?explicit credentials source is required}"

[[ "$temporary_home" != / && "$temporary_home" != "$HOME" ]] || {
  printf 'refusing broad temporary DSH_HOME target\n' >&2
  exit 2
}
[[ -d "$module_root" ]] || {
  printf 'module root is not a directory: %s\n' "$module_root" >&2
  exit 2
}
[[ -f "$credentials_source" && ! -L "$credentials_source" ]] || {
  printf 'credentials source must be a regular non-symlink file: %s\n' "$credentials_source" >&2
  exit 2
}
[[ "$(stat -c '%u' "$credentials_source")" == "$(id -u)" ]] || {
  printf 'credentials source must be owned by the invoking user\n' >&2
  exit 2
}
credentials_mode="$(stat -c '%a' "$credentials_source")"
(( (8#$credentials_mode & 8#077) == 0 )) || {
  printf 'credentials source must not grant group or other access\n' >&2
  exit 2
}
if [[ -e "$temporary_home" ]]; then
  [[ -d "$temporary_home" ]] || {
    printf 'temporary DSH_HOME exists but is not a directory: %s\n' "$temporary_home" >&2
    exit 2
  }
  [[ -z "$(find "$temporary_home" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    printf 'temporary DSH_HOME must be empty: %s\n' "$temporary_home" >&2
    exit 2
  }
fi

profile_dir="$temporary_home/profiles/telegram"
mkdir -p -m 700 "$profile_dir"
mkdir -p -m 700 "$temporary_home/storages/telegram"
install -m 644 "$script_dir/cordis.patch.yml" "$profile_dir/cordis.patch.yml"
install -m 600 "$credentials_source" "$temporary_home/.credentials.yaml"
cat >"$profile_dir/package.json" <<'JSON'
{
  "name": "dsh-profile-context-manager-telegram-canary",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base"]
    }
  }
}
JSON
cat >"$profile_dir/pnpm-workspace.yaml" <<'YAML'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
YAML
ln -s "$(readlink -f "$module_root")" "$profile_dir/node_modules"
chmod 700 "$temporary_home" "$temporary_home/profiles" "$profile_dir"

printf '%s\n' "$profile_dir"
