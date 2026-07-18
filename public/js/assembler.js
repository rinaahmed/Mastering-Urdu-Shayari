// Session assembler. A session is assembled entirely by local code before any
// API call: standing elements first, then the current lesson's drills, then
// interleaved spaced-repetition review, with a per-node cap and plateau flags.

import { dueNodes, reviewWeight, isPlateaued } from './ledger.js';
import { flattenLessons } from './schema.js';

function pickItem(plan, drillTypeId, nodeIds, usedItemIds) {
  const candidates = plan.itemBank.filter(it =>
    it.drillTypeId === drillTypeId &&
    !usedItemIds.has(it.id) &&
    (nodeIds.length === 0 || (it.skillNodeIds || []).some(id => nodeIds.includes(id)))
  );
  if (candidates.length === 0) {
    // fall back to any item of this drill type, allowing reuse
    const any = plan.itemBank.filter(it => it.drillTypeId === drillTypeId);
    if (any.length === 0) return null;
    return any[Math.floor(Math.random() * any.length)];
  }
  const item = candidates[Math.floor(Math.random() * candidates.length)];
  usedItemIds.add(item.id);
  return item;
}

// assembleSession(plan, nodeStates, currentLessonId) -> { lesson, blocks, flags }
// blocks: { kind, title, drillTypeId, itemId, skillNodeIds, standingElementId? }
export function assembleSession(plan, nodeStates, currentLessonId, now = Date.now()) {
  const settings = plan.settings || {};
  const blockTarget = settings.sessionBlockTarget || 8;
  const nodeCap = settings.reviewNodeCap || 0.4;
  // Cap any single node at ~40% of the intended session size — applies to
  // lesson blocks too, so a one-node lesson can't dominate the session.
  const maxPerNode = Math.max(1, Math.round(blockTarget * nodeCap));
  const usedItemIds = new Set();
  const blocks = [];
  const nodeBlockCount = new Map();

  const countNodes = (ids) => (ids || []).forEach(id =>
    nodeBlockCount.set(id, (nodeBlockCount.get(id) || 0) + 1));
  const underCap = (ids) => (ids || []).length === 0 ||
    (ids || []).some(id => (nodeBlockCount.get(id) || 0) < maxPerNode);

  const lessons = flattenLessons(plan);
  const lesson = lessons.find(l => l.id === currentLessonId) || lessons[0];

  // 1. Standing elements — open every session regardless of lesson.
  for (const se of plan.standingElements || []) {
    const item = pickItem(plan, se.drillTypeId, se.skillNodeIds || [], usedItemIds);
    blocks.push({
      kind: 'standing',
      title: se.title,
      minutes: se.minutes,
      standingElementId: se.id,
      drillTypeId: se.drillTypeId,
      itemId: item ? item.id : null,
      skillNodeIds: se.skillNodeIds || []
    });
    countNodes(se.skillNodeIds);
  }

  // 2. Current lesson's drills.
  const lessonDrillCount = Math.max(2, Math.ceil(blockTarget / 2));
  for (let i = 0; i < lessonDrillCount; i++) {
    const drillTypeId = lesson.drillTypeIds[i % lesson.drillTypeIds.length];
    const item = pickItem(plan, drillTypeId, lesson.skillNodeIds, usedItemIds);
    if (!item) continue;
    const nodeIds = (item.skillNodeIds && item.skillNodeIds.length) ? item.skillNodeIds : lesson.skillNodeIds;
    if (!underCap(nodeIds)) continue;
    blocks.push({
      kind: 'lesson',
      title: lesson.title,
      lessonId: lesson.id,
      drillTypeId,
      itemId: item.id,
      skillNodeIds: nodeIds
    });
    countNodes(nodeIds);
  }

  // 3. Plateau flags — surface "this isn't moving" instead of more reps.
  const flags = [];
  const flagOpts = {
    attemptThreshold: settings.flagAttemptThreshold || 8,
    window: settings.flagAccuracyWindow || 6
  };
  for (const n of nodeStates) {
    if (isPlateaued(n, flagOpts)) {
      flags.push(n.id);
      blocks.push({
        kind: 'flag',
        title: `Not moving: ${n.name}`,
        drillTypeId: null,
        itemId: null,
        skillNodeIds: [n.id],
        note: `${n.name} has ${n.attempts} attempts with flat accuracy (${Math.round(n.accuracy * 100)}%). Change approach rather than repeating the same drill.`
      });
    }
  }
  const flaggedSet = new Set(flags);

  // 4. Interleaved review — due nodes weighted toward low accuracy, skipping
  //    flagged nodes, capped so no single node dominates the session.
  const due = dueNodes(nodeStates, now)
    .filter(n => !flaggedSet.has(n.id))
    .sort((a, b) => reviewWeight(b, now) - reviewWeight(a, now));

  const reviewSlots = Math.max(0, blockTarget - blocks.filter(b => b.kind !== 'flag').length);
  let slot = 0;
  for (const n of due) {
    if (slot >= reviewSlots) break;
    if ((nodeBlockCount.get(n.id) || 0) >= maxPerNode) continue; // cap ~40% per node

    // find a drill type that exercises this node
    const drillType = (plan.drillTypes || []).find(d =>
      plan.itemBank.some(it => it.drillTypeId === d.id && (it.skillNodeIds || []).includes(n.id))
    );
    if (!drillType) continue;
    const item = pickItem(plan, drillType.id, [n.id], usedItemIds);
    if (!item) continue;

    blocks.push({
      kind: 'review',
      title: `Review: ${n.name}`,
      drillTypeId: drillType.id,
      itemId: item.id,
      skillNodeIds: [n.id]
    });
    countNodes([n.id]);
    slot++;
  }

  // Interleave review blocks among lesson blocks (standing stays first,
  // flags stay last).
  const standing = blocks.filter(b => b.kind === 'standing');
  const lessonBlocks = blocks.filter(b => b.kind === 'lesson');
  const review = blocks.filter(b => b.kind === 'review');
  const flagBlocks = blocks.filter(b => b.kind === 'flag');
  const interleaved = [];
  const maxLen = Math.max(lessonBlocks.length, review.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < lessonBlocks.length) interleaved.push(lessonBlocks[i]);
    if (i < review.length) interleaved.push(review[i]);
  }

  return {
    lesson,
    blocks: [...standing, ...interleaved, ...flagBlocks],
    flags,
    reviewDebt: due.length
  };
}

// Review debt for the progress view: how many nodes are due right now.
export function reviewDebt(nodeStates, now = Date.now()) {
  return dueNodes(nodeStates, now).length;
}
