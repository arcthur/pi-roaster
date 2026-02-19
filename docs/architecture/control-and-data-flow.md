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
  participant STORES as Ledger/Event Stores

  U->>CLI: invoke command
  CLI->>CLI: parse args + resolve mode
  CLI->>SES: createBrewvaSession()
  SES->>RT: construct runtime
  SES->>EXT: register extension handlers + tools
  U->>CLI: submit prompt / run turn
  CLI->>EXT: before_agent_start
  EXT->>RT: observeContextUsage() + buildContextInjection()
  CLI->>EXT: tool_call
  EXT->>RT: checkToolAccess() + trackToolCallStart()
  CLI->>TOOLS: execute tool
  TOOLS-->>EXT: tool_result
  EXT->>RT: recordToolResult() + trackToolCallEnd()
  RT->>STORES: append ledger/events
  CLI->>EXT: agent_end
```

## `--no-extensions` Flow (Reduced Orchestration)

```mermaid
flowchart TD
  A["createBrewvaSession(enableExtensions=false)"] --> B["register custom tools directly"]
  B --> C["registerRuntimeCoreEventBridge()"]
  C --> D["record core lifecycle + assistant usage events"]
  D --> E["runtime/tools continue without extension hooks"]
```

This mode keeps runtime/tool execution available, but extension-layer gates and
transforms are intentionally bypassed.

## Persistence Data Flow

```mermaid
flowchart LR
  INPUT["Prompt / Tool IO / Usage"] --> RT["BrewvaRuntime"]
  RT --> EVENTS[".orchestrator/events/<session>.jsonl (event tape)"]
  RT --> LEDGER[".orchestrator/ledger/evidence.jsonl (evidence chain)"]
  RT --> SNAP[".orchestrator/snapshots/<session>/* (rollback only)"]
  RT --> INDEX[".brewva/skills_index.json"]
```

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
