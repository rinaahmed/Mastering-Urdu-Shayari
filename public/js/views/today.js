// Today view — the default and only session surface. Shows today's session
// only: not the week, not the phase, and never a "sessions completed" count.

import { db, STORES } from '../db.js';
import {
  getActivePlan, getNodeStates, getErrorCategories, getActiveSession,
  startSession, submitResponse, resolveFlag, endSession, addRevision, markRevision
} from '../session.js';
import { buildContextPayload } from '../context.js';
import { generate, OfflineError } from '../api.js';
import { flattenLessons } from '../schema.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export async function renderToday(root) {
  root.innerHTML = '';
  const plan = await getActivePlan();
  if (!plan) {
    root.append(el('div', 'empty', 'No plan loaded. Go to Settings to import one.'));
    return;
  }

  let session = await getActiveSession();
  if (!session) {
    const lessons = flattenLessons(plan);
    const currentLessonId = await db.getMeta('currentLessonId');
    const lesson = lessons.find(l => l.id === currentLessonId) || lessons[0];

    const card = el('section', 'card start-card');
    card.append(el('h2', null, 'Today'));
    card.append(el('p', 'muted', `${lesson.weekTitle} · ${lesson.title}`));
    card.append(el('p', null, lesson.objective));

    const lessonSel = el('select');
    lessons.forEach(l => {
      const o = el('option', null, `${l.weekTitle} — ${l.title}`);
      o.value = l.id;
      if (l.id === lesson.id) o.selected = true;
      lessonSel.append(o);
    });
    lessonSel.onchange = () => db.setMeta('currentLessonId', lessonSel.value);
    const selWrap = el('label', 'lesson-select');
    selWrap.append(el('span', 'muted', 'Lesson: '), lessonSel);
    card.append(selWrap);

    const btn = el('button', 'primary big', "Start today's session");
    btn.onclick = async () => {
      btn.disabled = true;
      await startSession();
      renderToday(root);
    };
    card.append(btn);
    root.append(card);
    return;
  }

  await renderSession(root, plan, session);
}

async function renderSession(root, plan, session) {
  const header = el('div', 'session-header');
  const done = session.blocks.filter(b => b.attempted).length;
  header.append(el('h2', null, "Today's session"));
  header.append(el('span', 'muted', `${done}/${session.blocks.length} blocks`));
  root.append(header);

  const currentIndex = session.blocks.findIndex(b => !b.attempted);

  session.blocks.forEach((block, i) => {
    const isCurrent = i === currentIndex;
    const card = el('section', `card block ${block.kind}${isCurrent ? ' current' : ''}${block.attempted ? ' done' : ''}`);
    const kindLabel = { standing: 'Standing', lesson: 'Lesson', review: 'Review', flag: '⚑ Flag' }[block.kind] || block.kind;
    const head = el('div', 'block-head');
    head.append(el('span', `chip chip-${block.kind}`, kindLabel));
    head.append(el('strong', null, block.title));
    if (block.minutes) head.append(el('span', 'muted', ` ${block.minutes} min`));
    card.append(head);

    if (block.kind === 'flag') {
      renderFlagBlock(card, session, i, block, root);
    } else if (block.attempted) {
      renderCompletedBlock(card, plan, block);
    } else if (isCurrent) {
      renderActiveBlock(card, plan, session, i, block, root);
    } else {
      card.append(el('p', 'muted', 'Coming up…'));
    }
    root.append(card);
  });

  if (currentIndex === -1) {
    const endCard = el('section', 'card');
    endCard.append(el('p', null, 'All blocks done.'));
    const btn = el('button', 'primary', 'Finish session');
    btn.onclick = async () => {
      await endSession(session);
      renderToday(root);
    };
    endCard.append(btn);
    root.append(endCard);
  }
}

function renderCompletedBlock(card, plan, block) {
  const item = (plan.itemBank || []).find(it => it.id === block.itemId);
  if (item) card.append(el('p', 'prompt', item.prompt));
  if (block.userResponse) card.append(el('p', 'response', `You: ${block.userResponse}`));
  const r = block.result;
  if (!r) return;
  if (r.correct === true) card.append(el('p', 'verdict ok', `✓ ${r.detail || 'Correct'}`));
  else if (r.correct === false) card.append(el('p', 'verdict bad', `✗ ${r.detail || 'Incorrect'}`));
  else card.append(el('p', 'verdict pending', r.detail || 'Pending'));
  if (r.judgment) card.append(el('p', 'muted', `Judgment: ${r.judgment}${r.judgmentNote ? ` — ${r.judgmentNote}` : ''}`));
}

