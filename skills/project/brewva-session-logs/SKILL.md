---
name: brewva-session-logs
description: Search and analyze Brewva runtime session artifacts (event store, evidence ledger, memory, cost, tape, context arena telemetry) using jq and rg.
version: 1.1.0
stability: stable
tier: project
tags: [session, logs, events, ledger, memory, cost, diagnosis, jsonl, context-arena]
anti_tags: []
tools:
  required: [read, grep]
  optional: [exec, process, ledger_query, tape_info, tape_search, cost_view, skill_complete]
  denied: [write, edit]
budget:
  max_tool_calls: 80
  max_tokens: 160000
outputs:
  [
    session_summary,
    event_timeline,
    cost_report,
    ledger_integrity,
    memory_snapshot,
    process_evidence,
  ]
consumes: []
escalation_path:
  artifact_missing: exploration
  chain_broken: debugging
---

# Brewva Session Logs Skill

## Objective

Provide practical, recipe-driven access to Brewva runtime artifacts for session inspection,
cost analysis, behavioral reconstruction, and evidence integrity verification.

This skill is the process evidence layer. It answers: "what happened at runtime?" without
making source-level or delivery decisions.

## Trigger

Use this skill when:

- inspecting session history or runtime behavior
- checking cost/budget consumption across sessions
- verifying evidence ledger hash chain integrity
- exploring memory evolution or knowledge state
- reconstructing a specific turn or event sequence
- searching across sessions for a pattern or anomaly
- debugging runtime behavior from JSONL artifacts

## Artifact Locations

All paths are relative to the workspace root (detected via `.brewva/` marker or git root).

| Artifact            | Path                                                 | Format             |
| ------------------- | ---------------------------------------------------- | ------------------ |
| Event store         | `.orchestrator/events/{sessionId}.jsonl`             | JSONL              |
| Evidence ledger     | `.orchestrator/ledger/evidence.jsonl`                | JSONL (hash chain) |
| Memory units        | `.orchestrator/memory/units.jsonl`                   | JSONL              |
| Memory crystals     | `.orchestrator/memory/{sessionId}.json`              | JSON               |
| Memory state        | `.orchestrator/memory/state.json`                    | JSON               |
| Working memory      | `.orchestrator/memory/working.md`                    | Markdown           |
| Session state       | `.orchestrator/state/{sessionId}.json`               | JSON               |
| Task ledger         | `.orchestrator/state/task-ledger/`                   | JSON               |
| File snapshots      | `.orchestrator/snapshots/{sessionId}/patchsets.json` | JSON               |
| Turn WAL            | `.orchestrator/turn-wal/`                            | JSONL              |
| Schedule projection | `.brewva/schedule/intents.jsonl`                     | JSONL              |
| Skills index        | `.brewva/skills_index.json`                          | JSON               |

## Key Fields Reference

### Event Store

| Field       | Type    | Description                   |
| ----------- | ------- | ----------------------------- |
| `id`        | string  | `evt_{timestamp}_{id}`        |
| `sessionId` | string  | Session identifier            |
| `type`      | string  | Event type                    |
| `timestamp` | number  | Unix epoch milliseconds       |
| `turn`      | number? | Turn number (when applicable) |
| `payload`   | object? | Event-specific data           |

Event types: `session_start`, `agent_end`, `tool_call`, `anchor`, `checkpoint`,
`memory_*`, `cost_update`, `context_usage`, `context_injected`, `context_injection_dropped`,
`context_arena_*`, `context_external_recall_*`, `task_event`, `ledger_compacted`,
`skill_completed`.

### Evidence Ledger

| Field          | Type   | Description                        |
| -------------- | ------ | ---------------------------------- |
| `id`           | string | `ev_{timestamp}_{id}`              |
| `sessionId`    | string | Session identifier                 |
| `turn`         | number | Turn number                        |
| `skill`        | string | Active skill name                  |
| `tool`         | string | Tool that produced evidence        |
| `verdict`      | enum   | `pass` \| `fail` \| `inconclusive` |
| `previousHash` | string | Hash of previous row (chain link)  |
| `hash`         | string | SHA-256 of this row                |

### Memory Units

| Field        | Type   | Description         |
| ------------ | ------ | ------------------- |
| `id`         | string | Unit identifier     |
| `sessionId`  | string | Originating session |
| `topic`      | string | Topic cluster key   |
| `statement`  | string | Core assertion      |
| `confidence` | number | Confidence score    |
| `status`     | string | Lifecycle status    |

## Common Queries

### List all sessions by date and size

```bash
for f in .orchestrator/events/*.jsonl; do
  ts=$(head -1 "$f" | jq -r '.timestamp')
  date=$(date -r $((ts / 1000)) '+%Y-%m-%d %H:%M' 2>/dev/null || date -d @$((ts / 1000)) '+%Y-%m-%d %H:%M')
  size=$(ls -lh "$f" | awk '{print $5}')
  lines=$(wc -l < "$f")
  echo "$date ${lines}events $size $(basename "$f" .jsonl)"
done | sort -r | head -30
```

### Find sessions from a specific day

