# Control And Data Flow

This document models runtime control flow and persistence flow for normal execution, interruption, replay, and rollback.

## Normal Execution (Control Flow)

```mermaid
sequenceDiagram
  participant U as User
  participant CLI as CLI
  participant RT as RoasterRuntime
  participant EXT as Extensions
  participant TOOLS as Tools
  participant STORES as Ledger/Event/Snapshot Stores

  U->>CLI: start session
  CLI->>RT: create runtime
  CLI->>EXT: register handlers
  U->>CLI: submit prompt
  CLI->>EXT: before_agent_start
  EXT->>RT: buildContextInjection()
  CLI->>TOOLS: execute tool call
  EXT->>RT: checkToolAccess() + markToolCall()
  TOOLS->>EXT: tool_result
  EXT->>RT: recordToolResult()
  RT->>STORES: append ledger/events
  CLI->>EXT: agent_end
  EXT->>RT: persistSessionSnapshot()
  RT->>STORES: write snapshot + memory digest
```

## Persistence Data Flow

```mermaid
flowchart LR
  INPUT["Prompt / Tool IO / Usage"] --> RT["RoasterRuntime"]
  RT --> LEDGER[".orchestrator/ledger/evidence.jsonl"]
  RT --> EVENTS[".orchestrator/events/<session>.jsonl"]
  RT --> SNAP[".orchestrator/state/<session>.json"]
  RT --> MEM[".orchestrator/memory/<session>.json"]
  RT --> INDEX[".pi/skills_index.json"]
```

## Interruption and Resume Flow

```mermaid
flowchart TD
  A["SIGINT/SIGTERM or shutdown"] --> B["persistSessionSnapshot(reason, interrupted)"]
  B --> C["session snapshot written"]
  C --> D["next startup"]
  D --> E{"restoreStartupSession() finds snapshot?"}
  E -->|Yes| F["restore active skill / counters / verification / parallel"]
  E -->|No| G["fresh runtime state"]
  F --> H["inject resume hint"]
  G --> H
  H --> I["continue normal turn loop"]
```

## Replay and Rollback Flow

```mermaid
flowchart TD
  A["--replay"] --> B["queryStructuredEvents(sessionId)"] --> C["emit timeline text/json"]

  D["--undo or rollback_last_patch"] --> E["rollbackLastPatchSet(sessionId)"]
  E --> F{"rollback ok?"}
  F -->|Yes| G["reset verification state + emit rollback event"]
  F -->|No| H["return no_patchset or restore_failed"]
```
