// Today view — the default surface. One screen per content block or drill,
// explicit Back/Next, no scroll in the session flow (E Ink). Shows today's
// session only; never a completed-sessions count.

import { db, STORES } from '../db.js';
import {
  getActivePlan, getNodeStates, getErrorCategories, getActiveSession,
  startSession, submitResponse, resolveFlag,
  endSession, addRevision, saveReflection, goTo, markScreenDone,
  findDrillType, findItem, saveSession
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

// Minimal markdown: paragraphs, **bold**, *italic*, - lists. No HTML injection.
function md(text) {
  const container = el('div', 'md');
  const paras = (text || '').split(/\n\n+/);
  for (const p of paras) {
    const lines = p.split('\n');
    if (lines.every((l) => l.trim().startsWith('- ') || l.trim() === '')) {
      const ul = el('ul');
      lines.filter((l) => l.trim()).forEach((l) => ul.append(inline(l.trim().slice(2), 'li')));
      container.append(ul);
    } else {
      container.append(inline(p, 'p'));
    }
  }
  return container;
}
function inline(text, tag) {
  const node = el(tag);
  //

  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  for (const part of parts) {
    if (/^\*\*[^*]+\*\*$/.test(part)) node.append(el('strong', null, part.slice(2, -2)));
    else if (/^\*[^*]+\*$/.test(part)) node.append(el('em', null, part.slice(1, -1)));
    else node.append(document.createTextNode(part));
  }
  return node;
}

function applyDirection(node, blockOrItem) {
  if (blockOrItem && blockOrItem.direction) {
    node.setAttribute('dir', blockOrItem.direction);
    if (blockOrItem.direction === 'rtl') node.classList.add('rtl');
  }
  if (blockOrItem && blockOrItem.lang) node.setAttribute('lang', blockOrItem.lang);
  return node;
}

export async function renderToday(root) {
  root.innerHTML = '';
  const plan = await getActivePlan();
  if (!plan) {
    root.append(el('div', 'empty', 'No plan loaded. Go to Settings to import one.'));
    return;
  }

  const session = await getActiveSession();
  if (!session) {
    await renderStart(root, plan);
    return;
  }
  renderScreen(root, plan, session);
}

async function renderStart(root, plan) {
  const lessons = flattenLessons(plan);
  const currentLessonId = await db.getMeta('currentLessonId');
  const lesson = lessons.find((l) => l.id === currentLessonId) || lessons[0];

  const card = el('section', 'card start-card');
  card.append(el('h2', 'serif', 'Today'));
  card.append(el('p', 'muted', `Unit ${lesson.unitNumber} · ${lesson.title}`));
  card.append(el('p', 'serif', lesson.objective));
  if (lesson.estimatedMinutes) card.append(el('p', 'muted small', `~${lesson.estimatedMinutes} min`));

  const btn = el('button', 'primary big', 'Begin session');
  btn.onclick = async () => {
    btn.disabled = true;
    await startSession();
    renderToday(root);
  };
  card.append(btn);

  const allLink = el('button', null, 'All lessons ›');
  allLink.onclick = () => { location.hash = '#lessons'; };
  card.append(allLink);

  root.append(card);
}

function renderScreen(root, plan, session) {
  const screen = session.screens[session.index];
  const total = session.screens.length;

  const wrap = el('div', 'session');
  const card = el('section', `card screen kind-${screen.kind}`);

  // Header: kind chip + title
  const head = el('div', 'screen-head');
  const kindLabel = {
    drill: { standing: 'Standing', lesson: 'Drill', review: 'Review' }[screen.origin] || 'Drill',
    generate: screen.origin === 'standing' ? 'Standing' : 'Tutor',
    prose: 'Study', example: 'Example', reflect: 'Reflect',
    flag: 'Flag', blocked: 'Blocked', summary: 'Done'
  }[screen.kind] || screen.kind;
  head.append(el('span', 'chip', kindLabel));
  head.append(el('strong', 'screen-title', screen.title || ''));
  card.append(head);

  const body = el('div', 'screen-body');
  card.append(body);

  const renderers = {
    prose: renderProse, example: renderExample, generate: renderGenerate,
    reflect: renderReflect, drill: renderDrill, flag: renderFlag,
    blocked: renderBlocked, summary: renderSummary
  };
  (renderers[screen.kind] || renderProse)(body, root, plan, session, screen);

  wrap.append(card);
  wrap.append(renderPager(root, plan, session, screen));
  root.append(wrap);
}

function renderPager(root, plan, session, screen) {
  const pager = el('div', 'pager');
  const back = el('button', 'pager-btn', '‹ Back');
  back.disabled = session.index === 0;
  back.onclick = async () => { await goTo(session, session.index - 1); renderToday(root); };

  const pos = el('span', 'pager-pos', `${session.index + 1} / ${session.screens.length}`);

  const next = el('button', 'pager-btn primary', 'Next ›');
  next.disabled = session.index >= session.screens.length - 1;
  const expectsResponse = screen.kind === 'generate' && screen.block && screen.block.expectsResponse;
  // A generate block that hasn't successfully produced text yet — still
  // loading, or the call failed — must not be skippable. Without this, Next
  // stays clickable through a tutor error and silently marks the screen
  // done, which for a lesson whose only content is that one block means it
  // "completes" without the person ever having seen real material.
  const generateNotReady = screen.kind === 'generate' && !screen.generatedText;
  const needsAction = ((screen.kind === 'drill' || screen.kind === 'flag') || expectsResponse || generateNotReady) && !screen.done;
  if (needsAction) next.disabled = true;
  next.onclick = async () => {
    const autoCompletable = ['prose', 'example', 'blocked'].includes(screen.kind) ||
      (screen.kind === 'generate' && !expectsResponse && !generateNotReady);
    if (autoCompletable && !screen.done) {
      await markScreenDone(session, session.index);
    }
    if (screen.kind === 'reflect' && !screen.done) {
      screen.done = true; // skipping a reflection is allowed
      await saveSession(session);
    }
    await goTo(session, session.index + 1);
    renderToday(root);
  };

  pager.append(back, pos, next);
  return pager;
}

// ---- screen renderers ----

function renderProse(body, root, plan, session, screen) {
  body.append(applyDirection(md(screen.block.body), screen.block));
}

function renderExample(body, root, plan, session, screen) {
  const ex = el('div', 'example-box');
  ex.append(applyDirection(el('p', 'serif example-text', screen.block.body), screen.block));
  body.append(ex);
  if (screen.block.commentary) body.append(el('p', 'commentary', screen.block.commentary));
}

async function renderGenerate(body, root, plan, session, screen) {
  if (!screen.generatedText) {
    const out = el('div', 'tutor-out', 'Preparing…');
    body.append(out);
    try {
      const context = await buildContext(plan, session, screen, null, null);
      const text = await generate(context, screen.block.body);
      screen.generatedText = text;
      if (screen.block.expectsResponse) screen.conversation = [{ role: 'tutor', text }];
      await saveSession(session);
      // The pager's Next state was fixed at render time, before this async
      // call resolved — re-render so it picks up the now-successful result.
      renderToday(root);
      return;
    } catch (e) {
      out.innerHTML = '';
      out.append(el('p', null, e instanceof OfflineError
        ? 'Offline — this block needs a connection to expand.'
        : `Tutor error: ${e.message}`));
      const retry = el('button', null, 'Retry');
      retry.onclick = () => renderToday(root);
      out.append(retry);
      return; // nothing generated — Next stays disabled, no fallback content
    }
  }

  if (!screen.block.expectsResponse) {
    body.append(md(screen.generatedText));
    return;
  }

  // Open-ended exchange, not a single reply-then-done: every turn so far,
  // then — unless the learner has already chosen to stop — both a reply box
  // and a "Done" button. Continuing or wrapping up is the learner's call
  // each time, not something the screen decides for them.
  const conversation = screen.conversation || [{ role: 'tutor', text: screen.generatedText }];
  conversation.forEach((turn) => {
    if (turn.role === 'user') body.append(el('p', 'response', `You: ${turn.text}`));
    else body.append(md(turn.text));
  });

  if (screen.done) return;

  body.append(el('p', 'muted small', 'Reply to keep going, or tap Done when you\'re ready to move on.'));
  const input = el('textarea', 'answer');
  input.placeholder = 'your reply…';
  body.append(input);

  const row = el('div', 'btn-row');
  const send = el('button', 'primary', 'Send');
  const doneBtn = el('button', null, 'Done — move on');
  const out = el('div', 'tutor-out');

  send.onclick = async () => {
    const value = input.value.trim();
    if (!value) return;
    send.disabled = true;
    doneBtn.disabled = true;
    out.textContent = 'Asking the tutor…';
    try {
      const context = await buildContext(plan, session, screen, null, null);
      const transcript = conversation.map((t) => `${t.role === 'tutor' ? 'Tutor' : 'Learner'}: ${t.text}`).join('\n\n');
      const reply = await generate(context,
        `This is a continuing conversation about the exercise above.\n\n${transcript}\n\nLearner: ${value}\n\nContinue the conversation naturally, per your standing instructions — do not restart or summarize what's already been said.`);
      conversation.push({ role: 'user', text: value });
      conversation.push({ role: 'tutor', text: reply });
      screen.conversation = conversation;
      await saveSession(session);
      renderToday(root);
    } catch (e) {
      send.disabled = false;
      doneBtn.disabled = false;
      out.textContent = e instanceof OfflineError
        ? 'Offline — replying needs a connection. Try again once online; nothing is lost.'
        : `Tutor error: ${e.message}`;
    }
  };

  doneBtn.onclick = async () => {
    screen.done = true;
    await saveSession(session);
    renderToday(root);
  };

  row.append(send, doneBtn);
  body.append(input, row, out);
}

function renderReflect(body, root, plan, session, screen) {
  body.append(applyDirection(md(screen.block.body), screen.block));
  const input = el('textarea', 'answer');
  input.value = screen.note || '';
  input.placeholder = 'your note…';
  body.append(input);
  const save = el('button', 'primary', screen.done ? 'Saved' : 'Save note');
  save.onclick = async () => {
    await saveReflection(session, session.index, input.value.trim());
    save.textContent = 'Saved';
  };
  body.append(save);
}

function renderDrill(body, root, plan, session, screen) {
  const drillType = findDrillType(plan, screen.drillTypeId);
  const item = findItem(plan, screen.itemId);
  if (!drillType || !item) {
    body.append(el('p', 'muted', 'No drill item available.'));
    screen.done = true;
    return;
  }

  if (screen.intro) body.append(md(screen.intro));
  body.append(el('p', 'muted small', drillType.format));
  body.append(applyDirection(el('p', 'prompt serif', item.prompt), item));

  if (screen.done) {
    renderResult(body, screen);
    if (screen.artifactId) renderRevisionLoop(body, root, session, screen);
    renderTutorButtons(body, plan, session, screen, item, drillType, true);
    return;
  }

  const input = drillType.inputShape === 'text' ? el('textarea', 'answer') : el('input', 'answer');
  input.placeholder = { pattern: 'e.g. 122 122 122 122', number: 'a number', word: 'one word', text: 'your line…' }[drillType.inputShape] || '';
  body.append(input);

  const row = el('div', 'btn-row');
  const submit = el('button', 'primary', 'Submit');
  submit.onclick = async () => {
    const value = input.value.trim();
    if (!value) return;
    submit.disabled = true;
    await submitResponse(session, session.index, value);
    renderToday(root);
  };
  row.append(submit);
  body.append(row);
  renderTutorButtons(row, plan, session, screen, item, drillType, false, input);
  const out = el('div', 'tutor-out');
  body.append(out);
  row._tutorOut = out;
}

function renderResult(body, screen) {
  const r = screen.result;
  if (!r) return;
  if (screen.response) body.append(el('p', 'response', `You: ${screen.response}`));
  let box;
  if (r.correct === true) box = el('div', 'verdict ok');
  else if (r.correct === false) box = el('div', 'verdict bad');
  else box = el('div', 'verdict pending');
  const mark = r.correct === true ? '✓ Correct' : r.correct === false ? '✗ Incorrect' : '… Pending';
  box.append(el('strong', null, mark + (r.provisional ? ' (provisional)' : '')));
  if (r.detail) box.append(el('p', null, r.detail));
  if (r.judgment) box.append(el('p', 'muted small', `${r.judgment}${r.judgmentNote ? ` — ${r.judgmentNote}` : ''}`));
  body.append(box);
}

function renderTutorButtons(container, plan, session, screen, item, drillType, done, input) {
  const hint = el('button', null, done ? 'Explain' : 'Hint');
  hint.onclick = async () => {
    const out = container._tutorOut || container.parentElement.querySelector('.tutor-out') || (() => {
      const o = el('div', 'tutor-out');
      container.parentElement.append(o);
      return o;
    })();
    out.textContent = 'Asking the tutor…';
    try {
      const context = await buildContext(plan, session, screen, item, drillType);
      const request = done
        ? `My answer was: "${screen.response}". The verdict was: ${screen.result && screen.result.correct === false ? 'incorrect' : screen.result && screen.result.correct === true ? 'correct' : 'pending'} (${screen.result ? screen.result.detail : ''}). Explain briefly.`
        : `Give me a hint for this drill. Do not give the answer.${input && input.value.trim() ? ` My draft so far: "${input.value.trim()}"` : ''}`;
      const text = await generate(context, request);
      out.textContent = '';
      out.append(md(text));
    } catch (e) {
      out.textContent = e instanceof OfflineError
        ? 'Offline — hints and explanations need a connection. Local grading still works.'
        : `Tutor error: ${e.message}`;
    }
  };
  container.append(hint);
}

async function buildContext(plan, session, screen, item, drillType) {
  const [nodeStates, errorCategories, artifacts] = await Promise.all([
    getNodeStates(plan.id),
    getErrorCategories(plan.id),
    db.getAllByIndex(STORES.artifacts, 'planId', plan.id)
  ]);
  const lessons = flattenLessons(plan);
  const lesson = lessons.find((l) => l.id === session.lessonId) || lessons[0];
  return buildContextPayload({ plan, lesson, nodeStates, errorCategories, artifacts, screen, item, drillType });
}

function renderRevisionLoop(body, root, session, screen) {
  const wrap = el('div', 'revision-loop');
  wrap.append(el('h3', null, 'Revise?'));
  wrap.append(el('p', 'muted small', 'The learning is in the revision chain. Record what changed and why.'));
  const text = el('textarea', 'answer');
  text.placeholder = 'revised version…';
  const what = el('input', 'answer');
  what.placeholder = 'what changed';
  const why = el('input', 'answer');
  why.placeholder = 'why';
  const save = el('button', null, 'Add revision');
  save.onclick = async () => {
    if (!text.value.trim()) return;
    await addRevision(screen.artifactId, { text: text.value.trim(), whatChanged: what.value.trim(), why: why.value.trim() });
    screen.response = text.value.trim();
    await saveSession(session);
    text.value = ''; what.value = ''; why.value = '';
    save.textContent = 'Added ✓';
  };
  wrap.append(text, what, why, save);
  body.append(wrap);
}

function renderFlag(body, root, plan, session, screen) {
  body.append(el('p', 'serif', screen.note || 'This is not moving.'));
  if (screen.done) {
    body.append(el('p', 'muted', screen.result ? screen.result.detail : ''));
    return;
  }
  const noteInput = el('input', 'answer');
  noteInput.placeholder = 'note on the new approach (optional)';
  const row = el('div', 'btn-row');
  const change = el('button', 'primary', 'Change approach');
  const keep = el('button', null, 'Keep drilling');
  change.onclick = async () => { await resolveFlag(session, session.index, true, noteInput.value.trim()); renderToday(root); };
  keep.onclick = async () => { await resolveFlag(session, session.index, false); renderToday(root); };
  row.append(change, keep);
  body.append(noteInput, row);
}

function renderBlocked(body, root, plan, session, screen) {
  body.append(el('p', 'serif', `This lesson cannot start yet: it depends on "${screen.missingTitle}".`));
  if (screen.missingDescription) body.append(el('p', null, screen.missingDescription));
  if (screen.howToResolve) body.append(el('p', 'muted', `To resolve: ${screen.howToResolve}`));
  body.append(el('p', 'muted small', 'Resolve it in Settings → Plan dependencies, then start a new session.'));
}

function renderSummary(body, root, plan, session, screen) {
  const drills = session.screens.filter((s) => s.kind === 'drill' && s.done);
  const correct = drills.filter((s) => s.result && s.result.correct === true).length;
  const pending = drills.filter((s) => s.result && s.result.correct === null).length;
  body.append(el('p', 'serif', `Drills: ${correct} of ${drills.length} correct${pending ? `, ${pending} pending judgment` : ''}.`));
  const lessonScreens = session.screens.filter((s) => s.lessonId === session.lessonId && s.kind !== 'blocked');
  const lessonDone = lessonScreens.length > 0 && lessonScreens.every((s) => s.done);
  if (lessonScreens.length) {
    body.append(el('p', null, lessonDone
      ? 'Lesson complete — its skills are now open for review scheduling.'
      : 'Lesson not finished — revisit the remaining screens before ending, or it stays incomplete.'));
  }
  const btn = el('button', 'primary big', 'End session');
  btn.onclick = async () => {
    await endSession(session);
    renderToday(root);
  };
  body.append(btn);
}
