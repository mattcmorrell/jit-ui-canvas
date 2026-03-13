# INTENT: User-Directed Progressive Disclosure

## Goal
Replace the "dump 8-15 blocks at once" model with a **progressive disclosure canvas** where the user pulls threads. Each click reveals more, and the canvas grows organically as an exploration trail. The user directs the investigation, not the AI.

**Key interaction**: User types query → seed card + prompt chips appear → click a prompt → focused response + new prompts → click deeper → canvas grows as a tree of discoveries.

## Current Direction

### Interaction Model
1. **Seed**: User types "Raj Patel just resigned" → AI returns person card + metrics + 4-6 clickable prompt chips
2. **Explore**: Click a prompt → it highlights, others dim → spinner → AI returns focused answer (1-3 blocks) + new prompts
3. **Scenario**: AI presents choices (e.g., 3 candidate interim managers as dashed-border cards) → click one → AI returns consequences
4. **Re-focus**: Click any explored node → its unexplored prompts reappear
5. **Actions**: User choices accumulate in a decisions panel (right edge)

### Data Model
Each thing on the canvas is a **node** in an exploration tree:
```
Node { id, type, parentId, direction, data, el, status }
Types: seed | prompt | response | options | option | fyi | loading
Directions: below (vertical flow) | right (branching)
```

### Layout
- **Column 0**: main vertical flow — seed → selected prompt → response → next prompt → response → ...
- **Column 1+**: branches to the right — action prompts, option groups, FYI consequences
- Each node positioned relative to parent: "below" = same column, "right" = next column
- `layoutAll()` walks the tree and assigns positions; later siblings pushed down

### Architecture
- **`/api/explore` SSE endpoint**: Same tool loop as `/api/chat/stream` but different system prompt (focused, small responses) and response format `{ blocks, prompts, options }`
- **`app.js`**: Full rewrite — node tree state, `startExploration()`, `explorePrompt()`, `exploreOption()`, `refocus()`, `layoutAll()`
- **Prompt categories**: "consequence" (below, main flow) vs "action" (right, branching)
- **Decisions panel**: Replaces action drawer — accumulates choices and action items

## What's Done
1. **`/api/explore` SSE endpoint** in server.js — progressive disclosure system prompt, max 5 tool iterations, forced final response if tools exhaust, `sendExploreResponse()` helper for JSON parsing
2. **`app.js` full rewrite** — node tree with `canvasNodes` Map, layout algorithm walking tree to assign column/row positions, renderers for seed card, prompt chips, response content, person grid, info list, FYI blocks, option cards, loading spinner
3. **`canvas-engine.js` additions** — `moveBlock(id, x, y, animate)` for pixel repositioning, `setBlockVisible(id, visible)` for dim/show, `removeBlock(id)` for cleanup, `.disclosure-node` in pointer-down exclusion
4. **`styles.css` new components** (~300 lines) — seed card, prompt chips (consequence=blue border, action=green border), response content, person grid (2-col with avatars), info list, FYI blocks (severity colors), option cards (dashed border → solid on hover), loading spinner, decisions panel
5. **`index.html` updates** — new suggestion chips, decisions panel replaces action drawer, removed unused center-placeholder and SVG connections
6. **Verified working**: 3-level deep exploration tested — seed → impact analysis → direct reports grid. Person grid renders with photos. Prompt focus/dim works. Layout algorithm correctly places below/right children.

### New Block Types
- `person_grid` — compact 2-col grid of people with avatars (for direct reports, team members)
- `info_list` — key-value list (for checklists, details)
- `fyi` — severity-colored info/warning block (for consequences, warnings)

## What We Kept
- `canvas-engine.js` — pan/zoom/addBlock/zoomToFit/focusOn (all reused, plus new methods)
- `primitives.js` — chart renderers, avatarHtml helper, parseMarkdown, existing block renderers (impact_card, cascade_path, metric_row used inside response-content)
- `server.js` graph tools — all 9 tools reused as-is
- Express server structure, conversation state management

## Rejected Approaches
- **Radial/polar layout**: Scattered cards with no hierarchy.
- **Dump-all-blocks-at-once**: Current model where AI returns 8-15 blocks. Too overwhelming, no user agency.
- **custom_visual (LLM-generated HTML)**: Model couldn't generate escaped HTML in JSON.
- **MAX_TOOL_CALLS = 3**: Too low — model needs search + impact_radius + final response. Increased to 5 with forced `tool_choice: 'none'` fallback.

## Open Questions
- Should clicking a person in the person_grid trigger an exploration? (e.g., click Derek Lin → show Derek's profile + prompts)
- Options/scenario flow needs live testing — no scenario has triggered options yet
- Should the old `/api/chat/stream` endpoint be removed or kept for backwards compatibility?
- Right-column stacking gets visually dense with many exploration levels — need to test with 4+ levels deep

## Next Steps
1. Test options/scenario flow (interim manager selection)
2. Polish prompt chip sizing — they're functional but could be more compact
3. Add click-to-explore on person grid cards
4. Test refocus flow more thoroughly (click back on seed, explore a different prompt)
5. Consider animation polish — staggered chip appearance, smooth camera tracking
6. Remove old `/api/chat/stream` and legacy app.js code paths if this direction is confirmed
