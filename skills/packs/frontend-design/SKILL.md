---
name: frontend-design
description: Senior UI/UX engineering workflow with metric-driven design rules, strict component architecture, CSS hardware acceleration, and anti-slop guardrails for bold, production-ready interfaces.
version: 2.0.0
stability: stable
tier: pack
tags: [frontend, ui, ux, design, motion, typography, layout]
anti_tags: [backend, api-only]
tools:
  required: [read]
  optional: [look_at, lsp_diagnostics, ast_grep_search, skill_complete]
  denied: []
budget:
  max_tool_calls: 60
  max_tokens: 130000
outputs: [design_direction, ui_changes, interaction_checks]
consumes: [execution_steps, component_changes]
escalation_path:
  design_system_conflict: planning
---

# Frontend Design Pack Skill

## Intent

Deliver visually intentional, context-aware interfaces that are functional, testable, and memorable — while actively overriding default LLM biases toward generic UI patterns.

## Trigger

Use this pack when user requests:

- new UI surfaces or major visual refresh
- interaction redesign
- stronger aesthetic direction beyond routine styling

## Design Baseline

Three tuning dials govern all design decisions. These are the defaults — adapt them dynamically based on what the user explicitly requests.

```text
DESIGN_VARIANCE:  8  (1=Perfect Symmetry, 10=Artsy Chaos)
MOTION_INTENSITY: 6  (1=Static, 10=Cinematic)
VISUAL_DENSITY:   4  (1=Art Gallery, 10=Cockpit)
```

Dial definitions:

| Dial | 1–3 | 4–7 | 8–10 |
|---|---|---|---|
| VARIANCE | Symmetric grids, centered layouts, equal paddings | Offset overlaps, varied aspect ratios, left-aligned headers | Masonry, fractional grid units (`2fr 1fr 1fr`), massive whitespace zones |
| MOTION | No auto-animation; CSS `:hover`/`:active` only | `cubic-bezier(0.16,1,0.3,1)` transitions, `animation-delay` cascades, `transform`+`opacity` only | Scroll-triggered reveals, parallax via Framer Motion hooks — never `window.addEventListener('scroll')` |
| DENSITY | Huge spacing, generous section gaps, expensive feel | Normal app spacing | Tiny paddings, 1px separators, `font-mono` for all numbers |

**Mobile override:** For VARIANCE 4–10, asymmetric layouts above `md:` MUST fall back to single-column (`w-full`, `px-4`, `py-8`) on viewports < 768px.

## Design Workflow

### Step 1: Commit to a design direction (mandatory)

Pick one explicit aesthetic direction before coding:

- brutally minimal
- editorial/magazine
- industrial/utilitarian
- retro-futuristic
- playful/toy-like
- luxury/refined
- brutalist/raw

Then quantify it using the three dials above, adjusting from baseline as needed.

Blocking output:

```text
DESIGN_DIRECTION
- direction: "<chosen style>"
- product_goal: "<what this UI must achieve>"
- differentiation: "<one memorable quality>"
- dials: VARIANCE=<n> MOTION=<n> DENSITY=<n>
```

### Step 2: Define constraints and boundaries

Capture:

- framework and existing design system constraints
- accessibility baseline (keyboard, screen-reader, focus visibility)
- responsive breakpoints (standardize `sm`, `md`, `lg`, `xl`)
- performance constraints (animation/render budgets)

Architecture defaults (unless user specifies otherwise):

- **Framework:** React or Next.js. Default to Server Components (RSC).
  - Global state works ONLY in Client Components. Wrap providers in `"use client"`.
  - Interactive UI with motion MUST be extracted as isolated leaf `'use client'` components.
- **State:** Local `useState`/`useReducer` for isolated UI. Global state strictly for deep prop-drilling avoidance.
- **Styling:** Tailwind CSS. Check `package.json` for v3 vs v4 — never mix syntax. For v4, use `@tailwindcss/postcss` or the Vite plugin, NOT `tailwindcss` in `postcss.config.js`.
- **Icons:** `@phosphor-icons/react` or `@radix-ui/react-icons`. Standardize `strokeWidth` globally.

