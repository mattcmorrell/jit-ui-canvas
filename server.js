require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 3456;

// --- Graph Loading ---
const DATA_URL = 'https://mattcmorrell.github.io/ee-graph/data';
let nodes, edges;

async function loadGraphData() {
  console.log('Loading graph data from ee-graph...');
  const [nodesRes, edgesRes] = await Promise.all([
    fetch(`${DATA_URL}/nodes.json`),
    fetch(`${DATA_URL}/edges.json`)
  ]);
  nodes = (await nodesRes.json()).nodes;
  edges = (await edgesRes.json()).edges;
  console.log(`Loaded ${nodes.length} nodes, ${edges.length} edges`);
  buildIndexes();
}

// Build indexes
const nodesById = {};
const edgesBySource = {};
const edgesByTarget = {};
const nodesByType = {};

function buildIndexes() {
  for (const n of nodes) {
    nodesById[n.id] = n;
    if (!nodesByType[n.type]) nodesByType[n.type] = [];
    nodesByType[n.type].push(n);
  }
  for (const e of edges) {
    if (!edgesBySource[e.source]) edgesBySource[e.source] = [];
    edgesBySource[e.source].push(e);
    if (!edgesByTarget[e.target]) edgesByTarget[e.target] = [];
    edgesByTarget[e.target].push(e);
  }
  console.log(`Node types: ${Object.keys(nodesByType).length}, indexed by source: ${Object.keys(edgesBySource).length}, by target: ${Object.keys(edgesByTarget).length}`);
}

// --- Helper functions ---
function nodeSummary(n) {
  if (!n) return null;
  const p = n.properties;
  const base = { id: n.id, type: n.type, name: p.name || p.title || n.id };
  if (n.type === 'person') {
    return { ...base, role: p.role, level: p.level, status: p.status, startDate: p.startDate, location: p.location, avatarUrl: p.avatarUrl };
  }
  if (n.type === 'team') return { ...base, teamType: p.teamType, headcount: p.headcount };
  if (n.type === 'project') return { ...base, status: p.status, priority: p.priority, targetEndDate: p.targetEndDate };
  if (n.type === 'skill') return { ...base, category: p.category };
  return { ...base, ...Object.fromEntries(Object.entries(p).slice(0, 5)) };
}

function fuzzyMatch(text, query) {
  if (!text) return false;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  return t.includes(q) || q.split(/\s+/).every(w => t.includes(w));
}

// --- 7 Graph Tool Implementations ---
function search_people(query) {
  const results = (nodesByType['person'] || [])
    .filter(n => {
      const p = n.properties;
      return fuzzyMatch(p.name, query) || fuzzyMatch(p.role, query) || fuzzyMatch(p.email, query);
    })
    .slice(0, 10)
    .map(nodeSummary);
  return { count: results.length, people: results };
}

function get_person_full(person_id) {
  const n = nodesById[person_id];
  if (!n || n.type !== 'person') return { error: `Person ${person_id} not found` };

  const outEdges = edgesBySource[person_id] || [];
  const inEdges = edgesByTarget[person_id] || [];

  // Group connections by edge type
  const connections = {};
  for (const e of [...outEdges, ...inEdges]) {
    const targetId = e.source === person_id ? e.target : e.source;
    const targetNode = nodesById[targetId];
    if (!targetNode) continue;

    // Skip individual survey responses (privacy)
    if (targetNode.type === 'survey_response') continue;

    const key = e.type;
    if (!connections[key]) connections[key] = [];
    connections[key].push({
      direction: e.source === person_id ? 'outgoing' : 'incoming',
      node: nodeSummary(targetNode),
      metadata: e.metadata || {}
    });
  }

  return {
    person: { id: n.id, ...n.properties },
    connectionSummary: Object.fromEntries(
      Object.entries(connections).map(([type, conns]) => [type, { count: conns.length, items: conns.slice(0, 15) }])
    ),
    totalConnections: outEdges.length + inEdges.length
  };
}

function get_team_full(team_id) {
  const n = nodesById[team_id];
  if (!n || n.type !== 'team') return { error: `Team ${team_id} not found` };

  // Find members (people with member_of edge to this team)
  const memberEdges = (edgesByTarget[team_id] || []).filter(e => e.type === 'member_of');
  const members = memberEdges.map(e => {
    const person = nodesById[e.source];
    return person ? { ...nodeSummary(person), teamRole: (e.metadata || {}).role } : null;
  }).filter(Boolean);

  // Find manager (person with member_of role=manager)
  const manager = members.find(m => m.teamRole === 'manager');

  // Find projects (via team members' works_on edges)
  const projectIds = new Set();
  const projects = [];
  for (const m of memberEdges) {
    for (const e of (edgesBySource[m.source] || [])) {
      if (e.type === 'works_on' && !projectIds.has(e.target)) {
        projectIds.add(e.target);
        const proj = nodesById[e.target];
        if (proj) projects.push(nodeSummary(proj));
      }
    }
  }

  return {
    team: { id: n.id, ...n.properties },
    manager: manager || null,
    members: members.slice(0, 20),
    memberCount: members.length,
    projects: projects.slice(0, 10)
  };
}

function get_direct_reports(person_id, recursive = false) {
  const person = nodesById[person_id];
  if (!person) return { error: `Person ${person_id} not found` };

  function getReports(pid, depth) {
    if (depth > 5) return [];
    const reportEdges = (edgesByTarget[pid] || []).filter(e => e.type === 'reports_to');
    const reports = [];
    for (const e of reportEdges) {
      const p = nodesById[e.source];
      if (!p) continue;
      const report = { ...nodeSummary(p), depth };
      if (recursive) {
        const subReports = getReports(e.source, depth + 1);
        if (subReports.length > 0) report.directReports = subReports;
      }
      reports.push(report);
    }
    return reports;
  }

  const reports = getReports(person_id, 1);
  return {
    manager: nodeSummary(person),
    reports,
    totalCount: countTree(reports)
  };
}

function countTree(reports) {
  let count = reports.length;
  for (const r of reports) {
    if (r.directReports) count += countTree(r.directReports);
  }
  return count;
}

