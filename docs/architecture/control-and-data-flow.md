# Control And Data Flow

This document models runtime control flow and persistence flow for normal
execution, interruption recovery, replay, and rollback.

## Default Session Flow (Extensions Enabled)

```mermaid
sequenceDiagram
  participant U as User
  participant CLI as brewva-cli
  participant SES as session.ts
  participant RT as BrewvaRuntime
  participant EXT as brewva-extensions
  participant TOOLS as brewva-tools
  participant STORES as Event/Ledger/Memory Stores

  U->>CLI: invoke command
  CLI->>CLI: parse args + resolve mode
  CLI->>SES: createBrewvaSession()
  SES->>RT: construct runtime
  SES->>EXT: register extension handlers + tools
  U->>CLI: submit prompt / run turn
  CLI->>EXT: before_agent_start
  EXT->>RT: observeContextUsage() + buildContextInjection()
  RT->>STORES: refresh memory projections + publish working.md (if needed)
  CLI->>EXT: tool_call
  EXT->>RT: checkToolAccess() + trackToolCallStart()
  CLI->>TOOLS: execute tool
  TOOLS-->>EXT: tool_result (raw hook)
  EXT->>RT: recordToolResult() + trackToolCallEnd()
  RT->>STORES: append ledger + semantic events (e.g. tool_result_recorded, memory_*)
  CLI->>EXT: agent_end
  EXT->>RT: memory refresh hook (agent_end)
```

In this diagram, `BrewvaRuntime` represents the facade API layer. Internal
state transitions and side effects are delegated to service modules in
`packages/brewva-runtime/src/services/*`.

## `--no-extensions` Flow (Core-Enforced Profile)

```mermaid
flowchart TD
  A["createBrewvaSession(enableExtensions=false)"] --> B["register built-in + custom tools"]
  B --> C["register createRuntimeCoreBridgeExtension()"]
  C --> D["tool_call => runtime.startToolCall(): policy + compaction gate + call tracking"]
  D --> E["tool execute"]
  E --> F["tool_result => runtime.finishToolCall(): ledger write + patch tracking"]
  F --> G["registerRuntimeCoreEventBridge(): lifecycle + usage telemetry"]
```

For scheduling paths, facade methods delegate to `ScheduleIntentService`, which
manages `SchedulerService` through a narrow `SchedulerRuntimePort` adapter.

This mode disables extension presentation hooks, but runtime safety and evidence
chain enforcement stay active through the runtime core bridge hooks.

Memory behavior in this profile is split:

- Projection ingest still runs on `recordEvent()` (memory JSONL state can advance).
- Auto-injection (`brewva.working-memory` / `brewva.memory-recall`) and `agent_end`
  refresh hooks are extension-only and therefore disabled.

## Persistence Data Flow

```mermaid
flowchart LR
  INPUT["Prompt / Tool IO / Usage"] --> RT["BrewvaRuntime"]
  RT --> EVENTS[".orchestrator/events/<session>.jsonl (event tape)"]
  RT --> LEDGER[".orchestrator/ledger/evidence.jsonl (evidence chain)"]
  RT --> MEMORY[".orchestrator/memory/*.jsonl + working.md (memory projections)"]
  RT --> SNAP[".orchestrator/snapshots/<session>/* (rollback only)"]
  RT --> INDEX[".brewva/skills_index.json"]
```

## Memory Projection Flow

```mermaid
flowchart TD
  EVT["Event Tape append"] --> EX["MemoryExtractor (rules-first)"]
  EX --> U["units.jsonl upsert/merge"]
  U --> C["crystals.jsonl compile"]
  U --> I["insights.jsonl (conflict/evolves_pending)"]
  U --> E["evolves.jsonl (shadow proposals)"]
  C --> W["working.md publish"]
  I --> W
  W --> INJ["before_agent_start inject: brewva.working-memory"]
  U --> R["memory retrieval search"]
  C --> R
  R --> INJ2["before_agent_start inject: brewva.memory-recall"]
```

Notes:

- EVOLVES proposals are shadow-only until reviewed (`memory_review_evolves_edge`).
- Accepted `replaces/challenges` edges may supersede older units and trigger a
  fresh working-memory publication on the next refresh cycle.
- Retrieval scoring policy is configured via `memory.retrievalWeights.*`.

## Interruption and Recovery Flow

```mermaid
flowchart TD
  A["SIGINT/SIGTERM"] --> B["record session_interrupted"]
  B --> C["waitForIdle (bounded by graceful timeout)"]
  C --> D["abort/exit"]
  D --> E["next startup"]
  E --> F["read event tape"]
  F --> G["TurnReplayEngine fold (checkpoint + delta)"]
  G --> H["resume with reconstructed task/truth state"]
```

## Replay and Rollback Flow

```mermaid
flowchart TD
  A["--replay"] --> B["resolve session (explicit --session or latest)"]
  B --> C["queryStructuredEvents(sessionId)"]
  C --> D["emit timeline text/json"]

  U["--undo or rollback_last_patch"] --> V["resolve session id"]
  V --> W["rollbackLastPatchSet(sessionId)"]
  W --> X{"rollback ok?"}
  X -->|Yes| Y["restore tracked files + emit rollback + verification_state_reset"]
  X -->|No| Z["return no_patchset or restore_failed"]
```