**Dependency verification (mandatory):** Before importing ANY third-party library, check `package.json`. If missing, output the install command first. Never assume a library exists.

### Step 3: Compose visual system

Define and apply:

- typography pairing (display + body)
- color tokens (dominant, support, accent)
- spacing/grid rhythm
- interaction motion hierarchy

#### Typography rules

- **Display/Headlines:** `text-4xl md:text-6xl tracking-tighter leading-none`.
- **Body:** `text-base text-gray-600 leading-relaxed max-w-[65ch]`.
- **Font selection:** Discourage `Inter` for premium or creative contexts. Prefer `Geist`, `Outfit`, `Cabinet Grotesk`, or `Satoshi`.
- **Dashboard constraint:** Serif fonts are BANNED for Dashboard/Software UIs. Use Sans-Serif pairings (`Geist` + `Geist Mono` or `Satoshi` + `JetBrains Mono`).

#### Color rules

- Max 1 accent color. Saturation < 80%.
- No purple/blue "AI glow" aesthetic — no purple button glows, no neon gradients.
- Neutral bases: Zinc/Slate. High-contrast singular accents (Emerald, Electric Blue, Deep Rose).
- Stick to one palette for the entire output — no warm/cool gray fluctuations.

#### Layout rules

- Contain page layouts: `max-w-[1400px] mx-auto` or `max-w-7xl`.
- Full-height sections: ALWAYS `min-h-[100dvh]`, NEVER `h-screen` (iOS Safari layout jump).
- Grid over Flex math: NEVER `w-[calc(33%-1rem)]`, ALWAYS `grid grid-cols-1 md:grid-cols-3 gap-6`.
- When VARIANCE > 4: centered Hero/H1 sections are BANNED. Use split-screen, left-aligned, or asymmetric whitespace.

#### Materiality and shadows

- Use cards ONLY when elevation communicates hierarchy. Tint shadows to background hue.
- When DENSITY > 7: generic card containers are BANNED. Group with `border-t`, `divide-y`, or negative space.

### Step 4: Implement interaction model

For each primary interaction define: initial state → user action → visible feedback → loading/error/empty behavior.

#### Mandatory interaction states

- **Loading:** Skeletal loaders matching layout dimensions — avoid generic circular spinners.
- **Empty:** Beautifully composed empty states indicating how to populate.
- **Error:** Clear inline error reporting (forms: label above, error below, `gap-2`).
- **Tactile feedback:** On `:active`, apply `-translate-y-[1px]` or `scale-[0.98]` for physical push feel.

#### Motion engineering (when MOTION > 3)

- **Spring physics:** No linear easing. Use `type: "spring", stiffness: 100, damping: 20`.
- **Layout transitions:** Use Framer Motion `layout` and `layoutId` for smooth re-ordering and shared element transitions.
- **Staggered reveals:** Use `staggerChildren` or CSS `animation-delay: calc(var(--index) * 100ms)` — parent and children MUST reside in the same Client Component tree.
- **Magnetic hover (MOTION > 5):** Use EXCLUSIVELY `useMotionValue` and `useTransform` — NEVER `useState` for continuous cursor-tracking animations.
- **Perpetual micro-interactions (MOTION > 5):** Embed infinite loops (Pulse, Typewriter, Float, Shimmer) in standard components. Memoize (`React.memo`) and isolate in microscopic Client Components.

Ensure keyboard and screen-reader pathways remain valid for all interactions.

#### Advanced concepts

For high-end interaction patterns (Parallax Tilt, Spotlight Border, Magnetic Button, Bento grids, scroll-triggered sequences, etc.), consult `references/creative-arsenal.md`.

For SaaS dashboard Bento architecture and perpetual-motion card archetypes, consult `references/bento-paradigm.md`.

### Step 5: Verify UI quality

Minimum checks:

- desktop/mobile responsiveness
- interaction correctness across all states
- visual consistency with chosen direction and dials
- accessibility baseline (focus visibility, semantic controls, keyboard nav)

Output:

```text
INTERACTION_CHECKS
- scenario: "<user action>"
  expected: "<visible outcome>"
  status: <pass|fail|pending>
```

When interactive verification cannot run in the current environment, emit `TOOL_BRIDGE` using
`skills/base/planning/references/executable-evidence-bridge.md` for a reproducible UI check script.