```bash
for f in .orchestrator/events/*.jsonl; do
  head -1 "$f" | jq -r '.timestamp' | \
    awk '{d=int($1/1000); cmd="date -r " d " +%Y-%m-%d"; cmd | getline dt; close(cmd); if(dt=="2026-02-25") print FILENAME}' FILENAME="$f"
done
```

### Extract event timeline for a session

```bash
jq -r '[.timestamp, .type, (.payload | keys? // [] | join(","))] | @tsv' \
  .orchestrator/events/<sessionId>.jsonl | head -50
```

### Filter by event type

```bash
jq -r 'select(.type == "tool_call") | [.timestamp, .type, .payload.tool // "?"] | @tsv' \
  .orchestrator/events/<sessionId>.jsonl
```

### Tool usage breakdown for a session

```bash
jq -r 'select(.type == "tool_call") | .payload.tool // .payload.toolName // "unknown"' \
  .orchestrator/events/<sessionId>.jsonl | sort | uniq -c | sort -rn
```

### Skill completion history for a session

```bash
jq -r 'select(.type == "skill_completed") | [.timestamp, .payload.skillName // "?", (.payload.outputKeys // [] | join(","))] | @tsv' \
  .orchestrator/events/<sessionId>.jsonl
```

### Cost summary for a session

```bash
jq -r 'select(.type == "agent_end") | .payload.costSummary | "input=\(.inputTokens) output=\(.outputTokens) cache_read=\(.cacheReadTokens) cost=$\(.totalCostUsd)"' \
  .orchestrator/events/<sessionId>.jsonl
```

### Daily cost summary across all sessions

```bash
for f in .orchestrator/events/*.jsonl; do
  ts=$(head -1 "$f" | jq -r '.timestamp')
  date=$(date -r $((ts / 1000)) '+%Y-%m-%d' 2>/dev/null)
  cost=$(jq -r 'select(.type == "agent_end") | .payload.costSummary.totalCostUsd // 0' "$f" | awk '{s+=$1} END {print s}')
  [ -n "$cost" ] && [ "$cost" != "0" ] && echo "$date $cost"
done | awk '{a[$1]+=$2} END {for(d in a) printf "%s $%.4f\n", d, a[d]}' | sort -r
```

### Context usage for a session

```bash
jq -r 'select(.type == "context_usage") | "turn=\(.turn // "?") tokens=\(.payload.tokens) pct=\(.payload.percent * 100 | floor)%"' \
  .orchestrator/events/<sessionId>.jsonl
```

### Context arena planning telemetry

```bash
jq -r '
  select(.type == "context_injected" or .type == "context_injection_dropped")
  | [
      .timestamp,
      .type,
      ("floor_unmet=" + ((.payload.floorUnmet // false) | tostring)),
      ("degrade=" + (.payload.degradationApplied // "none")),
      ("truth_alloc=" + ((.payload.zoneAllocatedTokens.truth // 0) | tostring)),
      ("truth_accept=" + ((.payload.zoneAcceptedTokens.truth // 0) | tostring)),
      ("recall_alloc=" + ((.payload.zoneAllocatedTokens.memory_recall // 0) | tostring)),
      ("recall_accept=" + ((.payload.zoneAcceptedTokens.memory_recall // 0) | tostring))
    ]
  | @tsv
' .orchestrator/events/<sessionId>.jsonl
```

### Arena adaptation / SLO / floor recovery events

```bash
jq -r '
  select(
    .type == "context_arena_zone_adapted"
    or .type == "context_arena_slo_enforced"
    or .type == "context_arena_floor_unmet_recovered"
    or .type == "context_arena_floor_unmet_unrecoverable"
  )
  | [.timestamp, .type, (.payload | tostring)]
  | @tsv
' .orchestrator/events/<sessionId>.jsonl
```

### External recall boundary outcomes

```bash
jq -r '
  select(.type == "context_external_recall_injected" or .type == "context_external_recall_skipped")
  | [.timestamp, .type, (.payload.reason // "injected"), (.payload.query // "")]
  | @tsv
' .orchestrator/events/<sessionId>.jsonl
```

### Search across ALL sessions for a keyword

```bash
rg -l "keyword" .orchestrator/events/*.jsonl
```

### Search event payloads for a pattern

```bash
rg -l '"type":"tool_call".*"tool":"lsp_diagnostics"' .orchestrator/events/*.jsonl
```

## Evidence Ledger Queries

### Verify hash chain integrity

```bash
jq -s '
  reduce .[] as $row (
    {prev: "root", ok: true, broken_at: null};
    if .ok and ($row.previousHash != .prev) then
      {prev: $row.hash, ok: false, broken_at: $row.id}
    else
      {prev: $row.hash, ok: .ok, broken_at: .broken_at}
    end
  ) | if .ok then "chain_integrity=verified" else "chain_integrity=BROKEN at \(.broken_at)" end
' .orchestrator/ledger/evidence.jsonl
```

### Verdict summary

```bash
jq -r '.verdict' .orchestrator/ledger/evidence.jsonl | sort | uniq -c | sort -rn
```

### Failed verdicts with context

