# Category And Skills

Skills are loaded by category, not by lifecycle tier.

## Current Layout

- Core capability skills: `skills/core`
- Domain capability skills: `skills/domain`
- Operator skills: `skills/operator`
- Meta skills: `skills/meta`
- Reserved internal skills: `skills/internal`
- Shared project context: `skills/project/shared`
- Project overlays: `skills/project/overlays`

The important distinction is semantic:

- public skill = routable capability boundary
- runtime phase = workflow owned by runtime/control plane
- project overlay = project-specific tightening plus shared context
- operator/meta = loaded, but hidden from standard routing by default

## Routing Scopes

`skills.routing.enabled=false` by default. When enabled,
`skills.routing.scopes` is the only allowlist for auto routing visibility.
Typical defaults are `core` and `domain`; operator/meta stay loaded but hidden
unless scopes explicitly opt in.

Bounded multi-run skills are still gated by routing context and required
artifacts. For example, `goal-loop` is not auto-routed for ordinary one-shot
implementation prompts.

## Current Inventory

- Core: `repository-analysis`, `design`, `implementation`, `debugging`, `review`
- Domain: `agent-browser`, `frontend-design`, `github`, `telegram`, `structured-extraction`, `goal-loop`
- Operator: `runtime-forensics`, `git-ops`
- Meta: `skill-authoring`, `self-improve`
- Overlays: `repository-analysis`, `design`, `implementation`, `debugging`, `review`, `runtime-forensics`
- Shared project context: `critical-rules`, `migration-priority-matrix`, `package-boundaries`, `runtime-artifacts`

## Overlay Semantics

Project overlays do not create new semantic territory. They:

- can add project-specific execution hints and shared context
- tighten allowed/denied effects, resource ceilings, and dispatch/routing constraints
- keep base outputs/consumes unless the overlay explicitly replaces them
- prepend shared project context from `skills/project/shared`

This keeps project knowledge centralized without turning every project into a new
catalog of public super-skills.

## Runtime-Owned Phases

These are no longer public skills:

- verification
- finishing
- recovery
- compose-style chain planning

`skills/internal/` is intentionally reserved for future structured phase docs.
Today those runtime-owned phases are implemented in code, not as routable skills.

Skill configuration contract is defined in `packages/brewva-runtime/src/types.ts`
(`BrewvaConfig.skills`).
