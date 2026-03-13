# INTENT: Grid Layout for Infinite Canvas

## Goal
Replace the chaotic radial/polar layout with a structured grid-based row layout following Gestalt principles (hierarchy, proximity, alignment) to make the canvas comprehensible to humans.

## Current Direction
Implemented a top-down hierarchical row layout:
- Person card at origin (0,0) — top of the hierarchy
- Each ring type maps to a horizontal row at a fixed Y offset
- Cards within rows are evenly spaced and centered
- Impacts sorted by severity (critical first)
- Subtle grid dot background provides visual structure
- S-curve connections flow from person card downward to targets

## What's Done
1. **Grid infrastructure**: Visual dot grid at 200px intervals (CSS background pattern on a grid-layer div)
2. **Row-based layout**: Replaced `redistributeRing()` — rings become horizontal rows at fixed Y offsets (0, 300, 600, 940, 1300)
3. **Severity sorting**: Impact cards (ring 2) sorted by severity — critical leftmost
4. **Row wrapping**: If a row exceeds 1800px, cards wrap to a second line
5. **S-curve connections**: Replaced perpendicular-offset beziers with vertical cubic bezier S-curves for top-down flow
6. **Connection label repositioning**: Labels placed at 75% along curve (near target) instead of midpoint
7. **Ring-aware zoomToFit**: Uses per-ring size estimates for accurate bounding box
8. **Visual refinements**: Thinner/more transparent connection lines and dots, subtle grid

## Rejected Approaches
- **Pure grid snapping** (snap every card to absolute grid coordinates): Cards of different sizes don't snap cleanly. The row-based layout achieves alignment without snapping artifacts.
- **Manhattan routing** for connections: Overkill for this case. S-curves look natural with the vertical layout.
- **Zone labels** ("METRICS", "IMPACT ANALYSIS" etc.): Adds visual noise and would be wrong if certain block types aren't present in a query response.

## Open Questions
- Connection lines through the metrics area still create some visual noise — consider hiding labels or only showing on hover
- Relationship map can get clipped by the input bar on smaller viewports
- Could add subtle row divider lines or zone backgrounds for additional structure

## Next Steps
- Consider connection label truncation or hover-reveal
- Test with edge cases (many items per row, missing row types)
- Potential: add subtle row zone backgrounds for grouping emphasis
