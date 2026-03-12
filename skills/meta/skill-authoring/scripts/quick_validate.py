#!/usr/bin/env python3
"""Minimal validator for latest-generation Brewva skills."""

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
    "intent",
    "effects",
    "resources",
    "execution_hints",
    "consumes",
    "requires",
    "composable_with",
    "stability",
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
    "consumes",
    "requires",
    "composable_with",
    "references",
    "scripts",
    "heuristics",
    "invariants",
}

EFFECT_CLASSES = {
    "workspace_read",
    "workspace_write",
    "local_exec",
    "runtime_observe",
    "external_network",
    "external_side_effect",
    "schedule_mutation",
    "memory_write",
}
COST_HINTS = {"low", "medium", "high"}
VERIFICATION_LEVELS = {"quick", "standard", "strict"}
OUTPUT_CONTRACT_KINDS = {"text", "enum", "json"}


def is_overlay_skill(skill_dir: Path) -> bool:
    parts = skill_dir.resolve().parts
    return len(parts) >= 3 and parts[-3:-1] == ("project", "overlays")


def validate_string_array_value(value: object, label: str) -> tuple[bool, str | None]:
    if not isinstance(value, list):
        return False, f"Field '{label}' must be an array"
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            return False, f"Field '{label}[{index}]' must be a non-empty string"
    return True, None


def validate_string_array(frontmatter: dict[str, object], key: str) -> tuple[bool, str | None]:
    value = frontmatter.get(key)
    if value is None:
        return True, None
    return validate_string_array_value(value, key)


def validate_positive_number(
    value: object, label: str, minimum: int
) -> tuple[bool, str | None]:
    if not isinstance(value, (int, float)) or int(value) < minimum:
        return False, f"Field '{label}' must be a number >= {minimum}"
    return True, None


def validate_effect_array(
    effects: dict[str, object], key: str
) -> tuple[bool, str | None]:
    value = effects.get(key)
    if value is None:
        return True, None
    ok, message = validate_string_array_value(value, f"effects.{key}")
    if not ok:
        return ok, message
    for effect in value:
        if effect not in EFFECT_CLASSES:
            return (
                False,
                f"Field 'effects.{key}' contains unsupported effect '{effect}'",
            )
    return True, None


def validate_budget_object(
    value: object, label: str
) -> tuple[bool, str | None]:
    if not isinstance(value, dict):
        return False, f"Field '{label}' must be an object"

    recognized = 0
    for key, minimum in (
        ("max_tool_calls", 1),
        ("max_tokens", 1000),
        ("max_parallel", 1),
    ):
        if key not in value:
            continue
        recognized += 1
        ok, message = validate_positive_number(value[key], f"{label}.{key}", minimum)
        if not ok:
            return ok, message

    if recognized == 0:
        return (
            False,
            f"Field '{label}' must declare at least one of: max_tool_calls, max_tokens, max_parallel",
        )
    return True, None


