// Plan schema v2 validation. Hand-rolled so every error carries an exact JSON
// path, plus cross-reference checks JSON Schema cannot express, plus the
// teaching-order audit that blocks import when a drill exercises a node whose
// taughtIn lesson comes later in plan order.

export const CONTENT_TYPES = ['prose', 'example', 'generate', 'reflect', 'drill'];
export const LESSON_TYPES = ['study', 'drill', 'production', 'mixed'];
export const EVALUATION_MODES = ['deterministic', 'judgment', 'hybrid'];
export const INPUT_SHAPES = ['pattern', 'number', 'word', 'text'];
export const CHECKER_STRATEGIES = ['exact', 'normalized-exact', 'set-match', 'sequence-diff', 'numeric', 'external', 'judgment'];
export const NODE_STATUSES = ['not-attempted', 'emerging', 'shaky', 'solid'];

function isStr(v) { return typeof v === 'string' && v.length > 0; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function isArr(v) { return Array.isArray(v); }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

export function validatePlan(plan) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);

  if (!isObj(plan)) return { ok: false, errors: ['(root): plan must be a JSON object'] };
  if (plan.schemaVersion !== 2) {
    err('schemaVersion', plan.schemaVersion === 1
      ? 'this is a v1 plan — run the migration (Settings offers it on import)'
      : 'must be 2');
    if (plan.schemaVersion === 1) return { ok: false, errors, v1: true };
  }
  if (!isStr(plan.id)) err('id', 'required string');
  if (!isStr(plan.title)) err('title', 'required string');
  if (!isStr(plan.tutorInstructions)) err('tutorInstructions', 'required string — the method lives in the plan, not the app');

  // ---- missingData ----
  const missingIds = new Set();
  if (plan.missingData !== undefined) {
    if (!isArr(plan.missingData)) err('missingData', 'must be an array');
    else plan.missingData.forEach((m, i) => {
      const p = `missingData[${i}]`;
      if (!isStr(m.id)) err(`${p}.id`, 'required string');
      else if (missingIds.has(m.id)) err(`${p}.id`, `duplicate id "${m.id}"`);
      else missingIds.add(m.id);
      if (!isStr(m.title)) err(`${p}.title`, 'required string');
    });
  }

  // ---- checkers (plan-declared plugins; ids are free strings) ----
  const checkerById = new Map();
  if (!isArr(plan.checkers)) {
    err('checkers', 'required array — checkers are plan data, not app code');
  } else {
    plan.checkers.forEach((c, i) => {
      const p = `checkers[${i}]`;
      if (!isStr(c.id)) err(`${p}.id`, 'required string');
      else if (checkerById.has(c.id)) err(`${p}.id`, `duplicate id "${c.id}"`);
      else checkerById.set(c.id, c);
      if (!isStr(c.name)) err(`${p}.name`, 'required string');
      if (!CHECKER_STRATEGIES.includes(c.strategy)) err(`${p}.strategy`, `must be one of ${CHECKER_STRATEGIES.join(', ')}`);
      if (c.strategy === 'external' && !isStr(c.externalUrl)) err(`${p}.externalUrl`, 'required when strategy is "external"');
      if (c.config !== undefined && !isObj(c.config)) err(`${p}.config`, 'must be an object');
    });
    // fallback refs
    plan.checkers.forEach((c, i) => {
      if (c.fallback !== undefined) {
        if (!checkerById.has(c.fallback)) err(`checkers[${i}].fallback`, `unknown checker id "${c.fallback}"`);
        else if (c.fallback === c.id) err(`checkers[${i}].fallback`, 'a checker cannot fall back to itself');
      }
    });
  }

  // ---- lessons first pass (ids needed for taughtIn) ----
  const lessonIds = new Set();
  if (isArr(plan.phases)) {
    plan.phases.forEach((ph) => (ph.weeks || []).forEach((wk) => (wk.lessons || []).forEach((ls) => {
      if (isStr(ls.id)) lessonIds.add(ls.id);
    })));
  }

  // ---- skillNodes ----
  const nodeIds = new Set();
  if (!isArr(plan.skillNodes) || plan.skillNodes.length === 0) {
    err('skillNodes', 'required non-empty array');
  } else {
    plan.skillNodes.forEach((n, i) => {
      const p = `skillNodes[${i}]`;
      if (!isStr(n.id)) err(`${p}.id`, 'required string');
      else if (nodeIds.has(n.id)) err(`${p}.id`, `duplicate id "${n.id}"`);
      else nodeIds.add(n.id);
      if (!isStr(n.name)) err(`${p}.name`, 'required string');
      if (!isStr(n.description)) err(`${p}.description`, 'required string');
      if (!isArr(n.prerequisites)) err(`${p}.prerequisites`, 'required array (may be empty)');
      if (!isStr(n.taughtIn)) err(`${p}.taughtIn`, 'required lesson id — a node is ineligible for drills and review until this lesson is complete');
      else if (!lessonIds.has(n.taughtIn)) err(`${p}.taughtIn`, `unknown lesson id "${n.taughtIn}"`);
      if (n.status !== undefined && !NODE_STATUSES.includes(n.status)) err(`${p}.status`, `must be one of ${NODE_STATUSES.join(', ')}`);
      if (n.confidence !== undefined && !(isNum(n.confidence) && n.confidence >= 0 && n.confidence <= 1)) err(`${p}.confidence`, 'must be a number in 0..1');
    });
    plan.skillNodes.forEach((n, i) => {
      (n.prerequisites || []).forEach((pr, j) => {
        if (!nodeIds.has(pr)) err(`skillNodes[${i}].prerequisites[${j}]`, `unknown node id "${pr}"`);
      });
    });
  }

  // ---- drillTypes ----
  const drillIds = new Set();
  const drillById = new Map();
  if (!isArr(plan.drillTypes) || plan.drillTypes.length === 0) {
    err('drillTypes', 'required non-empty array');
  } else {
    plan.drillTypes.forEach((d, i) => {
      const p = `drillTypes[${i}]`;
      if (!isStr(d.id)) err(`${p}.id`, 'required string');
      else if (drillIds.has(d.id)) err(`${p}.id`, `duplicate id "${d.id}"`);
      else { drillIds.add(d.id); drillById.set(d.id, d); }
      if (!isStr(d.name)) err(`${p}.name`, 'required string');
      if (!isStr(d.format)) err(`${p}.format`, 'required string');
      if (!INPUT_SHAPES.includes(d.inputShape)) err(`${p}.inputShape`, `must be one of ${INPUT_SHAPES.join(', ')}`);
      if (!EVALUATION_MODES.includes(d.evaluationMode)) err(`${p}.evaluationMode`, `must be one of ${EVALUATION_MODES.join(', ')}`);

      const checker = d.checkerId !== undefined ? checkerById.get(d.checkerId) : undefined;
      if (d.checkerId !== undefined && !checker) {
        err(`${p}.checkerId`, `unknown checker id "${d.checkerId}" — declare it in checkers[]`);
      }
      if (d.evaluationMode === 'deterministic' || d.evaluationMode === 'hybrid') {
        if (!isStr(d.checkerId)) err(`${p}.checkerId`, `required for ${d.evaluationMode} drills — deterministic grading never calls the API`);
        else if (checker && checker.strategy === 'judgment') err(`${p}.checkerId`, `"${d.checkerId}" is a judgment checker; ${d.evaluationMode} drills need a non-judgment strategy`);
      }
      if (d.evaluationMode === 'judgment' && checker && checker.strategy !== 'judgment') {
        err(`${p}.checkerId`, `judgment drills may only reference a judgment-strategy checker (got "${checker.strategy}")`);
      }
      if (d.evaluationMode === 'hybrid') {
        if (!isObj(d.hybrid) || !isStr(d.hybrid.deterministicAxis) || !isStr(d.hybrid.judgmentAxis)) {
          err(`${p}.hybrid`, 'hybrid drills need { deterministicAxis, judgmentAxis } strings');
        }
      }
    });
  }

  // ---- standingElements ----
  // Either drillTypeId (pick a static item from itemBank each session, as
  // before) or generatePrompt (call the tutor at session start for fresh
  // material each time — never a cached item) — not both, not neither.
  if (!isArr(plan.standingElements)) {
    err('standingElements', 'required array (may be empty)');
  } else {
    plan.standingElements.forEach((s, i) => {
      const p = `standingElements[${i}]`;
      if (!isStr(s.id)) err(`${p}.id`, 'required string');
      if (!isStr(s.title)) err(`${p}.title`, 'required string');
      if (!isNum(s.minutes)) err(`${p}.minutes`, 'required number');
      if (s.generatePrompt !== undefined) {
        if (!isStr(s.generatePrompt)) err(`${p}.generatePrompt`, 'must be a non-empty string');
        if (s.drillTypeId !== undefined) err(`${p}.drillTypeId`, 'must not be set alongside generatePrompt — a standing element is either itemBank-backed or tutor-generated, not both');
      } else if (!drillIds.has(s.drillTypeId)) {
        err(`${p}.drillTypeId`, `unknown drill type "${s.drillTypeId}" (or provide generatePrompt instead, for a tutor-generated standing element)`);
      }
      (s.skillNodeIds || []).forEach((id, j) => {
        if (!nodeIds.has(id)) err(`${p}.skillNodeIds[${j}]`, `unknown node id "${id}"`);
      });
    });
  }

  // ---- errorCategories ----
  if (!isArr(plan.errorCategories)) {
    err('errorCategories', 'required array (may be empty)');
  } else {
    const ecIds = new Set();
    plan.errorCategories.forEach((c, i) => {
      const p = `errorCategories[${i}]`;
      if (!isStr(c.id)) err(`${p}.id`, 'required string');
      else if (ecIds.has(c.id)) err(`${p}.id`, `duplicate id "${c.id}"`);
      else ecIds.add(c.id);
      if (!isStr(c.name)) err(`${p}.name`, 'required string');
      if (!isStr(c.rootCause)) err(`${p}.rootCause`, 'required string');
      (c.skillNodeIds || []).forEach((id, j) => {
        if (!nodeIds.has(id)) err(`${p}.skillNodeIds[${j}]`, `unknown node id "${id}"`);
      });
      if (!isArr(c.instances)) err(`${p}.instances`, 'required array (may be empty)');
      else c.instances.forEach((inst, j) => {
        const q = `${p}.instances[${j}]`;
        ['date', 'material', 'userDid', 'correct'].forEach((k) => {
          if (!isStr(inst[k])) err(`${q}.${k}`, 'required string');
        });
      });
    });
  }

  // ---- calibrationExamples ----
  if (!isArr(plan.calibrationExamples)) {
    err('calibrationExamples', 'required array (may be empty)');
  } else {
    plan.calibrationExamples.forEach((c, i) => {
      const p = `calibrationExamples[${i}]`;
      if (!drillIds.has(c.drillTypeId)) err(`${p}.drillTypeId`, `unknown drill type "${c.drillTypeId}"`);
      ['prompt', 'response', 'evaluation', 'commentary'].forEach((k) => {
        if (!isStr(c[k])) err(`${p}.${k}`, 'required string');
      });
    });
  }

  // ---- itemBank ----
  const itemById = new Map();
  if (!isArr(plan.itemBank)) {
    err('itemBank', 'required array (may be empty)');
  } else {
    plan.itemBank.forEach((it, i) => {
      const p = `itemBank[${i}]`;
      if (!isStr(it.id)) err(`${p}.id`, 'required string');
      else if (itemById.has(it.id)) err(`${p}.id`, `duplicate id "${it.id}"`);
      else itemById.set(it.id, it);
      if (!drillIds.has(it.drillTypeId)) err(`${p}.drillTypeId`, `unknown drill type "${it.drillTypeId}"`);
      if (!isStr(it.prompt)) err(`${p}.prompt`, 'required string');
      if (!isStr(it.answer)) err(`${p}.answer`, 'required string');
      if (it.direction !== undefined && !['ltr', 'rtl'].includes(it.direction)) err(`${p}.direction`, 'must be "ltr" or "rtl"');
      (it.skillNodeIds || []).forEach((id, j) => {
        if (!nodeIds.has(id)) err(`${p}.skillNodeIds[${j}]`, `unknown node id "${id}"`);
      });
    });
  }

  // ---- phases → weeks → lessons (full pass) ----
  if (!isArr(plan.phases) || plan.phases.length === 0) {
    err('phases', 'required non-empty array');
  } else {
    const seenLessonIds = new Set();
    plan.phases.forEach((ph, i) => {
      const p = `phases[${i}]`;
      if (!isStr(ph.id)) err(`${p}.id`, 'required string');
      if (!isStr(ph.title)) err(`${p}.title`, 'required string');
      if (!isArr(ph.weeks) || ph.weeks.length === 0) { err(`${p}.weeks`, 'required non-empty array'); return; }
      ph.weeks.forEach((wk, j) => {
        const q = `${p}.weeks[${j}]`;
        if (!isStr(wk.id)) err(`${q}.id`, 'required string');
        if (!isStr(wk.title)) err(`${q}.title`, 'required string');
        if (!isArr(wk.lessons) || wk.lessons.length === 0) { err(`${q}.lessons`, 'required non-empty array'); return; }
        wk.lessons.forEach((ls, k) => {
          const r = `${q}.lessons[${k}]`;
          if (!isStr(ls.id)) err(`${r}.id`, 'required string');
          else if (seenLessonIds.has(ls.id)) err(`${r}.id`, `duplicate lesson id "${ls.id}"`);
          else seenLessonIds.add(ls.id);
          if (!isStr(ls.title)) err(`${r}.title`, 'required string');
          if (!LESSON_TYPES.includes(ls.lessonType)) err(`${r}.lessonType`, `must be one of ${LESSON_TYPES.join(', ')}`);
          if (!isStr(ls.objective)) err(`${r}.objective`, 'required string');
          if (!isStr(ls.masteryCriteria)) err(`${r}.masteryCriteria`, 'required string');

          if (!isArr(ls.content) || ls.content.length === 0) {
            err(`${r}.content`, 'required non-empty array — a lesson is teaching material first, drills second');
          } else {
            ls.content.forEach((b, m) => {
              const s = `${r}.content[${m}]`;
              if (!CONTENT_TYPES.includes(b.type)) { err(`${s}.type`, `must be one of ${CONTENT_TYPES.join(', ')}`); return; }
              if (b.type === 'drill') {
                if (!isStr(b.drillTypeId)) err(`${s}.drillTypeId`, 'required for drill blocks');
                else if (!drillIds.has(b.drillTypeId)) err(`${s}.drillTypeId`, `unknown drill type "${b.drillTypeId}"`);
                (b.itemIds || []).forEach((id, x) => {
                  if (!itemById.has(id)) err(`${s}.itemIds[${x}]`, `unknown item id "${id}"`);
                  else if (itemById.get(id).drillTypeId !== b.drillTypeId) err(`${s}.itemIds[${x}]`, `item "${id}" belongs to drill type "${itemById.get(id).drillTypeId}", not "${b.drillTypeId}"`);
                });
              } else {
                if (!isStr(b.body)) err(`${s}.body`, `required for ${b.type} blocks`);
              }
              if (b.direction !== undefined && !['ltr', 'rtl'].includes(b.direction)) err(`${s}.direction`, 'must be "ltr" or "rtl"');
            });
          }

          // drillTypeIds / skillNodeIds are OPTIONAL in v2 — a study lesson
          // may have neither.
          (ls.drillTypeIds || []).forEach((id, m) => {
            if (!drillIds.has(id)) err(`${r}.drillTypeIds[${m}]`, `unknown drill type "${id}"`);
          });
          (ls.skillNodeIds || []).forEach((id, m) => {
            if (!nodeIds.has(id)) err(`${r}.skillNodeIds[${m}]`, `unknown node id "${id}"`);
          });
          if (ls.blockedOn !== undefined) {
            if (!missingIds.has(ls.blockedOn)) err(`${r}.blockedOn`, `unknown missingData id "${ls.blockedOn}"`);
          }
        });
      });
    });
  }

  return { ok: errors.length === 0, errors };
}

