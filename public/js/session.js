// Session runtime: builds sessions from the assembler, paginates screens,
// grades responses (deterministic checkers locally, judgment via the
// evaluator), applies ledger deltas, maintains artifacts and lesson
// completion state.

import { db, STORES, uid } from './db.js';
import { assembleSession } from './assembler.js';
import { runCheck, isJudgmentChecker } from './checkers.js';
import { recordResult, newDerivedNode } from './ledger.js';
import { buildEvaluatorPayload } from './context.js';
import { evaluate, enqueueEvaluation, OfflineError } from './api.js';
import { flattenLessons } from './schema.js';

export async function getActivePlan() {
  const planId = await db.getMeta('activePlanId');
  if (!planId) return null;
  return db.get(STORES.plans, planId);
}

export async function getNodeStates(planId) {
  return db.getAllByIndex(STORES.nodes, 'planId', planId);
}

export async function getErrorCategories(planId) {
  return db.getAllByIndex(STORES.errorCategories, 'planId', planId);
}

export async function getCompletedLessonIds(planId) {
  const rows = await db.getAllByIndex(STORES.lessonState, 'planId', planId);
  return new Set(rows.filter((r) => r.status === 'complete').map((r) => r.id));
}

export async function getResolvedMissingIds(planId) {
  return new Set(await db.getMeta(`resolvedMissing:${planId}`, []));
}

export async function resolveMissingData(planId, missingId, note) {
  const resolved = await db.getMeta(`resolvedMissing:${planId}`, []);
  if (!resolved.includes(missingId)) resolved.push(missingId);
  await db.setMeta(`resolvedMissing:${planId}`, resolved);
  await db.setMeta(`resolvedMissingNote:${planId}:${missingId}`, note || '');
}

// currentLessonId is the app's own progress state — not read from the plan
// JSON, which has no concept of position. Defaulted to the first lesson on
// import (see exporter.js) and otherwise only ever changed here.
export async function getCurrentLessonId() {
  return db.getMeta('currentLessonId');
}

export async function setCurrentLessonId(lessonId) {
  return db.setMeta('currentLessonId', lessonId);
}

// Set only when "Start next lesson" stops on a blocked lesson (see below) —
// tracks that the CURRENT lesson became current without ever being opened,
// so the next click retries opening it instead of completing it unseen.
export async function getPendingOpenLessonId() {
  return db.getMeta('pendingOpenLessonId', null);
}

export async function getActiveSession() {
  const sessions = await db.getAllByIndex(STORES.sessions, 'status', 'active');
  return sessions[0] || null;
}

export async function startSession() {
  const plan = await getActivePlan();
  if (!plan) throw new Error('No active plan. Import one in Settings.');
  const [nodeStates, completed, resolved] = await Promise.all([
    getNodeStates(plan.id),
    getCompletedLessonIds(plan.id),
    getResolvedMissingIds(plan.id)
  ]);
  const currentLessonId = await getCurrentLessonId();
  const assembled = assembleSession(plan, nodeStates, currentLessonId, completed, resolved);

  const session = {
    id: uid('ses'),
    planId: plan.id,
    lessonId: assembled.lesson.id,
    date: new Date().toISOString().slice(0, 10),
    startedAt: Date.now(),
    endedAt: null,
    status: 'active',
    index: 0,
    screens: assembled.screens.map((s) => ({
      ...s,
      done: false,
      response: null,
      result: null,        // {correct, detail, provisional?, source, ...}
      note: null,          // reflect responses
      generatedText: null, // cached generator output for generate screens
      ledgerDeltas: [],
      artifactId: null
    })),
    reviewDebtAtStart: assembled.reviewDebt,
    flags: assembled.flags
  };
  await db.put(STORES.sessions, session);
  await setCurrentLessonId(assembled.lesson.id);
  return session;
}

export function findDrillType(plan, id) {
  return (plan.drillTypes || []).find((d) => d.id === id) || null;
}
export function findItem(plan, id) {
  return (plan.itemBank || []).find((it) => it.id === id) || null;
}

export async function saveSession(session) {
  await db.put(STORES.sessions, session);
}

// ---- lesson-list navigation ----

// Jump directly to a lesson from the flat lesson list, making it current.
// If a different lesson's session is active, abandon it (only one active
// session at a time); resume the same lesson's in-progress session if there
// is one, otherwise start fresh.
export async function jumpToLesson(lessonId) {
  const active = await getActiveSession();
  if (active && active.lessonId !== lessonId) {
    await abandonSession(active);
  }
  await setCurrentLessonId(lessonId);
  if (active && active.lessonId === lessonId) return active;
  return startSession();
}