function traverse(start_id, edge_types, max_depth = 3) {
  const startNode = nodesById[start_id];
  if (!startNode) return { error: `Node ${start_id} not found` };

  const visited = new Set([start_id]);
  const discoveredNodes = [{ ...nodeSummary(startNode), depth: 0 }];
  const discoveredEdges = [];
  let frontier = [start_id];

  for (let depth = 1; depth <= Math.min(max_depth, 5); depth++) {
    const nextFrontier = [];
    for (const nodeId of frontier) {
      const outEdges = (edgesBySource[nodeId] || []).filter(e => !edge_types || edge_types.includes(e.type));
      const inEdges = (edgesByTarget[nodeId] || []).filter(e => !edge_types || edge_types.includes(e.type));

      for (const e of [...outEdges, ...inEdges]) {
        const neighborId = e.source === nodeId ? e.target : e.source;
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        const neighbor = nodesById[neighborId];
        if (!neighbor) continue;

        discoveredNodes.push({ ...nodeSummary(neighbor), depth });
        discoveredEdges.push({ source: e.source, target: e.target, type: e.type, metadata: e.metadata });
        nextFrontier.push(neighborId);

        if (discoveredNodes.length >= 50) {
          return { nodes: discoveredNodes, edges: discoveredEdges, truncated: true, message: 'Capped at 50 nodes' };
        }
      }
    }
    frontier = nextFrontier;
  }

  return { nodes: discoveredNodes, edges: discoveredEdges, truncated: false };
}

function search_nodes(query, node_type = null) {
  const pool = node_type ? (nodesByType[node_type] || []) : nodes;
  const results = pool.filter(n => {
    const p = n.properties;
    return fuzzyMatch(p.name || '', query) || fuzzyMatch(p.title || '', query) ||
           fuzzyMatch(p.role || '', query) || fuzzyMatch(p.description || '', query);
  }).slice(0, 15).map(nodeSummary);
  return { count: results.length, results };
}

function get_impact_radius(person_id) {
  const person = nodesById[person_id];
  if (!person || person.type !== 'person') return { error: `Person ${person_id} not found` };

  const p = person.properties;
  const outEdges = edgesBySource[person_id] || [];
  const inEdges = edgesByTarget[person_id] || [];

  // Direct reports
  const reportEdges = inEdges.filter(e => e.type === 'reports_to');
  const directReports = reportEdges.map(e => nodeSummary(nodesById[e.source])).filter(Boolean);

  // Mentees
  const menteeEdges = outEdges.filter(e => e.type === 'mentors');
  const mentees = menteeEdges.map(e => {
    const mentee = nodesById[e.target];
    if (!mentee) return null;
    // Check if this person has other mentors
    const otherMentors = (edgesByTarget[e.target] || []).filter(me => me.type === 'mentors' && me.source !== person_id);
    return { ...nodeSummary(mentee), otherMentorCount: otherMentors.length, metadata: e.metadata };
  }).filter(Boolean);

  // Projects and co-contributors
  const projectEdges = outEdges.filter(e => e.type === 'works_on');
  const projects = projectEdges.map(e => {
    const proj = nodesById[e.target];
    if (!proj) return null;
    // Find other contributors
    const contributors = (edgesByTarget[e.target] || [])
      .filter(pe => pe.type === 'works_on' && pe.source !== person_id)
      .map(pe => nodeSummary(nodesById[pe.source]))
      .filter(Boolean);
    return {
      ...nodeSummary(proj),
      personRole: (e.metadata || {}).role,
      personAllocation: (e.metadata || {}).allocation,
      otherContributors: contributors,
      contributorCount: contributors.length
    };
  }).filter(Boolean);

  // Skills and who else has them
  const skillEdges = outEdges.filter(e => e.type === 'has_skill');
  const skills = skillEdges.map(e => {
    const skill = nodesById[e.target];
    if (!skill) return null;
    const othersWithSkill = (edgesByTarget[e.target] || [])
      .filter(se => se.type === 'has_skill' && se.source !== person_id)
      .map(se => {
        const other = nodesById[se.source];
        return other && other.properties.status === 'active' ? { ...nodeSummary(other), proficiency: (se.metadata || {}).proficiency } : null;
      })
      .filter(Boolean);
    return {
      ...nodeSummary(skill),
      personProficiency: (e.metadata || {}).proficiency,
      othersWithSkill: othersWithSkill.slice(0, 5),
      totalOthersCount: othersWithSkill.length
    };
  }).filter(Boolean);

  // Team membership
  const teamEdges = outEdges.filter(e => e.type === 'member_of');
  const teams = teamEdges.map(e => {
    const team = nodesById[e.target];
    if (!team) return null;
    const memberCount = (edgesByTarget[e.target] || []).filter(te => te.type === 'member_of').length;
    return { ...nodeSummary(team), memberCount, personRole: (e.metadata || {}).role };
  }).filter(Boolean);

  // Manager
  const managerEdge = outEdges.find(e => e.type === 'reports_to');
  const manager = managerEdge ? nodeSummary(nodesById[managerEdge.target]) : null;

  // Recruiting pipeline - positions this person interviews for
  const interviewEdges = inEdges.filter(e => e.type === 'interviewed_by');
  const pipeline = interviewEdges.map(e => {
    const candidate = nodesById[e.source];
    return candidate ? { ...nodeSummary(candidate), interviewMetadata: e.metadata } : null;
  }).filter(Boolean);

  // Review info
  const reviewEdges = outEdges.filter(e => e.type === 'has_review');
  const reviews = reviewEdges.map(e => {
    const review = nodesById[e.target];
    return review ? { id: review.id, ...review.properties } : null;
  }).filter(Boolean);

  return {
    person: { id: person.id, ...person.properties },
    directReports: { count: directReports.length, people: directReports },
    mentees: { count: mentees.length, people: mentees },
    projects: { count: projects.length, items: projects },
    skills: { count: skills.length, items: skills },
    teams: { count: teams.length, items: teams },
    manager,
    pipeline: { count: pipeline.length, candidates: pipeline },
    reviews,
    summary: {
      totalDirectReports: directReports.length,
      totalProjects: projects.length,
      soloProjects: projects.filter(pr => pr.contributorCount === 0).map(pr => pr.name),
      criticalProjects: projects.filter(pr => pr.priority === 'critical' || pr.priority === 'high').map(pr => pr.name),
      uniqueSkills: skills.filter(s => s.totalOthersCount < 3).map(s => s.name),
      menteesWithNoOtherMentor: mentees.filter(m => m.otherMentorCount === 0).map(m => m.name)
    }
  };
}

