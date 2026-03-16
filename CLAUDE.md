# JIT-UI Canvas

> **Before starting work, read `../KNOWLEDGE.md`** for the three-experiment research framework. This project is **Experiment 1: Progressive Disclosure**. Stay focused on the interaction model — visual polish and component architecture are Experiment 2's job.

## What This Is

A progressive disclosure canvas where the user types a question, gets a seed card + prompt chips, and pulls threads to explore deeper. The AI builds responses one focused step at a time. The canvas grows as a tree of discoveries.

## This Experiment's Question

Is "pull a thread, get a focused answer, pull another" the right interaction model for exploring graph data?

## Tech Stack

- **Server:** Node.js + Express, port 3456
- **LLM:** OpenAI SDK + dotenv
- **Frontend:** Plain HTML/CSS/JS, no frameworks
- **Canvas:** Custom pan/zoom engine (`canvas-engine.js`)
- **Data:** EE graph fetched from GitHub Pages at startup

## Data Source

Acme Co Employee Experience Graph (~648 nodes, ~3,104 edges).

- Nodes: `https://mattcmorrell.github.io/ee-graph/data/nodes.json`
- Edges: `https://mattcmorrell.github.io/ee-graph/data/edges.json`

## Key Files

- `server.js` — Express server, graph loading/indexing, 9 graph query tools, `/api/explore` SSE endpoint
- `public/app.js` — Exploration tree state, layout algorithm, all renderers, interaction handlers
- `public/canvas-engine.js` — Pan/zoom, block placement, camera controls
- `public/primitives.js` — Shared renderers (charts, avatars, markdown)
- `public/styles.css` — All styling including disclosure-specific components
- `public/index.html` — Entry point

## Decision Journal

When `product-decisions.json` exists in the project root:

**Auto-start server:** At the beginning of a session, check if port 3334 is in use (`lsof -ti:3334`). If not, start the journal server in the background: `node decision-journal-server.js &`. Don't mention this to the user unless it fails.

**Auto-update journal:** As you work, maintain `product-decisions.json`:
- When a significant decision is made → add a `decisions` entry with reasoning
- When a new solution or approach is explored → add a `solutions` entry
- When an experiment is run → add an `experiments` entry
- When an approach is rejected, deferred, or chosen → update the entry's `status`
- Always capture `reasoning` — the WHY, not just the what
- Never delete entries — change `status` instead
- Update `lastUpdated` when making changes