// "Start next lesson": force-marks the current lesson done — regardless of
// whether every screen was seen, this is a deliberate override — advances
// currentLessonId to the next lesson in plan order, and opens it.
//
// currentLessonId always advances to that immediate next lesson, whether or
// not it is blocked. If it IS blocked, no session is started for it — the
// caller gets { type: 'blocked', ... } and must show the dependency clearly.
// It never continues silently past a blocked lesson to reach a later,
// unblocked one.
//
// Special case: a lesson can become current purely because a PREVIOUS click
// stopped here while it was blocked — it was never actually opened. Marking
// that lesson "done" the moment its dependency is resolved, without ever
// showing its content, would skip it in all but name. So if the current
// lesson is the one we're still pending-open on, this click instead retries
// OPENING it (not completing it); only once it has actually been opened does
// a later click complete it and advance, per the normal behaviour above.
export async function startNextLesson() {
  const plan = await getActivePlan();
  if (!plan) throw new Error('No active plan.');
  const lessons = flattenLessons(plan);
  const currentId = await getCurrentLessonId();
  const idx = lessons.findIndex((l) => l.id === currentId);
  if (idx === -1) throw new Error('Current lesson not found in plan.');
  const current = lessons[idx];

  const active = await getActiveSession();
  const pendingOpenId = await getPendingOpenLessonId();

  if (pendingOpenId === currentId) {
    const resolved = await getResolvedMissingIds(plan.id);
    if (current.blockedOn && !resolved.has(current.blockedOn)) {
      if (active && active.lessonId !== currentId) await abandonSession(active);
      const missingData = (plan.missingData || []).find((m) => m.id === current.blockedOn);
      return { type: 'blocked', lesson: current, missingData };
    }
    await db.setMeta('pendingOpenLessonId', null);
    if (active && active.lessonId === currentId) {
      return { type: 'started', session: active };
    }
    if (active) await abandonSession(active);
    const session = await startSession();
    return { type: 'started', session };
  }

  if (active) await abandonSession(active);

  await db.put(STORES.lessonState, {
    id: currentId,
    planId: plan.id,
    status: 'complete',
    completedAt: Date.now()
  });

  if (idx + 1 >= lessons.length) {
    await db.setMeta('pendingOpenLessonId', null);
    return { type: 'plan-complete' };
  }

  const next = lessons[idx + 1];
  await setCurrentLessonId(next.id);

  const resolved = await getResolvedMissingIds(plan.id);
  if (next.blockedOn && !resolved.has(next.blockedOn)) {
    await db.setMeta('pendingOpenLessonId', next.id);
    const missingData = (plan.missingData || []).find((m) => m.id === next.blockedOn);
    return { type: 'blocked', lesson: next, missingData };
  }

  await db.setMeta('pendingOpenLessonId', null);
  const session = await startSession();
  return { type: 'started', session };
}

// ---- navigation ----

export async function goTo(session, index) {
  session.index = Math.max(0, Math.min(index, session.screens.length - 1));
  await saveSession(session);
  return session;
}

export async function markScreenDone(session, index) {
  session.screens[index].done = true;
  await saveSession(session);
}

// ---- grading ----

async function applyLedger(session, screen, correct, confidenceDelta) {
  const deltas = [];
  for (const nodeId of screen.skillNodeIds || []) {
    const node = await db.get(STORES.nodes, nodeId);
    if (!node) continue;
    const before = { status: node.status, accuracy: node.accuracy, attempts: node.attempts };
    recordResult(node, correct, { confidenceDelta });
    await db.put(STORES.nodes, node);
    deltas.push({ nodeId, before, after: { status: node.status, accuracy: node.accuracy, attempts: node.attempts } });
  }
  screen.ledgerDeltas = deltas;
  return deltas;
}

async function recordErrorInstance(planId, categoryId, newCategory, item, userResponse, screen) {
  let category = null;
  if (categoryId) {
    category = await db.get(STORES.errorCategories, categoryId);
  } else if (newCategory) {
    category = {
      id: uid('ec'),
      planId,
      name: newCategory.name,
      rootCause: newCategory.rootCause,
      skillNodeIds: screen.skillNodeIds || [],
      instances: []
    };
  }
  if (!category) return null;
  category.instances = category.instances || [];
  category.instances.push({
    date: new Date().toISOString().slice(0, 10),
    material: item ? item.prompt : '(no item)',
    userDid: userResponse,
    correct: item ? item.answer : '(judged)'
  });
  await db.put(STORES.errorCategories, category);
  return category.id;
}

