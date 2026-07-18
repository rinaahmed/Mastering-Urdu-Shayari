// Context payload builder. The API is stateless: every generator call receives
// a freshly assembled payload from local state. Target ~3k tokens. The
// evaluator payload is deliberately minimal — no teaching context, ever.

import { decayedConfidence } from './ledger.js';

const CHARS_PER_TOKEN = 4; // rough budget estimate

function estTokens(s) { return Math.ceil(s.length / CHARS_PER_TOKEN); }

function nodeLine(n, now) {
  const conf = decayedConfidence(n, now).toFixed(2);
  return `- ${n.name} [${n.id}] — status: ${n.status}, attempts: ${n.attempts}, accuracy: ${Math.round(n.accuracy * 100)}%, confidence(now): ${conf}${n.derived ? ', derived mid-session' : ''}${n.flagged ? ', FLAGGED (flat progress)' : ''}`;
}

// buildContextPayload({plan, lesson, nodeStates, errorCategories, artifacts,
//                      screen, item, drillType}) -> string
export function buildContextPayload({ plan, lesson, nodeStates, errorCategories, artifacts, screen, item, drillType, now = Date.now() }) {
  const target = (plan.settings && plan.settings.targetContextTokens) || 3000;
  const parts = [];

  // 1. Tutor instructions — verbatim from the plan file; the method is data.
  parts.push(`## Tutor instructions (from the plan, follow verbatim)\n${plan.tutorInstructions}`);

  // 2. Current lesson and objective.
  parts.push([
    `## Current lesson`,
    `${lesson.phaseTitle} → ${lesson.weekTitle} → ${lesson.title} (${lesson.lessonType})`,
    `Objective: ${lesson.objective}`,
    `Mastery criteria: ${lesson.masteryCriteria}`
  ].join('\n'));

  // 3. Current screen: a drill, or a content block being expanded.
  if (drillType) {
    const lines = [
      `## Current drill`,
      `Type: ${drillType.name} — ${drillType.format}`,
      `Origin: ${screen && screen.origin ? screen.origin : 'lesson'}`
    ];
    if (item) lines.push(`Prompt: ${item.prompt}`);
    if (drillType.evaluationMode === 'hybrid' && drillType.hybrid) {
      lines.push(`Hybrid drill — the ${drillType.hybrid.deterministicAxis} is checked by local code; you only address: ${drillType.hybrid.judgmentAxis}.`);
    }
    parts.push(lines.join('\n'));
  } else if (screen && screen.block) {
    parts.push(`## Current lesson block (${screen.block.type})\n${screen.block.body || ''}`);
  }

  // 4. Exercised skill nodes with status and accuracy.
  const exercisedIds = new Set((screen && screen.skillNodeIds) || lesson.skillNodeIds || []);
  const exercised = nodeStates.filter((n) => exercisedIds.has(n.id));
  if (exercised.length) {
    parts.push(`## Skill nodes in play\n${exercised.map((n) => nodeLine(n, now)).join('\n')}`);
  }

  // 5. Matched error categories with 2–3 real instances each.
  const matched = (errorCategories || []).filter((c) =>
    (c.skillNodeIds || []).some((id) => exercisedIds.has(id)) && (c.instances || []).length > 0
  );
  if (matched.length) {
    const ecText = matched.map((c) => {
      const inst = (c.instances || []).slice(-3).map((i) =>
        `  - ${i.date}: "${i.material}" — did: ${i.userDid}; correct: ${i.correct}`
      ).join('\n');
      return `- ${c.name} [${c.id}] — root cause: ${c.rootCause}\n${inst}`;
    }).join('\n');
    parts.push(`## Known error categories for these nodes (name them, don't re-explain)\n${ecText}`);
  }

  // 6. Last 2–3 artifacts with revision chains — the learning is in the sequence.
  const recent = (artifacts || [])
    .slice()
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 3);
  if (recent.length) {
    const artText = recent.map((a) => {
      const chain = (a.revisions || []).map((r, i) =>
        `  rev ${i + 1}: "${r.text}"${r.whatChanged ? ` — changed: ${r.whatChanged}` : ''}${r.why ? `; why: ${r.why}` : ''}${r.accepted === false ? `; REJECTED: ${r.rejectionReason || 'no reason recorded'}` : r.accepted === true ? '; accepted' : ''}`
      ).join('\n');
      return `- ${a.date} (lesson ${a.lessonId}): final evaluation: ${a.finalEvaluation || 'pending'}\n${chain}`;
    }).join('\n');
    parts.push(`## Recent artifacts (respond to the revision chain, not just final versions)\n${artText}`);
  }

  // 7. Calibration examples from the plan file, filtered to this drill type.
  const calib = (plan.calibrationExamples || []).filter((c) => !drillType || c.drillTypeId === drillType.id);
  if (calib.length) {
    const cText = calib.map((c) =>
      `- Prompt: ${c.prompt}\n  Response: ${c.response}\n  Evaluation: ${c.evaluation}\n  Commentary: ${c.commentary}`
    ).join('\n');
    parts.push(`## Calibration examples (this is the grading bar)\n${cText}`);
  }

  // Trim to budget: drop artifacts first, then calibration, then error
  // instances — tutor instructions and the current screen always survive.
  let text = parts.join('\n\n');
  if (estTokens(text) > target) {
    const dropOrder = ['## Recent artifacts', '## Calibration examples', '## Known error categories'];
    for (const marker of dropOrder) {
      if (estTokens(text) <= target) break;
      const idx = parts.findIndex((p) => p.startsWith(marker));
      if (idx >= 0) {
        parts.splice(idx, 1);
        text = parts.join('\n\n');
      }
    }
  }
  return text;
}

// Evaluator payload: prompt, expected answer, user response. Nothing else.
export function buildEvaluatorPayload({ drillType, item, userResponse, errorCategories, judgmentAxis = null }) {
  return {
    drill: {
      type: drillType.name,
      format: drillType.format,
      prompt: item ? item.prompt : '',
      judgmentAxis
    },
    correctAnswer: item ? item.answer : '',
    answerNote: item && item.answerNote ? item.answerNote : null,
    userResponse,
    knownErrorCategories: (errorCategories || []).map((c) => ({ id: c.id, name: c.name, rootCause: c.rootCause }))
  };
}
