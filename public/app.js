// app.js — Brick grid canvas: SSE consumption, section-based placement

(() => {
  // --- Raw mode: ?raw in URL shows plain JSON instead of rendered primitives ---
  const RAW_MODE = new URLSearchParams(window.location.search).has('raw');

  // --- DOM refs ---
  const viewport = document.getElementById('viewport');
  const world = document.getElementById('world');
  const emptyState = document.getElementById('empty-state');
  const chatInput = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');
  const suggestionChips = document.getElementById('suggestion-chips');
  const centerPlaceholder = document.getElementById('center-placeholder');
  const actionDrawer = document.getElementById('action-drawer');
  const actionDrawerBody = document.getElementById('action-drawer-body');
  const actionDrawerTab = document.getElementById('action-drawer-tab');
  const statusIndicator = document.getElementById('status-indicator');

  // --- State ---
  let conversationId = null;
  let isStreaming = false;
  let blockCounter = 0;
  let personCardId = null;
  // (insight bar replaces content on each narrative, no accumulation needed)
  let actionDrawerOpen = false;

  // --- Init canvas engine ---
  CanvasEngine.init(viewport, world);

  // --- Extract person name from query for instant placeholder ---
  function extractPersonName(query) {
    // Match patterns like "Raj Patel just resigned", "Tell me about Sarah Chen"
    const patterns = [
      /^(\w+ \w+)\s+(?:just |has |is |was |recently )/i,
      /about\s+(\w+ \w+)/i,
      /^(\w+ \w+)['']s\b/i,
      /^What (?:if|about|happens when) (\w+ \w+)/i,
    ];
    for (const p of patterns) {
      const m = query.match(p);
      if (m) return m[1];
    }
    return null;
  }

  function showCenterPlaceholder(name) {
    if (!name) return;
    centerPlaceholder.style.display = 'flex';
    centerPlaceholder.querySelector('.center-placeholder-name').textContent = name;
    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    centerPlaceholder.querySelector('.center-placeholder-avatar').textContent = initials;
    centerPlaceholder.classList.add('pulsing');
  }

  function hideCenterPlaceholder() {
    centerPlaceholder.style.display = 'none';
    centerPlaceholder.classList.remove('pulsing');
  }

  // --- Narrative count (only show first on canvas) ---
  let narrativeCount = 0;

  // --- Action drawer ---
  function showActionDrawer(block) {
    const el = Primitives.render(block, handleFollowUp);
    if (!el) return;
    actionDrawerBody.innerHTML = '';
    actionDrawerBody.appendChild(el);
    actionDrawer.classList.add('open');
    actionDrawerOpen = true;
  }

  actionDrawerTab.addEventListener('click', () => {
    if (actionDrawerOpen) {
      actionDrawer.classList.remove('open');
      actionDrawerOpen = false;
    } else if (actionDrawerBody.children.length > 0) {
      actionDrawer.classList.add('open');
      actionDrawerOpen = true;
    }
  });

  // --- Status ---
  function showStatus(message) {
    statusIndicator.querySelector('.status-text').textContent = message;
    statusIndicator.style.display = 'flex';
  }

  function clearStatus() {
    statusIndicator.style.display = 'none';
  }

  // --- Follow-up handler ---
  function handleFollowUp(query) {
    if (isStreaming) return;
    chatInput.value = query;
    sendMessage();
  }

  // --- Send message ---
  function sendMessage() {
    const message = chatInput.value.trim();
    if (!message || isStreaming) return;

    isStreaming = true;
    sendBtn.disabled = true;
    chatInput.value = '';

    // Hide empty state
    if (emptyState) emptyState.style.display = 'none';

    // Reset canvas for new query
    CanvasEngine.reset();
    hideCenterPlaceholder();
    blockCounter = 0;
    personCardId = null;
    impactCount = 0;
    cascadeCount = 0;
    nextRowLeft = 0;
    nextRowRight = 0;
    narrativeCount = 0;
    actionDrawer.classList.remove('open');
    actionDrawerOpen = false;
    actionDrawerBody.innerHTML = '';

    // Show instant placeholder for the person
    const name = extractPersonName(message);
    if (name) showCenterPlaceholder(name);

    // Connect to SSE
    const params = new URLSearchParams({ message });
    if (conversationId) params.set('conversation_id', conversationId);

    const eventSource = new EventSource(`/api/chat/stream?${params.toString()}`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case 'status':
            showStatus(data.message);
            break;

          case 'block':
            clearStatus();
            placeBlock(data.block);
            break;

          case 'error':
            clearStatus();
            showStatus('Error: ' + (data.message || 'Something went wrong'));
            break;

          case 'done':
            if (data.conversation_id) conversationId = data.conversation_id;
            clearStatus();
            eventSource.close();
            isStreaming = false;
            sendBtn.disabled = false;
            chatInput.focus();
            // Zoom to fit all content
            setTimeout(() => CanvasEngine.zoomToFit(100), 300);
            break;
        }
      } catch (e) {
        console.error('SSE parse error:', e, event.data);
      }
    };

    eventSource.onerror = () => {
      clearStatus();
      eventSource.close();
      isStreaming = false;
      sendBtn.disabled = false;
      showStatus('Connection lost. Please try again.');
    };
  }

  // --- Place block on brick grid ---
  // Layout uses two columns with dynamic row placement to prevent overlap.
  // Col 0 = left column (person, cascades)
  // Col 0 = left column (person, cascades)
  // Col RIGHT_COL = right column (impacts, relationship map)
  // Rows are computed from actual rendered heights so nothing overlaps.

  let impactCount = 0;
  let cascadeCount = 0;
  const BRICK = CanvasEngine.BRICK;
  const RIGHT_COL = 7; // 672px — clears 610px left sections (2×300px grid + gap)

  // Track the next available row for each column
  let nextRowLeft = 0;   // column 0
  let nextRowRight = 0;  // column RIGHT_COL

  // Recalculate rows AND reflow: push down any elements that overlap
  // due to sections growing as children stream in.
  function recalcRows() {
    const leftEls = [];
    const rightEls = [];
    const all = world.querySelectorAll(':scope > .canvas-block, :scope > .canvas-section');
    for (const el of all) {
      const left = parseFloat(el.style.left) || 0;
      const col = Math.round(left / BRICK);
      if (col < RIGHT_COL) leftEls.push(el);
      else rightEls.push(el);
    }
    nextRowLeft = reflowColumn(leftEls);
    nextRowRight = reflowColumn(rightEls);
  }

  // Sort elements top-to-bottom, push any overlapping ones down, return next available row.
  function reflowColumn(elements) {
    if (elements.length === 0) return 0;
    elements.sort((a, b) => (parseFloat(a.style.top) || 0) - (parseFloat(b.style.top) || 0));
    let nextTop = 0;
    for (const el of elements) {
      const currentTop = parseFloat(el.style.top) || 0;
      if (currentTop < nextTop) {
        el.style.top = `${nextTop}px`;
      }
      const top = parseFloat(el.style.top) || 0;
      const h = el.scrollHeight || el.offsetHeight || 300;
      nextTop = top + h + BRICK; // 1 brick gap between elements
    }
    return Math.ceil(nextTop / BRICK);
  }

  // --- Raw block renderer (for ?raw mode) ---
  // Renders clean readable cards without the full styled primitives.
  // Charts still render as charts. Other blocks get a minimal text layout.
  function renderRawBlock(block) {
    const el = document.createElement('div');
    el.className = 'raw-block';
    const type = block.type;
    const d = block.data || block;

    // Charts render normally — they're already data-driven visuals
    if (type === 'chart' || type === 'custom_visual') {
      return Primitives.renderChart(block);
    }

    switch (type) {
      case 'person_card': {
        const statusClass = d.status === 'terminated' ? 'raw-status-terminated' : 'raw-status-active';
        el.innerHTML = `
          <div class="raw-person-header">
            ${Primitives.avatarHtml(d.avatarUrl, d.name, 'raw-avatar', statusClass)}
            <div class="raw-person-info">
              <div class="raw-block-type">person</div>
              <div class="raw-title">${d.name || 'Unknown'}</div>
              <div class="raw-subtitle">${d.role || ''}${d.level ? ' · ' + d.level : ''}${d.teamName ? ' · ' + d.teamName : ''}</div>
            </div>
          </div>
          <div class="raw-person-meta-row">
            ${d.managerName ? `<span class="raw-meta-tag">↑ ${d.managerName}</span>` : ''}
            ${d.location ? `<span class="raw-meta-tag">◎ ${d.location}</span>` : ''}
            ${d.startDate ? `<span class="raw-meta-tag">Since ${d.startDate}</span>` : ''}
            ${d.directReportCount ? `<span class="raw-meta-tag">${d.directReportCount} reports</span>` : ''}
            ${d.projectCount ? `<span class="raw-meta-tag">${d.projectCount} projects</span>` : ''}
          </div>`;
        break;
      }
      case 'metric_row': {
        const metrics = d.metrics || [];
        el.className = 'raw-metrics-row';
        el.innerHTML = metrics.map(m =>
          `<div class="raw-metric-chip">
            <span class="raw-metric-val">${m.value}</span>
            <span class="raw-metric-label">${m.label}</span>
          </div>`
        ).join('');
        break;
      }
      case 'impact_card': {
        const sev = d.severity || 'medium';
        const people = (d.affectedPeople || []).map(p =>
          `<span class="raw-person-tag">${p.name}</span>`
        ).join('');
        el.innerHTML = `
          <div class="raw-impact-header">
            <span class="raw-severity-tag raw-sev-${sev}">${sev}</span>
            <span class="raw-title">${d.title || ''}</span>
          </div>
          <div class="raw-body">${d.description || ''}</div>
          ${people ? `<div class="raw-people-row">${people}</div>` : ''}`;
        el.classList.add(`raw-severity-${sev}`);
        break;
      }
      case 'cascade_path': {
        const steps = d.steps || [];
        el.innerHTML = `<div class="raw-block-type">cascade</div>
          <div class="raw-title">${d.title || ''}</div>
          <div class="raw-cascade-flow">${steps.map(s =>
            s.edge ? `<span class="raw-flow-edge">→ <em>${s.label}</em></span>`
                   : `<span class="raw-flow-node">${s.label}${s.detail ? `<span class="raw-flow-detail">${s.detail}</span>` : ''}</span>`
          ).join('')}</div>`;
        break;
      }
      case 'relationship_map': {
        const nodes = d.nodes || [];
        const edgeCount = (d.edges || []).length;
        el.innerHTML = `<div class="raw-block-type">relationship map</div>
          <div class="raw-title">${d.title || ''}</div>
          <div class="raw-meta">${nodes.length} nodes · ${edgeCount} edges</div>
          <div class="raw-node-list">${nodes.map(n =>
            `<span class="raw-node-tag${n.highlight ? ' raw-node-highlight' : ''}">${n.label}</span>`
          ).join('')}</div>`;
        break;
      }
      default: {
        el.innerHTML = `<div class="raw-block-type">${type}</div><div class="raw-body">${d.content || d.title || JSON.stringify(d).substring(0, 300)}</div>`;
      }
    }
    return el;
  }

  function placeBlock(block) {
    console.log('placeBlock:', block.type, block);
    const type = block.type;
    const id = `block-${blockCounter++}`;

    // Re-scan DOM for actual heights before placing anything new
    recalcRows();

    // --- RAW MODE: minimal text + real charts, section-based layout ---
    if (RAW_MODE) {
      hideCenterPlaceholder();

      switch (type) {

        case 'person_card': {
          const el = renderRawBlock(block);
          el.classList.add('raw-hero');
          personCardId = id;
          CanvasEngine.addBlock(id, el, 0, nextRowLeft);
          recalcRows();
          if (blockCounter === 1) CanvasEngine.focusOn(id, 1);
          break;
        }

        case 'metric_row': {
          // First metric_row: append inline into person card
          // Subsequent metric_rows: place as standalone blocks
          const d = block.data || block;
          const metrics = d.metrics || [];
          const personEntry = personCardId ? CanvasEngine.getBlock(personCardId) : null;
          if (metrics.length > 0 && personEntry && !personEntry._hasMetrics) {
            const metricEl = renderRawBlock(block);
            metricEl.classList.add('raw-metrics-inline');
            personEntry.el.appendChild(metricEl);
            personEntry._hasMetrics = true;
            recalcRows();
          } else {
            const el = renderRawBlock(block);
            const col = nextRowLeft <= nextRowRight ? 0 : RIGHT_COL;
            const row = col === 0 ? nextRowLeft : nextRowRight;
            CanvasEngine.addBlock(id, el, col, row);
            recalcRows();
          }
          break;
        }

        case 'impact_card': {
          if (!CanvasEngine.getSection('raw-impacts')) {
            CanvasEngine.addSection('raw-impacts', RIGHT_COL, nextRowRight, 'Key Impacts', { grid: 2 });
          }
          const el = renderRawBlock(block);
          CanvasEngine.addToSection('raw-impacts', el);
          impactCount++;
          const sec = CanvasEngine.getSection('raw-impacts');
          if (sec) recalcRows();
          break;
        }

        case 'cascade_path': {
          if (!CanvasEngine.getSection('raw-cascades')) {
            CanvasEngine.addSection('raw-cascades', 0, nextRowLeft, 'How It Connects', { grid: 2 });
          }
          const el = renderRawBlock(block);
          CanvasEngine.addToSection('raw-cascades', el);
          cascadeCount++;
          const sec = CanvasEngine.getSection('raw-cascades');
          if (sec) recalcRows();
          break;
        }

        case 'relationship_map': {
          if (!CanvasEngine.getSection('raw-map')) {
            CanvasEngine.addSection('raw-map', RIGHT_COL, nextRowRight, 'Organizational Footprint');
          }
          const el = renderRawBlock(block);
          CanvasEngine.addToSection('raw-map', el);
          const sec = CanvasEngine.getSection('raw-map');
          if (sec) recalcRows();
          break;
        }

        case 'narrative': {
          // Only show the first narrative on canvas (primary analysis)
          if (narrativeCount > 0) break;
          narrativeCount++;
          const content = typeof block.data === 'string' ? block.data : (block.data?.content || block.content || '');
          if (!content) break;
          const el = document.createElement('div');
          el.className = 'narrative-card';
          el.innerHTML = Primitives.renderNarrativeContent(content);
          const narCol = nextRowLeft <= nextRowRight ? 0 : RIGHT_COL;
          const narRow = narCol === 0 ? nextRowLeft : nextRowRight;
          CanvasEngine.addBlock(id, el, narCol, narRow);
          recalcRows();
          break;
        }

        case 'action_list': {
          showActionDrawer(block);
          break;
        }

        case 'chart':
        case 'custom_visual': {
          const d = block.data || block;
          const vizTitle = d.title || 'Insight';
          const vizCol = nextRowLeft <= nextRowRight ? 0 : RIGHT_COL;
          const vizRow = vizCol === 0 ? nextRowLeft : nextRowRight;
          const vizId = `viz-${id}`;
          CanvasEngine.addSection(vizId, vizCol, vizRow, vizTitle);
          const el = Primitives.renderChart(block);
          CanvasEngine.addToSection(vizId, el);
          const vizSec = CanvasEngine.getSection(vizId);
          if (vizSec) recalcRows();
          break;
        }

        default: {
          const col = nextRowLeft <= nextRowRight ? 0 : RIGHT_COL;
          const row = col === 0 ? nextRowLeft : nextRowRight;
          const el = renderRawBlock(block);
          CanvasEngine.addBlock(id, el, col, row);
          recalcRows();
          break;
        }
      }
      return;
    }

    // --- NORMAL MODE: styled primitives ---
    switch (type) {

      case 'person_card': {
        hideCenterPlaceholder();
        const el = Primitives.renderPersonCardHero(block, handleFollowUp);
        personCardId = id;
        CanvasEngine.addBlock(id, el, 0, nextRowLeft);
        recalcRows();
        CanvasEngine.focusOn(id, 1);
        break;
      }

      case 'metric_row': {
        // Render metrics as chips inside the person card
        const d = block.data || block;
        const metrics = d.metrics || [];
        const chips = Primitives.renderMetricChips(metrics);
        if (chips && personCardId) {
          const personEntry = CanvasEngine.getBlock(personCardId);
          if (personEntry) {
            const personCard = personEntry.el.querySelector('.person-card');
            if (personCard) {
              personCard.appendChild(chips);
              // Re-measure person card since it grew
              recalcRows();
            }
          }
        }
        break;
      }

      case 'impact_card': {
        if (!CanvasEngine.getSection('impacts')) {
          CanvasEngine.addSection('impacts', RIGHT_COL, nextRowRight, 'Key Impacts', { grid: 2 });
        }
        const el = Primitives.render(block, handleFollowUp);
        CanvasEngine.addToSection('impacts', el);
        impactCount++;
        // Re-measure section after each card added
        const sec = CanvasEngine.getSection('impacts');
        if (sec) recalcRows();
        break;
      }

      case 'cascade_path': {
        if (!CanvasEngine.getSection('cascades')) {
          CanvasEngine.addSection('cascades', 0, nextRowLeft, 'How It Connects');
        }
        const el = Primitives.render(block, handleFollowUp);
        CanvasEngine.addToSection('cascades', el);
        cascadeCount++;
        const sec = CanvasEngine.getSection('cascades');
        if (sec) recalcRows();
        break;
      }

      case 'narrative': {
        if (narrativeCount > 0) break;
        narrativeCount++;
        const narContent = typeof block.data === 'string' ? block.data : (block.data?.content || block.content || '');
        if (!narContent) break;
        const narEl = document.createElement('div');
        narEl.className = 'narrative-card';
        narEl.innerHTML = Primitives.renderNarrativeContent(narContent);
        const narCol = nextRowLeft <= nextRowRight ? 0 : RIGHT_COL;
        const narRow = narCol === 0 ? nextRowLeft : nextRowRight;
        CanvasEngine.addBlock(id, narEl, narCol, narRow);
        recalcRows();
        break;
      }

      case 'action_list': {
        showActionDrawer(block);
        break;
      }

      case 'relationship_map': {
        if (!CanvasEngine.getSection('map')) {
          CanvasEngine.addSection('map', RIGHT_COL, nextRowRight, 'Organizational Footprint');
        }
        const el = Primitives.render(block, handleFollowUp);
        CanvasEngine.addToSection('map', el);
        const sec = CanvasEngine.getSection('map');
        if (sec) recalcRows();
        break;
      }

      case 'chart':
      case 'custom_visual': {
        // Data visualization — place in whichever column has more room
        const d = block.data || block;
        const vizTitle = d.title || 'Insight';
        const vizCol = nextRowLeft <= nextRowRight ? 0 : RIGHT_COL;
        const vizRow = vizCol === 0 ? nextRowLeft : nextRowRight;
        const vizId = `viz-${id}`;
        CanvasEngine.addSection(vizId, vizCol, vizRow, vizTitle);
        const el = Primitives.render(block, handleFollowUp);
        CanvasEngine.addToSection(vizId, el);
        const vizSec = CanvasEngine.getSection(vizId);
        if (vizSec) recalcRows();
        break;
      }

      default: {
        const el = Primitives.render(block, handleFollowUp);
        if (el) CanvasEngine.addBlock(id, el, 0, nextRowLeft);
        break;
      }
    }
  }

  // --- Escape HTML ---
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // --- Event bindings ---
  sendBtn.addEventListener('click', sendMessage);

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Suggestion chips
  if (suggestionChips) {
    suggestionChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.suggestion-chip');
      if (!chip) return;
      const query = chip.dataset.query;
      if (query) {
        chatInput.value = query;
        sendMessage();
      }
    });
  }

  // --- Theme toggle ---
  const themeToggle = document.getElementById('theme-toggle');
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);

  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? null : 'light';
    if (next) {
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.removeItem('theme');
    }
  });

})();
