# Package Boundaries and Invariants

## Workspace Topology

| Package | Responsibility | Must Not Own |
| --- | --- | --- |
| `@pi-roaster/roaster-runtime` | contracts, registry, selector, verification state, ledger primitives, security policy | CLI wiring, transport-specific tooling behavior |
| `@pi-roaster/roaster-tools` | concrete tool adapters (`ledger_query`, `lsp`, `ast-grep`, `look_at`, skill lifecycle tools) | runtime orchestration decisions |
| `@pi-roaster/roaster-extensions` | runtime hooks and event wiring to agent lifecycle | core contract model or low-level persistence primitives |
| `@pi-roaster/roaster-cli` | session bootstrap and user entrypoints | core policy logic and verification semantics |

## Dependency Direction
Preferred direction:
`runtime` -> `tools` (interfaces) -> `extensions` -> `cli` (composition root)

Hard constraints:
- `runtime` should stay framework-agnostic where possible.
- `tools` should avoid importing extension orchestration internals.
- `cli` should orchestrate, not re-implement runtime policy.

## Contract Invariants
- Skill contract tightening must remain monotonic (project/pack can only tighten).
- Denied tools are enforceable policy, not advisory metadata.
- Budget checks (`maxToolCalls`, `maxTokens`) are part of correctness, not optional ergonomics.
- Output requirements are part of completion semantics.

## Verification Invariants
- Evidence-only checks are acceptable for `quick` mode, not for stronger levels.
- Verification artifacts must be traceable to commands or deterministic tooling outputs.
- Verification summaries should expose missing evidence explicitly.

## Change Checklist by Package

### Runtime change checklist
- contract parsing and merge behavior still deterministic
- tool access policy still enforced before execution
- verification decision path still produces explicit verdict

### Tools change checklist
- tool output format remains stable for classifier/evidence consumers
- failures include actionable error details
- heuristic tools clearly signal confidence/quality mode

### Extensions change checklist
- lifecycle hooks remain idempotent where required
- context injection does not mutate source user intent
- completion/reporting logic cannot silently bypass required outputs

### CLI change checklist
- bootstrap options remain backward-compatible
- default config paths remain predictable
- runtime and extensions initialization order remains deterministic
