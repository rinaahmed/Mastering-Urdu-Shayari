// Lessons view — the primary navigation surface. Every lesson in the active
// plan, flattened into one scrollable list in plan order (no grouping by
// week; the app's own UI calls that grouping level a "unit" and shows it as
// per-row context, e.g. "Unit 3"). Status is visible at a glance — done,
// current, blocked, or not yet started — via shape/border/weight, no tap
// required and never colour alone.

import { getActivePlan, getCompletedLessonIds, getResolvedMissingIds,
  getCurrentLessonId, getPendingOpenLessonId, startNextLesson, jumpToLesson } from '../session.js';
import { flattenLessons } from '../schema.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function lessonMarker({ isDone, isCurrent, isBlocked }) {
  if (isCurrent && isBlocked) return '▸ 🔒';
  if (isCurrent) return '▸';
  if (isDone) return '●';
  if (isBlocked) return '🔒';
  return '○';
}

function statusLabel({ isDone, isCurrent, isBlocked }) {
  if (isCurrent && isBlocked) return 'current · blocked';
  if (isCurrent) return 'current';
  if (isDone) return 'done';
  if (isBlocked) return 'blocked';
  return 'not started';
}

function renderBanner(banner) {
  if (banner.type === 'blocked') {
    const box = el('div', 'lesson-action-note blocked');
    box.append(el('p', null,
      `"${banner.lesson.title}" is next, but it's blocked: it depends on "${banner.missingData ? banner.missingData.title : banner.lesson.blockedOn}".`));
    if (banner.missingData && banner.missingData.description) {
      box.append(el('p', 'muted small', banner.missingData.description));
    }
    if (banner.missingData && banner.missingData.howToResolve) {
      box.append(el('p', 'muted small', `To resolve: ${banner.missingData.howToResolve}`));
    }
    const link = el('button', null, 'Go to Settings →');
    link.onclick = () => { location.hash = '#settings'; };
    box.append(link);
    return box;
  }
  if (banner.type === 'plan-complete') {
    const box = el('div', 'lesson-action-note done');
    box.append(el('p', null, "No more lessons — you've reached the end of the plan."));
    return box;
  }
  const box = el('div', 'lesson-action-note blocked');
  box.append(el('p', null, `Could not advance: ${banner.message}`));
  return box;
}

export async function renderLessons(root, banner = null) {
  root.innerHTML = '';
  const plan = await getActivePlan();
  if (!plan) {
    root.append(el('div', 'empty', 'No plan loaded. Go to Settings to import one.'));
    return;
  }

  const [lessons, doneIds, resolvedMissing, currentId, pendingOpenId] = await Promise.all([
    Promise.resolve(flattenLessons(plan)),
    getCompletedLessonIds(plan.id),
    getResolvedMissingIds(plan.id),
    getCurrentLessonId(),
    getPendingOpenLessonId()
  ]);

  const head = el('div', 'view-head');
  head.append(el('h2', null, 'Lessons'));
  root.append(head);

  const currentLesson = lessons.find((l) => l.id === currentId) || null;
  const isRetryOpen = !!currentLesson && pendingOpenId === currentLesson.id;

  // ---- prominent action: Start next lesson ----
  const actionCard = el('section', 'card lesson-action-card');
  actionCard.append(el('h3', null, 'Start next lesson'));
  actionCard.append(el('p', 'muted small', !currentLesson
    ? 'No current lesson.'
    : isRetryOpen
      ? `Opens "${currentLesson.title}" — it stopped here blocked and was never opened.`
      : `Marks "${currentLesson.title}" done and moves to the next lesson in the plan.`));
  const actionBtn = el('button', 'primary big', 'Start next lesson');
  actionBtn.disabled = !currentLesson;
  actionBtn.onclick = async () => {
    actionBtn.disabled = true;
    try {
      const result = await startNextLesson();
      if (result.type === 'started') {
        location.hash = '#today';
      } else {
        await renderLessons(root, result);
      }
    } catch (e) {
      await renderLessons(root, { type: 'error', message: e.message });
    }
  };
  actionCard.append(actionBtn);
  if (banner) actionCard.append(renderBanner(banner));
  root.append(actionCard);

  // ---- full flat list, in plan order, not grouped by unit ----
  const list = el('div', 'lesson-list');
  for (const lesson of lessons) {
    const isDone = doneIds.has(lesson.id);
    const isCurrent = lesson.id === currentId;
    const isBlocked = !!lesson.blockedOn && !resolvedMissing.has(lesson.blockedOn) && !isDone;
    const state = { isDone, isCurrent, isBlocked };

    const classes = ['lesson-row'];
    if (isDone) classes.push('done');
    if (isCurrent) classes.push('current');
    if (isBlocked) classes.push('blocked');
    if (!isDone && !isCurrent && !isBlocked) classes.push('not-started');

    const row = el('button', classes.join(' '));
    row.append(el('span', 'lesson-marker', lessonMarker(state)));
    const info = el('span', 'lesson-info');
    info.append(el('span', 'lesson-title', lesson.title));
    info.append(el('span', 'lesson-meta', `${lesson.phaseTitle} · Unit ${lesson.unitNumber} · ${statusLabel(state)}`));
    row.append(info);
    row.onclick = async () => {
      await jumpToLesson(lesson.id);
      location.hash = '#today';
    };
    list.append(row);
  }
  root.append(list);
}
