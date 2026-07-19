// Progress view — compact status summary plus only the skills that need
// attention right now (due, flagged/stuck, or low confidence). The full
// per-skill list with accuracy trends lives one tap away ("See all
// skills"), where the detailed card layout is reserved. Never shows a
// completed-sessions count.

import { getActivePlan, getNodeStates, getCompletedLessonIds } from '../session.js';
import { accuracyTrend, decayedConfidence, isEligible, dueNodes, reviewWeight, STATUSES } from '../ledger.js';
import { reviewDebt } from '../assembler.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function sparkline(values) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const w = 120, h = 28, pad = 3;
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'spark');
  if (values.length === 0) return svg;
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${pad + i * step},${h - pad - v * (h - pad * 2)}`).join(' ');
  const line = document.createElementNS(svgNS, 'polyline');
  line.setAttribute('points', pts);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '2');
  svg.append(line);
  return svg;
}

const LOW_CONFIDENCE_THRESHOLD = 0.4;

// A node with pre-seeded status/confidence (from prior history outside the
// app — see newNodeState's `seeded` flag) but zero in-app attempts hasn't
// had that seeded number blended with anything real yet: showing it next to
// "0 attempts · 0%" reads as contradictory. Once there's at least one real
// attempt, recordResult has already blended the seed into a live number, so
// the normal accuracy/confidence line is accurate again.
function isSeededOnly(n) {
  return n.attempts === 0 && n.seeded;
}

function confidenceLabel(n, now) {
  const conf = decayedConfidence(n, now).toFixed(2);
  return isSeededOnly(n) ? `${conf} (from import)` : conf;
}

function detailMeta(n, locked, now) {
  if (locked) return `locked until lesson "${n.taughtIn}" is complete`;
  if (isSeededOnly(n)) return `${n.status} · no attempts yet in this app · confidence ${confidenceLabel(n, now)}`;
  return `${n.status} · ${n.attempts} attempts · ${Math.round(n.accuracy * 100)}% · conf ${confidenceLabel(n, now)}`;
}

function nodeName(n) {
  return n.name + (n.derived ? ' (derived)' : '') + (n.flagged ? ' ⚑' : '');
}

function attentionReason(n, dueIds, now) {
  if (n.flagged) return 'flagged — flat progress, try a different approach';
  if (dueIds.has(n.id)) return 'due for review';
  return `low confidence — ${confidenceLabel(n, now)}`;
}

function needsAttention(n, completed, dueIds) {
  if (!isEligible(n, completed)) return false; // not actionable yet
  if (n.flagged) return true;
  if (dueIds.has(n.id)) return true;
  if (n.attempts === 0 && !n.seeded) return false; // untouched, nothing to act on
  return decayedConfidence(n) < LOW_CONFIDENCE_THRESHOLD;
}

function renderAttentionCard(n, reason) {
  const card = el('div', `attn-card status-${n.status}${n.flagged ? ' flagged' : ''}`);
  const info = el('div', 'node-info');
  info.append(el('strong', null, nodeName(n)));
  info.append(el('span', 'muted small', reason));
  card.append(info);
  return card;
}

function renderDetailCard(n, completed, now) {
  const locked = !isEligible(n, completed);
  const row = el('div', `node-row status-${n.status}${n.flagged ? ' flagged' : ''}${locked ? ' locked' : ''}`);
  const info = el('div', 'node-info');
  const name = nodeName(n) + (locked ? ' 🔒' : '');
  info.append(el('strong', null, name));
  info.append(el('span', 'muted small', detailMeta(n, locked, now)));
  row.append(info);
  row.append(sparkline(accuracyTrend(n)));
  return row;
}

export async function renderProgress(root) {
  root.innerHTML = '';
  const plan = await getActivePlan();
  if (!plan) {
    root.append(el('div', 'empty', 'No plan loaded.'));
    return;
  }
  const now = Date.now();
  const [nodes, completed] = await Promise.all([
    getNodeStates(plan.id),
    getCompletedLessonIds(plan.id)
  ]);

  // Review debt
  const debt = reviewDebt(nodes, completed, now);
  const debtCard = el('section', 'card');
  debtCard.append(el('h2', null, 'Review debt'));
  debtCard.append(el('p', 'big-number', String(debt)));
  debtCard.append(el('p', 'muted', debt === 1 ? 'skill due for review' : 'skills due for review'));
  root.append(debtCard);

  // Status distribution — compact summary, always shown
  const statusCard = el('section', 'card');
  statusCard.append(el('h2', null, 'Skills by status'));
  const grid = el('div', 'status-grid');
  for (const s of [...STATUSES].reverse()) {
    const count = nodes.filter((n) => n.status === s).length;
    const cell = el('div', `status-cell status-${s}`);
    cell.append(el('div', 'big-number', String(count)));
    cell.append(el('div', 'muted small', s));
    grid.append(cell);
  }
  statusCard.append(grid);
  root.append(statusCard);

  // Needs attention — due, flagged/stuck, or low confidence; eligible only.
  // This replaces a full scroll through every skill with just what's
  // actionable right now. Everything else is one tap away.
  const dueIds = new Set(dueNodes(nodes, now).filter((n) => isEligible(n, completed)).map((n) => n.id));
  const attention = nodes.filter((n) => needsAttention(n, completed, dueIds));
  attention.sort((a, b) => {
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
    return reviewWeight(b, now) - reviewWeight(a, now);
  });

  const attnCard = el('section', 'card');
  attnCard.append(el('h2', null, 'Needs attention'));
  if (attention.length === 0) {
    attnCard.append(el('p', 'muted small', 'Nothing needs attention right now.'));
  } else {
    const list = el('div', 'attn-list');
    attention.forEach((n) => list.append(renderAttentionCard(n, attentionReason(n, dueIds, now))));
    attnCard.append(list);
  }
  const seeAllBtn = el('button', null, `See all skills (${nodes.length}) →`);
  seeAllBtn.onclick = () => { location.hash = '#progress-all'; };
  attnCard.append(seeAllBtn);
  root.append(attnCard);
}

// Secondary view: every skill, detailed card (status/attempts/accuracy/
// confidence/sparkline) — reserved here, off the primary Progress screen.
export async function renderAllSkills(root) {
  root.innerHTML = '';
  const plan = await getActivePlan();
  if (!plan) {
    root.append(el('div', 'empty', 'No plan loaded.'));
    return;
  }
  const now = Date.now();
  const [nodes, completed] = await Promise.all([
    getNodeStates(plan.id),
    getCompletedLessonIds(plan.id)
  ]);

  const head = el('div', 'view-head');
  head.append(el('h2', null, 'All skills'));
  const backBtn = el('button', null, '← Progress');
  backBtn.onclick = () => { location.hash = '#progress'; };
  head.append(backBtn);
  root.append(head);

  const list = el('div', 'node-list');
  nodes
    .slice()
    .sort((a, b) => b.attempts - a.attempts)
    .forEach((n) => list.append(renderDetailCard(n, completed, now)));
  root.append(list);
}
