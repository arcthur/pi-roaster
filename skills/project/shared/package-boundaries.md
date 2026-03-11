# Package Boundaries and Invariants

## Workspace Topology

| Package                  | Responsibility                                                              | Must Not Own                              |
| ------------------------ | --------------------------------------------------------------------------- | ----------------------------------------- |
| `@brewva/brewva-runtime` | governance kernel, contracts, gates, verification state, context boundaries | CLI wiring or transport-specific behavior |
| `@brewva/brewva-tools`   | concrete tool adapters and runtime-aware helpers                            | orchestration policy                      |
| `@brewva/brewva-addons`  | public addon SDK and operator-facing augmentation surface                   | kernel authority or truth                 |
| `@brewva/brewva-cli`     | user entrypoints and frontend command surface                               | channel/control-plane ownership           |
| `@brewva/brewva-gateway` | daemon control plane, session supervision, channel host, and runtime wiring | kernel semantics                          |

## Invariants

- tool and budget enforcement are correctness rules, not advisory metadata
- skill outputs and runtime artifacts must stay explicit and auditable
- project overlays may tighten or extend project context, but should not invent new semantic territory
