#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)

python3 - "$repository_root" <<'PY'
from __future__ import annotations

import json
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
packages = {
    "telegram-gateway": "@deepseek-ai/dsh-telegram-gateway",
    "dsh-cron": "@deepseek-ai/dsh-cron",
    "dsh-assistant": "@deepseek-ai/dsh-assistant",
}
extra_forbidden = {
    "telegram-gateway": set(),
    "dsh-cron": {"@deepseek-ai/dsh-credentials"},
    "dsh-assistant": {"@deepseek-ai/dsh-credentials"},
}
dependency_sections = (
    "dependencies",
    "peerDependencies",
    "devDependencies",
    "optionalDependencies",
)
source_suffixes = {".ts", ".tsx", ".js", ".mjs", ".cjs"}
artifact_suffixes = {".js", ".mjs", ".cjs", ".ts"}
specifier = re.compile(
    r"(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\b(?:mock|doMock|unstable_mockModule)\s*\()"
    r"\s*['\"]([^'\"]+)['\"]",
    re.MULTILINE,
)

errors: list[str] = []


def is_forbidden_module(
    module: str,
    forbidden: set[str],
    sibling_dirs: set[str],
) -> bool:
    return (
        any(module == name or module.startswith(f"{name}/") for name in forbidden)
        or any(part in sibling_dirs for part in module.split("/"))
    )

for package_dir, package_name in packages.items():
    siblings = {name for name in packages.values() if name != package_name}
    forbidden = siblings | extra_forbidden[package_dir]
    sibling_dirs = {name for name in packages if name != package_dir}
    manifest_path = root / package_dir / "package.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for section in dependency_sections:
        declared = manifest.get(section, {})
        for dependency in sorted(forbidden.intersection(declared)):
            errors.append(f"{manifest_path.relative_to(root)}: {section} declares forbidden dependency {dependency}")

    for area in ("src", "tests"):
        area_path = root / package_dir / area
        if not area_path.exists():
            continue
        for path in area_path.rglob("*"):
            if not path.is_file() or path.suffix not in source_suffixes:
                continue
            text = path.read_text(encoding="utf-8")
            for match in specifier.finditer(text):
                module = match.group(1)
                if is_forbidden_module(module, forbidden, sibling_dirs):
                    errors.append(
                        f"{path.relative_to(root)}: sibling module reference {module!r}"
                    )

    lib_path = root / package_dir / "lib"
    if not lib_path.exists():
        errors.append(f"{lib_path.relative_to(root)}: missing clean-build output")
        continue
    for path in lib_path.rglob("*"):
        if not path.is_file() or path.suffix not in artifact_suffixes:
            continue
        text = path.read_text(encoding="utf-8")
        for dependency in sorted(forbidden):
            if dependency in text:
                errors.append(
                    f"{path.relative_to(root)}: built forbidden dependency reference {dependency!r}"
                )

if errors:
    raise SystemExit("plugin boundary violations:\n- " + "\n- ".join(errors))

print("plugin sibling dependency boundary passed")
PY
