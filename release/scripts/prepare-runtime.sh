#!/usr/bin/env bash
set -Eeuo pipefail

dsh_home="${DSH_HOME:-/home/herman/.dsh}"
template_root="/opt/dsh/harness/local-profiles"
skills_root="/opt/dsh/plugins-src/skills"
automation_instructions="/opt/dsh/release-system/harness-automation-instructions.md"
lock_file="$dsh_home/.container-profile.lock"

mkdir -p "$dsh_home/profiles" "$dsh_home/skills" "$dsh_home/workspace"
test -f "$automation_instructions"

exec 9>"$lock_file"
flock 9

instructions_stage="$dsh_home/.AGENTS.md.next.$$"
install -m 0644 "$automation_instructions" "$instructions_stage"
mv -Tf "$instructions_stage" "$dsh_home/AGENTS.md"

for profile in web telegram telegram-test; do
  template="$template_root/$profile"
  target="$dsh_home/profiles/$profile"
  stage="$dsh_home/profiles/.${profile}.next.$$"
  test -f "$template/package.json"
  test -f "$template/cordis.patch.yml"
  rm -rf -- "$stage"
  mkdir -p "$stage"
  install -m 0644 "$template/package.json" "$stage/package.json"
  install -m 0644 "$template/cordis.patch.yml" "$stage/cordis.patch.yml"
  printf '%s\n' '# dsh container-derived empty profile root' '[]' >"$stage/cordis.yml"
  ln -s "/opt/dsh/harness/local-profiles/$profile/node_modules" "$stage/node_modules"
  if [[ -e "$target" || -L "$target" ]]; then
    rm -rf -- "$target"
  fi
  mv -- "$stage" "$target"
done

# Harness heals this derived fallback on every boot. Never retain links to an
# old release tree across an image switch.
rm -rf -- "$dsh_home/profiles/node_modules"

for skill in explore-opportunity personal-feed personal-task-list; do
  source="$skills_root/$skill"
  target="$dsh_home/skills/$skill"
  if [[ -d "$source" ]]; then
    rm -rf -- "$target"
    ln -s "/opt/dsh/plugins-src/skills/$skill" "$target"
  fi
done

printf 'prepared image=%s dsh_home=%s\n' "${DSH_IMAGE_ID:-unknown}" "$dsh_home"
