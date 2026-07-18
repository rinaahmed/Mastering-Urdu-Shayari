// Plan schema validation. Hand-rolled so error messages carry exact JSON paths.
// validatePlan(plan) -> { ok: boolean, errors: string[] }

const EVALUATION_MODES = ['deterministic', 'judgment', 'hybrid'];
const INPUT_SHAPES = ['pattern', 'number', 'word', 'text'];

function isStr(v) { return typeof v === 'string' && v.length > 0; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function isArr(v) { return Array.isArray(v); }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

export function validatePlan(plan) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);

  if (!isObj(plan)) return { ok: false, errors: ['(root): plan must be a JSON object'] };

  if (plan.schemaVersion !== 1) err('schemaVersion', 'must be 1');
  if (!isStr(plan.id)) err('id', 'required string');
  if (!isStr(plan.title)) err('title', 'required string');
  if (!isStr(plan.tutorInstructions)) err('tutorInstructions', 'required string — the method lives in the plan, not the app');

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
    });
    // prerequisite refs
    plan.skillNodes.forEach((n, i) => {
      (n.prerequisites || []).forEach((pr, j) => {
        if (!nodeIds.has(pr)) err(`skillNodes[${i}].prerequisites[${j}]`, `unknown node id "${pr}"`);
      });
    });
  }

  // ---- drillTypes ----
  const drillIds = new Set();
  if (!isArr(plan.drillTypes) || plan.drillTypes.length === 0) {
    err('drillTypes', 'required non-empty array');
  } else {
    plan.drillTypes.forEach((d, i) => {
      const p = `drillTypes[${i}]`;
      if (!isStr(d.id)) err(`${p}.id`, 'required string');
      else if (drillIds.has(d.id)) err(`${p}.id`, `duplicate id "${d.id}"`);
      else drillIds.add(d.id);
      if (!isStr(d.name)) err(`${p}.name`, 'required string');
      if (!isStr(d.format)) err(`${p}.format`, 'required string');
      if (!INPUT_SHAPES.includes(d.inputShape)) err(`${p}.inputShape`, `must be one of ${INPUT_SHAPES.join(', ')}`);
      if (!EVALUATION_MODES.includes(d.evaluationMode)) err(`${p}.evaluationMode`, `must be one of ${EVALUATION_MODES.join(', ')}`);
      if (d.evaluationMode !== 'judgment' && !isStr(d.checkerId)) {
        err(`${p}.checkerId`, `required for ${d.evaluationMode} drills — deterministic grading is never sent to the API`);
      }
      if (d.evaluationMode === 'hybrid') {
        if (!isObj(d.hybrid) || !isStr(d.hybrid.deterministicAxis) || !isStr(d.hybrid.judgmentAxis)) {
          err(`${p}.hybrid`, 'hybrid drills need { deterministicAxis, judgmentAxis } strings');
        }
      }
    });
  }

  // ---- standingElements ----
  if (!isArr(plan.standingElements)) {
    err('standingElements', 'required array (may be empty)');
  } else {
    plan.standingElements.forEach((s, i) => {
      const p = `standingElements[${i}]`;
      if (!isStr(s.id)) err(`${p}.id`, 'required string');
      if (!isStr(s.title)) err(`${p}.title`, 'required string');
      if (!isNum(s.minutes)) err(`${p}.minutes`, 'required number');
      if (!drillIds.has(s.drillTypeId)) err(`${p}.drillTypeId`, `unknown drill type "${s.drillTypeId}"`);
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
        if (!isStr(inst.date)) err(`${q}.date`, 'required string (ISO date)');
        if (!isStr(inst.material)) err(`${q}.material`, 'required string');
        if (!isStr(inst.userDid)) err(`${q}.userDid`, 'required string');
        if (!isStr(inst.correct)) err(`${q}.correct`, 'required string');
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
  if (!isArr(plan.itemBank)) {
    err('itemBank', 'required array');
  } else {
    const itemIds = new Set();
    plan.itemBank.forEach((it, i) => {
      const p = `itemBank[${i}]`;
      if (!isStr(it.id)) err(`${p}.id`, 'required string');
      else if (itemIds.has(it.id)) err(`${p}.id`, `duplicate id "${it.id}"`);
      else itemIds.add(it.id);
      if (!drillIds.has(it.drillTypeId)) err(`${p}.drillTypeId`, `unknown drill type "${it.drillTypeId}"`);
      if (!isStr(it.prompt)) err(`${p}.prompt`, 'required string');
      if (!isStr(it.answer)) err(`${p}.answer`, 'required string');
      (it.skillNodeIds || []).forEach((id, j) => {
        if (!nodeIds.has(id)) err(`${p}.skillNodeIds[${j}]`, `unknown node id "${id}"`);
      });
    });
  }

  // ---- phases → weeks → lessons ----
  if (!isArr(plan.phases) || plan.phases.length === 0) {
    err('phases', 'required non-empty array');
  } else {
    const lessonIds = new Set();
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
          else if (lessonIds.has(ls.id)) err(`${r}.id`, `duplicate lesson id "${ls.id}"`);
          else lessonIds.add(ls.id);
          if (!isStr(ls.title)) err(`${r}.title`, 'required string');
          if (!isStr(ls.objective)) err(`${r}.objective`, 'required string');
          if (!isStr(ls.masteryCriteria)) err(`${r}.masteryCriteria`, 'required string');
          if (!isArr(ls.drillTypeIds) || ls.drillTypeIds.length === 0) err(`${r}.drillTypeIds`, 'required non-empty array');
          else ls.drillTypeIds.forEach((id, m) => {
            if (!drillIds.has(id)) err(`${r}.drillTypeIds[${m}]`, `unknown drill type "${id}"`);
          });
          if (!isArr(ls.skillNodeIds) || ls.skillNodeIds.length === 0) err(`${r}.skillNodeIds`, 'required non-empty array');
          else ls.skillNodeIds.forEach((id, m) => {
            if (!nodeIds.has(id)) err(`${r}.skillNodeIds[${m}]`, `unknown node id "${id}"`);
          });
        });
      });
    });
  }

  return { ok: errors.length === 0, errors };
}

// Ordered flat list of lessons for "current lesson" navigation.
export function flattenLessons(plan) {
  const out = [];
  for (const ph of plan.phases || []) {
    for (const wk of ph.weeks || []) {
      for (const ls of wk.lessons || []) {
        out.push({ ...ls, phaseId: ph.id, phaseTitle: ph.title, weekId: wk.id, weekTitle: wk.title });
      }
    }
  }
  return out;
}
