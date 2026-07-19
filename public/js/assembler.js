// Session assembler. A session is a paginated list of screens, built entirely
// by local code before any API call:
//   1. standing elements (skipped while their nodes are still untaught)
//   2. the current lesson, content block by content block — or a blocked
//      screen explaining the unresolved missingData dependency
//   3. interleaved review of due nodes, weighted toward low confidence,
//      capped per settings.reviewNodeCap
//   4. eligibility filter: no node whose taughtIn lesson is incomplete
//   5. flat-progress flags instead of more reps

import { dueNodes, reviewWeight, isPlateaued, isEligible } from './ledger.js';
import { flattenLessons } from './schema.js';

function pickItems(plan, drillTypeId, nodeFilter, usedItemIds, count) {
  const pool = (plan.itemBank || []).filter((it) =>
    it.drillTypeId === drillTypeId &&
    !usedItemIds.has(it.id) &&
    (nodeFilter === null || (it.skillNodeIds || []).some((id) => nodeFilter(id)))
  );
  const out = [];
  while (out.length < count && pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    const item = pool.splice(idx, 1)[0];
    usedItemIds.add(item.id);
    out.push(item);
  }
  return out;
}

// assembleSession(plan, nodeStates, currentLessonId, completedLessonIds,
//                 resolvedMissingIds) -> { lesson, screens, flags, reviewDebt }
export function assembleSession(plan, nodeStates, currentLessonId, completedLessonIds, resolvedMissingIds, now = Date.now()) {
  const settings = plan.settings || {};
  const blockTarget = settings.sessionBlockTarget || 8;
  const nodeCap = settings.reviewNodeCap || 0.4;
  const maxPerNode = Math.max(1, Math.round(blockTarget * nodeCap));
  const usedItemIds = new Set();
  const screens = [];
  const nodeById = new Map(nodeStates.map((n) => [n.id, n]));

  const drillNodeCount = new Map();
  const countNodes = (ids) => (ids || []).forEach((id) =>
    drillNodeCount.set(id, (drillNodeCount.get(id) || 0) + 1));
  const underCap = (ids) => (ids || []).length === 0 ||
    (ids || []).some((id) => (drillNodeCount.get(id) || 0) < maxPerNode);

  const lessons = flattenLessons(plan);
  const lesson = lessons.find((l) => l.id === currentLessonId) || lessons[0];

  const eligibleStrict = (nodeId) => {
    const n = nodeById.get(nodeId);
    return n ? isEligible(n, completedLessonIds) : false;
  };
  const eligibleInLesson = (nodeId) => {
    const n = nodeById.get(nodeId);
    return n ? isEligible(n, completedLessonIds, lesson.id) : false;
  };

  // ---- 1. standing elements ----
  for (const se of plan.standingElements || []) {
    const nodeIds = se.skillNodeIds || [];
    // Hard gate: skip the element entirely while none of its nodes are taught.
    const eligibleIds = nodeIds.filter(eligibleStrict);
    if (nodeIds.length > 0 && eligibleIds.length === 0) continue;

    if (se.generatePrompt) {
      // Tutor-generated standing element: the screen carries only the
      // instructions for the tutor (screen.block.body) — no item-bank pick,
      // no caching. renderGenerate calls the API fresh every session and
      // displays only its output, never these instructions themselves.
      screens.push({
        kind: 'generate',
        origin: 'standing',
        title: se.title,
        minutes: se.minutes,
        standingElementId: se.id,
        block: { type: 'generate', body: se.generatePrompt },
        skillNodeIds: eligibleIds
      });
      continue;
    }

    const [item] = pickItems(plan, se.drillTypeId,
      eligibleIds.length ? ((id) => eligibleIds.includes(id)) : null, usedItemIds, 1);
    if (!item) continue;
    screens.push({
      kind: 'drill',
      origin: 'standing',
      title: se.title,
      minutes: se.minutes,
      standingElementId: se.id,
      drillTypeId: se.drillTypeId,
      itemId: item.id,
      skillNodeIds: (item.skillNodeIds || []).length ? item.skillNodeIds : eligibleIds
    });
    countNodes(item.skillNodeIds || eligibleIds);
  }

  // ---- 2. the current lesson, content block by content block ----
  if (lesson.blockedOn && !resolvedMissingIds.has(lesson.blockedOn)) {
    const md = (plan.missingData || []).find((m) => m.id === lesson.blockedOn);
    screens.push({
      kind: 'blocked',
      title: lesson.title,
      lessonId: lesson.id,
      missingDataId: lesson.blockedOn,
      missingTitle: md ? md.title : lesson.blockedOn,
      missingDescription: md ? (md.description || '') : '',
      howToResolve: md ? (md.howToResolve || '') : ''
    });
  } else {
    (lesson.content || []).forEach((block, bi) => {
      if (block.type === 'drill') {
        const count = block.count || (block.itemIds ? block.itemIds.length : 1);
        let items;
        if (block.itemIds && block.itemIds.length) {
          items = block.itemIds
            .map((id) => (plan.itemBank || []).find((it) => it.id === id))
            .filter(Boolean);
          items.forEach((it) => usedItemIds.add(it.id));
        } else {
          const lessonNodes = lesson.skillNodeIds || [];
          const filter = lessonNodes.length
            ? ((id) => lessonNodes.includes(id) && eligibleInLesson(id))
            : eligibleInLesson;
          items = pickItems(plan, block.drillTypeId, filter, usedItemIds, count);
        }
        for (const item of items) {
          const nodeIds = item.skillNodeIds || lesson.skillNodeIds || [];
          // Within its own lesson a node may be drilled pre-completion, but
          // every node must at least be taught by now (audit guarantees this
          // for valid plans; guard anyway for hand-edited ones).
          if (!nodeIds.every(eligibleInLesson)) continue;
          if (!underCap(nodeIds)) continue;
          screens.push({
            kind: 'drill',
            origin: 'lesson',
            title: lesson.title,
            lessonId: lesson.id,
            contentIndex: bi,
            intro: block.body || null,
            drillTypeId: block.drillTypeId,
            itemId: item.id,
            skillNodeIds: nodeIds
          });
          countNodes(nodeIds);
        }
      } else {
        screens.push({
          kind: block.type, // prose | example | generate | reflect
          title: lesson.title,
          lessonId: lesson.id,
          contentIndex: bi,
          block
        });
      }
    });
  }

  // ---- 3. flat-progress flags — surface, don't hammer ----
  const flags = [];
  const flagOpts = {
    attemptThreshold: settings.flagAttemptThreshold || 8,
    window: settings.flagAccuracyWindow || 6
  };
  for (const n of nodeStates) {
    if (isPlateaued(n, flagOpts)) {
      flags.push(n.id);
      screens.push({
        kind: 'flag',
        title: n.name,
        skillNodeIds: [n.id],
        note: `"${n.name}" has ${n.attempts} attempts with flat accuracy (${Math.round(n.accuracy * 100)}%). This isn't moving — change approach rather than repeating the same drill.`
      });
    }
  }
  const flaggedSet = new Set(flags);

  // ---- 4. interleaved review: due + eligible (strict), low confidence first ----
  const due = dueNodes(nodeStates, now)
    .filter((n) => !flaggedSet.has(n.id) && isEligible(n, completedLessonIds))
    .sort((a, b) => reviewWeight(b, now) - reviewWeight(a, now));

  const drillScreens = screens.filter((s) => s.kind === 'drill').length;
  const reviewSlots = Math.max(0, blockTarget - drillScreens);
  const reviewScreens = [];
  for (const n of due) {
    if (reviewScreens.length >= reviewSlots) break;
    if ((drillNodeCount.get(n.id) || 0) >= maxPerNode) continue;
    const drillType = (plan.drillTypes || []).find((d) =>
      (plan.itemBank || []).some((it) => it.drillTypeId === d.id && (it.skillNodeIds || []).includes(n.id)));
    if (!drillType) continue;
    const [item] = pickItems(plan, drillType.id, (id) => id === n.id, usedItemIds, 1);
    if (!item) continue;
    reviewScreens.push({
      kind: 'drill',
      origin: 'review',
      title: n.name,
      drillTypeId: drillType.id,
      itemId: item.id,
      skillNodeIds: [n.id]
    });
    countNodes([n.id]);
  }

  // Interleave review among the lesson screens: after each lesson screen from
  // the midpoint on, then any remainder at the end. Standing stays first,
  // flags stay last.
  const standing = screens.filter((s) => s.origin === 'standing');
  const lessonScreens = screens.filter((s) => s.lessonId !== undefined && s.kind !== 'flag');
  const flagScreens = screens.filter((s) => s.kind === 'flag');
  const merged = [];
  const insertEvery = reviewScreens.length
    ? Math.max(1, Math.ceil(lessonScreens.length / (reviewScreens.length + 1)))
    : Infinity;
  let ri = 0;
  lessonScreens.forEach((s, i) => {
    merged.push(s);
    if ((i + 1) % insertEvery === 0 && ri < reviewScreens.length) {
      merged.push(reviewScreens[ri++]);
    }
  });
  while (ri < reviewScreens.length) merged.push(reviewScreens[ri++]);

  const finalScreens = [...standing, ...merged, ...flagScreens];
  finalScreens.push({ kind: 'summary', title: 'Session complete' });

  return {
    lesson,
    screens: finalScreens,
    flags,
    reviewDebt: due.length
  };
}

// Review debt for the progress view: eligible nodes due right now.
export function reviewDebt(nodeStates, completedLessonIds, now = Date.now()) {
  return dueNodes(nodeStates, now).filter((n) => isEligible(n, completedLessonIds)).length;
}
