#!/usr/bin/env python3
"""Generate context strategy metrics report from Brewva event logs."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from collections import defaultdict
from pathlib import Path
from typing import Any


UNKNOWN_MODEL = "(unknown)"
NONE_TASK_CLASS = "(none)"


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="Build weekly context strategy report from JSONL events")
  parser.add_argument("--workspace", default=".", help="Workspace root path")
  parser.add_argument("--days", type=int, default=7, help="Lookback days")
  parser.add_argument(
    "--output",
    default="",
    help="Output markdown path (default: .brewva/strategy/reports/context-strategy-YYYYMMDD.md)",
  )
  return parser.parse_args()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
  rows: list[dict[str, Any]] = []
  if not path.exists():
    return rows
  with path.open("r", encoding="utf-8") as handle:
    for raw in handle:
      line = raw.strip()
      if not line:
        continue
      try:
        obj = json.loads(line)
      except json.JSONDecodeError:
        continue
      if isinstance(obj, dict):
        rows.append(obj)
  return rows


def session_bucket(events: list[dict[str, Any]]) -> tuple[str, str]:
  model = UNKNOWN_MODEL
  task_class = NONE_TASK_CLASS
  for event in reversed(events):
    event_type = event.get("type")
    payload = event.get("payload")
    if not isinstance(payload, dict):
      continue
    if model == UNKNOWN_MODEL and event_type == "cost_update":
      candidate = payload.get("model")
      if isinstance(candidate, str) and candidate.strip():
        model = candidate.strip()
    if task_class == NONE_TASK_CLASS and event_type == "skill_activated":
      candidate = payload.get("skillName")
      if isinstance(candidate, str) and candidate.strip():
        task_class = candidate.strip()
    if model != UNKNOWN_MODEL and task_class != NONE_TASK_CLASS:
      break
  return model, task_class


def as_number(value: Any, default: float = 0.0) -> float:
  if isinstance(value, (int, float)):
    return float(value)
  return default


def build_report(workspace: Path, lookback_days: int) -> tuple[str, dict[str, Any]]:
  events_dir = workspace / ".orchestrator" / "events"
  cutoff_ms = int((dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=lookback_days)).timestamp() * 1000)
  grouped: dict[tuple[str, str], dict[str, float]] = defaultdict(
    lambda: {
      "plans": 0.0,
      "floor_unmet": 0.0,
      "dropped": 0.0,
      "injected_tokens_sum": 0.0,
      "injected_count": 0.0,
      "zone_moves": 0.0,
      "zone_move_tokens": 0.0,
      "verification_total": 0.0,
      "verification_pass": 0.0,
    }
  )

  if not events_dir.exists():
    return ("# Context Strategy Report\n\nNo event files found.\n", {})

  for file_path in sorted(events_dir.glob("*.jsonl")):
    events = read_jsonl(file_path)
    if not events:
      continue
    model, task_class = session_bucket(events)
    bucket = grouped[(model, task_class)]
    for event in events:
      timestamp = event.get("timestamp")
      if not isinstance(timestamp, (int, float)) or timestamp < cutoff_ms:
        continue
      event_type = event.get("type")
      payload = event.get("payload")
      payload = payload if isinstance(payload, dict) else {}

      if event_type == "context_injected":
        bucket["plans"] += 1
        bucket["injected_count"] += 1
        bucket["injected_tokens_sum"] += as_number(payload.get("sourceTokens"))
      elif event_type == "context_injection_dropped":
        reason = payload.get("reason")
        if reason != "duplicate_content":
          bucket["plans"] += 1
          bucket["dropped"] += 1
      elif event_type == "context_arena_floor_unmet_unrecoverable":
        bucket["floor_unmet"] += 1
      elif event_type == "context_arena_zone_adapted":
        bucket["zone_moves"] += 1
        bucket["zone_move_tokens"] += as_number(payload.get("movedTokens"))
      elif event_type == "verification_outcome_recorded":
        bucket["verification_total"] += 1
        if payload.get("outcome") == "pass":
          bucket["verification_pass"] += 1

  today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
  lines = [f"# Context Strategy Report ({today})", ""]
  summary_payload: dict[str, Any] = {"generatedAt": today, "lookbackDays": lookback_days, "buckets": []}

  if not grouped:
    lines.append("No context strategy signals in the lookback window.")
    return ("\n".join(lines) + "\n", summary_payload)

  for (model, task_class), values in sorted(grouped.items(), key=lambda item: item[0]):
    plans = max(1.0, values["plans"])
    injected_count = max(1.0, values["injected_count"])
    verification_total = max(1.0, values["verification_total"])

    floor_unmet_rate = values["floor_unmet"] / plans
    dropped_rate = values["dropped"] / plans
    avg_injection_tokens = values["injected_tokens_sum"] / injected_count
    zone_move_ratio = values["zone_move_tokens"] / max(1.0, values["injected_tokens_sum"])
    verification_pass_rate = values["verification_pass"] / verification_total
    quality_proxy = verification_pass_rate * (1.0 - dropped_rate)

    lines.extend(
      [
        f"## Model: {model} | Task: {task_class}",
        "",
        "| Metric | Value |",
        "|---|---:|",
        f"| floor_unmet_rate | {floor_unmet_rate:.4f} |",
        f"| injection_dropped_rate | {dropped_rate:.4f} |",
        f"| avg_injection_tokens | {avg_injection_tokens:.1f} |",
        f"| zone_adaptation_move_ratio | {zone_move_ratio:.4f} |",
        f"| verification_pass_rate | {verification_pass_rate:.4f} |",
        f"| quality_proxy | {quality_proxy:.4f} |",
        "",
      ]
    )

    summary_payload["buckets"].append(
      {
        "model": model,
        "taskClass": task_class,
        "floorUnmetRate": floor_unmet_rate,
        "injectionDroppedRate": dropped_rate,
        "avgInjectionTokens": avg_injection_tokens,
        "zoneAdaptationMoveRatio": zone_move_ratio,
        "verificationPassRate": verification_pass_rate,
        "qualityProxy": quality_proxy,
        "samples": {
          "plans": int(values["plans"]),
          "verification": int(values["verification_total"]),
        },
      }
    )

  return ("\n".join(lines) + "\n", summary_payload)


def main() -> int:
  args = parse_args()
  workspace = Path(args.workspace).resolve()
  report_markdown, report_payload = build_report(workspace, max(1, args.days))

  reports_dir = workspace / ".brewva" / "strategy" / "reports"
  reports_dir.mkdir(parents=True, exist_ok=True)
  default_output = reports_dir / f"context-strategy-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d')}.md"
  output_path = Path(args.output).resolve() if args.output else default_output
  output_path.parent.mkdir(parents=True, exist_ok=True)
  output_path.write_text(report_markdown, encoding="utf-8")

  summary_json_path = output_path.with_suffix(".json")
  summary_json_path.write_text(json.dumps(report_payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")

  print(f"Observer report: {output_path}")
  print(f"Observer summary: {summary_json_path}")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
