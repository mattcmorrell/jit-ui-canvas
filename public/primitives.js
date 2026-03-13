// primitives.js — 7 component renderers + spatial variants for JIT-UI blocks
// Each renderer takes (data, onFollowUp) and returns a DOM element

const Primitives = (() => {

  // --- Helpers ---
  function el(tag, className, innerHTML) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (innerHTML !== undefined) e.innerHTML = innerHTML;
    return e;
  }

  function initials(name) {
    if (!name) return '?';
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }

  function parseMarkdown(md) {
    if (!md) return '';
    return md
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
  }

  function nodeTypeIcon(type) {
    const icons = { person: 'P', project: 'J', team: 'T', skill: 'S', department: 'D' };
    return icons[type] || type[0]?.toUpperCase() || '?';
  }

  function nodeTypeClass(type) {
    const known = ['person', 'project', 'team', 'skill'];
    return known.includes(type) ? type : 'default';
  }

  // --- 1. Narrative ---
  function renderNarrative(data) {
    const div = el('div', 'block block-narrative');
    const content = typeof data === 'string' ? data : (data.data?.content || data.content || data.data || '');
    div.innerHTML = `<p>${parseMarkdown(content)}</p>`;
    return div;
  }

  // Narrative content only (for panel)
  function renderNarrativeContent(content) {
    return `<p>${parseMarkdown(content)}</p>`;
  }

  // --- 2. Person Card (standard) ---
  function renderPersonCard(data, onFollowUp) {
    const d = data.data || data;
    const div = el('div', 'block');
    const card = el('div', 'person-card');

    const statusClass = d.status === 'terminated' ? 'terminated' : 'active';
    card.innerHTML = `
      <div class="person-avatar ${statusClass}">${initials(d.name)}</div>
      <div class="person-info">
        <h3>${d.name || 'Unknown'}</h3>
        <div class="role">${d.role || ''}${d.level ? ' · ' + d.level : ''}</div>
        <div class="person-meta">
          ${d.teamName ? `<span class="meta-item"><span class="meta-icon">◆</span> ${d.teamName}</span>` : ''}
          ${d.managerName ? `<span class="meta-item">↑ ${d.managerName}</span>` : ''}
          ${d.location ? `<span class="meta-item">◎ ${d.location}</span>` : ''}
          ${d.startDate ? `<span class="meta-item">Since ${d.startDate}</span>` : ''}
        </div>
        ${d.stats ? `<div class="person-stats">${d.stats.map(s =>
          `<div class="person-stat"><span class="stat-value">${s.value}</span><span class="stat-label">${s.label}</span></div>`
        ).join('')}</div>` : ''}
      </div>
    `;

    if (d.id && onFollowUp) {
      card.addEventListener('click', () => onFollowUp(`Tell me more about ${d.name}`));
    }

    div.appendChild(card);
    return div;
  }

  // --- 2b. Person Card HERO variant (larger, center stage) ---
  function renderPersonCardHero(data, onFollowUp) {
    const d = data.data || data;
    const div = el('div', 'block person-card-hero-wrapper');
    const card = el('div', 'person-card person-card-hero');

    const statusClass = d.status === 'terminated' ? 'terminated' : 'active';
    card.innerHTML = `
      <div class="hero-avatar ${statusClass}">${initials(d.name)}</div>
      <div class="person-info">
        <h3 class="hero-name">${d.name || 'Unknown'}</h3>
        <div class="role hero-role">${d.role || ''}${d.level ? ' · ' + d.level : ''}</div>
        <div class="person-meta">
          ${d.teamName ? `<span class="meta-item"><span class="meta-icon">◆</span> ${d.teamName}</span>` : ''}
          ${d.managerName ? `<span class="meta-item">↑ ${d.managerName}</span>` : ''}
          ${d.location ? `<span class="meta-item">◎ ${d.location}</span>` : ''}
          ${d.startDate ? `<span class="meta-item">Since ${d.startDate}</span>` : ''}
        </div>
        ${d.stats ? `<div class="person-stats hero-stats">${d.stats.map(s =>
          `<div class="person-stat"><span class="stat-value">${s.value}</span><span class="stat-label">${s.label}</span></div>`
        ).join('')}</div>` : ''}
      </div>
    `;

    if (d.id && onFollowUp) {
      card.addEventListener('click', () => onFollowUp(`Tell me more about ${d.name}`));
    }

    div.appendChild(card);
    return div;
  }

  // --- 2c. Single Metric card (decomposed from metric_row for ring 1) ---
  function renderSingleMetric(metric) {
    const div = el('div', 'block single-metric');
    div.innerHTML = `
      <div class="single-metric-value">${metric.value}</div>
      <div class="single-metric-label">${metric.label}</div>
      ${metric.context ? `<div class="single-metric-context">${metric.context}</div>` : ''}
    `;
    return div;
  }

  // --- 3. Impact Card ---
  function renderImpactCard(data, onFollowUp) {
    const d = data.data || data;
    const severity = d.severity || 'medium';
    const div = el('div', 'block');
    const card = el('div', `impact-card ${severity}`);

    let peopleHtml = '';
    if (d.affectedPeople && d.affectedPeople.length > 0) {
      peopleHtml = `<div class="affected-people">${d.affectedPeople.map(p =>
        `<span class="person-chip" data-name="${p.name}" data-id="${p.id || ''}"><span class="chip-dot"></span>${p.name}</span>`
      ).join('')}</div>`;
    }

    card.innerHTML = `
      <div class="impact-header">
        <span class="severity-badge ${severity}">${severity}</span>
        <span class="impact-title">${d.title || ''}</span>
      </div>
      <div class="impact-description">${d.description || ''}</div>
      ${peopleHtml}
    `;

    // Clickable person chips
    if (onFollowUp) {
      card.querySelectorAll('.person-chip').forEach(chip => {
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          const name = chip.dataset.name;
          onFollowUp(`Tell me more about ${name}`);
        });
      });
    }

    div.appendChild(card);
    return div;
  }

  // --- 4. Metric Row ---
  function renderMetricRow(data) {
    const d = data.data || data;
    const metrics = d.metrics || [];
    const div = el('div', 'block');
    const row = el('div', 'metric-row');

    for (const m of metrics) {
      const card = el('div', 'metric-card');
      card.innerHTML = `
        <div class="metric-value">${m.value}</div>
        <div class="metric-label">${m.label}</div>
        ${m.context ? `<div class="metric-context">${m.context}</div>` : ''}
      `;
      row.appendChild(card);
    }

    div.appendChild(row);
    return div;
  }

  // --- 5. Cascade Path ---
  function renderCascadePath(data, onFollowUp) {
    const d = data.data || data;
    const steps = d.steps || [];
    const div = el('div', 'block');
    const container = el('div', 'cascade-path');

    if (d.title) {
      container.innerHTML = `<div class="cascade-title">${d.title}</div>`;
    }

    const stepsContainer = el('div', 'cascade-steps');
    let stepIndex = 0;

    for (const step of steps) {
      if (step.edge) {
        const edgeEl = el('div', 'cascade-edge');
        edgeEl.style.animationDelay = `${stepIndex * 200}ms`;
        edgeEl.innerHTML = `
          <div class="cascade-edge-line"></div>
          <div class="cascade-edge-label" title="${step.label || step.edge}">${step.label || step.edge}</div>
        `;
        stepsContainer.appendChild(edgeEl);
      } else {
        const nodeType = nodeTypeClass(step.type || 'default');
        const nodeEl = el('div', 'cascade-node');
        nodeEl.style.animationDelay = `${stepIndex * 200}ms`;
        nodeEl.innerHTML = `
          <div class="cascade-node-dot ${nodeType}">${nodeTypeIcon(step.type || 'default')}</div>
          <div class="cascade-node-label" title="${step.label || ''}">${step.label || ''}</div>
          ${step.detail ? `<div class="cascade-node-detail" title="${step.detail}">${step.detail}</div>` : ''}
        `;

        if (step.id && onFollowUp) {
          nodeEl.addEventListener('click', () => onFollowUp(`Tell me more about ${step.label}`));
        }

        stepsContainer.appendChild(nodeEl);
      }
      stepIndex++;
    }

    container.appendChild(stepsContainer);
    div.appendChild(container);
    return div;
  }

  // --- 6. Action List ---
  function renderActionList(data) {
    const d = data.data || data;
    const actions = d.actions || [];
    const div = el('div', 'block');
    const container = el('div', 'action-list');

    container.innerHTML = `<div class="action-list-title">${d.title || 'Recommended Actions'}</div>`;

    for (const a of actions) {
      const priority = a.priority || 'medium';
      const item = el('div', 'action-item');
      item.innerHTML = `
        <div class="action-priority ${priority}"></div>
        <div class="action-content">
          <div class="action-text">${a.action}</div>
          <div class="action-meta">
            ${a.owner ? `<span class="action-owner">${a.owner}</span>` : ''}
            ${a.reason ? ` · ${a.reason}` : ''}
          </div>
        </div>
      `;
      container.appendChild(item);
    }

    div.appendChild(container);
    return div;
  }

  // --- 7. Relationship Map ---
  function renderRelationshipMap(data, onFollowUp) {
    const d = data.data || data;
    const mapNodes = d.nodes || [];
    const mapEdges = d.edges || [];
    const div = el('div', 'block');
    const container = el('div', 'relationship-map');

    if (d.title) {
      container.innerHTML = `<div class="relationship-map-title">${d.title}</div>`;
    }

    const svgNS = 'http://www.w3.org/2000/svg';
    const width = 600;
    const height = 350;
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    const colors = {
      person: '#4ea8de',
      project: '#ff8c42',
      team: '#06d6a0',
      skill: '#64dfdf',
      department: '#ffd166',
      default: '#b388ff'
    };

    const nodeMap = {};
    const simNodes = mapNodes.map((n) => {
      const node = {
        ...n,
        x: width / 2 + (Math.random() - 0.5) * 200,
        y: height / 2 + (Math.random() - 0.5) * 200,
        vx: 0, vy: 0
      };
      nodeMap[n.id] = node;
      return node;
    });

    const simEdges = mapEdges.map(e => ({
      source: nodeMap[e.source],
      target: nodeMap[e.target],
      label: e.label || e.type || ''
    })).filter(e => e.source && e.target);

    function simulate(nodes, edges, iterations = 100) {
      const k = 80;
      for (let iter = 0; iter < iterations; iter++) {
        const alpha = 1 - iter / iterations;
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            let dx = nodes[j].x - nodes[i].x;
            let dy = nodes[j].y - nodes[i].y;
            let dist = Math.sqrt(dx * dx + dy * dy) || 1;
            let force = (k * k) / dist * alpha * 0.5;
            let fx = (dx / dist) * force;
            let fy = (dy / dist) * force;
            nodes[i].x -= fx;
            nodes[i].y -= fy;
            nodes[j].x += fx;
            nodes[j].y += fy;
          }
        }
        for (const e of edges) {
          let dx = e.target.x - e.source.x;
          let dy = e.target.y - e.source.y;
          let dist = Math.sqrt(dx * dx + dy * dy) || 1;
          let force = (dist - k) * alpha * 0.05;
          let fx = (dx / dist) * force;
          let fy = (dy / dist) * force;
          e.source.x += fx;
          e.source.y += fy;
          e.target.x -= fx;
          e.target.y -= fy;
        }
        for (const n of nodes) {
          n.x += (width / 2 - n.x) * 0.01;
          n.y += (height / 2 - n.y) * 0.01;
          n.x = Math.max(40, Math.min(width - 40, n.x));
          n.y = Math.max(30, Math.min(height - 30, n.y));
        }
      }
    }

    simulate(simNodes, simEdges);

    const edgeGroup = document.createElementNS(svgNS, 'g');
    edgeGroup.setAttribute('class', 'map-edges');
    for (const e of simEdges) {
      const g = document.createElementNS(svgNS, 'g');
      g.setAttribute('class', 'map-edge');
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', e.source.x);
      line.setAttribute('y1', e.source.y);
      line.setAttribute('x2', e.target.x);
      line.setAttribute('y2', e.target.y);
      g.appendChild(line);

      if (e.label) {
        const midX = (e.source.x + e.target.x) / 2;
        const midY = (e.source.y + e.target.y) / 2;
        const text = document.createElementNS(svgNS, 'text');
        text.setAttribute('x', midX);
        text.setAttribute('y', midY - 4);
        text.setAttribute('text-anchor', 'middle');
        text.textContent = e.label;
        g.appendChild(text);
      }
      edgeGroup.appendChild(g);
    }
    svg.appendChild(edgeGroup);

    const nodeGroup = document.createElementNS(svgNS, 'g');
    nodeGroup.setAttribute('class', 'map-nodes');
    for (const n of simNodes) {
      const g = document.createElementNS(svgNS, 'g');
      g.setAttribute('class', 'map-node');
      g.style.cursor = 'pointer';

      const color = colors[n.type] || colors.default;
      const radius = n.highlight ? 16 : 12;

      const circle = document.createElementNS(svgNS, 'circle');
      circle.setAttribute('cx', n.x);
      circle.setAttribute('cy', n.y);
      circle.setAttribute('r', radius);
      circle.setAttribute('fill', color + '33');
      circle.setAttribute('stroke', color);
      circle.setAttribute('stroke-width', n.highlight ? '3' : '2');
      g.appendChild(circle);

      const text = document.createElementNS(svgNS, 'text');
      text.setAttribute('x', n.x);
      text.setAttribute('y', n.y + radius + 14);
      text.setAttribute('text-anchor', 'middle');
      text.textContent = n.label || n.id;
      g.appendChild(text);

      if (n.id && onFollowUp) {
        g.addEventListener('click', () => onFollowUp(`Tell me more about ${n.label || n.id}`));
      }

      nodeGroup.appendChild(g);
    }
    svg.appendChild(nodeGroup);

    container.appendChild(svg);
    div.appendChild(container);
    return div;
  }

  // --- 8. Metric Chips (inline inside person card) ---
  function renderMetricChips(metrics) {
    if (!metrics || metrics.length === 0) return null;
    const container = el('div', 'metric-chips');
    for (const m of metrics) {
      const chip = el('div', 'metric-chip');
      chip.innerHTML = `
        <span class="metric-chip-value">${m.value}</span>
        <span class="metric-chip-label">${m.label}</span>
      `;
      container.appendChild(chip);
    }
    return container;
  }

  // --- Renderer dispatch ---
  function render(block, onFollowUp) {
    const type = block.type;
    switch (type) {
      case 'narrative': return renderNarrative(block);
      case 'person_card': return renderPersonCard(block, onFollowUp);
      case 'impact_card': return renderImpactCard(block, onFollowUp);
      case 'metric_row': return renderMetricRow(block);
      case 'cascade_path': return renderCascadePath(block, onFollowUp);
      case 'action_list': return renderActionList(block);
      case 'relationship_map': return renderRelationshipMap(block, onFollowUp);
      default:
        const div = el('div', 'block block-error');
        div.textContent = `Unknown block type: ${type}`;
        return div;
    }
  }

  return {
    render,
    renderPersonCardHero,
    renderSingleMetric,
    renderMetricChips,
    renderNarrativeContent
  };
})();
