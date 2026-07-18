// Portfolio view — artifacts browsable by date and by lesson, with full
// revision chains visible (the sequence is where the learning shows).
// Scrolling is allowed here.

import { db, STORES } from '../db.js';
import { getActivePlan, markRevision } from '../session.js';
import { flattenLessons } from '../schema.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let groupBy = 'date';

export async function renderPortfolio(root) {
  root.innerHTML = '';
  const plan = await getActivePlan();
  if (!plan) {
    root.append(el('div', 'empty', 'No plan loaded.'));
    return;
  }
  const artifacts = await db.getAllByIndex(STORES.artifacts, 'planId', plan.id);
  const lessons = flattenLessons(plan);
  const lessonTitle = (id) => {
    const l = lessons.find((x) => x.id === id);
    return l ? `Unit ${l.unitNumber} — ${l.title}` : id;
  };

  const head = el('div', 'view-head');
  head.append(el('h2', null, 'Portfolio'));
  const toggle = el('div', 'btn-row');
  const byDate = el('button', groupBy === 'date' ? 'primary' : '', 'By date');
  const byLesson = el('button', groupBy === 'lesson' ? 'primary' : '', 'By lesson');
  byDate.onclick = () => { groupBy = 'date'; renderPortfolio(root); };
  byLesson.onclick = () => { groupBy = 'lesson'; renderPortfolio(root); };
  toggle.append(byDate, byLesson);
  head.append(toggle);
  root.append(head);

  if (artifacts.length === 0) {
    root.append(el('div', 'empty', 'No artifacts yet. Production drills create them.'));
    return;
  }

  const groups = new Map();
  for (const a of artifacts) {
    const key = groupBy === 'date' ? a.date : a.lessonId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const keys = [...groups.keys()].sort().reverse();

  for (const key of keys) {
    const section = el('section', 'card');
    section.append(el('h3', null, groupBy === 'date' ? key : lessonTitle(key)));
    for (const a of groups.get(key)) {
      section.append(renderArtifact(a, lessonTitle, root));
    }
    root.append(section);
  }
}

function renderArtifact(a, lessonTitle, root) {
  const wrap = el('div', 'artifact');
  wrap.append(el('p', 'muted small', `${a.date} · ${lessonTitle(a.lessonId)}`));
  wrap.append(el('p', 'prompt small serif', a.prompt));

  const chain = el('ol', 'revision-chain');
  (a.revisions || []).forEach((r, i) => {
    const li = el('li', r.accepted === false ? 'rejected' : r.accepted === true ? 'accepted' : '');
    li.append(el('span', 'rev-text serif', r.text));
    const meta = [];
    if (r.whatChanged) meta.push(`changed: ${r.whatChanged}`);
    if (r.why) meta.push(`why: ${r.why}`);
    if (r.accepted === false) meta.push(`rejected: ${r.rejectionReason || 'no reason'}`);
    if (r.accepted === true) meta.push('accepted');
    if (meta.length) li.append(el('div', 'muted small', meta.join(' · ')));

    if (r.accepted === null) {
      const row = el('div', 'btn-row tiny');
      const acc = el('button', 'tiny-btn', '✓ accept');
      const rej = el('button', 'tiny-btn', '✗ reject');
      acc.onclick = async () => { await markRevision(a.id, i, true); renderPortfolio(root); };
      rej.onclick = async () => {
        const reason = prompt('Why rejected?') || '';
        await markRevision(a.id, i, false, reason);
        renderPortfolio(root);
      };
      row.append(acc, rej);
      li.append(row);
    }
    chain.append(li);
  });
  wrap.append(chain);

  if (a.finalEvaluation) wrap.append(el('p', 'small', `Final: ${a.finalEvaluation}`));
  return wrap;
}
