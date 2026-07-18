// Session runtime: starts sessions from the assembler, grades responses
// (deterministic-first), applies ledger deltas, maintains artifacts and the
// per-session log.

import { db, STORES, uid } from './db.js';
import { assembleSession } from './assembler.js';
import { runChecker } from './checkers.js';
import { recordResult } from './ledger.js';
import { buildEvaluatorPayload } from './context.js';
import { evaluate, enqueueEvaluation, OfflineError } from './api.js';

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

export async function getActiveSession() {
  const sessions = await db.getAllByIndex(STORES.sessions, 'status', 'active');
  return sessions[0] || null;
}

export async function startSession() {
  const plan = await getActivePlan();
  if (!plan) throw new Error('No active plan. Import one in Settings.');
  const nodeStates = await getNodeStates(plan.id);
  const currentLessonId = await db.getMeta('currentLessonId');
  const assembled = assembleSession(plan, nodeStates, currentLessonId);

  const session = {
    id: uid('ses'),
    planId: plan.id,
    lessonId: assembled.lesson.id,
    date: new Date().toISOString().slice(0, 10),
    startedAt: Date.now(),
    endedAt: null,
    status: 'active',
    blocks: assembled.blocks.map((b) => ({
      ...b,
      attempted: false,
      userResponse: null,
      result: null,          // {correct, detail, source: 'checker'|'evaluator'|'pending', ...}
      ledgerDeltas: [],      // [{nodeId, before, after}]
      artifactId: null
    })),
    reviewDebtAtStart: assembled.reviewDebt,
    flags: assembled.flags
  };
  await db.put(STORES.sessions, session);
  await db.setMeta('currentLessonId', assembled.lesson.id);
  return session;
}

function findDrillType(plan, id) {
  return (plan.drillTypes || []).find((d) => d.id === id) || null;
}
function findItem(plan, id) {
  return (plan.itemBank || []).find((it) => it.id === id) || null;
}

async function applyLedger(session, block, correct, confidenceDelta) {
  const deltas = [];
  for (const nodeId of block.skillNodeIds || []) {
    const node = await db.get(STORES.nodes, nodeId);
    if (!node) continue;
    const before = { status: node.status, accuracy: node.accuracy, attempts: node.attempts };
    recordResult(node, correct, { confidenceDelta });
    await db.put(STORES.nodes, node);
    deltas.push({ nodeId, before, after: { status: node.status, accuracy: node.accuracy, attempts: node.attempts } });
  }
  block.ledgerDeltas = deltas;
  return deltas;
}

