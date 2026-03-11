#!/usr/bin/env python3
"""Minimal validator for v2 Brewva skills."""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml


ALLOWED_PROPERTIES = {
    "name",
    "description",
    "dispatch",
    "routing",
    "continuity_required",
    "tools",
    "budget",
    "outputs",
    "output_contracts",
    "consumes",
    "requires",
    "composable_with",
    "max_parallel",
    "stability",
    "cost_hint",
    "effect_level",
    "references",
    "scripts",
    "heuristics",
    "invariants",
    "license",
    "compatibility",
    "source_name",
    "source_category",
    "forked_from",
    "forked_at",
    "tool",
}

STRING_ARRAY_FIELDS = {
    "outputs",
    "consumes",
    "requires",
    "composable_with",
    "references",
    "scripts",
    "heuristics",
    "invariants",
}


def is_overlay_skill(skill_dir: Path) -> bool:
    parts = skill_dir.resolve().parts
    return len(parts) >= 3 and parts[-3:-1] == ("project", "overlays")


def validate_output_contracts(
    frontmatter: dict[str, object], skill_dir: Path
) -> tuple[bool, str | None]:
    outputs = frontmatter.get("outputs")
    output_contracts = frontmatter.get("output_contracts")
    overlay = is_overlay_skill(skill_dir)

    if not isinstance(outputs, list):
        return False, "Field 'outputs' must be an array"

    if output_contracts is None:
        if outputs and not overlay:
            return False, "Missing 'output_contracts' for declared outputs"
        return True, None

    if not isinstance(output_contracts, dict):
        return False, "Field 'output_contracts' must be an object"

    declared_outputs = {item for item in outputs if isinstance(item, str)}
    contract_keys = set(output_contracts.keys())
    if not overlay:
        missing = sorted(declared_outputs - contract_keys)
        if missing:
            return False, f"Field 'output_contracts' is missing contracts for: {', '.join(missing)}"
    unexpected = sorted(name for name in contract_keys if declared_outputs and name not in declared_outputs)
    if unexpected and not overlay:
        return False, f"Field 'output_contracts' contains undeclared outputs: {', '.join(unexpected)}"

    for name, contract in output_contracts.items():
        if not isinstance(name, str) or not name.strip():
            return False, "Field 'output_contracts' must use non-empty string keys"
        if not isinstance(contract, dict):
            return False, f"Field 'output_contracts.{name}' must be an object"
        kind = contract.get("kind")
        if not isinstance(kind, str) or not kind.strip():
            return False, f"Field 'output_contracts.{name}.kind' must be a non-empty string"

    return True, None


def validate_string_array(frontmatter: dict[str, object], key: str) -> tuple[bool, str | None]:
    value = frontmatter.get(key)
    if value is None:
        return True, None
    if not isinstance(value, list):
        return False, f"Field '{key}' must be an array"
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            return False, f"Field '{key}[{index}]' must be a non-empty string"
    return True, None


def validate_skill(skill_path: str | Path) -> tuple[bool, str]:
    """Basic validation of a v2 skill directory."""
    skill_dir = Path(skill_path)
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return False, "SKILL.md not found"

    content = skill_md.read_text(encoding="utf8")
    if not content.startswith("---"):
        return False, "No YAML frontmatter found"

    match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not match:
        return False, "Invalid frontmatter format"

    try:
        frontmatter = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        return False, f"Invalid YAML in frontmatter: {exc}"
    if not isinstance(frontmatter, dict):
        return False, "Frontmatter must be a YAML dictionary"

    unexpected_keys = set(frontmatter.keys()) - ALLOWED_PROPERTIES
    if unexpected_keys:
        return False, (
            f"Unexpected key(s) in SKILL.md frontmatter: {', '.join(sorted(unexpected_keys))}. "
            f"Allowed properties are: {', '.join(sorted(ALLOWED_PROPERTIES))}"
        )

    if "tier" in frontmatter:
        return False, "Frontmatter field 'tier' is not allowed. Category is directory-derived."
    if "category" in frontmatter:
        return False, "Frontmatter field 'category' is not allowed. Category is directory-derived."

    for required_key in ("tools", "budget", "outputs", "consumes"):
        if required_key not in frontmatter:
            return False, f"Missing '{required_key}' in frontmatter"

    name = frontmatter.get("name", skill_dir.name)
    if not isinstance(name, str):
        return False, f"Name must be a string, got {type(name).__name__}"
    name = name.strip()
    if name:
        if not re.fullmatch(r"[a-z0-9-]+", name):
            return False, f"Name '{name}' should be kebab-case (lowercase letters, digits, and hyphens only)"
        if name.startswith("-") or name.endswith("-") or "--" in name:
            return False, f"Name '{name}' cannot start/end with hyphen or contain consecutive hyphens"
        if len(name) > 64:
            return False, f"Name is too long ({len(name)} characters). Maximum is 64 characters."

    description = frontmatter.get("description", "")
    if not isinstance(description, str):
        return False, f"Description must be a string, got {type(description).__name__}"
    description = description.strip()
    if description:
        if "<" in description or ">" in description:
            return False, "Description cannot contain angle brackets (< or >)"
        if len(description) > 1024:
            return False, f"Description is too long ({len(description)} characters). Maximum is 1024 characters."

    tools = frontmatter.get("tools")
    if not isinstance(tools, dict):
        return False, "Field 'tools' must be an object"
    for key in ("required", "optional", "denied"):
        value = tools.get(key)
        if not isinstance(value, list):
            return False, f"Field 'tools.{key}' must be an array"
        for index, item in enumerate(value):
            if not isinstance(item, str) or not item.strip():
                return False, f"Field 'tools.{key}[{index}]' must be a non-empty string"

    budget = frontmatter.get("budget")
    if not isinstance(budget, dict):
        return False, "Field 'budget' must be an object"
    max_tool_calls = budget.get("max_tool_calls")
    if not isinstance(max_tool_calls, (int, float)) or int(max_tool_calls) < 1:
        return False, "Field 'budget.max_tool_calls' must be a number >= 1"
    max_tokens = budget.get("max_tokens")
    if not isinstance(max_tokens, (int, float)) or int(max_tokens) < 1000:
        return False, "Field 'budget.max_tokens' must be a number >= 1000"

    for key in sorted(STRING_ARRAY_FIELDS):
        ok, message = validate_string_array(frontmatter, key)
        if not ok:
            return False, message or f"Invalid '{key}' field"

    ok, message = validate_output_contracts(frontmatter, skill_dir)
    if not ok:
        return False, message or "Invalid 'output_contracts' field"

    dispatch = frontmatter.get("dispatch")
    if dispatch is not None and not isinstance(dispatch, dict):
        return False, "Field 'dispatch' must be an object"
    routing = frontmatter.get("routing")
    if routing is not None and not isinstance(routing, dict):
        return False, "Field 'routing' must be an object"
    effect_level = frontmatter.get("effect_level")
    if effect_level is not None and effect_level not in {"read_only", "execute", "mutation"}:
        return False, "Field 'effect_level' must be one of: read_only | execute | mutation"

    compatibility = frontmatter.get("compatibility", "")
    if compatibility and (not isinstance(compatibility, str) or len(compatibility) > 500):
        return False, "Field 'compatibility' must be a string shorter than 500 characters"

    return True, "Skill is valid!"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>")
        sys.exit(1)
    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)
