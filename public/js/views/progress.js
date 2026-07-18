// Progress view — accuracy trend per node, nodes at each status, review debt,
// eligibility (taughtIn gate) visibility. Scrolling is allowed here.
// Never shows a completed-sessions count.

import { getActivePlan, getNodeStates, getCompletedLessonIds } from '../session.js';
import { accuracyTrend, decayedConfidence, isEligible, STATUSES } from '../ledger.js';
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

export async function renderProgress(root) {
  root.innerHTML = '';
  const plan = await getActivePlan();
  if (!plan) {
    root.append(el('div', 'empty', 'No plan loaded.'));
    return;
  }
  const [nodes, completed] = await Promise.all([
    getNodeStates(plan.id),
    getCompletedLessonIds(plan.id)
  ]);

  // Review debt
  const debt = reviewDebt(nodes, completed);
  const debtCard = el('section', 'card');
  debtCard.append(el('h2', null, 'Review debt'));
  debtCard.append(el('p', 'big-number', String(debt)));
  debtCard.append(el('p', 'muted', debt === 1 ? 'skill due for review' : 'skills due for review'));
  root.append(debtCard);

  // Status distribution
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

  // Per-node accuracy trends
  const nodesCard = el('section', 'card');
  nodesCard.append(el('h2', null, 'Accuracy trend per skill'));
  const list = el('div', 'node-list');
  nodes
    .slice()
    .sort((a, b) => b.attempts - a.attempts)
    .forEach((n) => {
      const locked = !isEligible(n, completed);
      const row = el('div', `node-row status-${n.status}${n.flagged ? ' flagged' : ''}${locked ? ' locked' : ''}`);
      const info = el('div', 'node-info');
      const name = n.name
        + (n.derived ? ' (derived)' : '')
        + (n.flagged ? ' ⚑' : '')
        + (locked ? ' 🔒' : '');
      info.append(el('strong', null, name));
      const meta = locked
        ? `locked until lesson "${n.taughtIn}" is complete`
        : `${n.status} · ${n.attempts} attempts · ${Math.round(n.accuracy * 100)}% · conf ${decayedConfidence(n).toFixed(2)}`;
      info.append(el('span', 'muted small', meta));
      row.append(info);
      row.append(sparkline(accuracyTrend(n)));
      list.append(row);
    });
  nodesCard.append(list);
  root.append(nodesCard);
}
