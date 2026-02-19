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
  participant STORES as Ledger/Event Stores

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
```

## Persistence Data Flow

```mermaid
flowchart LR
  INPUT["Prompt / Tool IO / Usage"] --> RT["RoasterRuntime"]
  RT --> LEDGER[".orchestrator/ledger/evidence.jsonl"]
  RT --> EVENTS[".orchestrator/events/<session>.jsonl"]
  RT --> INDEX[".pi-roaster/skills_index.json"]
```

## Interruption and Resume Flow

```mermaid
flowchart TD
  A["SIGINT/SIGTERM or shutdown"] --> B["record session_interrupted event"]
  B --> C["abort current run and exit"]
  C --> D["next startup"]
  D --> E["rebuild runtime state from ledger/events"]
  E --> F["continue normal turn loop"]
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
