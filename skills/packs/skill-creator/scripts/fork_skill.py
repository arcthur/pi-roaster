#!/usr/bin/env python3
"""
Skill Forker - Fork an existing skill into a local override directory.

This script is designed for environment/project-specific skill customization:
it copies an existing skill into a higher-precedence root while preserving the
same skill name so runtime resolves a single effective definition.
"""

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
from typing import Any, Dict, List, Optional, Sequence, Tuple

import yaml

try:
    from quick_validate import validate_skill
except Exception:  # pragma: no cover - fallback only
    validate_skill = None


FRONTMATTER_RE = re.compile(r"^---\n([\s\S]*?)\n---\n?([\s\S]*)$")
TIER_PRIORITY: Dict[str, int] = {"base": 1, "pack": 2, "project": 3}
TIER_DIRS: Dict[str, str] = {"base": "base", "pack": "packs", "project": "project"}
SOURCE_PRIORITIES: Dict[str, int] = {
    "module_ancestor": 1,
    "exec_ancestor": 2,
    "global_root": 3,
    "project_root": 4,
    "config_root": 5,
}
MAX_ANCESTOR_DEPTH = 10
DEFAULT_PACKS = ["typescript", "react", "bun", "skill-creator"]


@dataclass(frozen=True)
class SkillRoot:
    root_dir: Path
    skill_dir: Path
    source: str


@dataclass(frozen=True)
class SkillEntry:
    name: str
    tier: str
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


def has_tier_directories(path: Path) -> bool:
    return (path / "base").is_dir() or (path / "packs").is_dir() or (path / "project").is_dir()


def resolve_skill_directory(root_dir: Path) -> Optional[Path]:
    normalized = root_dir.resolve()
    if has_tier_directories(normalized):
        return normalized
    nested = normalized / "skills"
    if has_tier_directories(nested):
        return nested.resolve()
    return None


def collect_bounded_ancestors(start_dir: Path) -> List[Path]:
    out: List[Path] = []
    current = start_dir.resolve()
    for _ in range(MAX_ANCESTOR_DEPTH):
        out.append(current)
        if current.parent == current:
            break
        current = current.parent
    return out


