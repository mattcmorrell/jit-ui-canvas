# INTENT: Brick Grid Canvas

## Goal
Transform the infinite canvas from scattered individual cards into a **brick grid** system where content is organized into **sections** that pack tightly internally and use **whitespace gaps** between them to communicate hierarchy and relationships. No connection lines — the grid IS the information architecture.

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
  - `action_list` → stays in the drawer (not on canvas)
  - `narrative` → stays in the floating panel

## What's Done
1. **canvas-engine.js** — Rewritten as brick grid allocator. API: `addBlock(id, el, col, row)`, `addSection(id, col, row, title)`, `addToSection(sectionId, el)`. All SVG connection code removed. Pan/zoom/camera preserved.
2. **app.js** — `placeBlock()` rewritten for section-based placement. Person card at (0,0), impacts section at (5,0), cascades at (0,6), relationship map at (5,6). Metrics rendered as chips inside person card.
3. **primitives.js** — Added `renderMetricChips(metrics)` for inline metric display inside person card.
4. **styles.css** — Added `.canvas-block`, `.canvas-section`, `.section-title`, `.section-body`, `.metric-chips`, `.metric-chip` styles. Grid dots updated to 96px. Removed `.spatial-block` and `.connection-*` styles.
5. Grid dot background updated to 96px brick spacing.
6. SVG connection layer fully removed from rendering pipeline.

## Rejected Approaches
- **Radial/polar layout**: Scattered cards with no hierarchy. Replaced in previous iteration.
- **Row-based layout with connection lines**: Better than radial, but still individual floating cards with SVG connections creating visual noise. The wireframe shows a cleaner model — sections with containment.
- **Killing the canvas entirely**: User explicitly wants the canvas (pan/zoom) preserved. The grid lives ON the canvas.

## Open Questions
- Detail panel interaction: click scenario → detail panel appears in bottom-right of grid. Close with X. How does this affect the brick allocator?
- How to handle blocks arriving incrementally via SSE — sections may need to resize as children arrive
- Should sections have a max width or grow indefinitely?

## Next Steps
1. Fine-tune section widths (impacts section cards are narrow/tall — may want min-width or grid layout in section body)
2. Adjust grid coordinates so sections don't overlap at different content volumes
3. Add click-to-expand detail panel (click impact → detail appears at bottom-right)
4. Consider dynamic brick allocator that auto-places sections based on occupied cells
