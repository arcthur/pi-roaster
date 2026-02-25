# Guide: Channel Agent Workspace

`brewva --channel telegram` runs with workspace-first orchestration by default (`channels.orchestration.enabled=true`).
Set `channels.orchestration.enabled=false` to disable orchestration and route turns to a single default agent session.

## What It Enables

- Multi-agent registry under `.brewva/agents/<agentId>/`
- Per-agent runtime state isolation (`.brewva/agents/<agentId>/state/*`)
- In-channel command routing (`/new-agent`, `/del-agent`, `/agents`, `/focus`, `/run`, `/discuss`, `@agent ...`)
- Fan-out and bounded discussion loops
- Optional A2A tools (`agent_send`, `agent_broadcast`, `agent_list`)

## Key Config

```json
{
  "channels": {
    "orchestration": {
      "enabled": true,
      "scopeStrategy": "chat",
      "aclModeWhenOwnersEmpty": "open",
      "owners": { "telegram": ["123456789", "@ops_admin"] },
      "limits": {
        "fanoutMaxAgents": 4,
        "maxDiscussionRounds": 3,
        "a2aMaxDepth": 4,
        "a2aMaxHops": 6,
        "maxLiveRuntimes": 8,
        "idleRuntimeTtlMs": 900000
      }
    }
  }
}
```

## Runtime Isolation Guarantees

Worker runtimes force these paths per agent:

- `ledger.path -> .brewva/agents/<agentId>/state/ledger/evidence.jsonl`
- `memory.dir -> .brewva/agents/<agentId>/state/memory`
- `infrastructure.events.dir -> .brewva/agents/<agentId>/state/events`
- `infrastructure.turnWal.dir -> .brewva/agents/<agentId>/state/turn-wal`
- `schedule.projectionPath -> .brewva/agents/<agentId>/state/schedule/intents.jsonl`
- `schedule.enabled -> false`

This override happens in runtime manager code and cannot be bypassed by agent-local config.

## Recovery and Lifecycle

- Registry persists in `.brewva/channel/agent-registry.json`.
- Telegram inline approval callbacks route back to the originating agent when a mapping exists in `.brewva/channel/approval-routing.json` (otherwise they fall back to the current focus).
- Telegram callback state snapshots persist in `.brewva/channel/approval-state.json` (index) and `.brewva/channel/approval-state/<stateKey>.json` (blob) so callbacks can be rehydrated after process restarts.
- Worker runtimes are lazy-created on first routing hit.
- Runtime pool uses `maxLiveRuntimes` + idle TTL eviction.
- `/del-agent` performs soft delete and tears down active sessions for that agent.