```bash
jq -r 'select(.verdict == "fail") | [.id, .turn, .skill, .tool, .argsSummary[:60]] | @tsv' \
  .orchestrator/ledger/evidence.jsonl
```

### Tool-specific evidence

```bash
jq -r 'select(.tool == "lsp_diagnostics") | [.id, .verdict, .outputSummary[:80]] | @tsv' \
  .orchestrator/ledger/evidence.jsonl
```

### Evidence count by skill

```bash
jq -r '.skill // "none"' .orchestrator/ledger/evidence.jsonl | sort | uniq -c | sort -rn
```

## Memory Queries

### Current working memory

```bash
cat .orchestrator/memory/working.md
```

### All memory topics with counts

```bash
jq -r '.topic' .orchestrator/memory/units.jsonl | sort | uniq -c | sort -rn
```

### Active memory units

```bash
jq -r 'select(.status == "active") | [.id[:20], .topic, .confidence, .statement[:60]] | @tsv' \
  .orchestrator/memory/units.jsonl
```

### Memory evolution: belief revisions

```bash
for f in .orchestrator/memory/*.json; do
  jq -r '
    .topic // empty | . as $topic |
    "crystal: \($topic)"
  ' "$f" 2>/dev/null
done
```

### Memory state

```bash
jq '.' .orchestrator/memory/state.json
```

## Session State Queries

### View session state

```bash
jq '.' .orchestrator/state/<sessionId>.json
```

### List all session states

```bash
for f in .orchestrator/state/*.json; do
  [ "$(basename "$f")" = "state.json" ] && continue
  echo "$(basename "$f" .json): $(jq -r '.phase // .status // "?"' "$f" 2>/dev/null)"
done
```

## File Change / Snapshot Queries

### View patch history for a session

```bash
jq '.patchSets[] | {id, createdAt, summary, toolName, changes: (.changes | length)}' \
  .orchestrator/snapshots/<sessionId>/patchsets.json
```

### All files changed in a session

```bash
jq -r '.patchSets[].changes[].path' \
  .orchestrator/snapshots/<sessionId>/patchsets.json | sort -u
```

## Schedule Queries

### View schedule intents

```bash
jq -r 'select(.kind == "intent") | .record | [.intentId[:12], .status, .reason[:40], .goalRef[:30]] | @tsv' \
  .brewva/schedule/intents.jsonl 2>/dev/null
```

## Replay Shortcut

When full state reconstruction at a specific turn is needed, prefer `TurnReplayEngine`
(`packages/brewva-runtime/src/tape/replay-engine.ts`) over manual JSONL parsing.
It uses tape checkpoints for fast-forward and rebuilds `TaskState` + `TruthState`.

## Workflow

### Step 1: Identify target scope

Determine what to inspect:

- specific session ID → direct JSONL access
- date range → scan event files by timestamp
- keyword/pattern → `rg` across all session files
- cost question → filter `agent_end` or `cost_update` events
- context allocator question → filter `context_injected`, `context_injection_dropped`, `context_arena_*`, `context_external_recall_*`

### Step 2: Extract evidence

Use the recipes above to pull structured data. Always prefer:

- `jq` for structured field extraction
- `rg` for fast text search across many files
- `head`/`tail` for sampling large files

### Step 3: Verify integrity (when analyzing ledger)

Always run hash chain verification before trusting ledger analysis.
A broken chain invalidates downstream correlation.

### Step 4: Emit output

```text
SESSION_SUMMARY
- session_id: "<id>"
- date_range: "<first event> — <last event>"
- event_count: <N>
- cost: $<amount>
- key_events:
  - "<timestamped event>"
- anomalies:
  - "<unexpected pattern>"
```

## Stop Conditions

- Target artifact does not exist at expected path.
- Hash chain is broken and analysis depends on ledger integrity.
- Session file is too large for inline analysis (> 10k events) — recommend sampling.

## Anti-Patterns (never)

- Parsing JSONL manually when `jq` can do it.
- Trusting ledger data without hash chain verification.
- Reading entire multi-MB event stores into memory without filtering.
- Correlating events across sessions without verifying `sessionId` matches.
- Manual JSONL parsing when `TurnReplayEngine` can reconstruct state directly.

## Examples

### Example A — Cost analysis

Input:

```text
"How much did my sessions cost this week?"
```

Expected flow:

1. Scan event files for sessions in date range.
2. Extract `agent_end` cost summaries.
3. Aggregate by day and return `COST_REPORT`.

### Example B — Session forensics

Input:

```text
"What happened in session 0016d0e1-1be7-4d8c-89f4-10efe9326170?"
```

Expected flow:

1. Read event timeline from `events/<id>.jsonl`.
2. Check for `agent_end` cost summary.
3. Check for tool calls, skill completions.
4. Return `SESSION_SUMMARY` with key events.

### Example C — Ledger integrity check

Input:

```text
"Is my evidence ledger consistent?"
```

Expected flow:

1. Run hash chain verification.
2. Summarize verdict distribution.
3. Flag any broken chain links.
4. Return `LEDGER_INTEGRITY` report.
