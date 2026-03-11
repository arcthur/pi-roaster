# Internal Skills

`skills/internal/` is reserved for runtime-owned phase documentation.

Current phase ownership still lives in code:

- compose-style planning: chain planner + cascade services
- verification: `runtime.verification.*` and `VerificationService`
- finishing: `SessionLifecycleService`
- recovery: continuity policy, scheduler recovery, and turn WAL recovery
- automatic debug-loop control: `packages/brewva-gateway/src/runtime-plugins/debug-loop.ts`

This directory exists so future structured internal phase docs can live beside
the public capability catalog without reintroducing the old lifecycle-skill taxonomy.