// Ordered flat list of lessons for navigation and the teaching-order audit.
// weekId/weekTitle are read straight from the plan's own phases→weeks→lessons
// structure (untouched — the schema stays as-is). unitNumber is a derived,
// display-only field (not part of the plan schema): a running 1-based count
// of weeks across the whole plan, in plan order. The app's own UI refers to
// this grouping level as "unit"; only the schema's internal field names keep
// the original "week" wording.
export function flattenLessons(plan) {
  const out = [];
  let unitNumber = 0;
  for (const ph of plan.phases || []) {
    for (const wk of ph.weeks || []) {
      unitNumber += 1;
      for (const ls of wk.lessons || []) {
        out.push({ ...ls, phaseId: ph.id, phaseTitle: ph.title, weekId: wk.id, weekTitle: wk.title, unitNumber });
      }
    }
  }
  return out;
}

// Teaching-order audit. Runs AFTER structural validation passes; a violation
// refuses the import. A drill inside lesson L may only exercise nodes whose
// taughtIn lesson is L itself or one that comes earlier in plan order.
export function auditTeachingOrder(plan) {
  const violations = [];
  const lessons = flattenLessons(plan);
  const orderOf = new Map(lessons.map((l, i) => [l.id, i]));
  const nodeById = new Map((plan.skillNodes || []).map((n) => [n.id, n]));
  const itemById = new Map((plan.itemBank || []).map((it) => [it.id, it]));

  const checkNodes = (nodeIds, lessonIndex, path, what) => {
    for (const id of nodeIds || []) {
      const node = nodeById.get(id);
      if (!node) continue; // structural validation already reported it
      const taughtOrder = orderOf.get(node.taughtIn);
      if (taughtOrder === undefined) continue;
      if (taughtOrder > lessonIndex) {
        violations.push(
          `${path}: ${what} exercises node "${id}", but its taughtIn lesson ` +
          `"${node.taughtIn}" (position ${taughtOrder + 1}) comes after this lesson (position ${lessonIndex + 1})`
        );
      }
    }
  };

  lessons.forEach((ls, li) => {
    const base = `lesson "${ls.id}"`;
    // Lesson-declared nodes must be taught by this point.
    checkNodes(ls.skillNodeIds, li, base + '.skillNodeIds', 'lesson');
    // Every drill block: explicit items, or the drill type's bank items that
    // overlap the lesson's nodes.
    (ls.content || []).forEach((b, bi) => {
      if (b.type !== 'drill') return;
      const path = `${base}.content[${bi}]`;
      if (b.itemIds && b.itemIds.length) {
        for (const itemId of b.itemIds) {
          const item = itemById.get(itemId);
          if (item) checkNodes(item.skillNodeIds, li, `${path} (item "${itemId}")`, 'drill item');
        }
      } else {
        // No explicit items: the assembler draws bank items of this drill type
        // that overlap the lesson's declared nodes (or any item when the
        // lesson declares none) — audit exactly that candidate set.
        const lessonNodes = new Set(ls.skillNodeIds || []);
        for (const item of plan.itemBank || []) {
          if (item.drillTypeId !== b.drillTypeId) continue;
          if (lessonNodes.size > 0 && !(item.skillNodeIds || []).some((id) => lessonNodes.has(id))) continue;
          checkNodes(item.skillNodeIds, li, `${path} (bank item "${item.id}")`, 'drill item');
        }
      }
    });
  });

  return { ok: violations.length === 0, violations };
}
