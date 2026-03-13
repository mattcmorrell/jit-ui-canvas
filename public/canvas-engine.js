// canvas-engine.js — Brick grid spatial engine for JIT-UI canvas
// Sections + blocks snap to a brick grid. Pan/zoom. No connection lines.

const CanvasEngine = (() => {

  // --- Brick Grid Config ---
  const BRICK = 96;           // 1 brick = 96px (atomic grid unit)
  const MIN_SCALE = 0.3;
  const MAX_SCALE = 2.0;

  // --- State ---
  let viewport, world;
  let transform = { x: 0, y: 0, scale: 1 };
  let blocks = new Map();     // id → { el, col, row }
  let sections = new Map();   // id → { el, col, row, bodyEl }
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let panOrigin = { x: 0, y: 0 };
  let worldCenter = { x: 0, y: 0 };
  let animationFrame = null;

  // --- Init ---
  function init(viewportEl, worldEl) {
    viewport = viewportEl;
    world = worldEl;

    recalcCenter();
    transform.x = worldCenter.x;
    transform.y = worldCenter.y;
    applyTransform();

    createGridLayer();

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
    if (e.target.closest('.canvas-block, .canvas-section, .narrative-panel, .action-drawer, .input-bar-wrapper, .empty-state, .suggestion-chip, button, a, input')) return;
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

  function onPointerUp() {
    isPanning = false;
    viewport.style.cursor = '';
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

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

  // --- Blocks (standalone elements on the brick grid) ---
  function addBlock(id, element, col, row) {
    element.classList.add('canvas-block');
    element.dataset.blockId = id;
    element.style.left = `${col * BRICK}px`;
    element.style.top = `${row * BRICK}px`;
    element.style.opacity = '0';
    element.style.transform = 'scale(0.95)';

    world.appendChild(element);

    const entry = { el: element, col, row };
    blocks.set(id, entry);

    requestAnimationFrame(() => {
      element.style.transition = 'opacity 0.4s ease, transform 0.4s cubic-bezier(0.16,1,0.3,1)';
      element.style.opacity = '1';
      element.style.transform = 'scale(1)';
    });

    return entry;
  }

  // --- Sections (titled containers that hold child elements) ---
  function addSection(id, col, row, title) {
    const el = document.createElement('div');
    el.className = 'canvas-section';
    el.dataset.sectionId = id;
    el.style.left = `${col * BRICK}px`;
    el.style.top = `${row * BRICK}px`;
    el.style.opacity = '0';
    el.style.transform = 'scale(0.97)';

    if (title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'section-title';
      titleEl.textContent = title;
      el.appendChild(titleEl);
    }

    const bodyEl = document.createElement('div');
    bodyEl.className = 'section-body';
    el.appendChild(bodyEl);

    world.appendChild(el);

    const entry = { el, col, row, bodyEl };
    sections.set(id, entry);

    requestAnimationFrame(() => {
      el.style.transition = 'opacity 0.4s ease, transform 0.4s cubic-bezier(0.16,1,0.3,1)';
      el.style.opacity = '1';
      el.style.transform = 'scale(1)';
    });

    return entry;
  }

  function addToSection(sectionId, element) {
    const section = sections.get(sectionId);
    if (!section) return;
    section.bodyEl.appendChild(element);
  }

  // --- Getters ---
  function getBlock(id) {
    return blocks.get(id);
  }

  function getSection(id) {
    return sections.get(id);
  }

  function getBlockCount() {
    return blocks.size + sections.size;
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
    const elements = world.querySelectorAll('.canvas-block, .canvas-section');
    if (elements.length === 0) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const el of elements) {
      const x = parseFloat(el.style.left) || 0;
      const y = parseFloat(el.style.top) || 0;
      const w = el.offsetWidth || 300;
      const h = el.offsetHeight || 200;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x + w);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + h);
    }

    recalcCenter();
    const drawerOpen = document.querySelector('.action-drawer.open');
    const availW = viewport.clientWidth - (drawerOpen ? 380 : 0);
    const availH = viewport.clientHeight - 130;

    const contentW = maxX - minX + padding * 2;
    const contentH = maxY - minY + padding * 2;
    const scaleX = availW / contentW;
    const scaleY = availH / contentH;
    const newScale = Math.max(MIN_SCALE, Math.min(1.0, Math.min(scaleX, scaleY)));

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const effectiveCenterX = drawerOpen ? (availW / 2) : worldCenter.x;
    const effectiveCenterY = worldCenter.y - 20;
    const targetX = effectiveCenterX - cx * newScale;
    const targetY = effectiveCenterY - cy * newScale;

    animateTransform(targetX, targetY, newScale);
  }

  function focusOn(id, scale) {
    const entry = blocks.get(id) || sections.get(id);
    if (!entry) return;
    const el = entry.el;
    const x = parseFloat(el.style.left) || 0;
    const y = parseFloat(el.style.top) || 0;
    const w = el.offsetWidth || 300;
    const h = el.offsetHeight || 200;
    const cx = x + w / 2;
    const cy = y + h / 2;

    const targetScale = scale || Math.max(0.8, transform.scale);
    recalcCenter();
    const targetX = worldCenter.x - cx * targetScale;
    const targetY = worldCenter.y - cy * targetScale;
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
    for (const b of blocks.values()) b.el.remove();
    blocks.clear();

    for (const s of sections.values()) s.el.remove();
    sections.clear();

    recalcCenter();
    transform.x = worldCenter.x;
    transform.y = worldCenter.y;
    transform.scale = 1;
    applyTransform();
  }

  return {
    init,
    addBlock,
    addSection,
    addToSection,
    getBlock,
    getSection,
    getBlockCount,
    panTo,
    zoomToFit,
    focusOn,
    reset,
    BRICK
  };

})();