async function recordErrorInstance(planId, categoryId, newCategory, item, userResponse, block) {
  let category = null;
  if (categoryId) {
    category = await db.get(STORES.errorCategories, categoryId);
  } else if (newCategory) {
    category = {
      id: uid('ec'),
      planId,
      name: newCategory.name,
      rootCause: newCategory.rootCause,
      skillNodeIds: block.skillNodeIds || [],
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

// Grade a block. Deterministic-first: checker output is final for the
// deterministic axis; the API is only consulted for judgment.
// Returns the updated block.
export async function submitResponse(session, blockIndex, userResponse) {
  const plan = await getActivePlan();
  const block = session.blocks[blockIndex];
  const drillType = findDrillType(plan, block.drillTypeId);
  const item = findItem(plan, block.itemId);
  const errorCategories = await getErrorCategories(plan.id);

  block.attempted = true;
  block.userResponse = userResponse;

  if (drillType.evaluationMode === 'deterministic') {
    const check = runChecker(drillType, item, userResponse);
    block.result = { ...check, source: 'checker' };
    await applyLedger(session, block, check.correct, null);
  } else if (drillType.evaluationMode === 'hybrid') {
    // Deterministic axis first — graded locally, always.
    const check = runChecker(drillType, item, userResponse);
    block.result = { correct: check.correct, detail: check.detail, diff: check.diff, source: 'checker', judgment: 'pending' };
    await applyLedger(session, block, check.correct, null);
    // Judgment axis via evaluator; queue when offline.
    const payload = buildEvaluatorPayload({
      drillType, item, userResponse, errorCategories,
      judgmentAxis: drillType.hybrid ? drillType.hybrid.judgmentAxis : null
    });
    await runOrQueueEvaluation(session, blockIndex, payload, plan, block, item, userResponse, /*ledgerAlreadyApplied*/ true);
  } else {
    // judgment
    if (drillType.producesArtifact) {
      await upsertArtifact(session, block, item, userResponse, plan);
    }
    const payload = buildEvaluatorPayload({ drillType, item, userResponse, errorCategories });
    block.result = { correct: null, detail: 'Awaiting judgment…', source: 'pending' };
    await runOrQueueEvaluation(session, blockIndex, payload, plan, block, item, userResponse, false);
  }

  await db.put(STORES.sessions, session);
  return block;
}

async function runOrQueueEvaluation(session, blockIndex, payload, plan, block, item, userResponse, ledgerAlreadyApplied) {
  try {
    const result = await evaluate(payload);
    await applyEvaluation(session, blockIndex, result, ledgerAlreadyApplied);
  } catch (e) {
    if (e instanceof OfflineError) {
      await enqueueEvaluation(payload, {
        sessionId: session.id,
        blockIndex,
        ledgerAlreadyApplied
      });
      if (block.result) block.result.judgment = 'queued (offline)';
      else block.result = { correct: null, detail: 'Offline — judgment queued for retry.', source: 'pending' };
    } else {
      if (block.result) block.result.judgment = `error: ${e.message}`;
      else block.result = { correct: null, detail: `Evaluator error: ${e.message}`, source: 'error' };
    }
  }
}

// Apply an evaluator result to a session block (also used by the queue flusher).
export async function applyEvaluation(sessionOrId, blockIndex, result, ledgerAlreadyApplied) {
  const session = typeof sessionOrId === 'string' ? await db.get(STORES.sessions, sessionOrId) : sessionOrId;
  if (!session) return;
  const block = session.blocks[blockIndex];
  const plan = await db.get(STORES.plans, session.planId);
  const item = findItem(plan, block.itemId);

  if (ledgerAlreadyApplied) {
    // hybrid: deterministic verdict stands; judgment annotates.
    block.result = {
      ...block.result,
      judgment: result.correct ? 'trade accepted' : 'trade rejected',
      judgmentNote: result.note,
      source: 'checker+evaluator'
    };
  } else {
    block.result = { correct: result.correct, detail: result.note, source: 'evaluator' };
    await applyLedger(session, block, result.correct, result.confidenceDelta);
    if (block.artifactId) {
      const artifact = await db.get(STORES.artifacts, block.artifactId);
      if (artifact) {
        artifact.finalEvaluation = `${result.correct ? 'accepted' : 'not yet'} — ${result.note}`;
        await db.put(STORES.artifacts, artifact);
      }
    }
  }

  if (!result.correct && (result.errorCategoryId || result.newCategory)) {
    const catId = await recordErrorInstance(
      session.planId, result.errorCategoryId, result.newCategory, item,
      block.userResponse, block
    );
    block.result.errorCategoryId = catId;
  }

  await db.put(STORES.sessions, session);
  return session;
}

// ---- artifacts: revision chains matter more than final versions ----

async function upsertArtifact(session, block, item, text, plan) {
  if (block.artifactId) {
    const artifact = await db.get(STORES.artifacts, block.artifactId);
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
    skillNodeIds: block.skillNodeIds || []
  };
  await db.put(STORES.artifacts, artifact);
  block.artifactId = artifact.id;
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

// Resolve a flag block: either change approach (mark node flagged with a note)
// or keep drilling (reset the plateau window by noting the decision).
export async function resolveFlag(session, blockIndex, changeApproach, note) {
  const block = session.blocks[blockIndex];
  block.attempted = true;
  for (const nodeId of block.skillNodeIds || []) {
    const node = await db.get(STORES.nodes, nodeId);
    if (!node) continue;
    if (changeApproach) {
      node.flagged = true;
      node.flagNote = note || 'Marked for a change of approach.';
    } else {
      // keep drilling: trim history so the plateau check starts a fresh window
      node.history = node.history.slice(-3);
    }
    await db.put(STORES.nodes, node);
  }
  block.result = { correct: null, detail: changeApproach ? 'Approach change recorded.' : 'Continuing with more reps.', source: 'flag' };
  await db.put(STORES.sessions, session);
  return block;
}

export async function endSession(session) {
  session.status = 'completed';
  session.endedAt = Date.now();
  await db.put(STORES.sessions, session);
  return session;
}

// Create a derived node mid-session from a realization.
export async function createDerivedNode(planId, name, description) {
  const { newDerivedNode } = await import('./ledger.js');
  const node = newDerivedNode(planId, { id: uid('n-derived'), name, description });
  await db.put(STORES.nodes, node);
  return node;
}
