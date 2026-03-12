#!/usr/bin/env python3
"""Initialize a latest-generation Brewva skill scaffold."""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path


VALID_CATEGORIES = {"core", "domain", "operator", "meta", "internal", "overlay"}
ROUTABLE_CATEGORIES = {"core", "domain", "operator", "meta"}

SKILL_TEMPLATE = """---
name: {skill_name}
description: "TODO: explain what this skill does and exactly when it should be used."
stability: experimental
intent:
  outputs: []
effects:
  allowed_effects:
{allowed_effects}
resources:
  default_lease:
    max_tool_calls: 40
    max_tokens: 80000
  hard_ceiling:
    max_tool_calls: 60
    max_tokens: 120000
execution_hints:
  preferred_tools: [read]
  fallback_tools: [grep]
consumes: []
requires: []
---

# {skill_title}

## Intent

TODO: state the semantic territory of this skill.

## Trigger

Use this skill when:

- TODO: concrete trigger

## Workflow

### Step 1

TODO: describe the first meaningful action.

## Stop Conditions

- TODO: call out what should stay out of scope

## Anti-Patterns

- TODO: document the common boundary mistakes

## Example

Input: TODO
"""

EXAMPLE_SCRIPT = """#!/usr/bin/env python3
\"\"\"Example helper script for {skill_name}.\"\"\"


def main() -> None:
    print("Replace this helper with a real workflow for {skill_name}.")


if __name__ == "__main__":
    main()
"""

EXAMPLE_REFERENCE = """# Reference For {skill_title}

Use this file for detailed schemas, APIs, or decision tables that should not live in `SKILL.md`.
"""

EXAMPLE_ASSET = """Example asset placeholder for {skill_name}.
Replace this with templates or files the skill should reuse.
"""


def title_case_skill_name(skill_name: str) -> str:
    return " ".join(word.capitalize() for word in skill_name.split("-"))


def resolve_maybe_absolute(path_text: str, base_dir: Path) -> Path:
    normalized = path_text.strip()
    if not normalized:
        return base_dir.resolve()
    if normalized == "~":
        return Path.home().resolve()
    if normalized.startswith("~/"):
        return (Path.home() / normalized[2:]).resolve()
    candidate = Path(normalized)
    if candidate.is_absolute():
        return candidate.resolve()
    return (base_dir / candidate).resolve()


def resolve_global_brewva_root(cwd: Path) -> Path:
    agent_dir = os.environ.get("BREWVA_CODING_AGENT_DIR", "").strip()
    if agent_dir:
        return (resolve_maybe_absolute(agent_dir, cwd) / "..").resolve()
    xdg_config_home = os.environ.get("XDG_CONFIG_HOME", "").strip()
    if xdg_config_home:
        return resolve_maybe_absolute(f"{xdg_config_home}/brewva", cwd)
    return (Path.home() / ".config" / "brewva").resolve()


def category_relative_dir(category: str) -> Path:
    if category == "overlay":
        return Path("project") / "overlays"
    return Path(category)


def resolve_default_skill_parent(cwd: Path, category: str) -> tuple[Path, str]:
    project_brewva_root = (cwd / ".brewva").resolve()
    root = project_brewva_root if project_brewva_root.is_dir() else resolve_global_brewva_root(cwd)
    scope = "project" if project_brewva_root.is_dir() else "global"
    return (root / "skills" / category_relative_dir(category)).resolve(), scope


def resolve_explicit_skill_parent(base_path: Path, category: str) -> Path:
    relative_dir = category_relative_dir(category)
    normalized = base_path.resolve()
    if normalized.name == relative_dir.name and str(normalized).endswith(str(relative_dir)):
        return normalized
    if normalized.name == "skills":
        return (normalized / relative_dir).resolve()
    return (normalized / "skills" / relative_dir).resolve()


def default_allowed_effects(category: str) -> str:
    if category == "operator":
        effects = ["workspace_read", "runtime_observe", "local_exec"]
    else:
        effects = ["workspace_read", "runtime_observe"]
    return "\n".join(f"    - {effect}" for effect in effects)


def validate_skill_name(skill_name: str) -> None:
    if not re.fullmatch(r"[a-z0-9-]+", skill_name):
        raise ValueError("skill name must be kebab-case ([a-z0-9-]+).")
    if "--" in skill_name or skill_name.startswith("-") or skill_name.endswith("-"):
        raise ValueError("skill name cannot start/end with '-' or contain '--'.")


def init_skill(skill_name: str, parent_dir: Path, category: str) -> Path:
    skill_dir = parent_dir / skill_name
    if skill_dir.exists():
        raise FileExistsError(f"Directory already exists: {skill_dir}")

    skill_dir.mkdir(parents=True, exist_ok=False)
    (skill_dir / "scripts").mkdir()
    (skill_dir / "references").mkdir()
    (skill_dir / "assets").mkdir()

    skill_title = title_case_skill_name(skill_name)
    (skill_dir / "SKILL.md").write_text(
        SKILL_TEMPLATE.format(
            skill_name=skill_name,
            skill_title=skill_title,
            allowed_effects=default_allowed_effects(category),
        ),
        encoding="utf8",
    )
    example_script_path = skill_dir / "scripts" / "example.py"
    example_script_path.write_text(EXAMPLE_SCRIPT.format(skill_name=skill_name), encoding="utf8")
    example_script_path.chmod(0o755)
    (skill_dir / "references" / "api_reference.md").write_text(
        EXAMPLE_REFERENCE.format(skill_title=skill_title),
        encoding="utf8",
    )
    (skill_dir / "assets" / "example_asset.txt").write_text(
        EXAMPLE_ASSET.format(skill_name=skill_name),
        encoding="utf8",
    )
    return skill_dir


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Initialize a latest-generation Brewva skill scaffold."
    )
    parser.add_argument("skill_name")
    parser.add_argument(
        "--category",
        default="domain",
        choices=sorted(VALID_CATEGORIES),
        help="Target skill category. Defaults to domain.",
    )
    parser.add_argument(
        "--path",
        help="Optional target root. The script creates a latest-generation skills/<category>/... layout under it.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    skill_name = args.skill_name.strip()
    validate_skill_name(skill_name)
    cwd = Path.cwd()

    if args.path:
        parent_dir = resolve_explicit_skill_parent(resolve_maybe_absolute(args.path, cwd), args.category)
        location_type = "explicit"
    else:
        parent_dir, location_type = resolve_default_skill_parent(cwd, args.category)

    skill_dir = init_skill(skill_name, parent_dir, args.category)
    print(f"Created {location_type} {args.category} skill: {skill_dir}")
    print("Files:")
    print(f"  - {skill_dir / 'SKILL.md'}")
    print(f"  - {skill_dir / 'scripts' / 'example.py'}")
    print(f"  - {skill_dir / 'references' / 'api_reference.md'}")
    print(f"  - {skill_dir / 'assets' / 'example_asset.txt'}")
    if args.category in ROUTABLE_CATEGORIES:
        print(f"Routing scope: {args.category}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Error: {exc}")
        sys.exit(1)