function get_graph_schema() {
  // Node types: count + property keys from a sample
  const nodeTypes = {};
  for (const [type, list] of Object.entries(nodesByType)) {
    const sample = list[0];
    const propKeys = sample ? Object.keys(sample.properties) : [];
    nodeTypes[type] = { count: list.length, properties: propKeys };
  }

  // Edge types: count + sample metadata keys
  const edgeTypeCounts = {};
  const edgeTypeMeta = {};
  for (const e of edges) {
    edgeTypeCounts[e.type] = (edgeTypeCounts[e.type] || 0) + 1;
    if (!edgeTypeMeta[e.type] && e.metadata) {
      edgeTypeMeta[e.type] = Object.keys(e.metadata);
    }
  }
  const edgeTypes = {};
  for (const [type, count] of Object.entries(edgeTypeCounts)) {
    edgeTypes[type] = { count, metadataKeys: edgeTypeMeta[type] || [] };
  }

  return {
    totalNodes: nodes.length,
    totalEdges: edges.length,
    nodeTypes,
    edgeTypes,
    hint: 'Use this schema to understand what data exists before querying. If a concept (e.g. promotions, compensation) has no corresponding node or edge type, tell the user that data is not in the graph.'
  };
}

function get_org_stats(stat_type) {
  const people = nodesByType['person'] || [];

  switch (stat_type) {
    case 'managers_by_reports': {
      // Find all people who have direct reports (inbound reports_to edges)
      const managers = [];
      for (const p of people) {
        const reportEdges = (edgesByTarget[p.id] || []).filter(e => e.type === 'reports_to');
        if (reportEdges.length > 0) {
          const teamEdge = (edgesBySource[p.id] || []).find(e => e.type === 'member_of');
          const team = teamEdge ? nodesById[teamEdge.target] : null;
          managers.push({
            ...nodeSummary(p),
            directReportCount: reportEdges.length,
            teamName: team ? team.properties.name || team.properties.title : null
          });
        }
      }
      managers.sort((a, b) => b.directReportCount - a.directReportCount);
      return { stat: 'managers_by_reports', managers: managers.slice(0, 15), totalManagers: managers.length };
    }

    case 'team_sizes': {
      const teams = nodesByType['team'] || [];
      const result = teams.map(t => {
        const memberEdges = (edgesByTarget[t.id] || []).filter(e => e.type === 'member_of');
        return { ...nodeSummary(t), memberCount: memberEdges.length };
      }).sort((a, b) => b.memberCount - a.memberCount);
      return { stat: 'team_sizes', teams: result.slice(0, 20), totalTeams: result.length };
    }

    case 'tenure_distribution': {
      const now = new Date();
      const buckets = { '<1yr': 0, '1-2yr': 0, '2-3yr': 0, '3-5yr': 0, '5+yr': 0 };
      for (const p of people) {
        if (!p.properties.startDate) continue;
        const years = (now - new Date(p.properties.startDate)) / (365.25 * 24 * 60 * 60 * 1000);
        if (years < 1) buckets['<1yr']++;
        else if (years < 2) buckets['1-2yr']++;
        else if (years < 3) buckets['2-3yr']++;
        else if (years < 5) buckets['3-5yr']++;
        else buckets['5+yr']++;
      }
      return { stat: 'tenure_distribution', buckets, totalPeople: people.length };
    }

    case 'level_distribution': {
      const levels = {};
      for (const p of people) {
        const level = p.properties.level || 'unknown';
        levels[level] = (levels[level] || 0) + 1;
      }
      return { stat: 'level_distribution', levels, totalPeople: people.length };
    }

    case 'location_distribution': {
      const locations = {};
      for (const p of people) {
        const loc = p.properties.location || 'unknown';
        locations[loc] = (locations[loc] || 0) + 1;
      }
      const sorted = Object.entries(locations).sort((a, b) => b[1] - a[1]).map(([location, count]) => ({ location, count }));
      return { stat: 'location_distribution', locations: sorted, totalPeople: people.length };
    }

    case 'skill_coverage': {
      const skills = nodesByType['skill'] || [];
      const result = skills.map(s => {
        const holders = (edgesByTarget[s.id] || []).filter(e => e.type === 'has_skill');
        return { ...nodeSummary(s), holderCount: holders.length };
      }).sort((a, b) => a.holderCount - b.holderCount);
      return { stat: 'skill_coverage', skills: result.slice(0, 20), rareSkills: result.filter(s => s.holderCount <= 2), totalSkills: result.length };
    }

    case 'department_sizes': {
      const depts = nodesByType['department'] || [];
      const result = depts.map(d => {
        const memberEdges = (edgesByTarget[d.id] || []).filter(e => e.type === 'in_department');
        return { ...nodeSummary(d), headcount: memberEdges.length };
      }).sort((a, b) => b.headcount - a.headcount);
      return { stat: 'department_sizes', departments: result, totalDepartments: result.length };
    }

    case 'division_sizes': {
      const divs = nodesByType['division'] || [];
      const result = divs.map(d => {
        const memberEdges = (edgesByTarget[d.id] || []).filter(e => e.type === 'in_division');
        return { ...nodeSummary(d), headcount: memberEdges.length };
      }).sort((a, b) => b.headcount - a.headcount);
      return { stat: 'division_sizes', divisions: result, totalDivisions: result.length };
    }

    default:
      return { error: `Unknown stat_type: ${stat_type}. Available: managers_by_reports, team_sizes, department_sizes, division_sizes, tenure_distribution, level_distribution, location_distribution, skill_coverage` };
  }
}

