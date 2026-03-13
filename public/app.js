// app.js — Progressive disclosure canvas: user-directed exploration

(() => {
  // --- DOM refs ---
  const viewport = document.getElementById('viewport');
  const world = document.getElementById('world');
  const emptyState = document.getElementById('empty-state');
  const chatInput = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');
  const suggestionChips = document.getElementById('suggestion-chips');
  const statusIndicator = document.getElementById('status-indicator');
  const decisionsPanel = document.getElementById('decisions-panel');
  const decisionsList = document.getElementById('decisions-list');
  const decisionsCount = document.getElementById('decisions-count');
  const decisionsToggle = document.getElementById('decisions-toggle');

  // --- State ---
  let conversationId = null;
  let isStreaming = false;
  let decisions = [];

  // Exploration tree: each node on the canvas
  const canvasNodes = new Map(); // id → node
  let nodeIdCounter = 0;
  let focusedNodeId = null;

  // --- Init ---
  CanvasEngine.init(viewport, world);

  // --- Layout constants ---
  const COL_WIDTH = 480;
  const COL_GAP = 32;
  const ROW_GAP = 16;

  // --- Helpers ---
  function genId() { return `n-${nodeIdCounter++}`; }

  function showStatus(msg) {
    statusIndicator.querySelector('.status-text').textContent = msg;
    statusIndicator.style.display = 'flex';
  }

  function clearStatus() {
    statusIndicator.style.display = 'none';
  }

  function parseSimpleMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
  }

  // --- Node management ---
  function addCanvasNode(type, parentId, direction, data, el) {
    const id = genId();
    const node = {
      id, type, parentId,
      direction: direction || 'below',
      data, el,
      status: 'active',
      children: [],
      _layoutCol: 0,
      _layoutY: 0
    };
    canvasNodes.set(id, node);
    if (parentId) {
      const parent = canvasNodes.get(parentId);
      if (parent) parent.children.push(id);
    }
    el.classList.add('disclosure-node');
    el.dataset.nodeId = id;
    // Add to canvas at origin — layoutAll will position it
    CanvasEngine.addBlock(id, el, 0, 0);
    return id;
  }

  function removeCanvasNode(id) {
    const node = canvasNodes.get(id);
    if (!node) return;
    // Remove children first
    for (const childId of [...node.children]) {
      removeCanvasNode(childId);
    }
    // Remove from parent's children
    if (node.parentId) {
      const parent = canvasNodes.get(node.parentId);
      if (parent) {
        parent.children = parent.children.filter(c => c !== id);
      }
    }
    CanvasEngine.removeBlock(id);
    canvasNodes.delete(id);
  }

  // --- Layout ---
  function layoutAll() {
    const roots = [...canvasNodes.values()].filter(n => !n.parentId);
    const colBottoms = {};

    function getBottom(col) { return colBottoms[col] || 0; }
    function setBottom(col, y) { colBottoms[col] = Math.max(colBottoms[col] || 0, y); }

    function layoutNode(id) {
      const node = canvasNodes.get(id);
      if (!node || !node.el) return;

      const parent = node.parentId ? canvasNodes.get(node.parentId) : null;
      let col, y;

      if (!parent) {
        col = 0;
        y = getBottom(0);
      } else if (node.direction === 'right') {
        col = (parent._layoutCol || 0) + 1;
        y = Math.max(parent._layoutY || 0, getBottom(col));
      } else {
        col = parent._layoutCol || 0;
        y = getBottom(col);
      }

      node._layoutCol = col;
      node._layoutY = y;

      const x = col * (COL_WIDTH + COL_GAP);
      CanvasEngine.moveBlock(id, x, y, true);

      const h = node.el.offsetHeight || 60;
      setBottom(col, y + h + ROW_GAP);

      // Layout children: below first, then right
      const belowChildren = node.children.filter(cid => {
        const c = canvasNodes.get(cid);
        return c && c.direction !== 'right';
      });
      const rightChildren = node.children.filter(cid => {
        const c = canvasNodes.get(cid);
        return c && c.direction === 'right';
      });

      for (const childId of belowChildren) layoutNode(childId);
      for (const childId of rightChildren) layoutNode(childId);
    }

    for (const root of roots) {
      layoutNode(root.id);
    }
  }

  // --- Renderers ---

  function renderSeedCard(blocks) {
    const container = document.createElement('div');
    container.className = 'seed-card';

    for (const block of blocks) {
      if (block.type === 'person_card') {
        const d = block.data || block;
        const statusClass = d.status === 'terminated' ? 'terminated' : 'active';
        const cardEl = document.createElement('div');
        cardEl.className = 'seed-person';
        cardEl.innerHTML = `
          ${Primitives.avatarHtml(d.avatarUrl, d.name, 'seed-avatar', statusClass)}
          <div class="seed-info">
            <div class="seed-name">${d.name || 'Unknown'}</div>
            <div class="seed-role">${d.role || ''}${d.level ? ' · ' + d.level : ''}</div>
            <div class="seed-meta">
              ${d.teamName ? `<span class="seed-meta-item">${d.teamName}</span>` : ''}
              ${d.managerName ? `<span class="seed-meta-item">↑ ${d.managerName}</span>` : ''}
              ${d.location ? `<span class="seed-meta-item">${d.location}</span>` : ''}
              ${d.startDate ? `<span class="seed-meta-item">Since ${d.startDate}</span>` : ''}
            </div>
          </div>
          ${d.status === 'terminated' || d.status === 'departing' ? '<div class="seed-badge departing">Departing</div>' : ''}
        `;
        container.appendChild(cardEl);
      } else if (block.type === 'metric_row') {
        const d = block.data || block;
        const metrics = d.metrics || [];
        if (metrics.length > 0) {
          const chipContainer = document.createElement('div');
          chipContainer.className = 'seed-metrics';
          for (const m of metrics) {
            const chip = document.createElement('div');
            chip.className = 'seed-metric';
            chip.innerHTML = `
              <span class="seed-metric-val">${m.value}</span>
              <span class="seed-metric-label">${m.label}</span>
            `;
            if (m.context) chip.title = m.context;
            chipContainer.appendChild(chip);
          }
          container.appendChild(chipContainer);
        }
      }
    }
    return container;
  }

  function renderPromptChips(prompts) {
    const container = document.createElement('div');
    container.className = 'prompt-chips';

    for (const p of prompts) {
      const chip = document.createElement('button');
      chip.className = `prompt-chip prompt-chip-${p.category || 'consequence'}`;
      chip.textContent = p.text;
      chip.dataset.promptText = p.text;
      chip.dataset.promptCategory = p.category || 'consequence';

      chip.addEventListener('click', () => {
        const nodeEl = chip.closest('.disclosure-node');
        const nodeId = nodeEl?.dataset.nodeId;
        if (nodeId && !chip.classList.contains('prompt-chip-active')) {
          explorePrompt(nodeId, p, chip);
        }
      });

      container.appendChild(chip);
    }

    return container;
  }

  function renderResponseContent(blocks) {
    const container = document.createElement('div');
    container.className = 'response-content';

    for (const block of blocks) {
      const type = block.type;

      if (type === 'person_grid') {
        container.appendChild(renderPersonGrid(block.data || block));
      } else if (type === 'info_list') {
        container.appendChild(renderInfoList(block.data || block));
      } else if (type === 'fyi') {
        container.appendChild(renderFYI(block.data || block));
      } else if (type === 'action_list') {
        addDecisions(block.data || block);
      } else {
        // Use existing Primitives renderer
        const el = Primitives.render(block, (q) => {
          if (!isStreaming) {
            chatInput.value = q;
            sendMessage();
          }
        });
        if (el) container.appendChild(el);
      }
    }
    return container;
  }

  function renderPersonGrid(data) {
    const el = document.createElement('div');
    el.className = 'person-grid-block';
    if (data.title) {
      const title = document.createElement('div');
      title.className = 'person-grid-title';
      title.textContent = data.title;
      el.appendChild(title);
    }
    const grid = document.createElement('div');
    grid.className = 'person-grid';
    for (const p of (data.people || [])) {
      const card = document.createElement('div');
      card.className = 'person-grid-card';
      card.innerHTML = `
        ${Primitives.avatarHtml(p.avatarUrl, p.name, 'pgrid-avatar', 'active')}
        <div class="pgrid-info">
          <div class="pgrid-name">${p.name || ''}</div>
          <div class="pgrid-role">${p.role || ''}</div>
        </div>
      `;
      grid.appendChild(card);
    }
    el.appendChild(grid);
    return el;
  }

  function renderInfoList(data) {
    const el = document.createElement('div');
    el.className = 'info-list-block';
    if (data.title) {
      const title = document.createElement('div');
      title.className = 'info-list-title';
      title.textContent = data.title;
      el.appendChild(title);
    }
    const list = document.createElement('div');
    list.className = 'info-list';
    for (const item of (data.items || [])) {
      const row = document.createElement('div');
      row.className = 'info-list-item';
      row.innerHTML = `
        <span class="info-list-label">${item.label}</span>
        <span class="info-list-value">${item.value}</span>
      `;
      list.appendChild(row);
    }
    el.appendChild(list);
    return el;
  }

  function renderFYI(data) {
    const el = document.createElement('div');
    el.className = `fyi-block fyi-${data.severity || 'info'}`;
    el.innerHTML = `
      ${data.title ? `<div class="fyi-title">${data.title}</div>` : ''}
      <div class="fyi-content">${parseSimpleMarkdown(data.content || '')}</div>
    `;
    return el;
  }

  function renderOptionCards(options) {
    const container = document.createElement('div');
    container.className = 'option-cards';

    if (options.question) {
      const q = document.createElement('div');
      q.className = 'option-question';
      q.textContent = options.question;
      container.appendChild(q);
    }

    const grid = document.createElement('div');
    grid.className = 'option-grid';

    for (const item of (options.items || [])) {
      const card = document.createElement('div');
      card.className = 'option-card';
      card.innerHTML = `
        ${Primitives.avatarHtml(item.avatarUrl, item.name, 'option-avatar', 'active')}
        <div class="option-info">
          <div class="option-name">${item.name}</div>
          ${item.role ? `<div class="option-role">${item.role}</div>` : ''}
          ${item.reason ? `<div class="option-reason">${item.reason}</div>` : ''}
        </div>
      `;
      card.addEventListener('click', () => {
        const nodeEl = card.closest('.disclosure-node');
        const nodeId = nodeEl?.dataset.nodeId;
        if (nodeId && !card.classList.contains('option-selected')) {
          exploreOption(nodeId, item, card);
        }
      });
      grid.appendChild(card);
    }

    container.appendChild(grid);
    return container;
  }

  function renderLoading(text) {
    const el = document.createElement('div');
    el.className = 'loading-node';
    el.innerHTML = `
      <div class="loading-spinner-ring"></div>
      <span class="loading-text">${text || 'Exploring...'}</span>
    `;
    return el;
  }

  // --- Decisions panel ---
  function addDecisions(data) {
    for (const a of (data.actions || [])) {
      decisions.push(a);
    }
    updateDecisionsPanel();
  }

  function updateDecisionsPanel() {
    if (!decisionsPanel) return;
    if (decisions.length === 0) {
      decisionsPanel.classList.remove('has-items');
      return;
    }
    decisionsPanel.classList.add('has-items');
    if (decisionsCount) decisionsCount.textContent = decisions.length;
    if (decisionsList) {
      decisionsList.innerHTML = '';
      for (const d of decisions) {
        const item = document.createElement('div');
        item.className = 'decision-item';
        item.innerHTML = `
          <div class="decision-priority decision-${d.priority || 'medium'}"></div>
          <div class="decision-content">
            <div class="decision-text">${d.action}</div>
            <div class="decision-meta">
              ${d.owner ? `<span class="decision-owner">${d.owner}</span>` : ''}
              ${d.reason ? ` · ${d.reason}` : ''}
            </div>
          </div>
        `;
        decisionsList.appendChild(item);
      }
    }
  }

  // --- Focus management ---
  function setFocus(nodeId) {
    focusedNodeId = nodeId;
    for (const [id, node] of canvasNodes) {
      if (node.type === 'prompts' || node.type === 'action-prompts') {
        const isFocusChild = node.parentId === nodeId;
        const hasUnexplored = node.el.querySelector('.prompt-chip:not(.prompt-chip-active):not(.prompt-chip-dimmed)');

        if (isFocusChild) {
          // Show unexplored prompts for the focused node
          node.el.querySelectorAll('.prompt-chip').forEach(chip => {
            if (!chip.classList.contains('prompt-chip-active')) {
              chip.classList.remove('prompt-chip-dimmed');
              chip.disabled = false;
            }
          });
          node.el.classList.remove('node-dimmed');
        } else {
          // Dim other nodes' unexplored prompts
          node.el.querySelectorAll('.prompt-chip').forEach(chip => {
            if (!chip.classList.contains('prompt-chip-active')) {
              chip.classList.add('prompt-chip-dimmed');
              chip.disabled = true;
            }
          });
          if (!node.el.querySelector('.prompt-chip-active')) {
            node.el.classList.add('node-dimmed');
          }
        }
      }
    }
  }

  // --- Core interaction ---

  function startExploration(message) {
    if (isStreaming) return;
    isStreaming = true;
    sendBtn.disabled = true;
    chatInput.value = '';
    if (emptyState) emptyState.style.display = 'none';

    // Reset
    for (const [id] of canvasNodes) {
      CanvasEngine.removeBlock(id);
    }
    canvasNodes.clear();
    nodeIdCounter = 0;
    focusedNodeId = null;
    decisions = [];
    conversationId = null;
    updateDecisionsPanel();
    CanvasEngine.reset();

    // Loading
    const loadingEl = renderLoading('Analyzing...');
    const loadingId = addCanvasNode('loading', null, 'below', {}, loadingEl);
    requestAnimationFrame(() => {
      layoutAll();
      CanvasEngine.focusOn(loadingId, 1);
    });

    callExploreAPI(message, null, (response) => {
      removeCanvasNode(loadingId);

      // Render seed card from response blocks
      const seedEl = renderSeedCard(response.blocks);
      const seedId = addCanvasNode('seed', null, 'below', response, seedEl);

      // Click to refocus
      seedEl.style.cursor = 'pointer';
      seedEl.addEventListener('click', (e) => {
        if (!e.target.closest('button, .prompt-chip, .option-card')) {
          refocus(seedId);
        }
      });

      // Split prompts by category
      const consequencePrompts = (response.prompts || []).filter(p => p.category !== 'action');
      const actionPrompts = (response.prompts || []).filter(p => p.category === 'action');

      // Consequence prompts (below seed)
      if (consequencePrompts.length > 0) {
        const promptEl = renderPromptChips(consequencePrompts);
        addCanvasNode('prompts', seedId, 'below', { prompts: consequencePrompts }, promptEl);
      }

      // Action prompts (right of seed)
      if (actionPrompts.length > 0) {
        const promptEl = renderPromptChips(actionPrompts);
        addCanvasNode('action-prompts', seedId, 'right', { prompts: actionPrompts }, promptEl);
      }

      // Options (right of seed)
      if (response.options) {
        const optEl = renderOptionCards(response.options);
        addCanvasNode('options', seedId, 'right', response.options, optEl);
      }

      focusedNodeId = seedId;

      requestAnimationFrame(() => {
        layoutAll();
        // Re-layout after heights settle
        setTimeout(() => {
          layoutAll();
          CanvasEngine.focusOn(seedId, 0.9);
          isStreaming = false;
          sendBtn.disabled = false;
          chatInput.focus();
        }, 100);
      });
    });
  }

  function explorePrompt(promptNodeId, prompt, chipEl) {
    if (isStreaming) return;
    isStreaming = true;

    const promptNode = canvasNodes.get(promptNodeId);
    if (!promptNode) return;

    // Highlight clicked chip, dim others
    chipEl.classList.add('prompt-chip-active');
    promptNode.el.querySelectorAll('.prompt-chip').forEach(chip => {
      if (chip !== chipEl) {
        chip.classList.add('prompt-chip-dimmed');
        chip.disabled = true;
      }
    });

    // Loading below the prompt group
    const loadingEl = renderLoading(prompt.text);
    const loadingId = addCanvasNode('loading', promptNodeId, 'below', {}, loadingEl);

    requestAnimationFrame(() => {
      layoutAll();
      setTimeout(() => {
        layoutAll();
        CanvasEngine.focusOn(loadingId, 0.85);
      }, 50);
    });

    callExploreAPI(prompt.text, conversationId, (response) => {
      removeCanvasNode(loadingId);

      // Render response
      const responseEl = renderResponseContent(response.blocks);
      const responseId = addCanvasNode('response', promptNodeId, 'below', response, responseEl);

      // Click to refocus
      responseEl.style.cursor = 'pointer';
      responseEl.addEventListener('click', (e) => {
        if (!e.target.closest('button, .prompt-chip, .option-card')) {
          refocus(responseId);
        }
      });

      // New prompts
      const consequencePrompts = (response.prompts || []).filter(p => p.category !== 'action');
      const actionPrompts = (response.prompts || []).filter(p => p.category === 'action');

      if (consequencePrompts.length > 0) {
        const el = renderPromptChips(consequencePrompts);
        addCanvasNode('prompts', responseId, 'below', { prompts: consequencePrompts }, el);
      }

      if (actionPrompts.length > 0) {
        const el = renderPromptChips(actionPrompts);
        addCanvasNode('action-prompts', responseId, 'right', { prompts: actionPrompts }, el);
      }

      if (response.options) {
        const el = renderOptionCards(response.options);
        addCanvasNode('options', responseId, 'right', response.options, el);
      }

      focusedNodeId = responseId;
      setFocus(responseId);

      requestAnimationFrame(() => {
        layoutAll();
        setTimeout(() => {
          layoutAll();
          CanvasEngine.focusOn(responseId, 0.85);
          isStreaming = false;
          sendBtn.disabled = false;
          chatInput.focus();
        }, 100);
      });
    });
  }

  function exploreOption(optionNodeId, option, cardEl) {
    if (isStreaming) return;
    isStreaming = true;

    const optionNode = canvasNodes.get(optionNodeId);
    if (!optionNode) return;

    // Highlight selected, dim others
    cardEl.classList.add('option-selected');
    optionNode.el.querySelectorAll('.option-card').forEach(card => {
      if (card !== cardEl) card.classList.add('option-dimmed');
    });

    // Track decision
    decisions.push({
      action: `Selected ${option.name} for "${optionNode.data?.question || 'this role'}"`,
      priority: 'high',
      owner: option.name,
      reason: option.reason || ''
    });
    updateDecisionsPanel();

    // Loading
    const message = `The user selected ${option.name} (${option.role || ''}) for "${optionNode.data?.question || 'this role'}". ${option.reason ? 'Reason: ' + option.reason + '. ' : ''}What are the implications and consequences of this choice?`;

    const loadingEl = renderLoading(`Building scenario for ${option.name}...`);
    const loadingId = addCanvasNode('loading', optionNodeId, 'below', {}, loadingEl);

    requestAnimationFrame(() => {
      layoutAll();
      setTimeout(() => {
        layoutAll();
        CanvasEngine.focusOn(loadingId, 0.85);
      }, 50);
    });

    callExploreAPI(message, conversationId, (response) => {
      removeCanvasNode(loadingId);

      const responseEl = renderResponseContent(response.blocks);
      const responseId = addCanvasNode('response', optionNodeId, 'below', response, responseEl);

      responseEl.style.cursor = 'pointer';
      responseEl.addEventListener('click', (e) => {
        if (!e.target.closest('button, .prompt-chip, .option-card')) {
          refocus(responseId);
        }
      });

      const consequencePrompts = (response.prompts || []).filter(p => p.category !== 'action');
      const actionPrompts = (response.prompts || []).filter(p => p.category === 'action');

      if (consequencePrompts.length > 0) {
        const el = renderPromptChips(consequencePrompts);
        addCanvasNode('prompts', responseId, 'below', { prompts: consequencePrompts }, el);
      }

      if (actionPrompts.length > 0) {
        const el = renderPromptChips(actionPrompts);
        addCanvasNode('action-prompts', responseId, 'right', { prompts: actionPrompts }, el);
      }

      if (response.options) {
        const el = renderOptionCards(response.options);
        addCanvasNode('options', responseId, 'right', response.options, el);
      }

      focusedNodeId = responseId;
      setFocus(responseId);

      requestAnimationFrame(() => {
        layoutAll();
        setTimeout(() => {
          layoutAll();
          CanvasEngine.focusOn(responseId, 0.85);
          isStreaming = false;
          sendBtn.disabled = false;
          chatInput.focus();
        }, 100);
      });
    });
  }

  function refocus(nodeId) {
    if (focusedNodeId === nodeId || isStreaming) return;
    setFocus(nodeId);
    CanvasEngine.focusOn(nodeId, 0.85);
  }

  // --- API ---
  function callExploreAPI(message, convId, onResponse) {
    const params = new URLSearchParams({ message });
    if (convId) params.set('conversation_id', convId);

    const eventSource = new EventSource(`/api/explore?${params.toString()}`);
    let responseData = null;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case 'status':
            showStatus(data.message);
            break;
          case 'response':
            clearStatus();
            responseData = data;
            break;
          case 'error':
            clearStatus();
            showStatus('Error: ' + (data.message || 'Something went wrong'));
            isStreaming = false;
            sendBtn.disabled = false;
            eventSource.close();
            break;
          case 'done':
            if (data.conversation_id) conversationId = data.conversation_id;
            clearStatus();
            eventSource.close();
            if (responseData) onResponse(responseData);
            break;
        }
      } catch (e) {
        console.error('SSE parse error:', e);
      }
    };

    eventSource.onerror = () => {
      clearStatus();
      eventSource.close();
      isStreaming = false;
      sendBtn.disabled = false;
      showStatus('Connection lost. Try again.');
    };
  }

  // --- Send ---
  function sendMessage() {
    const message = chatInput.value.trim();
    if (!message || isStreaming) return;
    startExploration(message);
  }

  // --- Event bindings ---
  sendBtn.addEventListener('click', sendMessage);

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  if (suggestionChips) {
    suggestionChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.suggestion-chip');
      if (chip?.dataset.query) {
        chatInput.value = chip.dataset.query;
        sendMessage();
      }
    });
  }

  // Decisions panel toggle
  if (decisionsToggle) {
    decisionsToggle.addEventListener('click', () => {
      decisionsPanel.classList.toggle('open');
    });
  }

  // Theme toggle
  const themeToggle = document.getElementById('theme-toggle');
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);

  themeToggle?.addEventListener('click', () => {
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
