#!/usr/bin/env bash
set -euo pipefail
: "${DSH_TEST_PACKAGE:?set to a prepared, credential-free dsh-web package}"
if [[ -e "$DSH_TEST_PACKAGE/production-credentials" ]]; then
  echo 'integration tests require a credential-free package' >&2
  exit 1
fi
work=$(mktemp -d /tmp/dsh-plugin-import.XXXXXX)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
export DSH_HOME="$work/home"
export DSH_WEB_HOME="$DSH_HOME"
"$DSH_TEST_PACKAGE/bin/install"
"$DSH_TEST_PACKAGE/bin/dsh" --profile web --patch "$DSH_TEST_PACKAGE/config/web.patch.yml" --dump-config >"$work/effective.yml"
node - "$DSH_HOME/profiles/web/package.json" "$work/effective.yml" <<'NODE'
const fs = require('node:fs')
const assert = require('node:assert/strict')
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const config = fs.readFileSync(process.argv[3], 'utf8')
for (const name of ['@deepseek-ai/dsh-telegram-gateway', '@deepseek-ai/dsh-cron', '@deepseek-ai/dsh-assistant']) {
  assert.equal(manifest.dsh.profile.bundles.filter(value => value === name).length, 1, name)
}
for (const id of ['telegram-gateway', 'dsh-cron', 'dsh-cron-manager', 'dsh-assistant']) {
  assert.equal(config.split('\n').filter(line => line.trim() === '- id: ' + id).length, 1, id)
}
assert.ok(!manifest.dsh.profile.bundles.includes('@linxin666/dsh-web-all'))
assert.ok(!manifest.dsh.profile.bundles.includes('@linxin666/dsh-perf'))
console.log('official tgz installation and composed Profile passed')
NODE