## Performance Guardrails

- **Hardware acceleration:** Never animate `top`, `left`, `width`, `height`. Animate exclusively via `transform` and `opacity`.
- **DOM cost:** Grain/noise filters go on fixed `pointer-events-none` pseudo-elements only — never on scrolling containers.
- **Z-index restraint:** Use z-indexes strictly for systemic layers (sticky nav, modals, overlays). No arbitrary `z-50` spam.
- **GPU isolation:** CPU-heavy perpetual animations MUST live in their own isolated Client Components.
- **`useEffect` cleanup:** All animation effects MUST contain strict cleanup functions.
- **`will-change`:** Use sparingly and only on actively animating elements.

## Anti-Patterns (banned)

### Visual and CSS

- Neon/outer glows — use inner borders or tinted shadows instead.
- Pure `#000000` — use Off-Black, Zinc-950, or Charcoal.
- Oversaturated accents — desaturate to blend with neutrals.
- Excessive gradient text on large headers.
- Custom mouse cursors — performance and accessibility harm.
- Emojis in code, markup, or text content — replace with Phosphor/Radix icons or clean SVG.

### Typography

- `Inter` font for premium/creative contexts.
- Serif fonts on Dashboards.
- Oversized H1s — control hierarchy with weight and color, not just scale.

### Layout

- `h-screen` for full-height sections.
- Complex flex percentage math (`w-[calc(33%-1rem)]`).
- 3-column equal-width card rows — use zig-zag, asymmetric grid, or horizontal scroll.
- Centered Hero when VARIANCE > 4.

### Content (the "Jane Doe" effect)

- Generic placeholder names ("John Doe", "Sarah Chan") — use creative realistic names.
- Generic SVG avatars — use styled photo placeholders or `picsum.photos/seed/{id}/`.
- Predictable numbers (`99.99%`, `50%`) — use organic data (`47.2%`, `+1 (312) 847-1928`).
- Startup slop names ("Acme", "Nexus") — invent premium contextual brands.
- AI copywriting clichés ("Elevate", "Seamless", "Unleash", "Next-Gen") — use concrete verbs.
- Broken Unsplash links — use `https://picsum.photos/seed/{id}/800/600` or SVG avatars.

### Architecture

- Defaulting to generic UI patterns without explicit direction.
- Mixing multiple conflicting visual styles in one surface.
- Decorative motion that harms readability or task completion.
- Ignoring mobile behavior when changing layout structure.
- Sacrificing accessibility for visual novelty.
- Using `shadcn/ui` in generic default state — MUST customize radii, colors, shadows.
- Mixing GSAP/ThreeJS with Framer Motion in the same component tree.

## Pre-Flight Checklist

Before emitting final code, verify:

- [ ] Global state used appropriately (not arbitrarily)?
- [ ] Mobile collapse (`w-full`, `px-4`, `max-w-7xl mx-auto`) for high-variance designs?
- [ ] Full-height sections use `min-h-[100dvh]`?
- [ ] `useEffect` animations contain strict cleanup?
- [ ] Empty, loading, and error states provided?
- [ ] Cards omitted where spacing suffices?
- [ ] Perpetual animations isolated in own Client Components?
- [ ] Keyboard and screen-reader pathways remain valid?

## Stop Conditions

- Product/design constraints are missing and direction cannot be chosen safely.
- Existing design system forbids requested visual changes.
- Required assets (fonts/brand tokens) are unavailable.
- Verification is blocked and no meaningful `TOOL_BRIDGE` can be produced.

When blocked, report exact missing constraints or assets.

## Example

Input:

```text
"Design and implement a pricing hero that feels editorial and premium."
```

Expected workflow:

1. emit `DESIGN_DIRECTION` (`editorial/magazine`, VARIANCE=8, MOTION=6, DENSITY=4).
2. define typography (`Satoshi` + `Geist Mono`) and color tokens (Zinc base, Emerald accent).
3. implement asymmetric split-screen layout with measured spring transitions.
4. implement loading skeleton, empty state, error inline feedback.
5. return `INTERACTION_CHECKS` and responsive verification notes.