def append_discovered_root(
    roots: List[SkillRoot],
    index_by_skill_dir: Dict[str, int],
    root_dir: Path,
    source: str,
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


def normalize_string_array(value: Any, fallback: Sequence[str]) -> List[str]:
    if not isinstance(value, list):
        return list(fallback)
    normalized: List[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        trimmed = item.strip()
        if trimmed:
            normalized.append(trimmed)
    return normalized


def read_json_file(path: Path) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def load_skill_settings(
    cwd: Path, config_path: Optional[str]
) -> Tuple[List[str], List[Path], List[str], List[Path]]:
    packs = list(DEFAULT_PACKS)
    configured_roots: List[Path] = []
    disabled: List[str] = []

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

        if "packs" in skills:
            packs = normalize_string_array(skills.get("packs"), packs)

        if "roots" in skills:
            normalized: List[Path] = []
            roots = skills.get("roots")
            if isinstance(roots, list):
                for entry in roots:
                    if not isinstance(entry, str):
                        continue
                    trimmed = entry.strip()
                    if not trimmed:
                        continue
                    normalized.append(resolve_maybe_absolute(trimmed, cfg_path.parent))
            configured_roots = normalized

        if "disabled" in skills:
            disabled = normalize_string_array(skills.get("disabled"), disabled)

    return packs, configured_roots, disabled, config_files


def discover_skill_roots(cwd: Path, configured_roots: Sequence[Path]) -> List[SkillRoot]:
    roots: List[SkillRoot] = []
    index_by_skill_dir: Dict[str, int] = {}

    module_ancestors = list(reversed(collect_bounded_ancestors(Path(__file__).resolve().parent)))
    for ancestor in module_ancestors:
        append_discovered_root(roots, index_by_skill_dir, ancestor, "module_ancestor")

    exec_ancestors = list(reversed(collect_bounded_ancestors(Path(sys.executable).resolve().parent)))
    for ancestor in exec_ancestors:
        append_discovered_root(roots, index_by_skill_dir, ancestor, "exec_ancestor")

    append_discovered_root(roots, index_by_skill_dir, resolve_global_brewva_root(cwd), "global_root")
    append_discovered_root(roots, index_by_skill_dir, resolve_project_brewva_root(cwd), "project_root")

    for configured in configured_roots:
        append_discovered_root(roots, index_by_skill_dir, configured, "config_root")

    return roots


def parse_frontmatter(content: str) -> Tuple[Dict[str, Any], str]:
    match = FRONTMATTER_RE.match(content)
    if not match:
        return {}, content
    yaml_text = match.group(1) or ""
    body = match.group(2) or ""
    try:
        parsed = yaml.safe_load(yaml_text)
    except yaml.YAMLError:
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    return parsed, body


def load_tier_entries(tier_dir: Path, tier: str, root: SkillRoot) -> List[SkillEntry]:
    if not tier_dir.is_dir():
        return []
    out: List[SkillEntry] = []
    for skill_md in sorted(tier_dir.rglob("SKILL.md")):
        try:
            raw = skill_md.read_text(encoding="utf8")
        except Exception:
            continue
        frontmatter, _ = parse_frontmatter(raw)
        candidate_name = frontmatter.get("name")
        if isinstance(candidate_name, str) and candidate_name.strip():
            name = candidate_name.strip()
        else:
            name = skill_md.parent.name
        out.append(
            SkillEntry(
                name=name,
                tier=tier,
                file_path=skill_md.resolve(),
                base_dir=skill_md.parent.resolve(),
                root=root,
            )
        )
    return out


def load_registry(roots: Sequence[SkillRoot], active_packs: Sequence[str]) -> Tuple[Dict[str, SkillEntry], List[SkillEntry]]:
    active_pack_set = set(active_packs)
    loaded: Dict[str, SkillEntry] = {}
    all_entries: List[SkillEntry] = []

    for root in roots:
        tier_entries: List[SkillEntry] = []
        tier_entries.extend(load_tier_entries(root.skill_dir / "base", "base", root))

        packs_dir = root.skill_dir / "packs"
        include_all_packs = root.source in {"project_root", "config_root"}
        if packs_dir.is_dir():
            for pack_dir in sorted(packs_dir.iterdir()):
                if not pack_dir.is_dir():
                    continue
                if not include_all_packs and pack_dir.name not in active_pack_set:
                    continue
                tier_entries.extend(load_tier_entries(pack_dir, "pack", root))

        tier_entries.extend(load_tier_entries(root.skill_dir / "project", "project", root))

        for entry in tier_entries:
            all_entries.append(entry)
            existing = loaded.get(entry.name)
            if existing is None:
                loaded[entry.name] = entry
                continue
            if TIER_PRIORITY[entry.tier] >= TIER_PRIORITY[existing.tier]:
                loaded[entry.name] = entry

    return loaded, all_entries


def resolve_explicit_source(skill_name: str, source_path: str, cwd: Path) -> SkillEntry:
    candidate = resolve_maybe_absolute(source_path, cwd)
    if candidate.is_dir():
        skill_md = candidate / "SKILL.md"
    else:
        skill_md = candidate

    if not skill_md.is_file():
        raise RuntimeError(f"Source path does not contain SKILL.md: {candidate}")

    if skill_md.name != "SKILL.md":
        raise RuntimeError(f"Source path must point to SKILL.md or its directory: {candidate}")

    tier = "pack"
    parent_tier = skill_md.parent.parent.name
    if parent_tier == "base":
        tier = "base"
    elif parent_tier == "packs":
        tier = "pack"
    elif parent_tier == "project":
        tier = "project"

    raw = skill_md.read_text(encoding="utf8")
    frontmatter, _ = parse_frontmatter(raw)
    declared_name = frontmatter.get("name")
    resolved_name = declared_name.strip() if isinstance(declared_name, str) and declared_name.strip() else skill_md.parent.name

    if resolved_name != skill_name:
        raise RuntimeError(
            f"Requested skill '{skill_name}' but source declares '{resolved_name}' ({skill_md})"
        )

    synthetic_root = SkillRoot(root_dir=skill_md.parent.parent, skill_dir=skill_md.parent.parent, source="explicit")
    return SkillEntry(
        name=resolved_name,
        tier=tier,
        file_path=skill_md.resolve(),
        base_dir=skill_md.parent.resolve(),
        root=synthetic_root,
    )


def resolve_destination_skill_root(path_arg: Optional[str], cwd: Path) -> Tuple[Path, str]:
    if not path_arg:
        project_root = resolve_project_brewva_root(cwd)
        if project_root.is_dir():
            return (project_root / "skills").resolve(), "project_default"
        return (resolve_global_brewva_root(cwd) / "skills").resolve(), "global_default"

    explicit = resolve_maybe_absolute(path_arg, cwd)
    resolved = resolve_skill_directory(explicit)
    if resolved:
        return resolved.resolve(), "explicit_existing"
    if explicit.name == ".brewva":
        return (explicit / "skills").resolve(), "explicit_brewva_root"
    if explicit.name == "skills":
        return explicit.resolve(), "explicit_skills_root"
    return (explicit / "skills").resolve(), "explicit_generic"


def inject_fork_metadata(destination_skill_md: Path, source_entry: SkillEntry) -> None:
    raw = destination_skill_md.read_text(encoding="utf8")
    frontmatter, body = parse_frontmatter(raw)
    if not frontmatter:
        raise RuntimeError(f"Missing frontmatter in destination SKILL.md: {destination_skill_md}")

    metadata = frontmatter.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}

    metadata["fork"] = {
        "source_name": source_entry.name,
        "source_tier": source_entry.tier,
        "source_file": str(source_entry.file_path),
        "source_root": str(source_entry.root.skill_dir),
        "source_origin": source_entry.root.source,
        "forked_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "forked_by": os.environ.get("USER", ""),
        "tool": "skill-creator/scripts/fork_skill.py",
    }
    frontmatter["metadata"] = metadata

    yaml_text = yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=False).strip()
    rebuilt = f"---\n{yaml_text}\n---\n{body}"
    destination_skill_md.write_text(rebuilt, encoding="utf8")


