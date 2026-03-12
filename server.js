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
    return { ...base, role: p.role, level: p.level, status: p.status, startDate: p.startDate, location: p.location };
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

// --- Tool definitions for OpenAI ---
const toolDefs = [
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
  }
];

// Tool dispatch
const toolFns = {
  search_people: (args) => search_people(args.query),
  get_person_full: (args) => get_person_full(args.person_id),
  get_team_full: (args) => get_team_full(args.team_id),
  get_direct_reports: (args) => get_direct_reports(args.person_id, args.recursive),
  traverse: (args) => traverse(args.start_id, args.edge_types, args.max_depth),
  search_nodes: (args) => search_nodes(args.query, args.node_type),
  get_impact_radius: (args) => get_impact_radius(args.person_id)
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

You have 7 graph query tools. ALWAYS query the graph before answering. Never fabricate data.

- **search_people** — Find people by name/role/email
- **get_person_full** — Full profile + all connections grouped by relationship type
- **get_team_full** — Team details with members, manager, and work assignments
- **get_direct_reports** — Reporting tree (optionally recursive)
- **traverse** — Walk outward from any node along specified relationship types
- **search_nodes** — Search any node type
- **get_impact_radius** — The power tool. Multi-hop impact analysis for a person: direct reports, mentees, work assignments, skills with coverage, team size, recruiting pipeline. Start here for any "what happens if X leaves/changes" question.

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
{ "type": "person_card", "data": { "id": "person-008", "name": "Raj Patel", "role": "Engineering Lead", "level": "M-1", "status": "active", "startDate": "2022-11-07", "location": "Austin, TX", "teamName": "Platform", "managerName": "Lisa Huang", "directReportCount": 12, "projectCount": 4, "stats": [{ "label": "Tenure", "value": "3.3 years" }, { "label": "Direct Reports", "value": "12" }] } }
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

## Composition Rules

1. **Lead with person_card** for the subject of the query.
2. **metric_row early** — give the quantitative picture up front (reports, tenure, team size).
3. **cascade_path shows HOW you found each insight** — the relationship chain. This is what makes the demo special. But limit to 2-3 — pick the most meaningful discoveries.
4. **Follow cascade_path with impact_card** for the conclusion.
5. **End with action_list** — concrete next steps with owners.
6. **relationship_map at the end** — visual summary of the full impact footprint.
7. **Narrative sparingly** — for framing and transitions, not for dumping all analysis into text.
8. **Mix block types** — a good response has 8-15 blocks of 4-6 different types.

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

- Don't fabricate graph data. If you can't find it, say so.
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
        max_completion_tokens: 4096
      });

      const choice = completion.choices[0];
      const assistantMsg = choice.message;
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
            search_people: `Searching for "${args.query}"...`,
            get_person_full: `Loading full profile for ${args.person_id}...`,
            get_team_full: `Loading team ${args.team_id}...`,
            get_direct_reports: `Tracing reporting tree for ${args.person_id}...`,
            traverse: `Walking graph from ${args.start_id}...`,
            search_nodes: `Searching ${args.node_type || 'all'} nodes for "${args.query}"...`,
            get_impact_radius: `Analyzing impact radius — tracing reports, mentees, projects, skills...`
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