// Grade a drill screen. Deterministic-first: local checkers are final for the
// deterministic axis; the API is called only for judgment.
export async function submitResponse(session, index, userResponse) {
  const plan = await getActivePlan();
  const screen = session.screens[index];
  const drillType = findDrillType(plan, screen.drillTypeId);
  const item = findItem(plan, screen.itemId);
  const errorCategories = await getErrorCategories(plan.id);

  screen.done = true;
  screen.response = userResponse;

  const judgment = isJudgmentChecker(plan, drillType);

  if (!judgment && drillType.evaluationMode === 'deterministic') {
    const check = await runCheck(plan, drillType, item, userResponse);
    if (check.routeToJudgment) {
      // External checker down, fallback is judgment: evaluator grades it all.
      const payload = buildEvaluatorPayload({ drillType, item, userResponse, errorCategories });
      screen.result = { correct: null, detail: check.detail, source: 'pending', provisional: true };
      await runOrQueueEvaluation(session, index, payload, screen, false);
    } else {
      screen.result = { ...check, source: check.fallbackUsed ? 'checker-fallback' : 'checker' };
      await applyLedger(session, screen, check.correct, null);
    }
  } else if (drillType.evaluationMode === 'hybrid') {
    const check = await runCheck(plan, drillType, item, userResponse);
    const payload = buildEvaluatorPayload({
      drillType, item, userResponse, errorCategories,
      judgmentAxis: check.routeToJudgment ? null : (drillType.hybrid ? drillType.hybrid.judgmentAxis : null)
    });
    if (check.routeToJudgment) {
      // Deterministic axis unavailable: the evaluator judges both axes.
      screen.result = { correct: null, detail: check.detail, source: 'pending', provisional: true };
      await runOrQueueEvaluation(session, index, payload, screen, false);
    } else {
      screen.result = { ...check, source: check.fallbackUsed ? 'checker-fallback' : 'checker', judgment: 'pending' };
      await applyLedger(session, screen, check.correct, null);
      await runOrQueueEvaluation(session, index, payload, screen, true);
    }
  } else {
    // judgment
    if (drillType.producesArtifact) {
      await upsertArtifact(session, screen, item, userResponse, plan);
    }
    const payload = buildEvaluatorPayload({ drillType, item, userResponse, errorCategories });
    screen.result = { correct: null, detail: 'Awaiting judgment…', source: 'pending', provisional: true };
    await runOrQueueEvaluation(session, index, payload, screen, false);
  }

  await saveSession(session);
  return screen;
}

async function runOrQueueEvaluation(session, index, payload, screen, ledgerAlreadyApplied) {
  try {
    const result = await evaluate(payload);
    await applyEvaluation(session, index, result, ledgerAlreadyApplied);
  } catch (e) {
    if (e instanceof OfflineError) {
      await enqueueEvaluation(payload, { sessionId: session.id, screenIndex: index, ledgerAlreadyApplied });
      if (screen.result) {
        screen.result.judgment = 'queued (offline)';
        screen.result.provisional = true;
      }
    } else {
      if (screen.result && screen.result.source !== 'pending') {
        screen.result.judgment = `error: ${e.message}`;
      } else {
        screen.result = { correct: null, detail: `Evaluator error: ${e.message}`, source: 'error', provisional: true };
      }
    }
  }
}

// Apply an evaluator result to a session screen (also used by the queue flusher).
export async function applyEvaluation(sessionOrId, index, result, ledgerAlreadyApplied) {
  const session = typeof sessionOrId === 'string' ? await db.get(STORES.sessions, sessionOrId) : sessionOrId;
  if (!session) return;
  const screen = session.screens[index];
  const plan = await db.get(STORES.plans, session.planId);
  const item = findItem(plan, screen.itemId);

  if (ledgerAlreadyApplied) {
    // hybrid: the deterministic verdict stands; judgment annotates.
    screen.result = {
      ...screen.result,
      judgment: result.correct ? 'judged: accepted' : 'judged: not accepted',
      judgmentNote: result.note,
      provisional: false,
      source: 'checker+evaluator'
    };
  } else {
    screen.result = { correct: result.correct, detail: result.note, source: 'evaluator', provisional: false };
    await applyLedger(session, screen, result.correct, result.confidenceDelta);
    if (screen.artifactId) {
      const artifact = await db.get(STORES.artifacts, screen.artifactId);
      if (artifact) {
        artifact.finalEvaluation = `${result.correct ? 'accepted' : 'not yet'} — ${result.note}`;
        await db.put(STORES.artifacts, artifact);
      }
    }
  }

  if (!result.correct && (result.errorCategoryId || result.newCategory)) {
    const catId = await recordErrorInstance(
      session.planId, result.errorCategoryId, result.newCategory, item, screen.response, screen);
    screen.result.errorCategoryId = catId;
  }

  await saveSession(session);
  return session;
}

