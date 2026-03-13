// canvas-engine.js — Grid-based spatial layout engine for JIT-UI canvas
// Structured row layout, pan/zoom, SVG connections, camera control

const CanvasEngine = (() => {

  // --- Grid Config ---
  const GRID_SIZE = 200;     // Visual grid dot spacing (px)
  const MIN_SCALE = 0.3;
  const MAX_SCALE = 2.0;
  const TRANSITION_MS = 600;

  // Row layout configuration per ring index
  // y: vertical center of this row (world coords, person at origin)
  // cardW: estimated card width for spacing calculation
  // gap: horizontal gap between cards in the row
  // rowGap: vertical offset when a row wraps to a second line
  const ROW_CONFIG = [
    { y: 0,    cardW: 360, gap: 0,  rowGap: 0   },   // Ring 0: Person (centered)
    { y: 300,  cardW: 150, gap: 50, rowGap: 120  },   // Ring 1: Metrics
    { y: 600,  cardW: 260, gap: 60, rowGap: 200  },   // Ring 2: Impacts
    { y: 940,  cardW: 240, gap: 60, rowGap: 180  },   // Ring 3: Cascades
    { y: 1300, cardW: 480, gap: 80, rowGap: 440  },   // Ring 4: Rel Maps
  ];

  const MAX_ROW_WIDTH = 1800; // Wrap to next line if row exceeds this

  // --- State ---
  let viewport, world, svgLayer;
  let transform = { x: 0, y: 0, scale: 1 };
  let blocks = new Map(); // id → { el, ring, x, y, metadata }
  let connections = [];
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let panOrigin = { x: 0, y: 0 };
  let worldCenter = { x: 0, y: 0 };
  let animationFrame = null;

  // --- Init ---
  function init(viewportEl, worldEl, svgEl) {
    viewport = viewportEl;
    world = worldEl;
    svgLayer = svgEl;

    // Center the world in the viewport
    recalcCenter();
    transform.x = worldCenter.x;
    transform.y = worldCenter.y;
    applyTransform();

    // Create visual grid layer
    createGridLayer();

    // Mouse/trackpad events
    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', onPointerUp);
    viewport.addEventListener('pointercancel', onPointerUp);
    viewport.addEventListener('wheel', onWheel, { passive: false });

    window.addEventListener('resize', recalcCenter);
  }

  function createGridLayer() {
    const grid = document.createElement('div');
    grid.className = 'grid-layer';
    world.insertBefore(grid, world.firstChild);
  }

  function recalcCenter() {
    if (!viewport) return;
    worldCenter.x = viewport.clientWidth / 2;
    worldCenter.y = viewport.clientHeight / 2;
  }

  // --- Pan/Zoom ---
  function onPointerDown(e) {
    if (e.target.closest('.spatial-block, .narrative-panel, .action-drawer, .input-bar-wrapper, .empty-state, .suggestion-chip, button, a, input')) return;
    isPanning = true;
    panStart.x = e.clientX;
    panStart.y = e.clientY;
    panOrigin.x = transform.x;
    panOrigin.y = transform.y;
    viewport.style.cursor = 'grabbing';
    viewport.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!isPanning) return;
    transform.x = panOrigin.x + (e.clientX - panStart.x);
    transform.y = panOrigin.y + (e.clientY - panStart.y);
    applyTransform();
  }

  function onPointerUp(e) {
    isPanning = false;
    viewport.style.cursor = '';
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Zoom toward cursor
    const delta = -e.deltaY * 0.001;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, transform.scale * (1 + delta)));
    const ratio = newScale / transform.scale;

    transform.x = mx - (mx - transform.x) * ratio;
    transform.y = my - (my - transform.y) * ratio;
    transform.scale = newScale;
    applyTransform();
  }

  function applyTransform() {
    if (!world) return;
    world.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
  }

  // --- Layout ---
  function addBlock(id, element, ring, metadata = {}) {
    element.classList.add('spatial-block');
    element.dataset.blockId = id;
    element.dataset.ring = ring;

    // Start slightly scaled down and transparent for animation
    element.style.opacity = '0';
    element.style.transform = 'translate(-50%, -50%) scale(0.85)';

    world.appendChild(element);

    const entry = { el: element, ring, metadata, x: 0, y: 0 };
    blocks.set(id, entry);

    // Recalculate positions for all blocks on this row
    redistributeRing(ring);

    // Animate in after position is set
    requestAnimationFrame(() => {
      element.style.transition = `left ${TRANSITION_MS}ms cubic-bezier(0.16,1,0.3,1), top ${TRANSITION_MS}ms cubic-bezier(0.16,1,0.3,1), opacity 0.4s ease, transform 0.4s cubic-bezier(0.16,1,0.3,1)`;
      element.style.opacity = '1';
      element.style.transform = 'translate(-50%, -50%) scale(1)';
    });

    // Update connections after layout
    requestAnimationFrame(() => updateAllConnections());

    return entry;
  }

  function redistributeRing(ring) {
    let ringBlocks = [...blocks.values()].filter(b => b.ring === ring);
    const count = ringBlocks.length;
    if (count === 0) return;

    const config = ROW_CONFIG[ring] || {
      y: ring * 300,
      cardW: 260,
      gap: 60,
      rowGap: 200
    };

    // Ring 0: person card always at origin
    if (ring === 0) {
      for (const b of ringBlocks) {
        b.x = 0;
        b.y = 0;
        positionElement(b);
      }
      return;
    }

    // Sort impact cards by severity (most critical leftmost)
    if (ring === 2) {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      ringBlocks.sort((a, b) =>
        (order[a.metadata?.severity] ?? 2) - (order[b.metadata?.severity] ?? 2)
      );
    }

    const step = config.cardW + config.gap;
    const maxPerRow = Math.max(1, Math.floor((MAX_ROW_WIDTH + config.gap) / step));

    for (let i = 0; i < count; i++) {
      const rowIdx = Math.floor(i / maxPerRow);
      const colIdx = i % maxPerRow;
      const countInRow = Math.min(maxPerRow, count - rowIdx * maxPerRow);

      const b = ringBlocks[i];
      b.x = (colIdx - (countInRow - 1) / 2) * step;
      b.y = config.y + rowIdx * config.rowGap;
      positionElement(b);
    }
  }

  function positionElement(blockEntry) {
    const { el, x, y } = blockEntry;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  // --- Connections (SVG) ---
  function addConnection(sourceId, targetId, steps, title) {
    const conn = { sourceId, targetId, steps, title, el: null };
    connections.push(conn);
    renderConnection(conn);
    return conn;
  }

  function renderConnection(conn) {
    const source = blocks.get(conn.sourceId);
    const target = blocks.get(conn.targetId);
    if (!source || !target) return;

    // Remove old line if exists
    if (conn.el) conn.el.remove();

    const svgNS = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('class', 'connection-group');

    // SVG is offset by 4000px to allow negative coords
    const SVG_OFFSET = 4000;
    const x1 = source.x + SVG_OFFSET, y1 = source.y + SVG_OFFSET;
    const x2 = target.x + SVG_OFFSET, y2 = target.y + SVG_OFFSET;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);

    let pathD, isCubic = false;
    let qcx, qcy;          // quadratic control point
    let cx1, cy1, cx2, cy2; // cubic control points

    if (Math.abs(dy) > 50) {
      // Vertical flow: tight S-curve that hugs source/target
      // Tighter control points avoid crossing intermediate content rows
      isCubic = true;
      const tension = Math.min(100, Math.abs(dy) * 0.2);
      cx1 = x1; cy1 = y1 + tension;
      cx2 = x2; cy2 = y2 - tension;
      pathD = `M ${x1} ${y1} C ${cx1} ${cy1} ${cx2} ${cy2} ${x2} ${y2}`;
    } else {
      // Horizontal or near-horizontal: perpendicular offset curve
      const offset = dist * 0.15;
      const safeDist = dist || 1;
      qcx = (x1 + x2) / 2 + (-dy / safeDist) * offset;
      qcy = (y1 + y2) / 2 + (dx / safeDist) * offset;
      pathD = `M ${x1} ${y1} Q ${qcx} ${qcy} ${x2} ${y2}`;
    }

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('class', 'connection-path');
    path.setAttribute('fill', 'none');

    // Animate the stroke drawing
    const pathLength = dist * 1.2;
    path.style.strokeDasharray = pathLength;
    path.style.strokeDashoffset = pathLength;

    g.appendChild(path);

    // Label near target (75% along curve) to avoid overlapping intermediate rows
    if (conn.title) {
      const lt = 0.75;
      let lx, ly;
      if (isCubic) {
        const mt = 1 - lt;
        lx = mt*mt*mt*x1 + 3*mt*mt*lt*cx1 + 3*mt*lt*lt*cx2 + lt*lt*lt*x2;
        ly = mt*mt*mt*y1 + 3*mt*mt*lt*cy1 + 3*mt*lt*lt*cy2 + lt*lt*lt*y2;
      } else {
        lx = (1-lt)*(1-lt)*x1 + 2*(1-lt)*lt*qcx + lt*lt*x2;
        ly = (1-lt)*(1-lt)*y1 + 2*(1-lt)*lt*qcy + lt*lt*y2;
      }
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', lx + 10);
      label.setAttribute('y', ly - 6);
      label.setAttribute('class', 'connection-label');
      label.setAttribute('text-anchor', 'start');
      label.textContent = conn.title;
      g.appendChild(label);
    }

    // Step dots along the path
    if (conn.steps && conn.steps.length > 0) {
      const stepCount = conn.steps.length;
      for (let i = 0; i < stepCount; i++) {
        const t = (i + 1) / (stepCount + 1);
        let px, py;

        if (isCubic) {
          // Cubic bezier interpolation
          const mt = 1 - t;
          px = mt*mt*mt*x1 + 3*mt*mt*t*cx1 + 3*mt*t*t*cx2 + t*t*t*x2;
          py = mt*mt*mt*y1 + 3*mt*mt*t*cy1 + 3*mt*t*t*cy2 + t*t*t*y2;
        } else {
          // Quadratic bezier interpolation
          px = (1-t)*(1-t)*x1 + 2*(1-t)*t*qcx + t*t*x2;
          py = (1-t)*(1-t)*y1 + 2*(1-t)*t*qcy + t*t*y2;
        }

        const dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('cx', px);
        dot.setAttribute('cy', py);
        dot.setAttribute('r', '4');
        dot.setAttribute('class', 'connection-dot');
        g.appendChild(dot);
      }
    }

    svgLayer.appendChild(g);
    conn.el = g;

    // Trigger the draw animation
    requestAnimationFrame(() => {
      path.style.transition = 'stroke-dashoffset 1s ease-out';
      path.style.strokeDashoffset = '0';
    });
  }

  function updateAllConnections() {
    for (const conn of connections) {
      renderConnection(conn);
    }
  }

  // --- Camera ---
  function panTo(x, y, animate = true) {
    recalcCenter();
    const targetX = worldCenter.x - x * transform.scale;
    const targetY = worldCenter.y - y * transform.scale;

    if (animate) {
      animateTransform(targetX, targetY, transform.scale);
    } else {
      transform.x = targetX;
      transform.y = targetY;
      applyTransform();
    }
  }

  function zoomToFit(padding = 80) {
    if (blocks.size === 0) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    // Use ring-aware size estimates for accurate bounds
    const RING_HALF_W = [200, 90, 150, 140, 260];
    const RING_HALF_H = [130, 60, 110, 100, 220];
    for (const b of blocks.values()) {
      const hw = RING_HALF_W[b.ring] || 150;
      const hh = RING_HALF_H[b.ring] || 100;
      minX = Math.min(minX, b.x - hw);
      maxX = Math.max(maxX, b.x + hw);
      minY = Math.min(minY, b.y - hh);
      maxY = Math.max(maxY, b.y + hh);
    }

    recalcCenter();
    // Account for action drawer (380px right) and narrative panel (left)
    const drawerOpen = document.querySelector('.action-drawer.open');
    const availW = viewport.clientWidth - (drawerOpen ? 380 : 0);
    const availH = viewport.clientHeight - 130; // bottom input bar + gradient

    const contentW = maxX - minX + padding * 2;
    const contentH = maxY - minY + padding * 2;
    const scaleX = availW / contentW;
    const scaleY = availH / contentH;
    const newScale = Math.max(MIN_SCALE, Math.min(1.0, Math.min(scaleX, scaleY)));

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    // Shift center leftward to account for drawer
    const effectiveCenterX = (drawerOpen ? (availW / 2) : worldCenter.x);
    const effectiveCenterY = worldCenter.y - 20; // nudge up for input bar
    const targetX = effectiveCenterX - cx * newScale;
    const targetY = effectiveCenterY - cy * newScale;

    animateTransform(targetX, targetY, newScale);
  }

  function focusOn(id, scale) {
    const b = blocks.get(id);
    if (!b) return;
    const targetScale = scale || Math.max(0.8, transform.scale);
    recalcCenter();
    const targetX = worldCenter.x - b.x * targetScale;
    const targetY = worldCenter.y - b.y * targetScale;
    animateTransform(targetX, targetY, targetScale);
  }

  function animateTransform(targetX, targetY, targetScale, duration = 600) {
    const startX = transform.x;
    const startY = transform.y;
    const startScale = transform.scale;
    const startTime = performance.now();

    if (animationFrame) cancelAnimationFrame(animationFrame);

    function step(now) {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / duration);
      // Ease out cubic
      const ease = 1 - Math.pow(1 - t, 3);

      transform.x = startX + (targetX - startX) * ease;
      transform.y = startY + (targetY - startY) * ease;
      transform.scale = startScale + (targetScale - startScale) * ease;
      applyTransform();

      if (t < 1) {
        animationFrame = requestAnimationFrame(step);
      } else {
        animationFrame = null;
      }
    }
    animationFrame = requestAnimationFrame(step);
  }

  // --- Reset ---
  function reset() {
    // Remove all blocks
    for (const b of blocks.values()) {
      b.el.remove();
    }
    blocks.clear();

    // Remove all connections
    for (const c of connections) {
      if (c.el) c.el.remove();
    }
    connections.length = 0;

    // Clear SVG
    while (svgLayer.firstChild) svgLayer.firstChild.remove();

    // Reset camera
    recalcCenter();
    transform.x = worldCenter.x;
    transform.y = worldCenter.y;
    transform.scale = 1;
    applyTransform();
  }

  // --- Getters ---
  function getBlock(id) {
    return blocks.get(id);
  }

  function getBlockCount() {
    return blocks.size;
  }

  return {
    init,
    addBlock,
    addConnection,
    panTo,
    zoomToFit,
    focusOn,
    reset,
    getBlock,
    getBlockCount
  };

})();
