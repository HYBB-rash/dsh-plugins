#!/usr/bin/env bash
set -euo pipefail
repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
exec node --test "$repository_root/scripts/tests/npm-runtime.test.mjs"