// ---- reflect notes ----

export async function saveReflection(session, index, text) {
  const screen = session.screens[index];
  screen.note = text;
  screen.done = true;
  await saveSession(session);
}

// ---- artifacts: revision chains matter more than final versions ----

async function upsertArtifact(session, screen, item, text, plan) {
  if (screen.artifactId) {
    const artifact = await db.get(STORES.artifacts, screen.artifactId);
    artifact.revisions.push({ text, whatChanged: null, why: null, accepted: null, rejectionReason: null, ts: Date.now() });
    artifact.text = text;
    await db.put(STORES.artifacts, artifact);
    return artifact;
  }
  const artifact = {
    id: uid('art'),
    planId: plan.id,
    lessonId: session.lessonId,
    sessionId: session.id,
    date: new Date().toISOString().slice(0, 10),
    itemId: item ? item.id : null,
    prompt: item ? item.prompt : '',
    text,
    revisions: [{ text, whatChanged: null, why: null, accepted: null, rejectionReason: null, ts: Date.now() }],
    finalEvaluation: null,
    skillNodeIds: screen.skillNodeIds || []
  };
  await db.put(STORES.artifacts, artifact);
  screen.artifactId = artifact.id;
  return artifact;
}

export async function addRevision(artifactId, { text, whatChanged, why }) {
  const artifact = await db.get(STORES.artifacts, artifactId);
  artifact.revisions.push({ text, whatChanged, why, accepted: null, rejectionReason: null, ts: Date.now() });
  artifact.text = text;
  await db.put(STORES.artifacts, artifact);
  return artifact;
}

export async function markRevision(artifactId, revIndex, accepted, rejectionReason = null) {
  const artifact = await db.get(STORES.artifacts, artifactId);
  const rev = artifact.revisions[revIndex];
  if (rev) {
    rev.accepted = accepted;
    rev.rejectionReason = accepted ? null : rejectionReason;
  }
  await db.put(STORES.artifacts, artifact);
  return artifact;
}

// ---- flags ----

export async function resolveFlag(session, index, changeApproach, note) {
  const screen = session.screens[index];
  screen.done = true;
  for (const nodeId of screen.skillNodeIds || []) {
    const node = await db.get(STORES.nodes, nodeId);
    if (!node) continue;
    if (changeApproach) {
      node.flagged = true;
      node.flagNote = note || 'Marked for a change of approach.';
    } else {
      node.history = node.history.slice(-3); // fresh window for the plateau check
    }
    await db.put(STORES.nodes, node);
  }
  screen.result = { correct: null, detail: changeApproach ? 'Approach change recorded.' : 'Continuing with more reps.', source: 'flag' };
  await saveSession(session);
  return screen;
}

// ---- lifecycle ----

export async function endSession(session) {
  session.status = 'completed';
  session.endedAt = Date.now();
  await db.put(STORES.sessions, session);

  // Lesson completion gate: complete when every lesson-origin screen was seen.
  const lessonScreens = session.screens.filter((s) => s.lessonId === session.lessonId && s.kind !== 'blocked');
  if (lessonScreens.length > 0 && lessonScreens.every((s) => s.done)) {
    await db.put(STORES.lessonState, {
      id: session.lessonId,
      planId: session.planId,
      status: 'complete',
      completedAt: Date.now()
    });
    // Auto-advance to the next lesson in plan order.
    const plan = await db.get(STORES.plans, session.planId);
    const lessons = flattenLessons(plan);
    const i = lessons.findIndex((l) => l.id === session.lessonId);
    if (i >= 0 && i + 1 < lessons.length) {
      await setCurrentLessonId(lessons[i + 1].id);
    }
  }
  return session;
}

export async function abandonSession(session) {
  session.status = 'abandoned';
  session.endedAt = Date.now();
  await db.put(STORES.sessions, session);
}

// Create a derived node mid-session from a realization. No taughtIn — it is
// eligible immediately.
export async function createDerivedNode(planId, name, description) {
  const node = newDerivedNode(planId, { id: uid('n-derived'), name, description });
  await db.put(STORES.nodes, node);
  return node;
}
