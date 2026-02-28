#!/usr/bin/env python3
"""Propose or apply context strategy overrides from observer summary."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="Tune context strategy overrides from observer JSON report")
  parser.add_argument("--workspace", default=".", help="Workspace root path")
  parser.add_argument(
    "--input",
    default="",
    help="Observer JSON path (default: latest .brewva/strategy/reports/context-strategy-*.json)",
  )
  parser.add_argument(
    "--output",
    default=".brewva/strategy/context-strategy.json",
    help="Overrides file path relative to workspace",
  )
  parser.add_argument("--ttl-hours", type=int, default=168, help="Override TTL in hours")
  parser.add_argument("--apply", action="store_true", help="Write overrides file in place")
  return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
  try:
    raw = json.loads(path.read_text(encoding="utf-8"))
  except Exception:
    return {}
  return raw if isinstance(raw, dict) else {}


def find_latest_observer_json(workspace: Path) -> Path | None:
  report_dir = workspace / ".brewva" / "strategy" / "reports"
  if not report_dir.exists():
    return None
  files = sorted(report_dir.glob("context-strategy-*.json"))
  return files[-1] if files else None


def choose_arm(bucket: dict[str, Any]) -> str:
  floor_unmet = float(bucket.get("floorUnmetRate", 0.0))
  dropped = float(bucket.get("injectionDroppedRate", 0.0))
  quality = float(bucket.get("qualityProxy", 0.0))
  zone_ratio = float(bucket.get("zoneAdaptationMoveRatio", 0.0))

  if quality >= 0.92 and floor_unmet <= 0.01 and dropped <= 0.08 and zone_ratio <= 0.02:
    return "passthrough"
  if quality >= 0.88 and floor_unmet <= 0.05:
    return "hybrid"
  return "managed"


def build_overrides(summary: dict[str, Any], ttl_hours: int) -> dict[str, Any]:
  now = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
  expires_at = now + max(1, ttl_hours) * 60 * 60 * 1000
  buckets = summary.get("buckets")
  if not isinstance(buckets, list):
    buckets = []

  entries: list[dict[str, Any]] = []
  for index, bucket in enumerate(buckets):
    if not isinstance(bucket, dict):
      continue
    samples = bucket.get("samples")
    plans = 0
    if isinstance(samples, dict):
      plans = int(samples.get("plans", 0) or 0)
    if plans < 20:
      continue

    model = str(bucket.get("model", "*")).strip() or "*"
    task_class = str(bucket.get("taskClass", "*")).strip() or "*"
    arm = choose_arm(bucket)
    entries.append(
      {
        "id": f"auto-{index + 1}",
        "model": model,
        "taskClass": task_class,
        "arm": arm,
        "expiresAt": expires_at,
        "updatedAt": now,
        "source": "tuner",
      }
    )

  return {
    "version": 1,
    "generatedAt": now,
    "entries": entries,
  }


def main() -> int:
  args = parse_args()
  workspace = Path(args.workspace).resolve()
  input_path = Path(args.input).resolve() if args.input else find_latest_observer_json(workspace)
  if not input_path or not input_path.exists():
    print("No observer summary found. Run context_strategy_observer.py first.")
    return 1

  summary = load_json(input_path)
  overrides = build_overrides(summary, args.ttl_hours)
  output_path = (workspace / args.output).resolve()

  if args.apply:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(overrides, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    print(f"Applied strategy overrides: {output_path}")
  else:
    print(json.dumps(overrides, ensure_ascii=True, indent=2))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
