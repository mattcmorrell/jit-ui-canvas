// app.js — Spatial canvas: SSE consumption, block placement on radial canvas

(() => {
  // --- DOM refs ---
  const viewport = document.getElementById('viewport');
  const world = document.getElementById('world');
  const svgLayer = document.getElementById('svg-connections');
  const emptyState = document.getElementById('empty-state');
  const chatInput = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');
  const suggestionChips = document.getElementById('suggestion-chips');
  const centerPlaceholder = document.getElementById('center-placeholder');
  const narrativePanel = document.getElementById('narrative-panel');
  const narrativeBody = document.getElementById('narrative-body');
  const narrativeClose = document.getElementById('narrative-close');
  const actionDrawer = document.getElementById('action-drawer');
  const actionDrawerBody = document.getElementById('action-drawer-body');
  const actionDrawerTab = document.getElementById('action-drawer-tab');
  const statusIndicator = document.getElementById('status-indicator');

  // --- State ---
  let conversationId = null;
  let isStreaming = false;
  let blockCounter = 0;
  let metricCounter = 0;
  let personCardId = null;
  let narrativeQueue = [];
  let narrativeTimer = null;
  let narrativePinned = false;
  let actionDrawerOpen = false;

  // --- Init canvas engine ---
  CanvasEngine.init(viewport, world, svgLayer);

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

  // --- Narrative panel ---
  function showNarrative(block) {
    const content = typeof block.data === 'string' ? block.data : (block.data?.content || block.content || '');
    if (!content) return;

    narrativeBody.innerHTML = Primitives.renderNarrativeContent(content);
    narrativePanel.style.display = 'flex';
    narrativePanel.classList.add('visible');
    narrativePinned = false;

    // Auto-fade after 12s unless pinned
    clearTimeout(narrativeTimer);
    narrativeTimer = setTimeout(() => {
      if (!narrativePinned) {
        narrativePanel.classList.remove('visible');
        setTimeout(() => { narrativePanel.style.display = 'none'; }, 400);
      }
    }, 12000);
  }

  narrativeClose.addEventListener('click', () => {
    narrativePanel.classList.remove('visible');
    setTimeout(() => { narrativePanel.style.display = 'none'; }, 400);
  });

  narrativePanel.addEventListener('click', (e) => {
    if (!e.target.closest('.narrative-panel-close')) {
      narrativePinned = true;
      clearTimeout(narrativeTimer);
    }
  });

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
    metricCounter = 0;
    personCardId = null;
    narrativePanel.style.display = 'none';
    narrativePanel.classList.remove('visible');
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

  // --- Place block spatially ---
  function placeBlock(block) {
    const type = block.type;
    const id = `block-${blockCounter++}`;

    switch (type) {

      case 'person_card': {
        hideCenterPlaceholder();
        const el = Primitives.renderPersonCardHero(block, handleFollowUp);
        personCardId = id;
        CanvasEngine.addBlock(id, el, 0);
        CanvasEngine.focusOn(id, 1);
        break;
      }

      case 'metric_row': {
        // Decompose into individual metric cards on ring 1
        const d = block.data || block;
        const metrics = d.metrics || [];
        for (let i = 0; i < metrics.length; i++) {
          const metricId = `metric-${metricCounter++}`;
          const el = Primitives.renderSingleMetric(metrics[i]);
          setTimeout(() => {
            CanvasEngine.addBlock(metricId, el, 1);
          }, i * 200);
        }
        break;
      }

      case 'impact_card': {
        const d = block.data || block;
        const severity = d.severity || 'medium';
        const el = Primitives.render(block, handleFollowUp);
        el.classList.add(`severity-${severity}`);
        CanvasEngine.addBlock(id, el, 2, { severity });

        // Draw connection from person card to this impact
        if (personCardId) {
          const title = d.title || '';
          CanvasEngine.addConnection(personCardId, id, [], title);
        }
        break;
      }

      case 'cascade_path': {
        // Place cascade path cards on ring 3
        const d = block.data || block;
        const el = Primitives.render(block, handleFollowUp);
        el.classList.add('cascade-block');
        CanvasEngine.addBlock(id, el, 3);

        if (personCardId) {
          CanvasEngine.addConnection(personCardId, id, d.steps || [], d.title || '');
        }
        break;
      }

      case 'narrative': {
        showNarrative(block);
        break;
      }

      case 'action_list': {
        showActionDrawer(block);
        break;
      }

      case 'relationship_map': {
        const el = Primitives.render(block, handleFollowUp);
        CanvasEngine.addBlock(id, el, 4);
        break;
      }

      default: {
        const el = Primitives.render(block, handleFollowUp);
        if (el) CanvasEngine.addBlock(id, el, 2);
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
