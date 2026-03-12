// canvas-engine.js — Spatial layout engine for JIT-UI canvas
// Pan/zoom, ring-based radial placement, SVG connections, camera control

const CanvasEngine = (() => {

  // --- Config ---
  const RING_RADII = [0, 300, 600, 880, 1100];
  const MIN_SCALE = 0.3;
  const MAX_SCALE = 2.0;
  const TRANSITION_MS = 600;
  const NUDGE_DISTANCE = 40;

  // --- State ---
  let viewport, world, svgLayer;
  let transform = { x: 0, y: 0, scale: 1 };
  let blocks = new Map(); // id → { el, ring, angle, x, y }
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

    // Mouse/trackpad events
    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', onPointerUp);
    viewport.addEventListener('pointercancel', onPointerUp);
    viewport.addEventListener('wheel', onWheel, { passive: false });

    window.addEventListener('resize', recalcCenter);
  }

  function recalcCenter() {
    if (!viewport) return;
    worldCenter.x = viewport.clientWidth / 2;
    worldCenter.y = viewport.clientHeight / 2;
  }

  // --- Pan/Zoom ---
  function onPointerDown(e) {
    // Ignore if clicking on interactive elements
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

    // Start slightly inward and transparent for animation
    element.style.opacity = '0';
    element.style.transform = 'translate(-50%, -50%) scale(0.85)';

    world.appendChild(element);

    const entry = { el: element, ring, metadata, x: 0, y: 0, angle: 0 };
    blocks.set(id, entry);

    // Recalculate positions for all blocks on this ring
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
    const ringBlocks = [...blocks.values()].filter(b => b.ring === ring);
    const count = ringBlocks.length;
    if (count === 0) return;

    const radius = RING_RADII[ring] || ring * 240;

    if (ring === 0) {
      // Center block — always at origin
      for (const b of ringBlocks) {
        b.x = 0;
        b.y = 0;
        b.angle = 0;
        positionElement(b);
      }
      return;
    }

    // Distribute evenly around the ring
    // Start from top (-90°) and go clockwise
    const startAngle = -Math.PI / 2;
    const angleStep = (2 * Math.PI) / count;

    for (let i = 0; i < count; i++) {
      const b = ringBlocks[i];
      b.angle = startAngle + i * angleStep;
      b.x = Math.cos(b.angle) * radius;
      b.y = Math.sin(b.angle) * radius;
    }

    // Collision avoidance — nudge overlapping blocks outward
    resolveCollisions(ringBlocks, radius);

    for (const b of ringBlocks) {
      positionElement(b);
    }
  }

  function resolveCollisions(ringBlocks, baseRadius) {
    const MIN_DIST = 300;
    for (let pass = 0; pass < 5; pass++) {
      for (let i = 0; i < ringBlocks.length; i++) {
        for (let j = i + 1; j < ringBlocks.length; j++) {
          const a = ringBlocks[i];
          const b = ringBlocks[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < MIN_DIST && dist > 0) {
            const push = (MIN_DIST - dist) / 2;
            const nx = dx / dist;
            const ny = dy / dist;
            a.x -= nx * push;
            a.y -= ny * push;
            b.x += nx * push;
            b.y += ny * push;
          }
        }
      }
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

    // Compute a control point for a gentle curve
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Perpendicular offset for curve
    const offset = dist * 0.15;
    const cx = mx + (-dy / dist) * offset;
    const cy = my + (dx / dist) * offset;

    const path = document.createElementNS(svgNS, 'path');
    const d = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
    path.setAttribute('d', d);
    path.setAttribute('class', 'connection-path');
    path.setAttribute('fill', 'none');

    // Animate the stroke drawing
    const pathLength = dist * 1.2; // approximate
    path.style.strokeDasharray = pathLength;
    path.style.strokeDashoffset = pathLength;

    g.appendChild(path);

    // Label at midpoint
    if (conn.title) {
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', cx);
      label.setAttribute('y', cy - 8);
      label.setAttribute('class', 'connection-label');
      label.setAttribute('text-anchor', 'middle');
      label.textContent = conn.title;
      g.appendChild(label);
    }

    // Step dots along the path
    if (conn.steps && conn.steps.length > 0) {
      const stepCount = conn.steps.length;
      for (let i = 0; i < stepCount; i++) {
        const t = (i + 1) / (stepCount + 1);
        // Quadratic bezier point
        const px = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
        const py = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;

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
    for (const b of blocks.values()) {
      minX = Math.min(minX, b.x - 180);
      maxX = Math.max(maxX, b.x + 180);
      minY = Math.min(minY, b.y - 100);
      maxY = Math.max(maxY, b.y + 100);
    }

    recalcCenter();
    // Account for action drawer (380px right) and narrative panel (left)
    const drawerOpen = document.querySelector('.action-drawer.open');
    const availW = viewport.clientWidth - (drawerOpen ? 380 : 0);
    const availH = viewport.clientHeight - 80; // bottom input bar

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