def validate_output_contracts(
    intent: dict[str, object], skill_dir: Path
) -> tuple[bool, str | None]:
    overlay = is_overlay_skill(skill_dir)
    outputs = intent.get("outputs")

    if outputs is None:
        if overlay:
            return True, None
        return False, "Missing 'intent.outputs' in frontmatter"

    ok, message = validate_string_array_value(outputs, "intent.outputs")
    if not ok:
        return ok, message

    output_contracts = intent.get("output_contracts")
    if output_contracts is None:
        if outputs and not overlay:
            return False, "Missing 'intent.output_contracts' for declared outputs"
        return True, None

    if not isinstance(output_contracts, dict):
        return False, "Field 'intent.output_contracts' must be an object"

    declared_outputs = {item for item in outputs if isinstance(item, str)}
    contract_keys = set(output_contracts.keys())
    if not overlay:
        missing = sorted(declared_outputs - contract_keys)
        if missing:
            return (
                False,
                "Field 'intent.output_contracts' is missing contracts for: "
                + ", ".join(missing),
            )
    unexpected = sorted(
        name for name in contract_keys if declared_outputs and name not in declared_outputs
    )
    if unexpected and not overlay:
        return (
            False,
            "Field 'intent.output_contracts' contains undeclared outputs: "
            + ", ".join(unexpected),
        )

    for name, contract in output_contracts.items():
        if not isinstance(name, str) or not name.strip():
            return False, "Field 'intent.output_contracts' must use non-empty string keys"
        if not isinstance(contract, dict):
            return False, f"Field 'intent.output_contracts.{name}' must be an object"
        kind = contract.get("kind")
        if kind not in OUTPUT_CONTRACT_KINDS:
            return (
                False,
                f"Field 'intent.output_contracts.{name}.kind' must be one of: text | enum | json",
            )
        if kind == "text":
            for key in ("min_words", "min_length"):
                if key in contract:
                    ok, message = validate_positive_number(
                        contract[key], f"intent.output_contracts.{name}.{key}", 1
                    )
                    if not ok:
                        return ok, message
        elif kind == "enum":
            values = contract.get("values")
            ok, message = validate_string_array_value(
                values, f"intent.output_contracts.{name}.values"
            )
            if not ok:
                return ok, message
            if "case_sensitive" in contract and not isinstance(
                contract["case_sensitive"], bool
            ):
                return (
                    False,
                    f"Field 'intent.output_contracts.{name}.case_sensitive' must be a boolean",
                )
        elif kind == "json":
            for key in ("min_keys", "min_items"):
                if key in contract:
                    ok, message = validate_positive_number(
                        contract[key], f"intent.output_contracts.{name}.{key}", 1
                    )
                    if not ok:
                        return ok, message

    return True, None


def validate_intent(
    frontmatter: dict[str, object], skill_dir: Path
) -> tuple[bool, str | None]:
    overlay = is_overlay_skill(skill_dir)
    intent = frontmatter.get("intent")
    if intent is None:
        if overlay:
            return True, None
        return False, "Missing 'intent' in frontmatter"
    if not isinstance(intent, dict):
        return False, "Field 'intent' must be an object"

    ok, message = validate_output_contracts(intent, skill_dir)
    if not ok:
        return ok, message

    completion_definition = intent.get("completion_definition")
    if completion_definition is not None:
        if not isinstance(completion_definition, dict):
            return False, "Field 'intent.completion_definition' must be an object"
        verification_level = completion_definition.get("verification_level")
        if (
            verification_level is not None
            and verification_level not in VERIFICATION_LEVELS
        ):
            return (
                False,
                "Field 'intent.completion_definition.verification_level' must be one of: quick | standard | strict",
            )
        ok, message = validate_string_array(
            completion_definition, "required_evidence_kinds"
        )
        if not ok:
            return False, message.replace(
                "Field 'required_evidence_kinds'",
                "Field 'intent.completion_definition.required_evidence_kinds'",
            )

    return True, None


def validate_effects(
    frontmatter: dict[str, object], skill_dir: Path
) -> tuple[bool, str | None]:
    overlay = is_overlay_skill(skill_dir)
    effects = frontmatter.get("effects")
    if effects is None:
        if overlay:
            return True, None
        return False, "Missing 'effects' in frontmatter"
    if not isinstance(effects, dict):
        return False, "Field 'effects' must be an object"

    if "effect_level" in effects:
        return False, "Field 'effects.effect_level' has been removed; declare 'effects.allowed_effects' instead"
    if "rollback_required" in effects:
        return False, "Field 'effects.rollback_required' has been removed from the stable contract surface"
    if "approval_required" in effects:
        return False, "Field 'effects.approval_required' has been removed from the stable contract surface"

    if "allowed_effects" not in effects and not overlay:
        return False, "Missing 'effects.allowed_effects' in frontmatter"

    for key in ("allowed_effects", "denied_effects"):
        ok, message = validate_effect_array(effects, key)
        if not ok:
            return ok, message

    return True, None


