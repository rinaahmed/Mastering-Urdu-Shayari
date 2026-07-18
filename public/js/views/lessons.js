// Lessons view — the primary navigation surface. Every lesson in the active
// plan, grouped by phase (collapsible) and unit (the app's own UI name for
// the plan's "week" level) for display only — the underlying plan order
// (phases -> weeks -> lessons) is untouched and is what numbering and the
// starting-position bulk action both follow. Status is visible at a glance —
// done, current, blocked, or not yet started — via shape/border/weight, no
// tap required and never colour alone.

import { getActivePlan, getCompletedLessonIds, getResolvedMissingIds,
  getCurrentLessonId, getPendingOpenLessonId, startNextLesson, jumpToLesson } from '../session.js';
import { flattenLessons } from '../schema.js';
import { renderGroupedLessons } from './lessonGroups.js';

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

  // ---- grouped by phase (collapsible) and unit, in plan order ----
  const rowState = (lesson) => ({
    isDone: doneIds.has(lesson.id),
    isCurrent: lesson.id === currentId,
    isBlocked: !!lesson.blockedOn && !resolvedMissing.has(lesson.blockedOn) && !doneIds.has(lesson.id)
  });

  root.append(renderGroupedLessons({
    lessons,
    rowState,
    rowMarker: lessonMarker,
    rowStatusLabel: statusLabel,
    onRowClick: async (lesson) => {
      await jumpToLesson(lesson.id);
      location.hash = '#today';
    }
  }));
}
