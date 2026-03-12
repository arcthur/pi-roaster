#!/usr/bin/env python3
"""Fork an existing Brewva skill into an overlay root."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

try:
    from quick_validate import validate_skill
except Exception:  # pragma: no cover
    validate_skill = None


VALID_CATEGORIES = ("core", "domain", "operator", "meta", "internal")
SOURCE_PRIORITIES = {
    "module_ancestor": 1,
    "exec_ancestor": 2,
    "global_root": 3,
    "project_root": 4,
    "config_root": 5,
}
FRONTMATTER_RE = re.compile(r"^---\n([\s\S]*?)\n---\n?([\s\S]*)$")
MAX_ANCESTOR_DEPTH = 10
DEFAULT_TOOL_PATH = "skill-authoring/scripts/fork_skill.py"


@dataclass(frozen=True)
class SkillRoot:
    root_dir: Path
    skill_dir: Path
    source: str


@dataclass(frozen=True)
class SkillEntry:
    name: str
    category: str
    file_path: Path
    base_dir: Path
    root: SkillRoot


def normalize_path_input(path_text: str) -> str:
    trimmed = path_text.strip()
    if not trimmed:
        return trimmed
    if trimmed == "~":
        return str(Path.home())
    if trimmed.startswith("~/"):
        return str(Path.home() / trimmed[2:])
    return trimmed


def resolve_maybe_absolute(path_text: str, base_dir: Path) -> Path:
    normalized = normalize_path_input(path_text)
    candidate = Path(normalized)
    if candidate.is_absolute():
        return candidate.resolve()
    return (base_dir / candidate).resolve()


def resolve_global_brewva_root(cwd: Path) -> Path:
    agent_dir = os.environ.get("BREWVA_CODING_AGENT_DIR", "").strip()
    if agent_dir:
        return (resolve_maybe_absolute(agent_dir, cwd) / "..").resolve()
    xdg = os.environ.get("XDG_CONFIG_HOME", "").strip()
    if xdg:
        return resolve_maybe_absolute(f"{xdg}/brewva", cwd)
    return (Path.home() / ".config" / "brewva").resolve()


def resolve_project_brewva_root(cwd: Path) -> Path:
    return (cwd / ".brewva").resolve()


def collect_bounded_ancestors(start_dir: Path) -> list[Path]:
    out: list[Path] = []
    current = start_dir.resolve()
    for _ in range(MAX_ANCESTOR_DEPTH):
        out.append(current)
        if current.parent == current:
            break
        current = current.parent
    return out


def has_v2_skill_directories(path: Path) -> bool:
    skills_root = path / "skills"
    return any((skills_root / category).is_dir() for category in VALID_CATEGORIES) or (
        skills_root / "project"
    ).is_dir()


def resolve_skill_directory(root_dir: Path) -> Path | None:
    normalized = root_dir.resolve()
    if has_v2_skill_directories(normalized):
        return (normalized / "skills").resolve()
    if any((normalized / category).is_dir() for category in VALID_CATEGORIES) or (
        normalized / "project"
    ).is_dir():
        return normalized
    return None


def append_discovered_root(
    roots: list[SkillRoot], index_by_skill_dir: dict[str, int], root_dir: Path, source: str
) -> None:
    skill_dir = resolve_skill_directory(root_dir)
    if skill_dir is None:
        return
    key = str(skill_dir.resolve())
    existing_index = index_by_skill_dir.get(key)
    if existing_index is not None:
        existing = roots[existing_index]
        if SOURCE_PRIORITIES[source] > SOURCE_PRIORITIES[existing.source]:
            roots[existing_index] = SkillRoot(
                root_dir=root_dir.resolve(),
                skill_dir=existing.skill_dir,
                source=source,
            )
        return
    index_by_skill_dir[key] = len(roots)
    roots.append(SkillRoot(root_dir=root_dir.resolve(), skill_dir=skill_dir.resolve(), source=source))


def discover_skill_roots(cwd: Path, configured_roots: list[Path]) -> list[SkillRoot]:
    roots: list[SkillRoot] = []
    index_by_skill_dir: dict[str, int] = {}

    for ancestor in reversed(collect_bounded_ancestors(Path(__file__).resolve().parent)):
        append_discovered_root(roots, index_by_skill_dir, ancestor, "module_ancestor")
    for ancestor in reversed(collect_bounded_ancestors(Path(sys.executable).resolve().parent)):
        append_discovered_root(roots, index_by_skill_dir, ancestor, "exec_ancestor")

    append_discovered_root(roots, index_by_skill_dir, resolve_global_brewva_root(cwd), "global_root")
    append_discovered_root(roots, index_by_skill_dir, resolve_project_brewva_root(cwd), "project_root")
    for configured in configured_roots:
        append_discovered_root(roots, index_by_skill_dir, configured, "config_root")

    return roots


def read_json_file(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf8"))
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def load_skill_settings(cwd: Path, config_path: str | None) -> tuple[list[Path], list[str]]:
    configured_roots: list[Path] = []
    disabled: list[str] = []
    if config_path:
        config_files = [resolve_maybe_absolute(config_path, cwd)]
    else:
        config_files = [
            resolve_global_brewva_root(cwd) / "brewva.json",
            resolve_project_brewva_root(cwd) / "brewva.json",
        ]

    for cfg_path in config_files:
        loaded = read_json_file(cfg_path)
        if not loaded:
            continue
        skills = loaded.get("skills")
        if not isinstance(skills, dict):
            continue

        roots = skills.get("roots")
        if isinstance(roots, list):
            configured_roots = []
            for entry in roots:
                if isinstance(entry, str) and entry.strip():
                    configured_roots.append(resolve_maybe_absolute(entry, cfg_path.parent))

        raw_disabled = skills.get("disabled")
        if isinstance(raw_disabled, list):
            disabled = [entry.strip() for entry in raw_disabled if isinstance(entry, str) and entry.strip()]

    return configured_roots, disabled


def parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    match = FRONTMATTER_RE.match(content)
    if not match:
        return {}, content
    yaml_text = match.group(1) or ""
    body = match.group(2) or ""
    try:
        parsed = yaml.safe_load(yaml_text)
    except yaml.YAMLError:
        parsed = {}
    return (parsed if isinstance(parsed, dict) else {}), body


def load_category_entries(category_dir: Path, category: str, root: SkillRoot) -> list[SkillEntry]:
    if not category_dir.is_dir():
        return []
    out: list[SkillEntry] = []
    for skill_md in sorted(category_dir.rglob("SKILL.md")):
        raw = skill_md.read_text(encoding="utf8")
        frontmatter, _ = parse_frontmatter(raw)
        candidate_name = frontmatter.get("name")
        if isinstance(candidate_name, str) and candidate_name.strip():
            name = candidate_name.strip()
        else:
            name = skill_md.parent.name
        out.append(
            SkillEntry(
                name=name,
                category=category,
                file_path=skill_md.resolve(),
                base_dir=skill_md.parent.resolve(),
                root=root,
            )
        )
    return out


def load_registry(roots: list[SkillRoot]) -> dict[str, SkillEntry]:
    loaded: dict[str, SkillEntry] = {}
    for root in roots:
        for category in VALID_CATEGORIES:
            for entry in load_category_entries(root.skill_dir / category, category, root):
                loaded[entry.name] = entry
    return loaded


def load_registry_candidates(roots: list[SkillRoot]) -> dict[str, list[SkillEntry]]:
    loaded: dict[str, list[SkillEntry]] = {}
    for root in roots:
        for category in VALID_CATEGORIES:
            for entry in load_category_entries(root.skill_dir / category, category, root):
                loaded.setdefault(entry.name, []).append(entry)
    return loaded


def choose_source_entry(candidates: list[SkillEntry], destination_dir: Path | None = None) -> SkillEntry:
    if not candidates:
        raise RuntimeError("No source candidates available.")
    if destination_dir is None:
        return candidates[-1]

    normalized_destination = destination_dir.resolve()
    for entry in reversed(candidates):
        if entry.base_dir.resolve() != normalized_destination:
            return entry
    return candidates[-1]


def resolve_explicit_source(source_path: str, cwd: Path) -> SkillEntry:
    candidate = resolve_maybe_absolute(source_path, cwd)
    skill_md = candidate / "SKILL.md" if candidate.is_dir() else candidate
    if not skill_md.is_file():
        raise RuntimeError(f"Source path does not contain SKILL.md: {candidate}")
    raw = skill_md.read_text(encoding="utf8")
    frontmatter, _ = parse_frontmatter(raw)
    category = "domain"
    for maybe_category in VALID_CATEGORIES:
        if f"/skills/{maybe_category}/" in skill_md.as_posix() or skill_md.parent.parent.name == maybe_category:
            category = maybe_category
            break
    name = frontmatter.get("name") if isinstance(frontmatter.get("name"), str) else skill_md.parent.name
    synthetic_root = SkillRoot(root_dir=skill_md.parent.parent.parent, skill_dir=skill_md.parent.parent, source="explicit")
    return SkillEntry(
        name=name.strip(),
        category=category,
        file_path=skill_md.resolve(),
        base_dir=skill_md.parent.resolve(),
        root=synthetic_root,
    )


def resolve_source_entry(
    cwd: Path, skill_name: str, source_path: str | None, config_path: str | None
) -> tuple[SkillEntry, list[Path], list[str]]:
    configured_roots, disabled = load_skill_settings(cwd, config_path)
    if source_path:
        return resolve_explicit_source(source_path, cwd), configured_roots, disabled
    registry = load_registry_candidates(discover_skill_roots(cwd, configured_roots))
    candidates = registry.get(skill_name)
    if not candidates:
        raise RuntimeError(f"Skill '{skill_name}' was not found in discovered skill roots.")
    return choose_source_entry(candidates), configured_roots, disabled


def category_relative_dir(category: str) -> Path:
    return Path(category)


def resolve_destination_root(cwd: Path, explicit_path: str | None) -> tuple[Path, str]:
    if explicit_path:
        return resolve_maybe_absolute(explicit_path, cwd), "explicit"
    project_root = resolve_project_brewva_root(cwd)
    if project_root.is_dir():
        return project_root, "project"
    return resolve_global_brewva_root(cwd), "global"


def resolve_destination_parent(base_root: Path) -> Path:
    normalized = base_root.resolve()
    if normalized.name == "overlays" and normalized.parent.name == "project":
        return normalized
    if normalized.name == "skills":
        return (normalized / "project" / "overlays").resolve()
    return (normalized / "skills" / "project" / "overlays").resolve()


def annotate_frontmatter(raw: str, entry: SkillEntry) -> str:
    frontmatter, body = parse_frontmatter(raw)
    frontmatter.pop("routing", None)
    frontmatter["source_name"] = entry.name
    frontmatter["source_category"] = entry.category
    frontmatter["forked_from"] = str(entry.file_path)
    frontmatter["forked_at"] = datetime.now(timezone.utc).isoformat()
    frontmatter["tool"] = DEFAULT_TOOL_PATH
    yaml_text = yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=False).strip()
    body_text = body if body.startswith("\n") else f"\n{body}" if body else "\n"
    return f"---\n{yaml_text}\n---{body_text}"


def copy_skill(entry: SkillEntry, destination_dir: Path, force: bool) -> Path:
    source_dir = entry.base_dir.resolve()
    cleanup_dir: Path | None = None
    if destination_dir.exists():
        if not force:
            raise FileExistsError(f"Destination already exists: {destination_dir}")
        if source_dir == destination_dir.resolve():
            cleanup_dir = Path(tempfile.mkdtemp(prefix="brewva-skill-fork-self-"))
            source_dir = cleanup_dir / entry.base_dir.name
            shutil.copytree(entry.base_dir, source_dir)
        shutil.rmtree(destination_dir)
    destination_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source_dir, destination_dir)
    skill_md = destination_dir / "SKILL.md"
    raw = skill_md.read_text(encoding="utf8")
    skill_md.write_text(annotate_frontmatter(raw, entry), encoding="utf8")
    if validate_skill is not None:
        valid, message = validate_skill(destination_dir)
        if not valid:
            raise RuntimeError(f"Forked skill failed validation: {message}")
    if cleanup_dir is not None:
        shutil.rmtree(cleanup_dir, ignore_errors=True)
    return skill_md


def destination_is_active(
    destination_root: Path,
    cwd: Path,
    configured_roots: list[Path],
    disabled: list[str],
    skill_name: str,
) -> tuple[bool, str]:
    if skill_name in disabled:
        return False, "Remove the skill from skills.disabled to make the fork active."

    active_roots = {resolve_project_brewva_root(cwd), resolve_global_brewva_root(cwd), *configured_roots}
    for root in active_roots:
        normalized_root = root.resolve()
        if destination_root.resolve() == normalized_root:
            return True, "Forked skill is active at runtime."
    return False, "Forked skill exists on disk but is currently inactive at runtime."


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fork an existing Brewva skill into project/overlay form."
    )
    parser.add_argument("skill_name")
    parser.add_argument("--source", help="Explicit source skill path or SKILL.md file.")
    parser.add_argument(
        "--path",
        help="Target Brewva root. A skills/project/overlays/<skill>/... layout will be created under it.",
    )
    parser.add_argument("--config", help="Optional config file used to resolve skills.roots and skills.disabled.")
    parser.add_argument("--force", action="store_true", help="Overwrite the destination if it already exists.")
    parser.add_argument(
        "--allow-inactive",
        action="store_true",
        help="Allow writing the fork even if the destination root is not active at runtime.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cwd = Path.cwd()
    skill_name = args.skill_name.strip()
    entry, configured_roots, disabled = resolve_source_entry(
        cwd=cwd,
        skill_name=skill_name,
        source_path=args.source,
        config_path=args.config,
    )

    destination_root, destination_scope = resolve_destination_root(cwd, args.path)
    destination_parent = resolve_destination_parent(destination_root)
    destination_dir = destination_parent / entry.name

    if not args.source:
        registry = load_registry_candidates(discover_skill_roots(cwd, configured_roots))
        candidates = registry.get(skill_name) or []
        selected = choose_source_entry(candidates, destination_dir)
        entry = selected

    destination_skill_md = copy_skill(entry, destination_dir, args.force)

    is_active, message = destination_is_active(
        destination_root=destination_root,
        cwd=cwd,
        configured_roots=configured_roots,
        disabled=disabled,
        skill_name=entry.name,
    )

    print(f"Forked '{entry.name}' ({entry.category}) from {entry.file_path}")
    print(f"Destination scope: {destination_scope}")
    print(f"Destination: {destination_skill_md}")
    print(message)

    if not is_active and not args.allow_inactive:
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Error: {exc}")
        sys.exit(1)
