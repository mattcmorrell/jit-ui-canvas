# INTENT: Brick Grid Canvas

## Goal
Transform the infinite canvas from scattered individual cards into a **brick grid** system where content is organized into **sections** that pack tightly internally and use **whitespace gaps** between them to communicate hierarchy and relationships. No connection lines — the grid IS the information architecture.

**JIT-UI**: The LLM decides what visual format best communicates each insight — bar charts for rankings, donut charts for proportions, timelines for sequences, alongside the existing card types. The frontend renders structured data the LLM emits, not raw HTML.

## Current Direction

### JIT-UI Direction
The current primitives (person_card, impact_card, cascade_path, relationship_map) are hardcoded renderers — they look okay but they're rigid. The goal is to move toward the LLM deciding what visual format each insight needs, not just picking from a fixed menu of card types.

**Charts are the proof of concept.** The LLM emits structured data (`{ chartType: "bar", items: [...] }`) and the frontend renders SVG. This works well — the model picks bar charts for rankings, donuts for breakdowns, timelines for sequences. No hardcoded "if person resigned, show bar chart" logic.

**The question now**: can we extend this pattern to replace the other primitives? Instead of the LLM emitting `{ type: "impact_card", severity: "critical", ... }` that maps to a specific React-like template, could it emit something more flexible — a layout description, a mini visualization spec, or structured content that a smarter renderer interprets?

**`?raw` mode exists to evaluate this.** It strips the styled primitives and shows what the LLM is actually producing — clean text + real charts. This lets us see whether the model's output is good enough to drive visuals directly, or whether we need the primitive layer as a translation step.

**What's working**: Charts, narratives, action lists. The LLM's block composition (choosing what types to emit, in what order) is strong.

**What's not working yet**: The card primitives (person, impact, cascade) are visually mediocre and the model is forced into their rigid schemas. The relationship_map SVG renderer is basic.

### Canvas Infrastructure
**Brick grid allocator** on the infinite canvas:
- 1 brick = 96px (atomic unit)
- Every block snaps to brick coordinates (col, row)
- Sections group related blocks — items pack tight within a section
- Whitespace between sections communicates separation (Gestalt proximity)
  - 0 gap: items within a section (tightly related)
  - 1 brick gap: adjacent sections (related context)
  - 2+ brick gap: separate concept groups
- Canvas still pans/zooms — you're navigating a structured grid, not a scatter plot
- **No SVG connection lines** — relationships expressed through spatial grouping and containment
- Dynamic row tracking (`nextRowLeft`/`nextRowRight`) prevents overlap regardless of content size

### Block → Placement mapping
- `person_card` + `metric_row` → left column
- `impact_card` → "Key Impacts" section, right column
- `cascade_path` → "How It Connects" section, left column
- `relationship_map` → "Organizational Footprint" section, right column
- `chart` / `custom_visual` → placed in whichever column has more room
- `action_list` → stays in the drawer (not on canvas)
- `narrative` → stays in the floating panel

## What's Done
1. **canvas-engine.js** — Brick grid allocator with pan/zoom/camera. API: `addBlock`, `addSection`, `addToSection`. SVG connections removed.
2. **app.js** — Section-based placement with dynamic row tracking. `?raw` mode flag for evaluating LLM output without styled primitives.
3. **primitives.js** — Chart renderers (bar, donut, timeline) as SVG. Hardcoded card primitives (person, impact, cascade, relationship_map, action_list). Metric chips.
4. **styles.css** — Brick grid, chart, raw-mode, and card primitive styles.
5. **server.js** — 8 block types in system prompt. 8 graph tools including `get_org_stats` (aggregate rankings: managers_by_reports, team_sizes, department_sizes, division_sizes, tenure/level/location distributions, skill_coverage). 90s timeout, 6144 token limit.
6. **`?raw` mode** — Append `?raw` to URL. Now uses the same section-based canvas layout as normal mode (person hero top-left, "Key Impacts" section right, "How It Connects" section left, "Organizational Footprint" section bottom-right) but with clean minimal text renderers instead of styled primitives. Charts still render as real SVG. Metric chips inline into person card. Impact cards show severity tags and affected-people pills. Cascade paths render as flow-node chains. Relationship maps show tagged node lists. Narrative panel and action drawer work identically to normal mode.

## Rejected Approaches
- **Radial/polar layout**: Scattered cards with no hierarchy. Replaced in previous iteration.
- **Row-based layout with connection lines**: Better than radial, but still individual floating cards with SVG connections creating visual noise. The wireframe shows a cleaner model — sections with containment.
- **Killing the canvas entirely**: User explicitly wants the canvas (pan/zoom) preserved. The grid lives ON the canvas.
- **custom_visual (LLM-generated HTML in iframe)**: LLM couldn't generate full escaped HTML inside JSON within token/time limits. API calls hung. Replaced with structured chart data approach where LLM emits `{ chartType, items }` and frontend renders SVG.
- **Individual queries for rankings**: Model made 6+ tool calls to query each manager individually for "who has the most reports?", context got huge, final response generation hung. Fixed by adding `get_org_stats` aggregate tool.

## Open Questions
- Can the chart pattern (LLM emits structured data, frontend renders) replace the card primitives too? Or do we need the primitive layer as a translation step?
- What's the right abstraction for the LLM to describe a visual — a layout spec? A mini component DSL? Just richer structured data?
- Should chart blocks be interactive (click a bar → drill into that person)?

## Next Steps
1. Evaluate `?raw` output across multiple scenarios to understand what the LLM is good/bad at composing
2. Design a more flexible rendering approach to replace the rigid card primitives
3. Consider interactive charts (click bar → follow-up query)
4. Clean up debug console.log statements
