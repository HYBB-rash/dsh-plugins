#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

for retired_path in \
  "$repo_root/personal-feed" \
  "$repo_root/personal-feed-selector" \
  "$repo_root/x-feed" \
  "$repo_root/skills/personal-feed" \
  "$repo_root/skills/personal-feed-selector" \
  "$repo_root/skills/x-feed"; do
  test ! -e "$retired_path"
done

for generic_gateway_contract in \
  "$repo_root/telegram-gateway/src/extensions.ts" \
  "$repo_root/telegram-gateway/tests/extensions.spec.ts" \
  "$repo_root/telegram-gateway/tests/inbound-dispatch.spec.ts" \
  "$repo_root/telegram-gateway/tests/reply-context.spec.ts"; do
  test -f "$generic_gateway_contract"
done

python3 - "$repo_root" <<'PY'
import json
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
forbidden = re.compile(
    r"personal[-_ ]feed|personal-feed-selector|@herman/x-feed|x[-_ ]feed|"
    r"x_personal_feed_observer|DSH_X_FEED|x_feed_",
    re.IGNORECASE,
)

local_packages = {
    path.parent.name
    for path in root.glob("*/package.json")
}
expected_packages = {"dsh-assistant", "dsh-cron", "telegram-gateway"}
assert local_packages == expected_packages, (local_packages, expected_packages)

for profile in ("web", "telegram", "telegram-test"):
    package_path = root / "release" / "profiles" / profile / "package.json"
    package = json.loads(package_path.read_text())
    dependencies = package.get("dependencies", {})
    assert not any(forbidden.search(name) for name in dependencies), (profile, dependencies)
    expected = {"@deepseek-ai/dsh-assistant", "@deepseek-ai/dsh-cron"}
    if profile != "web":
        expected.add("@deepseek-ai/dsh-telegram-gateway")
    assert expected <= dependencies.keys(), (profile, dependencies)

    profile_text = (package_path.parent / "cordis.patch.yml").read_text()
    assert "name: '@deepseek-ai/dsh-assistant'" in profile_text, profile
    assert "name: '@deepseek-ai/dsh-cron'" in profile_text, profile
    if profile != "web":
        assert "name: '@deepseek-ai/dsh-telegram-gateway'" in profile_text, profile

topology_path = root / "runtime-package-topology.json"
topology = json.loads(topology_path.read_text())
release_targets = {
    target["name"]
    for target in topology["targets"]
    if target["kind"] == "release"
}
assert release_targets == {
    "@deepseek-ai/dsh-cron",
    "@deepseek-ai/dsh-telegram-gateway",
}, release_targets
for target in topology["targets"]:
    assert not forbidden.search(target["name"]), target
    assert not any(forbidden.search(consumer) for consumer in target["requiredBy"]), target

scan_roots = [
    root / "README.md",
    root / "README.en.md",
    root / "runtime-package-topology.json",
    root / ".agents" / "achieve-skills" / "dsh-dev" / "SKILL.md",
    root / ".agents" / "skills" / "dsh-web-dev" / "SKILL.md",
    root / "config",
    root / "dsh-assistant",
    root / "dsh-cron",
    root / "scripts",
    root / "skills",
    root / "telegram-gateway",
    root / "release",
]

tracked_paths = subprocess.run(
    [
        "git",
        "-C",
        str(root),
        "ls-files",
        "-z",
        "--",
        *(str(path.relative_to(root)) for path in scan_roots),
    ],
    check=True,
    capture_output=True,
).stdout.split(b"\0")

violations = []
for encoded_path in tracked_paths:
    if not encoded_path:
        continue
    path = root / encoded_path.decode()
    if path == root / "release" / "tests" / "no-personal-feed.sh":
        continue
    try:
        text = path.read_text()
    except UnicodeDecodeError:
        continue
    text = text.replace("no-personal-feed.sh", "retired-component-boundary.sh")
    for line_number, line in enumerate(text.splitlines(), start=1):
        if forbidden.search(line):
            violations.append(f"{path.relative_to(root)}:{line_number}:{line.strip()}")

if violations:
    raise SystemExit("retired Personal Feed responsibility remains:\n" + "\n".join(violations))
PY

printf 'personal feed absence contract passed\n'