function renderActiveBlock(card, plan, session, index, block, root) {
  const drillType = (plan.drillTypes || []).find(d => d.id === block.drillTypeId);
  const item = (plan.itemBank || []).find(it => it.id === block.itemId);

  if (!drillType || !item) {
    card.append(el('p', 'muted', 'No drill item available for this block.'));
    const skip = el('button', null, 'Skip');
    skip.onclick = async () => {
      block.attempted = true;
      block.result = { correct: null, detail: 'Skipped (no item).', source: 'skip' };
      await db.put(STORES.sessions, session);
      rerender(root);
    };
    card.append(skip);
    return;
  }

  card.append(el('p', 'muted small', drillType.format));
  card.append(el('p', 'prompt', item.prompt));

  const input = drillType.inputShape === 'text' ? el('textarea') : el('input');
  input.className = 'answer';
  input.placeholder = { pattern: 'e.g. 122 122 122 122', number: 'e.g. 5', word: 'one word', text: 'your line…' }[drillType.inputShape] || '';
  card.append(input);

  const row = el('div', 'btn-row');
  const submit = el('button', 'primary', 'Submit');
  const hint = el('button', null, 'Hint');
  row.append(submit, hint);
  card.append(row);

  const out = el('div', 'tutor-out');
  card.append(out);

  submit.onclick = async () => {
    const value = input.value.trim();
    if (!value) return;
    submit.disabled = true;
    await submitResponse(session, index, value);
    const updated = session.blocks[index];

    // Compose drills: offer revision loop before moving on.
    if (drillType.producesArtifact && updated.artifactId) {
      renderRevisionLoop(card, session, index, updated, root);
    } else {
      rerender(root);
    }
  };

  hint.onclick = () => callTutor(out, plan, session, block, item, drillType,
    'Give me a hint for this drill. Do not give the answer.');

  // Explain after a wrong deterministic answer is handled on the completed
  // card via the session re-render; offer explain here for convenience too.
  const explain = el('button', null, 'Explain');
  explain.onclick = () => callTutor(out, plan, session, block, item, drillType,
    `I answered: "${input.value.trim() || '(no answer yet)'}". Explain why the correct answer is what it is, briefly.`);
  row.append(explain);
}

async function callTutor(out, plan, session, block, item, drillType, request) {
  out.textContent = 'Asking the ustaad…';
  try {
    const [nodeStates, errorCategories, artifacts] = await Promise.all([
      getNodeStates(plan.id),
      getErrorCategories(plan.id),
      db.getAllByIndex(STORES.artifacts, 'planId', plan.id)
    ]);
    const lessons = flattenLessons(plan);
    const lesson = lessons.find(l => l.id === session.lessonId) || lessons[0];
    const context = buildContextPayload({ plan, lesson, nodeStates, errorCategories, artifacts, block, item, drillType });
    const text = await generate(context, request);
    out.textContent = text;
  } catch (e) {
    out.textContent = e instanceof OfflineError
      ? 'Offline — hints and explanations need a connection. Deterministic grading still works.'
      : `Tutor error: ${e.message}`;
  }
}

function renderRevisionLoop(card, session, index, block, root) {
  const wrap = el('div', 'revision-loop');
  wrap.append(el('h3', null, 'Revise?'));
  wrap.append(el('p', 'muted small', 'The learning is in the revision chain. Record what you changed and why, or finish the block.'));
  const text = el('textarea', 'answer');
  text.placeholder = 'revised line…';
  const what = el('input', 'answer');
  what.placeholder = 'what changed';
  const why = el('input', 'answer');
  why.placeholder = 'why';
  const row = el('div', 'btn-row');
  const save = el('button', 'primary', 'Add revision');
  const finish = el('button', null, 'Done with this block');
  row.append(save, finish);
  wrap.append(text, what, why, row);
  card.append(wrap);

  save.onclick = async () => {
    if (!text.value.trim()) return;
    await addRevision(block.artifactId, { text: text.value.trim(), whatChanged: what.value.trim(), why: why.value.trim() });
    block.userResponse = text.value.trim();
    await db.put(STORES.sessions, session);
    text.value = ''; what.value = ''; why.value = '';
  };
  finish.onclick = () => rerender(root);
}

function renderFlagBlock(card, session, index, block, root) {
  card.append(el('p', null, block.note || 'This node is not moving.'));
  if (block.attempted) {
    card.append(el('p', 'muted', block.result ? block.result.detail : ''));
    return;
  }
  const noteInput = el('input', 'answer');
  noteInput.placeholder = 'note on the new approach (optional)';
  const row = el('div', 'btn-row');
  const change = el('button', 'primary', 'Change approach');
  const keep = el('button', null, 'Keep drilling');
  row.append(change, keep);
  card.append(noteInput, row);
  change.onclick = async () => {
    await resolveFlag(session, index, true, noteInput.value.trim());
    rerender(root);
  };
  keep.onclick = async () => {
    await resolveFlag(session, index, false);
    rerender(root);
  };
}

function rerender(root) {
  renderToday(root);
}