def validate_resources(
    frontmatter: dict[str, object], skill_dir: Path
) -> tuple[bool, str | None]:
    overlay = is_overlay_skill(skill_dir)
    resources = frontmatter.get("resources")
    if resources is None:
        if overlay:
            return True, None
        return False, "Missing 'resources' in frontmatter"
    if not isinstance(resources, dict):
        return False, "Field 'resources' must be an object"

    default_lease = resources.get("default_lease")
    if default_lease is None:
        if not overlay:
            return False, "Missing 'resources.default_lease' in frontmatter"
    else:
        ok, message = validate_budget_object(default_lease, "resources.default_lease")
        if not ok:
            return ok, message

    hard_ceiling = resources.get("hard_ceiling")
    if hard_ceiling is None:
        if not overlay:
            return False, "Missing 'resources.hard_ceiling' in frontmatter"
    else:
        ok, message = validate_budget_object(hard_ceiling, "resources.hard_ceiling")
        if not ok:
            return ok, message

    if isinstance(default_lease, dict) and isinstance(hard_ceiling, dict):
        for key in ("max_tool_calls", "max_tokens", "max_parallel"):
            default_value = default_lease.get(key)
            hard_value = hard_ceiling.get(key)
            if isinstance(default_value, int) and isinstance(hard_value, int):
                if hard_value < default_value:
                    return (
                        False,
                        f"Field 'resources.hard_ceiling.{key}' must be >= 'resources.default_lease.{key}'",
                    )

    return True, None


def validate_execution_hints(
    frontmatter: dict[str, object], skill_dir: Path
) -> tuple[bool, str | None]:
    overlay = is_overlay_skill(skill_dir)
    hints = frontmatter.get("execution_hints")
    if hints is None:
        if overlay:
            return True, None
        return False, "Missing 'execution_hints' in frontmatter"
    if not isinstance(hints, dict):
        return False, "Field 'execution_hints' must be an object"

    for key in ("preferred_tools", "fallback_tools"):
        value = hints.get(key)
        if value is None:
            if not overlay:
                return False, f"Missing 'execution_hints.{key}' in frontmatter"
            continue
        ok, message = validate_string_array_value(value, f"execution_hints.{key}")
        if not ok:
            return ok, message

    cost_hint = hints.get("cost_hint")
    if cost_hint is not None and cost_hint not in COST_HINTS:
        return False, "Field 'execution_hints.cost_hint' must be one of: low | medium | high"

    suggested_chains = hints.get("suggested_chains")
    if suggested_chains is not None:
        if not isinstance(suggested_chains, list):
            return False, "Field 'execution_hints.suggested_chains' must be an array"
        for index, entry in enumerate(suggested_chains):
            if not isinstance(entry, dict):
                return (
                    False,
                    f"Field 'execution_hints.suggested_chains[{index}]' must be an object",
                )
            ok, message = validate_string_array(entry, "steps")
            if not ok:
                return False, message.replace(
                    "Field 'steps'",
                    f"Field 'execution_hints.suggested_chains[{index}].steps'",
                )

    return True, None


def validate_skill(skill_path: str | Path) -> tuple[bool, str]:
    """Basic validation of a latest-generation skill directory."""
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

    overlay = is_overlay_skill(skill_dir)
    if not overlay and "consumes" not in frontmatter:
        return False, "Missing 'consumes' in frontmatter"

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

    for key in sorted(STRING_ARRAY_FIELDS):
        ok, message = validate_string_array(frontmatter, key)
        if not ok:
            return False, message or f"Invalid '{key}' field"

    ok, message = validate_intent(frontmatter, skill_dir)
    if not ok:
        return False, message or "Invalid 'intent' field"

    ok, message = validate_effects(frontmatter, skill_dir)
    if not ok:
        return False, message or "Invalid 'effects' field"

    ok, message = validate_resources(frontmatter, skill_dir)
    if not ok:
        return False, message or "Invalid 'resources' field"

    ok, message = validate_execution_hints(frontmatter, skill_dir)
    if not ok:
        return False, message or "Invalid 'execution_hints' field"

    dispatch = frontmatter.get("dispatch")
    if dispatch is not None and not isinstance(dispatch, dict):
        return False, "Field 'dispatch' must be an object"
    routing = frontmatter.get("routing")
    if routing is not None and not isinstance(routing, dict):
        return False, "Field 'routing' must be an object"

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