def format_candidate_chain(skill_name: str, entries: Sequence[SkillEntry]) -> List[str]:
    relevant = [entry for entry in entries if entry.name == skill_name]
    lines: List[str] = []
    for index, entry in enumerate(relevant, start=1):
        lines.append(
            f"{index}. name={entry.name} tier={entry.tier} source={entry.root.source} path={entry.file_path}"
        )
    return lines


def run_validation(skill_dir: Path) -> Tuple[bool, str]:
    if validate_skill is None:
        return True, "quick_validate unavailable; skipped"
    try:
        ok, message = validate_skill(str(skill_dir))
        return bool(ok), str(message)
    except Exception as error:
        return False, f"validator execution failed: {error}"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fork_skill.py",
        description=(
            "Fork an existing skill into a project/global/custom directory while preserving the "
            "skill name for override semantics."
        ),
    )
    parser.add_argument("skill_name", help="Skill name to fork (must match source frontmatter name)")
    parser.add_argument(
        "--from",
        dest="source_path",
        help="Optional source skill path (skill directory or SKILL.md). Defaults to effective skill resolution.",
    )
    parser.add_argument(
        "--path",
        dest="target_path",
        help=(
            "Destination root path. Accepts <root>, <root>/skills, or .brewva root. "
            "Default: project .brewva/skills when present, else global ~/.config/brewva/skills."
        ),
    )
    parser.add_argument(
        "--tier",
        choices=["base", "pack", "project"],
        help="Override destination tier. Default: keep source tier.",
    )
    parser.add_argument(
        "--config",
        dest="config_path",
        help="Use explicit config file to resolve skills.roots and skills.packs.",
    )
    parser.add_argument("--force", action="store_true", help="Overwrite destination skill directory if it exists.")
    parser.add_argument("--dry-run", action="store_true", help="Preview actions without writing files.")
    parser.add_argument("--no-metadata", action="store_true", help="Do not inject metadata.fork into destination SKILL.md.")
    parser.add_argument(
        "--allow-inactive",
        action="store_true",
        help="Do not fail if the forked copy does not become active in current runtime resolution.",
    )
    parser.add_argument("--verbose", action="store_true", help="Print candidate resolution details.")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    skill_name = args.skill_name.strip()
    if not skill_name:
        print("❌ Error: skill_name is required.")
        return 1

    cwd = Path.cwd()
    packs, configured_roots, disabled, config_files = load_skill_settings(cwd, args.config_path)
    disabled_set = set(disabled)
    roots = discover_skill_roots(cwd, configured_roots)
    loaded, all_entries = load_registry(roots, packs)

    if args.verbose:
        print("Resolved config files:")
        for cfg in config_files:
            print(f"  - {cfg}")
        print("Resolved skill roots:")
        for root in roots:
            print(f"  - source={root.source} skill_dir={root.skill_dir}")
        print("Active packs:")
        print(f"  - {', '.join(packs) if packs else '(none)'}")
        print("Disabled skills:")
        print(f"  - {', '.join(disabled) if disabled else '(none)'}")
        print("Candidate chain:")
        chain = format_candidate_chain(skill_name, all_entries)
        if chain:
            for line in chain:
                print(f"  {line}")
        else:
            print("  (none)")
        print()

    if args.source_path:
        try:
            source_entry = resolve_explicit_source(skill_name, args.source_path, cwd)
        except RuntimeError as error:
            print(f"❌ Error: {error}")
            return 1
    else:
        source_entry = loaded.get(skill_name)
        if source_entry is None:
            print(f"❌ Error: Skill '{skill_name}' not found in resolved registry roots.")
            return 1
        if skill_name in disabled_set:
            print(
                f"⚠️ Note: '{skill_name}' is listed in skills.disabled and is currently inactive at runtime."
            )

    destination_skill_root, destination_source = resolve_destination_skill_root(args.target_path, cwd)
    destination_tier = args.tier or source_entry.tier
    destination_tier_dir = TIER_DIRS[destination_tier]
    destination_skill_dir = (destination_skill_root / destination_tier_dir / skill_name).resolve()

    print(f"🔀 Forking skill: {skill_name}")
    print(f"   Source: {source_entry.file_path}")
    print(f"   Source tier: {source_entry.tier}")
    print(f"   Source root source: {source_entry.root.source}")
    print(f"   Destination root: {destination_skill_root}")
    print(f"   Destination tier: {destination_tier}")
    print(f"   Destination path: {destination_skill_dir}")
    print(f"   Destination root mode: {destination_source}")
    print()

    if destination_skill_dir.exists() and not args.force:
        print(f"❌ Error: Destination already exists: {destination_skill_dir}")
        print("   Use --force to overwrite.")
        return 1

    if args.dry_run:
        print("✅ Dry-run complete. No files were written.")
        return 0

    source_dir_for_copy = source_entry.base_dir.resolve()
    staged_temp_dir: Optional[Path] = None
    if args.force and source_dir_for_copy == destination_skill_dir.resolve():
        staged_temp_dir = Path(tempfile.mkdtemp(prefix="brewva-skill-fork-stage-")).resolve()
        staged_source = (staged_temp_dir / "source").resolve()
        shutil.copytree(source_dir_for_copy, staged_source)
        source_dir_for_copy = staged_source

    try:
        if destination_skill_dir.exists() and args.force:
            shutil.rmtree(destination_skill_dir)

        destination_skill_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source_dir_for_copy, destination_skill_dir)
    except Exception as error:
        print(f"❌ Error: Failed to copy skill contents: {error}")
        return 1
    finally:
        if staged_temp_dir and staged_temp_dir.exists():
            shutil.rmtree(staged_temp_dir, ignore_errors=True)

    destination_skill_md = destination_skill_dir / "SKILL.md"
    if not destination_skill_md.exists():
        print("❌ Error: Destination SKILL.md missing after copy.")
        return 1

    if not args.no_metadata:
        try:
            inject_fork_metadata(destination_skill_md, source_entry)
        except Exception as error:
            print(f"❌ Error: Failed to inject fork metadata: {error}")
            return 1

    valid, message = run_validation(destination_skill_dir)
    if valid:
        print(f"✅ Validation: {message}")
    else:
        print(f"❌ Validation failed: {message}")
        return 1

    refreshed_roots = discover_skill_roots(cwd, configured_roots)
    refreshed_loaded, _ = load_registry(refreshed_roots, packs)
    for disabled_name in disabled:
        refreshed_loaded.pop(disabled_name, None)
    effective = refreshed_loaded.get(skill_name)

    active = effective is not None and effective.base_dir.resolve() == destination_skill_dir.resolve()
    if active:
        print("✅ Active override confirmed:")
        print(f"   Effective skill path: {effective.file_path}")
    else:
        print("⚠️ Fork created, but it is not currently the effective skill.")
        if effective is None:
            print("   No effective skill with this name is currently loaded.")
        else:
            print(f"   Effective path remains: {effective.file_path}")
            print(f"   Effective tier/source: {effective.tier}/{effective.root.source}")
        print("\nPossible fixes:")
        if skill_name in disabled_set:
            print("1. Remove the skill from skills.disabled in brewva config.")
            print("2. Fork into project .brewva/skills to ensure higher precedence.")
            print("3. If using a custom root, add it to skills.roots in brewva config.")
            print(
                "4. For pack-tier skills outside project/config roots, add the pack name to skills.packs."
            )
        else:
            print("1. Fork into project .brewva/skills to ensure higher precedence.")
            print("2. If using a custom root, add it to skills.roots in brewva config.")
            print(
                "3. For pack-tier skills outside project/config roots, add the pack name to skills.packs."
            )
        if not args.allow_inactive:
            return 2

    print("\n✅ Skill fork completed.")
    print("Next steps:")
    print(f"1. Edit {destination_skill_md}")
    print("2. Keep the same frontmatter name to preserve override semantics.")
    print("3. Run your normal runtime/docs checks for the target project.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