// --- Tool definitions for OpenAI ---
const toolDefs = [
  {
    type: 'function',
    function: {
      name: 'get_graph_schema',
      description: 'Returns the schema of the employee graph: all node types (with property keys and counts), all edge types (with metadata keys and counts). Call this FIRST when you are unsure whether the graph contains the data needed to answer a question. If the data does not exist, tell the user honestly rather than searching blindly.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_people',
      description: 'Search for people by name, role, email, or team. Returns up to 10 matches with summary info.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query — name, role, email' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_person_full',
      description: 'Get full profile and all connections for a person, grouped by edge type. Omits individual survey scores (anonymous).',
      parameters: {
        type: 'object',
        properties: { person_id: { type: 'string', description: 'Person ID, e.g. person-008' } },
        required: ['person_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_team_full',
      description: 'Get team details: members, manager, projects. Resolves member_of edges inward.',
      parameters: {
        type: 'object',
        properties: { team_id: { type: 'string', description: 'Team ID, e.g. team-001' } },
        required: ['team_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_direct_reports',
      description: 'Get direct reports for a manager. Optionally recursive (up to depth 5).',
      parameters: {
        type: 'object',
        properties: {
          person_id: { type: 'string', description: 'Manager person ID' },
          recursive: { type: 'boolean', description: 'If true, recurse down the reporting tree' }
        },
        required: ['person_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'traverse',
      description: 'Generic BFS graph traversal from a starting node. Walk outward along specified edge types up to max_depth. Returns discovered nodes and edges, capped at 50.',
      parameters: {
        type: 'object',
        properties: {
          start_id: { type: 'string', description: 'Starting node ID' },
          edge_types: { type: 'array', items: { type: 'string' }, description: 'Edge types to follow. If omitted, follows all types.' },
          max_depth: { type: 'integer', description: 'Max traversal depth (1-5, default 3)' }
        },
        required: ['start_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_nodes',
      description: 'Search any node type by name, title, role, or description. Optionally filter by node_type.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          node_type: { type: 'string', description: 'Optional: filter by node type (person, team, project, skill, etc.)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_impact_radius',
      description: 'Pre-walked multi-hop impact analysis for a person. Returns: direct reports, mentees (with whether they have other mentors), projects (with co-contributors), skills (with who else has them), team coverage, recruiting pipeline, and a summary highlighting solo projects, critical projects, unique skills, and orphaned mentees. One call replaces 4-5 separate queries.',
      parameters: {
        type: 'object',
        properties: { person_id: { type: 'string', description: 'Person ID to analyze' } },
        required: ['person_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_org_stats',
      description: 'Pre-computed org-wide statistics and rankings. Use this for aggregate questions like "who has the most reports", "team sizes", "tenure breakdown", etc. One call returns the full ranking — no need to query individual people.',
      parameters: {
        type: 'object',
        properties: {
          stat_type: {
            type: 'string',
            enum: ['managers_by_reports', 'team_sizes', 'department_sizes', 'division_sizes', 'tenure_distribution', 'level_distribution', 'location_distribution', 'skill_coverage'],
            description: 'Type of stat: managers_by_reports (ranked list of managers by direct report count), team_sizes (teams by member count), department_sizes (departments by headcount — Engineering, Sales, etc.), division_sizes (divisions by headcount — Product & Technology, Revenue, G&A), tenure_distribution (employee tenure buckets), level_distribution (headcount by level), location_distribution (headcount by location), skill_coverage (skills ranked by how many people have them, rare skills highlighted)'
          }
        },
        required: ['stat_type']
      }
    }
  }
];

// Tool dispatch
const toolFns = {
  get_graph_schema: () => get_graph_schema(),
  search_people: (args) => search_people(args.query),
  get_person_full: (args) => get_person_full(args.person_id),
  get_team_full: (args) => get_team_full(args.team_id),
  get_direct_reports: (args) => get_direct_reports(args.person_id, args.recursive),
  traverse: (args) => traverse(args.start_id, args.edge_types, args.max_depth),
  search_nodes: (args) => search_nodes(args.query, args.node_type),
  get_impact_radius: (args) => get_impact_radius(args.person_id),
  get_org_stats: (args) => get_org_stats(args.stat_type)
};

// --- System Prompt ---
function getSystemPrompt() {
  return `You are an HR intelligence analyst for Acme Co, a 148-employee tech company headquartered in Austin, TX. Today's date is 2026-03-12.

You have access to an Employee Graph — a knowledge graph with ${nodes.length} nodes (${Object.keys(nodesByType).length} types) and ${edges.length} edges (${new Set(edges.map(e => e.type)).size} types) representing every relationship in the company. This is not a traditional database — it's a connected graph where insights emerge by walking relationships.

## Your Audience

Your primary audience is an **HR administrator or CPO** — not an engineering manager. They care about:
1. **Org structure** — reporting lines, span of control, team headcount, who manages whom
2. **People risk** — retention, mentorship gaps, single points of failure, succession planning
3. **Compliance and process** — offboarding steps, benefits implications, COBRA deadlines, equipment return
4. **Team health** — coverage, morale signals (at team/dept level), skill distribution

Projects and technical work are relevant context but **secondary**. Don't lead with project names or engineering jargon. Lead with the people and the org.

## Your Tools

You have 9 graph query tools. ALWAYS query the graph before answering. Never fabricate data.

- **get_graph_schema** — Returns all node types, edge types, their properties, and counts. **Call this first when you're unsure whether the graph has the data to answer a question.** If the data doesn't exist, tell the user what's missing rather than searching blindly.
- **search_people** — Find people by name/role/email
- **get_person_full** — Full profile + all connections grouped by relationship type
- **get_team_full** — Team details with members, manager, and work assignments
- **get_direct_reports** — Reporting tree (optionally recursive)
- **traverse** — Walk outward from any node along specified relationship types
- **search_nodes** — Search any node type
- **get_impact_radius** — The power tool. Multi-hop impact analysis for a person: direct reports, mentees, work assignments, skills with coverage, team size, recruiting pipeline. Start here for any "what happens if X leaves/changes" question.
- **get_org_stats** — Pre-computed org-wide rankings and distributions. Use for aggregate questions like "who has the most reports", "largest teams", "tenure breakdown", "skill coverage". One call returns the full ranking — no need to query individuals one by one.

## How to Think

Walk outward from the event. At each hop, judge whether the connection matters for the people involved and the organization. Use real names and plain language.

**Good**: "Raj manages 12 people — that's the largest team in Engineering. When he leaves, those 12 reports need a new manager. Looking at who he mentors... Derek Lin is his only mentee, and Derek has no other mentor. Derek is relatively junior with about a year of tenure — he'll need support during this transition."

**Bad**: "The departing employee has downstream impacts on several team members and projects. The IC-3 contributor on the API Refactor loses his mentor, creating a single-threaded dependency on a critical-path deliverable."

Write like you're briefing an HR leader, not writing a technical incident report. Plain language. People first. Org impact front and center.

Stop walking when connections become tenuous. 3 hops is usually the sweet spot.

## Response Format

You MUST respond with valid JSON containing a "blocks" array. Each block has a "type" and type-specific fields. Mix block types for visual richness.

### Block Types

1. **narrative** — Markdown text. Use for framing, transitions, and conversational narration. Keep it warm and clear — you're briefing a colleague, not filing a report.
\`\`\`json
{ "type": "narrative", "content": "## Markdown here\\n\\nParagraph text..." }
\`\`\`

2. **person_card** — Profile card for a person. Lead your response with this for the subject.
\`\`\`json
{ "type": "person_card", "data": { "id": "person-008", "name": "Raj Patel", "role": "Engineering Lead", "level": "M-1", "status": "active", "startDate": "2022-11-07", "location": "Austin, TX", "teamName": "Platform", "managerName": "Lisa Huang", "directReportCount": 12, "projectCount": 4, "avatarUrl": "data/avatars/person-008.jpg", "stats": [{ "label": "Tenure", "value": "3.3 years" }, { "label": "Direct Reports", "value": "12" }] } }
\`\`\`

3. **impact_card** — A discovered impact with severity. Use after showing HOW you found it (via cascade_path).
\`\`\`json
{ "type": "impact_card", "data": { "severity": "critical", "title": "12 Direct Reports Need a New Manager", "description": "Raj manages the largest team in Engineering. All 12 reports will need reassignment — that's a significant org disruption to handle quickly.", "affectedPeople": [{ "id": "person-009", "name": "Derek Lin" }], "category": "org_structure" } }
\`\`\`
Severity: "critical" (red), "high" (orange), "medium" (yellow), "low" (blue)
Categories: org_structure, mentorship, retention, compliance, skills, succession

4. **metric_row** — 2-4 stat cards. Use for quantitative summary.
\`\`\`json
{ "type": "metric_row", "data": { "metrics": [{ "value": "12", "label": "Direct Reports", "context": "Largest team in Engineering" }, { "value": "3.3 yr", "label": "Tenure", "context": "Institutional knowledge at risk" }] } }
\`\`\`

5. **cascade_path** — THE DIFFERENTIATOR. Shows the chain of relationships that led to a discovery. An animated chain of connected nodes — makes the graph walk visible.
\`\`\`json
{ "type": "cascade_path", "data": { "title": "Mentorship gap", "steps": [
  { "id": "person-008", "label": "Raj Patel", "type": "person", "detail": "Departing" },
  { "edge": "mentors", "label": "only mentor for" },
  { "id": "person-009", "label": "Derek Lin", "type": "person", "detail": "1 year tenure, needs support" },
  { "edge": "member_of", "label": "on" },
  { "id": "team-001", "label": "Platform", "type": "team", "detail": "Will lose senior guidance" }
] } }
\`\`\`
Steps alternate between nodes (with id, label, type, detail) and edges (with relationship type and label). Each node is clickable.

6. **action_list** — Prioritized action items with clear owners.
\`\`\`json
{ "type": "action_list", "data": { "title": "Recommended Actions", "actions": [
  { "priority": "critical", "action": "Identify interim manager for 12 direct reports", "owner": "Lisa Huang", "reason": "Can't leave 12 people without a manager" },
  { "priority": "high", "action": "Pair Derek Lin with a new mentor", "owner": "Lisa Huang", "reason": "Junior employee losing his only mentor" },
  { "priority": "high", "action": "Start offboarding checklist — equipment, access, benefits", "owner": "HR", "reason": "Compliance deadlines (COBRA notice within 14 days)" }
] } }
\`\`\`

7. **relationship_map** — Mini graph visualization. Keep under 15 nodes. Show the big picture of who's affected.
\`\`\`json
{ "type": "relationship_map", "data": { "title": "Raj's Organizational Footprint", "nodes": [
  { "id": "person-008", "label": "Raj Patel", "type": "person", "highlight": true },
  { "id": "person-009", "label": "Derek Lin", "type": "person" },
  { "id": "team-001", "label": "Platform", "type": "team" }
], "edges": [
  { "source": "person-008", "target": "person-009", "label": "mentors" },
  { "source": "person-008", "target": "team-001", "label": "member_of" }
] } }
\`\`\`

8. **chart** — Structured data visualizations. Use when the insight is best shown as a chart rather than text or cards. The frontend renders these as styled SVG — you just provide the data.

**Bar chart** (horizontal bars — great for rankings and comparisons):
\`\`\`json
{ "type": "chart", "data": {
  "chartType": "bar",
  "title": "Managers by Direct Report Count",
  "items": [
    { "label": "Raj Patel", "value": 12, "subtitle": "Platform" },
    { "label": "Lisa Huang", "value": 8, "subtitle": "Engineering" },
    { "label": "Tom Davis", "value": 6, "subtitle": "Product" }
  ],
  "valueLabel": "direct reports"
} }
\`\`\`

**Donut chart** (proportions/breakdowns):
\`\`\`json
{ "type": "chart", "data": {
  "chartType": "donut",
  "title": "Team Size Distribution",
  "items": [
    { "label": "Engineering", "value": 62 },
    { "label": "Product", "value": 24 },
    { "label": "Design", "value": 18 }
  ]
} }
\`\`\`

**Timeline** (temporal sequence):
\`\`\`json
{ "type": "chart", "data": {
  "chartType": "timeline",
  "title": "Offboarding Milestones",
  "items": [
    { "label": "Last day confirmed", "date": "2026-03-15", "status": "done" },
    { "label": "Knowledge transfer complete", "date": "2026-03-22", "status": "in_progress" },
    { "label": "COBRA notice sent", "date": "2026-03-29", "status": "pending" }
  ]
} }
\`\`\`

Use chart for: rankings, comparisons, breakdowns, proportions, timelines, progress tracking. Do NOT use chart when a person_card, impact_card, or cascade_path already fits.

## Composition Rules

1. **Lead with person_card** for the subject of the query.
2. **metric_row early** — give the quantitative picture up front (reports, tenure, team size).
3. **cascade_path shows HOW you found each insight** — the relationship chain. This is what makes the demo special. But limit to 2-3 — pick the most meaningful discoveries.
4. **Follow cascade_path with impact_card** for the conclusion.
5. **End with action_list** — concrete next steps with owners.
6. **relationship_map at the end** — visual summary of the full impact footprint.
7. **Narrative sparingly** — for framing and transitions, not for dumping all analysis into text.
8. **Mix block types** — a good response has 8-15 blocks of 4-6 different types.
9. **chart for data insights** — when you have quantitative data best shown as a bar chart, donut, or timeline, use chart. 1-2 per response max.

## Priority Order for Impacts

When someone departs, surface impacts in this order (HR admin priorities):
1. **Reporting structure** — who reports to them, who needs a new manager
2. **Mentorship gaps** — who loses a mentor, are there alternatives
3. **Team coverage** — does any team lose a critical member, headcount concerns
4. **Skill gaps** — rare skills leaving the org, who else has them
5. **Compliance/process** — offboarding, COBRA, equipment, final pay, benefits
6. **Work continuity** — assignments and handoffs (mention but don't lead with)

## Tone

- Plain language. "Raj manages 12 people" not "Raj has a span of control encompassing 12 individual contributors."
- People first. "Derek will need a new mentor" not "The mentorship dependency graph has a single point of failure."
- Warm but professional. You're briefing a colleague who cares about these people.
- Use first names after introduction. "Raj" not "the departing employee."
- Avoid: jargon, acronyms without context, engineering-speak, abstract process language.

## Privacy Rules

- Survey responses (eNPS, wellbeing, satisfaction) are ANONYMOUS. Never show individual scores. Only aggregate at team/department level.
- Never show: individual survey scores, investigation details, garnishment details.

## What NOT to do

- Don't fabricate graph data. If you can't find it, say so. If you're unsure whether the graph has certain data, call get_graph_schema first.
- Don't return a wall of narrative text. Mix block types for visual richness.
- Don't show more than 3 cascade_paths — pick the most impactful discoveries.
- Don't include more than 15 nodes in a relationship_map.
- Don't use cascade_path for trivial single-hop connections. Reserve it for multi-hop discoveries.
- Don't lead with project names or technical work. Lead with people and org structure.

Remember: You're narrating a live discovery, not writing a report. "Looking at Raj's reporting relationships... he manages 12 people" not "The analysis reveals organizational dependencies."`;
}

// --- OpenAI Client ---
if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your-key-here') {
  console.warn('WARNING: OPENAI_API_KEY not set in .env — AI queries will fail. Set it and restart.');
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Conversation State ---
const conversations = new Map();
const CONVERSATION_TTL = 30 * 60 * 1000; // 30 minutes

// Cleanup old conversations periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, conv] of conversations) {
    if (now - conv.lastAccess > CONVERSATION_TTL) conversations.delete(id);
  }
}, 5 * 60 * 1000);

// --- SSE Chat Endpoint ---
app.get('/api/chat/stream', async (req, res) => {
  const { conversation_id, message } = req.query;

  if (!message) {
    res.status(400).json({ error: 'message parameter required' });
    return;
  }

  const convId = conversation_id || crypto.randomUUID();

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Conversation-Id', convId);
  res.flushHeaders();

  function sendSSE(type, data) {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  console.log('--- New request:', message.substring(0, 80));

  try {
    // Get or create conversation
    let conv = conversations.get(convId);
    if (!conv) {
      conv = { messages: [{ role: 'system', content: getSystemPrompt() }], lastAccess: Date.now() };
      conversations.set(convId, conv);
    }
    conv.lastAccess = Date.now();

    // Add user message
    conv.messages.push({ role: 'user', content: message });

    sendSSE('status', { message: 'Thinking...' });

    // Tool loop (max 8 iterations)
    let toolCalls = 0;
    const MAX_TOOL_CALLS = 8;

    while (toolCalls < MAX_TOOL_CALLS) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-5.4',
        messages: conv.messages,
        tools: toolDefs,
        tool_choice: toolCalls === 0 ? 'auto' : 'auto',
        temperature: 0.7,
        max_completion_tokens: 6144
      }, { timeout: 90000 });

      const choice = completion.choices[0];
      const assistantMsg = choice.message;
      console.log(`API call #${toolCalls} done. finish_reason=${choice.finish_reason}, has_tool_calls=${!!(assistantMsg.tool_calls && assistantMsg.tool_calls.length)}, content_len=${(assistantMsg.content || '').length}`);
      conv.messages.push(assistantMsg);

      // If the model wants to call tools
      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        for (const tc of assistantMsg.tool_calls) {
          const fnName = tc.function.name;
          let args;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch (e) {
            args = {};
          }

          // Status update
          const statusMessages = {
            get_graph_schema: 'Checking what data is available in the graph...',
            search_people: `Searching for "${args.query}"...`,
            get_person_full: `Loading full profile for ${args.person_id}...`,
            get_team_full: `Loading team ${args.team_id}...`,
            get_direct_reports: `Tracing reporting tree for ${args.person_id}...`,
            traverse: `Walking graph from ${args.start_id}...`,
            search_nodes: `Searching ${args.node_type || 'all'} nodes for "${args.query}"...`,
            get_impact_radius: `Analyzing impact radius — tracing reports, mentees, projects, skills...`,
            get_org_stats: `Computing org-wide ${args.stat_type || 'statistics'}...`
          };
          sendSSE('status', { message: statusMessages[fnName] || `Calling ${fnName}...` });

          // Execute tool
          const fn = toolFns[fnName];
          let result;
          if (fn) {
            result = fn(args);
          } else {
            result = { error: `Unknown tool: ${fnName}` };
          }

          conv.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result)
          });

          toolCalls++;
        }
        continue; // Loop back for more tool calls or final response
      }

      // No tool calls — we have the final response
      console.log('Final response received, finish_reason:', choice.finish_reason, 'content length:', (assistantMsg.content || '').length);
      if (choice.finish_reason === 'length') {
        console.warn('WARNING: Response truncated by token limit!');
      }
      if (assistantMsg.content) {
        // Parse the JSON response
        let content = assistantMsg.content.trim();
        // Strip markdown code blocks if present
        if (content.startsWith('```')) {
          content = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        }

        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (e) {
          console.error('JSON parse error:', e.message);
          console.error('Content starts with:', content.substring(0, 200));
          console.error('Content ends with:', content.substring(content.length - 200));
          // If it's not JSON, wrap it in a narrative block
          parsed = { blocks: [{ type: 'narrative', content: assistantMsg.content }] };
        }

        // Stream blocks one at a time
        const blocks = parsed.blocks || [parsed];
        sendSSE('status', { message: 'Composing response...' });

        for (let i = 0; i < blocks.length; i++) {
          await new Promise(resolve => setTimeout(resolve, i === 0 ? 100 : 400));
          sendSSE('block', { block: blocks[i], index: i, total: blocks.length });
        }
      }

      break; // Done
    }

    sendSSE('done', { conversation_id: convId });
  } catch (err) {
    console.error('Chat error:', err);
    sendSSE('error', { message: err.message || 'An error occurred' });
  } finally {
    res.end();
  }
});

// --- Explore System Prompt (Progressive Disclosure) ---
function getExploreSystemPrompt() {
  return `You are an HR intelligence analyst for Acme Co, a 148-employee tech company headquartered in Austin, TX. Today's date is 2026-03-12.

You have access to an Employee Graph with ${nodes.length} nodes and ${edges.length} edges. ALWAYS query the graph before answering. Never fabricate data.

## Mode: PROGRESSIVE DISCLOSURE

You work in progressive disclosure mode. Each response is SMALL and FOCUSED. The user explores by clicking follow-up prompts on an interactive canvas. Do NOT dump everything at once.

## Your Tools

You have 9 graph query tools. Use them — especially get_impact_radius for departure scenarios and get_org_stats for aggregate questions.

## Response Format

You MUST respond with valid JSON in this exact structure:
{
  "blocks": [ /* 1-3 content blocks */ ],
  "prompts": [ /* 2-6 follow-up prompts */ ],
  "options": null
}

### Response Types

**SEED response** (first message about a person/event):
- blocks: person_card for the subject + metric_row with 3-4 key metrics
- prompts: 4-6 follow-up prompts
- options: null

**EXPLORE response** (follow-up prompt clicked):
- blocks: 1-3 focused content blocks answering the specific question
- prompts: 2-4 follow-up prompts for deeper exploration
- options: null (or an options object if there's a choice to make)

**SCENARIO response** (user selected an option):
- blocks: 1-2 fyi/impact blocks showing consequences
- prompts: 1-3 follow-up prompts
- options: null

### Block Types

1. **person_card** — Profile card for a person
\`{ "type": "person_card", "data": { "id": "person-008", "name": "Raj Patel", "role": "Engineering Lead", "level": "M-1", "status": "active", "startDate": "2022-11-07", "location": "Austin, TX", "teamName": "Platform", "managerName": "Lisa Huang", "directReportCount": 12, "projectCount": 4, "avatarUrl": "data/avatars/person-008.jpg" } }\`

2. **metric_row** — 3-4 metric chips
\`{ "type": "metric_row", "data": { "metrics": [{ "value": "12", "label": "Direct Reports", "context": "Largest in Engineering" }] } }\`

3. **person_grid** — Compact grid of people
\`{ "type": "person_grid", "data": { "title": "Direct Reports", "people": [{ "id": "person-009", "name": "Derek Lin", "role": "Senior Engineer", "avatarUrl": "data/avatars/person-009.jpg" }] } }\`

4. **narrative** — Short markdown text (1-3 sentences max)
\`{ "type": "narrative", "content": "Raj manages the **largest team** in Engineering..." }\`

5. **impact_card** — Severity-tagged impact finding
\`{ "type": "impact_card", "data": { "severity": "critical", "title": "12 Reports Need a New Manager", "description": "Brief description", "affectedPeople": [{ "id": "person-009", "name": "Derek Lin" }], "category": "org_structure" } }\`

6. **cascade_path** — Relationship chain visualization
\`{ "type": "cascade_path", "data": { "title": "Mentorship gap", "steps": [{ "id": "person-008", "label": "Raj", "type": "person", "detail": "Departing" }, { "edge": "mentors", "label": "only mentor" }, { "id": "person-009", "label": "Derek", "type": "person", "detail": "1yr tenure" }] } }\`

7. **info_list** — Key-value information list
\`{ "type": "info_list", "data": { "title": "Offboarding Checklist", "items": [{ "label": "COBRA Notice", "value": "Due within 14 days" }, { "label": "Equipment Return", "value": "Laptop, badge, parking pass" }] } }\`

8. **fyi** — Informational or warning block
\`{ "type": "fyi", "data": { "severity": "warning", "title": "Derek Has No Backup Mentor", "content": "Derek Lin is relatively junior (1yr tenure) and Raj is his only mentor." } }\`
Severity: "info" (blue), "warning" (orange), "critical" (red)

9. **action_list** — Recommended actions (goes to decisions panel)
\`{ "type": "action_list", "data": { "title": "Recommended Actions", "actions": [{ "priority": "critical", "action": "Identify interim manager", "owner": "Lisa Huang", "reason": "12 reports need a manager" }] } }\`

10. **chart** — Data visualization
\`{ "type": "chart", "data": { "chartType": "bar", "title": "Title", "items": [...], "valueLabel": "label" } }\`

### Prompt Format

Each prompt object:
\`{ "text": "What's the effect on the team?", "category": "consequence" }\`

Categories:
- **consequence**: exploring impacts, understanding what happened (shown below content in main flow)
- **action**: things to do about it, next steps (shown to the right)

Write prompts as natural questions a curious HR leader would ask. Be specific — "Who's most at risk of leaving?" not "Learn more."

### Options Format (when presenting choices)

\`{ "question": "Who should be interim manager?", "items": [{ "id": "person-009", "name": "Derek Lin", "role": "Senior Engineer", "avatarUrl": "data/avatars/person-009.jpg", "reason": "Most senior on the team" }] }\`

## Rules

- Keep responses SMALL. 1-3 blocks max per response. The canvas grows organically.
- ALWAYS include 2-6 follow-up prompts. The user explores by clicking.
- Use person_grid for groups of people (direct reports, team members).
- Use cascade_path ONLY for multi-hop relationship discoveries.
- Use fyi for important warnings or context the user should know.
- action_list items go to the user's decisions panel — use for concrete next steps.
- Use real names and plain language. Write like you're briefing a colleague.
- NEVER fabricate data. If the graph doesn't have it, say so.
- Prompts should be specific and actionable — "Who's most at risk?" not "Tell me more."`;
}

function sendExploreResponse(content, sendSSE) {
  let text = content.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.error('Explore JSON parse error:', e.message);
    parsed = {
      blocks: [{ type: 'narrative', content }],
      prompts: [{ text: 'Tell me more', category: 'consequence' }],
      options: null
    };
  }

  if (!parsed.blocks) parsed.blocks = [];
  if (!parsed.prompts) parsed.prompts = [];

  sendSSE('response', {
    blocks: parsed.blocks,
    prompts: parsed.prompts,
    options: parsed.options || null
  });
}

