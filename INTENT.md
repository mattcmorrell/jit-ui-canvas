# INTENT: Brick Grid Canvas

## Goal
Transform the infinite canvas from scattered individual cards into a **brick grid** system where content is organized into **sections** that pack tightly internally and use **whitespace gaps** between them to communicate hierarchy and relationships. No connection lines — the grid IS the information architecture.

**JIT-UI**: The LLM decides what visual format best communicates each insight — bar charts for rankings, donut charts for proportions, timelines for sequences, alongside the existing card types. The frontend renders structured data the LLM emits, not raw HTML.

## Current Direction
**Brick grid allocator** on the infinite canvas:
- 1 brick = 96px (atomic unit)
- Every block snaps to brick coordinates (col, row)
- Blocks declare their size in bricks based on content type
- Sections group related blocks — items pack tight within a section
- Whitespace between sections communicates separation (Gestalt proximity)
  - 0 gap: items within a section (tightly related)
  - 1 brick gap: adjacent sections (related context)
  - 2+ brick gap: separate concept groups
- Canvas still pans/zooms — you're navigating a structured grid, not a scatter plot
- **No SVG connection lines** — relationships expressed through spatial grouping and containment

### Layout Structure (from wireframe)
```
Person card [3×3]  ·1 gap·  Staffing consequences [6×3]
(metrics inside)             (scenario/impact cards inside)

              ·· 2 gap (vertical) ··

Other consequences [3×2]  ·1 gap·  Detail panel [6×2] (on click)
(cascade/other items)                (appears when scenario selected)
```

### Architecture
- **Section**: A labeled container on the canvas that holds child cards. Positioned at brick coordinates. Has a title, border, internal padding.
- **Brick allocator**: Assigns grid positions to sections. Sections arrive as blocks stream in. Allocator tracks occupied cells and places new sections in the next available position respecting gaps.
- **Block → Section mapping**:
  - `person_card` + `metric_row` → "Person" section (top-left)
  - `impact_card` → "Staffing consequences" section (top-right)
  - `cascade_path` → "Other consequences" section (bottom-left)
  - `relationship_map` → its own section
  - `chart` / `custom_visual` → placed in whichever column has more room
  - `action_list` → stays in the drawer (not on canvas)
  - `narrative` → stays in the floating panel

## What's Done
1. **canvas-engine.js** — Rewritten as brick grid allocator. API: `addBlock(id, el, col, row)`, `addSection(id, col, row, title)`, `addToSection(sectionId, el)`. All SVG connection code removed. Pan/zoom/camera preserved.
2. **app.js** — `placeBlock()` rewritten for section-based placement with dynamic row tracking (`nextRowLeft`/`nextRowRight`). Person card at (0,nextRowLeft), impacts section at (5,nextRowRight), cascades at (0,nextRowLeft), charts placed in column with more room. `advanceRow()` measures DOM heights to prevent overlap.
3. **primitives.js** — Added `renderMetricChips(metrics)` for inline metric display. Added chart rendering: `renderBarChart`, `renderDonutChart`, `renderTimeline` with SVG — LLM emits structured data, frontend renders.
4. **styles.css** — Full brick grid styles, chart styles (bar-row, bar-track, bar-fill, donut-chart, donut-legend, timeline-track, timeline-item), person card hero as horizontal layout with metric chips.
5. **server.js** — 8 block types in system prompt (added `chart` with bar/donut/timeline schemas). Added `get_org_stats` tool for aggregate queries (managers_by_reports, team_sizes, tenure/level/location distributions, skill_coverage). This prevents the model from making dozens of individual queries for ranking-type questions.
6. Grid dot background updated to 96px brick spacing.
7. SVG connection layer fully removed from rendering pipeline.

## Rejected Approaches
- **Radial/polar layout**: Scattered cards with no hierarchy. Replaced in previous iteration.
- **Row-based layout with connection lines**: Better than radial, but still individual floating cards with SVG connections creating visual noise. The wireframe shows a cleaner model — sections with containment.
- **Killing the canvas entirely**: User explicitly wants the canvas (pan/zoom) preserved. The grid lives ON the canvas.
- **custom_visual (LLM-generated HTML in iframe)**: LLM couldn't generate full escaped HTML inside JSON within token/time limits. API calls hung. Replaced with structured chart data approach where LLM emits `{ chartType, items }` and frontend renders SVG.
- **Individual queries for rankings**: Model made 6+ tool calls to query each manager individually for "who has the most reports?", context got huge, final response generation hung. Fixed by adding `get_org_stats` aggregate tool.

## Open Questions
- Detail panel interaction: click scenario → detail panel appears in bottom-right of grid. Close with X. How does this affect the brick allocator?
- More chart types? Scatter, heatmap, stacked bar?
- Should chart blocks be interactive (click a bar → drill into that person)?

## Next Steps
1. Test timeline chart type
2. Add more suggestion chips for chart-style queries
3. Consider interactive charts (click bar → follow-up query)
4. Clean up debug console.log statements
