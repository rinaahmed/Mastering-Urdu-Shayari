// Progress view — accuracy trend per node, nodes at each status, review debt.
// Deliberately NOT the default screen, and no "sessions completed" anywhere.

import { getActivePlan, getNodeStates } from '../session.js';
import { accuracyTrend, decayedConfidence, STATUSES } from '../ledger.js';
import { reviewDebt } from '../assembler.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function sparkline(values) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const w = 120, h = 28, pad = 2;
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

export async function renderProgress(root) {
  root.innerHTML = '';
  const plan = await getActivePlan();
  if (!plan) {
    root.append(el('div', 'empty', 'No plan loaded.'));
    return;
  }
  const nodes = await getNodeStates(plan.id);

  // Review debt
  const debt = reviewDebt(nodes);
  const debtCard = el('section', 'card');
  debtCard.append(el('h2', null, 'Review debt'));
  debtCard.append(el('p', debt > 5 ? 'big-number warn' : 'big-number', String(debt)));
  debtCard.append(el('p', 'muted', debt === 1 ? 'node due for review' : 'nodes due for review'));
  root.append(debtCard);

  // Status distribution
  const statusCard = el('section', 'card');
  statusCard.append(el('h2', null, 'Nodes by status'));
  const grid = el('div', 'status-grid');
  for (const s of [...STATUSES].reverse()) {
    const count = nodes.filter(n => n.status === s).length;
    const cell = el('div', `status-cell status-${s}`);
    cell.append(el('div', 'big-number', String(count)));
    cell.append(el('div', 'muted small', s));
    grid.append(cell);
  }
  statusCard.append(grid);
  root.append(statusCard);

  // Per-node accuracy trends
  const nodesCard = el('section', 'card');
  nodesCard.append(el('h2', null, 'Accuracy trend per node'));
  const list = el('div', 'node-list');
  nodes
    .slice()
    .sort((a, b) => b.attempts - a.attempts)
    .forEach(n => {
      const row = el('div', `node-row status-${n.status}${n.flagged ? ' flagged' : ''}`);
      const info = el('div', 'node-info');
      info.append(el('strong', null, n.name + (n.derived ? ' (derived)' : '') + (n.flagged ? ' ⚑' : '')));
      info.append(el('span', 'muted small',
        `${n.status} · ${n.attempts} attempts · ${Math.round(n.accuracy * 100)}% · conf ${decayedConfidence(n).toFixed(2)}`));
      row.append(info);
      row.append(sparkline(accuracyTrend(n)));
      list.append(row);
    });
  nodesCard.append(list);
  root.append(nodesCard);
}