// --- SSE Explore Endpoint (Progressive Disclosure) ---
app.get('/api/explore', async (req, res) => {
  const { conversation_id, message } = req.query;

  if (!message) {
    res.status(400).json({ error: 'message parameter required' });
    return;
  }

  const convId = conversation_id || crypto.randomUUID();

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Conversation-Id', convId);
  res.flushHeaders();

  function sendSSE(type, data) {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  console.log('--- Explore request:', message.substring(0, 80));

  try {
    let conv = conversations.get(convId);
    if (!conv) {
      conv = { messages: [{ role: 'system', content: getExploreSystemPrompt() }], lastAccess: Date.now() };
      conversations.set(convId, conv);
    }
    conv.lastAccess = Date.now();

    conv.messages.push({ role: 'user', content: message });

    sendSSE('status', { message: 'Thinking...' });

    // Tool loop (max 5 tool calls for explore)
    let toolCalls = 0;
    const MAX_TOOL_CALLS = 5;
    let gotFinalResponse = false;

    while (toolCalls < MAX_TOOL_CALLS) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-5.4',
        messages: conv.messages,
        tools: toolDefs,
        tool_choice: 'auto',
        temperature: 0.7,
        max_completion_tokens: 4096
      }, { timeout: 90000 });

      const choice = completion.choices[0];
      const assistantMsg = choice.message;
      console.log(`Explore API call #${toolCalls} done. finish_reason=${choice.finish_reason}, tools=${!!(assistantMsg.tool_calls && assistantMsg.tool_calls.length)}`);
      conv.messages.push(assistantMsg);

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        for (const tc of assistantMsg.tool_calls) {
          const fnName = tc.function.name;
          let args;
          try { args = JSON.parse(tc.function.arguments); } catch (e) { args = {}; }

          const statusMessages = {
            get_graph_schema: 'Checking graph schema...',
            search_people: `Searching for "${args.query}"...`,
            get_person_full: `Loading profile...`,
            get_team_full: `Loading team...`,
            get_direct_reports: `Tracing reporting tree...`,
            traverse: `Walking graph...`,
            search_nodes: `Searching nodes...`,
            get_impact_radius: `Analyzing impact radius...`,
            get_org_stats: `Computing org statistics...`
          };
          sendSSE('status', { message: statusMessages[fnName] || `Querying ${fnName}...` });

          const fn = toolFns[fnName];
          const result = fn ? fn(args) : { error: `Unknown tool: ${fnName}` };

          conv.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result)
          });

          toolCalls++;
        }
        continue;
      }

      // Final response — parse and send
      if (assistantMsg.content) {
        sendExploreResponse(assistantMsg.content, sendSSE);
        gotFinalResponse = true;
      }

      break;
    }

    // If we ran out of tool calls, force a final response
    if (!gotFinalResponse) {
      sendSSE('status', { message: 'Composing response...' });
      const finalCompletion = await openai.chat.completions.create({
        model: 'gpt-5.4',
        messages: conv.messages,
        tools: toolDefs,
        tool_choice: 'none',
        temperature: 0.7,
        max_completion_tokens: 4096
      }, { timeout: 90000 });

      const finalMsg = finalCompletion.choices[0].message;
      conv.messages.push(finalMsg);
      if (finalMsg.content) {
        sendExploreResponse(finalMsg.content, sendSSE);
      }
    }

    sendSSE('done', { conversation_id: convId });
  } catch (err) {
    console.error('Explore error:', err);
    sendSSE('error', { message: err.message || 'An error occurred' });
  } finally {
    res.end();
  }
});

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Start ---
loadGraphData().then(() => {
  app.listen(PORT, () => {
    console.log(`JIT-UI server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to load graph data:', err);
  process.exit(1);
});
